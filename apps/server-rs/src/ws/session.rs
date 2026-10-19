//! ws-sessions.ts: members of a room, live or held (ADR 0043): join, resume, hold, end and kick, with their tokens.
//!
//! A [`Session`] lives in `RoomInner::sessions`; a socket points at it by member id (`Conn::member`) and owns it
//! only while `session.conn` is that socket, which is how "once another socket resumed it" is expressed.
//! Everything here is synchronous under the room lock; the only task is a held member's expiry, which sleeps on
//! the app clock, re-locks and re-checks.

use super::conn::{Conn, TimerCmd};
use super::frames::{close_with, publish_except_msg, send_error, send_error_after, send_msg};
use super::handle::clear_typing;
use super::limits::MemberBuckets;
use super::poll::{OpenPoll, member_left};
use crate::app::{App, lock};
use crate::contract::client_message::ClientMessage;
use crate::contract::constants::{KICK_COOLDOWN_MS, close};
use crate::contract::ids::{MemberId, ResumeToken, ShareToken};
use crate::contract::room::RoomVisibility;
use crate::contract::server_message::{ErrorCode, MemberLeftReason, ServerMessage};
use crate::outbox::{ConnId, publish_msg};
use crate::rate_limit::KeyedLimiter;
use crate::registry::{RoomCell, RoomInner, ShareGrant};
use crate::room::JoinFailure;
use crate::secrets::{hash_secret, mint_resume_token, mint_share_token};
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use tokio::task::AbortHandle;

/// `member-status` coalescing (ADR 0019 section 3).
#[derive(Debug)]
pub struct StatusRelay {
    /// When it was published (`mono` ms); -infinity before the first.
    pub at: f64,
    /// A trailing publish is waiting on the socket's timer.
    pub pending: bool,
}

/// A joined member's identity (ADR 0043). It outlives its socket while held: an unexpected close of a durable
/// member keeps it for the grace window, away, until a resume reattaches it or the hold expires.
pub struct Session {
    pub member_id: MemberId,
    /// Joined with the room's owner token (ADR 0028 section 3).
    pub owner: bool,
    /// Authorizes this member's shares until it leaves, is kicked or its hold expires; only sent to its own socket.
    pub share_token: ShareToken,
    /// `None` for a legacy join, which departs on close.
    pub resume_token: Option<ResumeToken>,
    /// Client key the member counts against, `None` when uncapped; moves with a resume from elsewhere.
    pub client: Option<String>,
    /// The one live socket; `None` while held.
    pub conn: Option<ConnId>,
    pub buckets: MemberBuckets,
    pub status: StatusRelay,
    /// The pending expiry of a hold: its generation (a stale wake-up checks it) and the task.
    hold: Option<(u64, AbortHandle)>,
}

impl Session {
    /// Cancels the hold's expiry.
    pub fn cancel_hold(&mut self) {
        if let Some((_, task)) = self.hold.take() {
            task.abort();
        }
    }
}

/// The session `conn` is, if it still owns one: not before join, not after leave, not once another socket resumed it.
pub fn session_of<'a>(inner: &'a RoomInner, member: Option<&MemberId>, conn: ConnId) -> Option<&'a Session> {
    let session = inner.sessions.get(member?)?;
    (session.conn == Some(conn)).then_some(session)
}

pub fn session_of_mut<'a>(inner: &'a mut RoomInner, member: Option<&MemberId>, conn: ConnId) -> Option<&'a mut Session> {
    let session = inner.sessions.get_mut(member?)?;
    (session.conn == Some(conn)).then_some(session)
}

/// Counts a `bad_message`-like failure; closes with BAD_MESSAGES and returns false at the limit.
pub fn count_bad(app: &App, inner: &mut RoomInner, conn: &mut Conn) -> bool {
    conn.bad += 1;
    if conn.bad < super::limits::MAX_BAD_MESSAGES {
        return true;
    }
    close_self(app, inner, conn, close::BAD_MESSAGES, "too many bad messages");
    false
}

/// A close the server starts on this very socket: no more frames of its are handled.
pub fn close_self(app: &App, inner: &mut RoomInner, conn: &mut Conn, code: u16, reason: &'static str) {
    conn.closing = true;
    close_with(app, inner, conn.id, code, reason);
}

/// Which failed-secret limiter a join takes from.
#[derive(Clone, Copy)]
enum Secret {
    Owner,
    Invite,
}

/// A join with a wrong secret: counts toward the 4400 close and takes from the limiter. True if the caller may go
/// on; false once the socket is closing or the bucket is dry (then `rate_limited`).
fn failed_secret(app: &App, inner: &mut RoomInner, conn: &mut Conn, which: Secret, message: &str) -> bool {
    if !count_bad(app, inner, conn) {
        return false;
    }
    let (limiter, now): (&std::sync::Mutex<KeyedLimiter>, f64) = match which {
        Secret::Owner => (&app.ws.failed_owners, app.mono()),
        Secret::Invite => (&app.ws.failed_invites, app.mono()),
    };
    let mut limiter = lock(limiter);
    if limiter.take(&conn.ip, now) {
        return true;
    }
    let retry = limiter.retry_after_ms(&conn.ip, now);
    drop(limiter);
    send_error_after(inner, conn.id, ErrorCode::RateLimited, message, Some(retry));
    false
}

static HOLD_GENERATION: AtomicU64 = AtomicU64::new(1);

/// Ends a member: revokes its resume and share tokens and frees its seat, slot, name and quota. The caller
/// announces it.
fn end(app: &App, inner: &mut RoomInner, member: &MemberId) -> Option<Session> {
    let mut session = inner.sessions.remove(member)?;
    session.cancel_hold();
    if let Some(token) = &session.resume_token {
        inner.resumable.remove(&hash_secret(token.as_str()));
    }
    inner.revoke_grant(&session.share_token);
    inner.forget_member(member);
    if let Some(conn) = session.conn {
        inner.subscribers.unsubscribe(conn);
    }
    let wall = app.wall();
    inner.room.leave(member, wall);
    if !inner.closed {
        member_left(inner, member);
    }
    // Not when the room itself is going: its row is about to be deleted.
    if inner.room.member_count() == 0 && !inner.closed {
        app.mark_active(inner, wall);
    }
    Some(session)
}

/// A durable member's socket closed without `leave` (ADR 0043): keep everything but the socket for the grace
/// window. Catching is cleared, away is published once, and one task ends the hold.
fn hold(app: &Arc<App>, cell: &Arc<RoomCell>, inner: &mut RoomInner, member: &MemberId) {
    if let Some(session) = inner.sessions.get_mut(member) {
        session.conn = None;
        session.status = StatusRelay {
            at: f64::NEG_INFINITY,
            pending: false,
        };
    }
    clear_typing(inner, member);
    inner.room.set_catching(member, false);
    if inner.room.take_catching_change(member).is_some() {
        publish_msg(
            inner,
            &ServerMessage::MemberStatus {
                member_id: member.clone(),
                catching: false,
            },
        );
    }
    if inner.room.set_away(member, true) {
        publish_msg(
            inner,
            &ServerMessage::MemberPresence {
                member_id: member.clone(),
                away: true,
            },
        );
    }
    let generation = HOLD_GENERATION.fetch_add(1, Ordering::Relaxed);
    let (app, cell, member_id) = (app.clone(), cell.clone(), member.clone());
    let grace = f64::from(app.config.resume_grace_ms);
    let task = tokio::spawn(async move {
        app.clock.sleep(grace).await;
        let Some(mut inner) = cell.lock_open() else { return };
        // Stale unless this hold is still the session's: a resume or an end cancels it, this checks anyway.
        let live = inner
            .sessions
            .get(&member_id)
            .is_some_and(|s| s.conn.is_none() && s.hold.as_ref().is_some_and(|(g, _)| *g == generation));
        if !live {
            return;
        }
        end(&app, &mut inner, &member_id);
        publish_msg(
            &mut inner,
            &ServerMessage::MemberLeft {
                member_id,
                reason: Some(MemberLeftReason::Left),
            },
        );
    });
    if let Some(session) = inner.sessions.get_mut(member) {
        session.hold = Some((generation, task.abort_handle()));
    } else {
        task.abort();
    }
}

/// `sessions.closed`: the socket is gone. A durable member is held, a legacy one leaves.
pub fn closed(app: &Arc<App>, cell: &Arc<RoomCell>, inner: &mut RoomInner, conn: &Conn) {
    inner.subscribers.detach(conn.id);
    if inner.closed {
        return;
    }
    // Found by socket, not through `conn.member`: this runs on every way out, a panicking handler included. None for
    // a socket another one replaced: its close never touches the member (ADR 0043).
    let Some(session) = inner.sessions.values().find(|s| s.conn == Some(conn.id)) else {
        return;
    };
    let member = session.member_id.clone();
    if session.resume_token.is_some() {
        hold(app, cell, inner, &member);
        return;
    }
    end(app, inner, &member);
    publish_msg(
        inner,
        &ServerMessage::MemberLeft {
            member_id: member,
            reason: None,
        },
    );
}

/// Explicit `leave`: no grace, both tokens die now. The socket keeps its buckets, the queue's included (ws.ts).
pub fn leave(app: &App, inner: &mut RoomInner, conn: &mut Conn, member: &MemberId) {
    conn.parked_add = inner.take_member_bucket(member);
    if let Some(session) = end(app, inner, member) {
        conn.buckets = session.buckets;
    }
    conn.member = None;
    conn.left = true;
    publish_msg(
        inner,
        &ServerMessage::MemberLeft {
            member_id: member.clone(),
            reason: None,
        },
    );
}

/// The guest member `id` names in the room, live or held (ADR 0043): not the sender, not owner-joined.
pub fn target_of(inner: &RoomInner, sender: &MemberId, id: &MemberId) -> bool {
    id != sender && inner.sessions.get(id).is_some_and(|s| !s.owner)
}

/// Ended and unsubscribed first, so the target gets no frame before the close (ADR 0030 section 2); a held target
/// has no socket, and its tokens die with the hold. The cooldown lives in the room's memory only.
pub fn kick(app: &App, inner: &mut RoomInner, target: &MemberId) {
    let Some(session) = inner.sessions.get(target) else { return };
    let (client, conn) = (session.client.clone(), session.conn);
    let wall = app.wall();
    if let Some(client) = client {
        inner.room.cool_down(
            &client,
            wall.saturating_add(i64::try_from(KICK_COOLDOWN_MS).unwrap_or(i64::MAX)),
            wall,
        );
    }
    end(app, inner, target);
    publish_msg(
        inner,
        &ServerMessage::MemberLeft {
            member_id: target.clone(),
            reason: Some(MemberLeftReason::Kicked),
        },
    );
    if let Some(conn) = conn {
        close_with(app, inner, conn, close::KICKED, "kicked");
    }
}

/// Reattaches the held (or still live) member `token` names, before any nickname, capacity, invite or cooldown
/// check (ADR 0043). Any token that doesn't name one of this room's members gets the same `resume_expired`, and
/// the socket stays unjoined: never a fresh member in its place.
fn resume(app: &App, inner: &mut RoomInner, conn: &mut Conn, token: &ResumeToken) {
    let member = inner
        .resumable
        .get(&hash_secret(token.as_str()))
        .filter(|m| inner.sessions.contains_key(*m))
        .cloned();
    let Some(member) = member else {
        send_error(inner, conn.id, ErrorCode::ResumeExpired, "session expired");
        return;
    };
    // Another address: the quota slot moves with it, or the resume is refused and the hold stays.
    let client = conn.keyed.then(|| conn.ip.clone());
    let moved = inner.sessions.get(&member).is_some_and(|s| s.client != client);
    if moved {
        if !inner.room.move_client(&member, client.as_deref()) {
            send_error(
                inner,
                conn.id,
                ErrorCode::TooManyMembers,
                "too many members from your address in this room",
            );
            return;
        }
        if let Some(session) = inner.sessions.get_mut(&member) {
            session.client = client;
        }
    }
    conn.join_timer = TimerCmd::Clear;
    // One socket per token: the old one, still open, hears nothing more and closes as replaced.
    let old = inner.sessions.get_mut(&member).and_then(|s| {
        s.cancel_hold();
        let old = s.conn.replace(conn.id);
        s.status = StatusRelay {
            at: f64::NEG_INFINITY,
            pending: false,
        };
        old
    });
    if let Some(old) = old {
        inner.subscribers.unsubscribe(old);
        close_with(app, inner, old, close::SESSION_REPLACED, "session replaced");
    }
    conn.member = Some(member.clone());
    let back = inner.room.set_away(&member, false);
    let Some(session) = inner.sessions.get(&member) else { return };
    let snapshot = ServerMessage::Snapshot {
        self_id: member.clone(),
        room: inner.room.snapshot(),
        share_token: Some(session.share_token.clone()),
        resume_token: Some(token.clone()),
        resumed: Some(true),
        owner: session.owner.then_some(true),
        poll: inner.poll.as_ref().and_then(OpenPoll::view),
    };
    send_msg(inner, conn.id, &snapshot);
    inner.subscribers.subscribe(conn.id);
    // No leave/join pair: the room only hears that the member is back.
    if back {
        publish_except_msg(
            inner,
            conn.id,
            &ServerMessage::MemberPresence {
                member_id: member,
                away: false,
            },
        );
    }
}

/// A `join` on a socket that has no session yet.
pub fn join(app: &App, inner: &mut RoomInner, conn: &mut Conn, msg: &ClientMessage) {
    let ClientMessage::Join {
        nickname,
        avatar,
        owner_token,
        invite_key,
        durable_session,
        resume_token,
        tint,
        accessory,
        hair,
    } = msg
    else {
        return;
    };
    if let Some(token) = resume_token {
        resume(app, inner, conn, token);
        return;
    }
    let wall = app.wall();
    // Secrets are compared by hash in constant time and never echoed or logged (ADR 0028 section 3).
    let owner = owner_token.as_ref().is_some_and(|t| inner.room.is_owner(t.as_str()));
    // A wrong owner token still joins, as a guest, while its bucket lasts.
    if owner_token.is_some() && !owner && !failed_secret(app, inner, conn, Secret::Owner, "too many wrong owner tokens, slow down") {
        return;
    }
    // Kicked from this address less than KICK_COOLDOWN_MS ago: closed before any snapshot. The owner is never locked out.
    if !owner && conn.keyed && inner.room.is_cooling_down(&conn.ip, wall) {
        close_self(app, inner, conn, close::KICKED, "kicked");
        return;
    }
    if inner.room.visibility == RoomVisibility::Private && !owner && !invite_key.as_ref().is_some_and(|k| inner.room.is_invited(k.as_str()))
    {
        // Like nickname_taken: the socket stays open and unjoined, and hears nothing from the room.
        if failed_secret(app, inner, conn, Secret::Invite, "too many wrong invite keys, slow down") {
            send_error(
                inner,
                conn.id,
                ErrorCode::InviteRequired,
                "this room is private: use its invite link",
            );
        }
        return;
    }
    let client = conn.keyed.then(|| conn.ip.clone());
    // Minted before the member exists, so an entropy failure leaves nothing to undo.
    let tokens = mint_share_token().and_then(|share| Ok((share, durable_session.then(mint_resume_token).transpose()?)));
    let Ok((share_token, resume_token)) = tokens else {
        close_self(app, inner, conn, 1011, "server error");
        return;
    };
    let member = match inner.room.join(nickname, *avatar, client.as_deref()) {
        Err(_) => {
            close_self(app, inner, conn, 1011, "server error");
            return;
        }
        Ok(Err(JoinFailure::RoomFull)) => {
            send_msg(inner, conn.id, &ServerMessage::RoomFull {});
            close_self(app, inner, conn, close::ROOM_FULL, "room full");
            return;
        }
        Ok(Err(JoinFailure::NicknameTaken)) => {
            send_error(inner, conn.id, ErrorCode::NicknameTaken, "that name is taken in this room");
            return;
        }
        Ok(Err(JoinFailure::TooManyMembers)) => {
            send_error(
                inner,
                conn.id,
                ErrorCode::TooManyMembers,
                "too many members from your address in this room",
            );
            return;
        }
        Ok(Ok(member)) => member,
    };
    conn.join_timer = TimerCmd::Clear;
    if let Some(tint) = tint {
        inner.room.set_tint(&member.id, *tint);
    }
    if let Some(accessory) = accessory {
        inner.room.set_accessory(&member.id, *accessory);
    }
    if let Some(hair) = hair {
        inner.room.set_hair(&member.id, *hair);
    }
    // Back after a restart under the same name: the seat it held, in its snapshot and, after the join, for the room.
    let held_seat = inner.room.claim_held_seat(&member.id, wall);
    // A muted member's address, back within MUTE_MEMORY_MS, starts muted; the owner never does (ADR 0030 section 3).
    if !owner {
        inner.room.restore_mute(&member.id, wall);
    }
    conn.member = Some(member.id.clone());
    inner.sessions.insert(
        member.id.clone(),
        Session {
            member_id: member.id.clone(),
            owner,
            share_token: share_token.clone(),
            resume_token: resume_token.clone(),
            client,
            conn: Some(conn.id),
            buckets: std::mem::replace(&mut conn.buckets, MemberBuckets::new(app.mono())),
            status: StatusRelay {
                at: f64::NEG_INFINITY,
                pending: false,
            },
            hold: None,
        },
    );
    if let Some(bucket) = conn.parked_add.take() {
        inner.put_member_bucket(&member.id, bucket);
    }
    if let Some(token) = &resume_token {
        inner.resumable.insert(hash_secret(token.as_str()), member.id.clone());
    }
    inner.insert_grant(&share_token, ShareGrant::new(member.id.clone(), owner, app.mono()));
    // Only the member's own snapshot carries its tokens or says it owns the room; nothing of either is ever broadcast.
    let snapshot = ServerMessage::Snapshot {
        self_id: member.id.clone(),
        room: inner.room.snapshot(),
        share_token: Some(share_token),
        resume_token,
        resumed: None,
        owner: owner.then_some(true),
        poll: inner.poll.as_ref().and_then(OpenPoll::view),
    };
    send_msg(inner, conn.id, &snapshot);
    inner.subscribers.subscribe(conn.id);
    let view = inner.room.view(&member);
    publish_except_msg(inner, conn.id, &ServerMessage::MemberJoined { member: view });
    if let Some(seat) = held_seat {
        publish_except_msg(
            inner,
            conn.id,
            &ServerMessage::SeatChanged {
                member_id: member.id.clone(),
                seat: Some(seat),
            },
        );
    }
    if inner.room.member_count() == 1 {
        app.mark_active(inner, wall);
    }
}
