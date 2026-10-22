//! ws.ts `message`, `admitType` and `handle`: one inbound frame, under the room lock, synchronously. Nothing here
//! touches the store except through `queue` and `owner_edits`, which write where the TS does: chat, control,
//! presence, status and ping never do.

use super::conn::{Conn, TimerCmd};
use super::frames::{send_error, send_error_after, send_msg};
use super::limits::{MAX_DROPPED_IN_A_ROW, MemberBuckets};
use super::poll;
use super::session::{close_self, count_bad, get_up, join, kick, leave, session_of, session_of_mut, target_of};
use crate::app::{App, lock};
use crate::contract::client_message::{ClientMessage, EmoteKind as InEmote, parse_client_message};
use crate::contract::constants::{TYPING_TIMEOUT_MS, close};
use crate::contract::ids::MemberId;
use crate::contract::room::ControlPolicy;
use crate::contract::server_message::{ErrorCode, ServerMessage};
use crate::contract::state::{EmoteKind, PingId, ServerTime};
use crate::outbox::publish_msg;
use crate::owner_edits;
use crate::playback::Control;
use crate::queue::{self, QueueActor, QueueAddRefusal, QueueRefusal};
use crate::rate_limit::TokenBucket;
use crate::registry::{RoomCell, RoomInner};
use crate::room::{FloorSitResult, SitResult, WalkResult};
use crate::secrets;
use std::sync::Arc;

/// What arrived on the socket.
pub enum Frame<'a> {
    Text(&'a str),
    /// Binary frames count as bad: the protocol is text only.
    Binary,
}

/// Handles one inbound frame. The L1 bucket is the socket's own, so it is checked before the room lock is
/// taken; the frame is parsed before it too. The member is taken out of the socket for the length of the frame,
/// so the handlers borrow it while they mutate the socket, and the session is looked up once.
pub fn on_frame(app: &Arc<App>, cell: &Arc<RoomCell>, conn: &mut Conn, frame: Frame<'_>) {
    let t0 = app.mono();
    let l1 = conn.bucket.take(t0);
    let parsed = match (&frame, l1) {
        (Frame::Text(text), true) => parse_client_message(text),
        _ => None,
    };
    let retry = if l1 { 0.0 } else { conn.bucket.retry_after_ms(t0) };
    let Some(mut inner) = cell.lock_open() else {
        // The room closed under us: its close frame is already queued.
        return;
    };
    let inner = &mut *inner;
    conn.left = false;
    let member = conn.member.take();
    // `Some(owner)` while this socket still owns its session (not before join, not after a replace).
    let owner = session_of(inner, member.as_ref(), conn.id).map(|s| s.owner);
    handle_frame(app, cell, inner, conn, member.as_ref(), owner, l1, retry, parsed);
    // A join or resume set a member; a leave cleared it; otherwise the socket keeps the one it had.
    if conn.member.is_none() && !conn.left {
        conn.member = member;
    }
    if l1 {
        app.metrics.observe_relay(app.mono() - t0);
    }
}

#[allow(
    clippy::too_many_arguments,
    reason = "one frame's state, split out of on_frame so the member can be borrowed"
)]
fn handle_frame(
    app: &Arc<App>,
    cell: &Arc<RoomCell>,
    inner: &mut RoomInner,
    conn: &mut Conn,
    member: Option<&MemberId>,
    owner: Option<bool>,
    l1: bool,
    retry: f64,
    parsed: Option<ClientMessage>,
) {
    if !l1 {
        refuse(app, inner, conn, retry, "too many messages, slow down");
        return;
    }
    let Some(msg) = parsed else {
        send_error(inner, conn.id, ErrorCode::BadMessage, "invalid message");
        count_bad(app, inner, conn);
        return;
    };
    if !admit_type(app, inner, conn, member, owner, &msg) {
        return;
    }
    conn.dropped = 0;
    handle(app, cell, inner, conn, member.zip(owner), msg);
}

/// Drops a frame: one notice per streak, and a close once the streak is MAX_DROPPED_IN_A_ROW long.
fn refuse(app: &App, inner: &mut RoomInner, conn: &mut Conn, retry_after_ms: f64, message: &str) {
    let first = conn.dropped == 0;
    conn.dropped += 1;
    if first {
        send_error_after(inner, conn.id, ErrorCode::RateLimited, message, Some(retry_after_ms));
    }
    if conn.dropped >= MAX_DROPPED_IN_A_ROW {
        close_self(app, inner, conn, close::RATE_LIMITED, "rate limited");
    }
}

/// Passes the frame's own limiters (L1 already passed), or refuses it and returns false.
fn admit_type(
    app: &App,
    inner: &mut RoomInner,
    conn: &mut Conn,
    member: Option<&MemberId>,
    owner: Option<bool>,
    msg: &ClientMessage,
) -> bool {
    let now = app.mono();
    // Takes from `pick`'s bucket or refuses the frame with `message`.
    macro_rules! admit {
        ($pick:ident, $message:expr) => {{
            match spend(inner, conn, member, now, |b| &mut b.$pick) {
                None => true,
                Some(retry) => {
                    refuse(app, inner, conn, retry, $message);
                    false
                }
            }
        }};
    }
    match msg {
        ClientMessage::Chat { .. } => admit!(chat, "too many chat messages, slow down"),
        // `/roll` is a chat line to the room (OME-1423).
        ClientMessage::Roll { .. } => admit!(chat, "too many chat messages, slow down"),
        // Opening a poll is a chat line too (OME-1452); votes have their own bucket.
        ClientMessage::PollOpen { .. } => admit!(chat, "too many chat messages, slow down"),
        ClientMessage::Vote { .. } => owner.is_none() || admit!(vote, "too many votes, slow down"),
        ClientMessage::Sit { .. } => admit!(sit, "too many seat changes, slow down"),
        ClientMessage::Control { .. } => {
            // Refused in `handle`, before any bucket: a guest can't drain the room's control budget (ADR 0030 section 4).
            if inner.room.control_policy() == ControlPolicy::Owner && owner != Some(true) {
                return true;
            }
            if !admit!(control, "too many playback changes, slow down") {
                return false;
            }
            // The room's limit is everyone's, not this sender's flood: a notice every time, and no streak (ADR 0018 section 2).
            if inner.control_bucket.take(now) {
                return true;
            }
            let retry = inner.control_bucket.retry_after_ms(now);
            send_error_after(
                inner,
                conn.id,
                ErrorCode::RateLimited,
                "this room is changing playback too fast, slow down",
                Some(retry),
            );
            false
        }
        ClientMessage::Join { .. } => {
            if !conn.keyed {
                return true;
            }
            let mut joins = lock(&app.ws.joins);
            if joins.take(&conn.ip, now) {
                return true;
            }
            let retry = joins.retry_after_ms(&conn.ip, now);
            drop(joins);
            refuse(app, inner, conn, retry, "too many joins, slow down");
            false
        }
        // Non-owners get not_owner (or not_joined) in `handle`; only the owner's edits take from the bucket.
        ClientMessage::LayoutSet { .. } | ClientMessage::TitleSet { .. } => {
            owner != Some(true) || admit!(edit, "too many room edits, slow down")
        }
        // Unjoined sockets get not_joined in `handle`.
        ClientMessage::Emote { .. } | ClientMessage::Pair { .. } => owner.is_none() || admit!(emote, "too many emotes, slow down"),
        // A timed reaction spends from the emote bucket; over it dropped silently, like a walk (OME-1625).
        ClientMessage::React { .. } => owner.is_none() || spend(inner, conn, member, now, |b| &mut b.emote).is_none(),
        // Cosmetic broadcasts share one bucket (ADR 0053).
        ClientMessage::SetTint { .. } => owner.is_none() || admit!(emote, "too many tint changes, slow down"),
        ClientMessage::SetAccessory { .. } => owner.is_none() || admit!(emote, "too many accessory changes, slow down"),
        ClientMessage::SetHair { .. } => owner.is_none() || admit!(emote, "too many hair changes, slow down"),
        // Over the typing bucket: dropped silently, as for walks (OME-1387).
        ClientMessage::Typing { .. } => owner.is_none() || spend(inner, conn, member, now, |b| &mut b.typing).is_none(),
        // Over the walk bucket: dropped silently, no notice and no streak toward a close (ADR 0053).
        ClientMessage::Walk { .. } => owner.is_none() || spend(inner, conn, member, now, |b| &mut b.walk).is_none(),
        // A floor sit is a step in place: the walk bucket, dropped silently over it (OME-1499).
        ClientMessage::FloorSit { .. } => owner.is_none() || spend(inner, conn, member, now, |b| &mut b.walk).is_none(),
        // The queue's add buckets come after its control-policy check, in `handle` (ADR 0031 section 3).
        ClientMessage::Leave {}
        | ClientMessage::Ping { .. }
        | ClientMessage::Status { .. }
        | ClientMessage::Presence { .. }
        | ClientMessage::PollClose { .. }
        | ClientMessage::Kick { .. }
        | ClientMessage::Mute { .. }
        | ClientMessage::ControlPolicy { .. }
        | ClientMessage::QueueAdd { .. }
        | ClientMessage::QueueRemove { .. }
        | ClientMessage::QueueMove { .. }
        | ClientMessage::QueueAdvance { .. }
        | ClientMessage::Ended { .. } => true,
    }
}

/// Takes a token from the member's bucket (the session's while joined, the socket's before) or says how long to wait.
fn spend(
    inner: &mut RoomInner,
    conn: &mut Conn,
    member: Option<&MemberId>,
    now: f64,
    pick: fn(&mut MemberBuckets) -> &mut TokenBucket,
) -> Option<f64> {
    let buckets = match session_of_mut(inner, member, conn.id) {
        Some(session) => &mut session.buckets,
        None => &mut conn.buckets,
    };
    let bucket = pick(buckets);
    if bucket.take(now) { None } else { Some(bucket.retry_after_ms(now)) }
}

fn emote_kind(kind: InEmote) -> EmoteKind {
    match kind {
        InEmote::Clap => EmoteKind::Clap,
        InEmote::Exclaim => EmoteKind::Exclaim,
        InEmote::Heart => EmoteKind::Heart,
        InEmote::Laugh => EmoteKind::Laugh,
        InEmote::Question => EmoteKind::Question,
        InEmote::Wave => EmoteKind::Wave,
        InEmote::Cheer => EmoteKind::Cheer,
        InEmote::Yawn => EmoteKind::Yawn,
        InEmote::Dance => EmoteKind::Dance,
    }
}

fn handle(
    app: &Arc<App>,
    cell: &Arc<RoomCell>,
    inner: &mut RoomInner,
    conn: &mut Conn,
    session: Option<(&MemberId, bool)>,
    msg: ClientMessage,
) {
    if let ClientMessage::Ping { id } = &msg {
        // Clock sample: sender only, allowed before join. The token bucket already counted it. (Both ids are
        // validated 0..=PING_ID_MAX, so `new` never refuses a parsed one.)
        if let Some(id) = PingId::new(id.get()) {
            let at = real_wall_ms();
            send_msg(inner, conn.id, &ServerMessage::Pong { id, at });
        }
        return;
    }
    if matches!(msg, ClientMessage::Join { .. }) {
        if session.is_some() {
            send_error(inner, conn.id, ErrorCode::AlreadyJoined, "already joined");
        } else {
            join(app, inner, conn, &msg);
        }
        return;
    }
    if let ClientMessage::Ended { item_id, position } = &msg {
        // Reports what a player saw: never an error, not even before join (ADR 0031 section 4).
        if session.is_some() {
            queue::ended(app, inner, item_id, position.get());
        }
        return;
    }
    let Some((member, owner)) = session else {
        send_error(inner, conn.id, ErrorCode::NotJoined, "join first");
        return;
    };
    match msg {
        ClientMessage::Presence { away } => {
            // A hint, published on transitions only: it never starts, extends or ends a hold (ADR 0043).
            if inner.room.set_away(member, away) {
                publish_msg(
                    inner,
                    &ServerMessage::MemberPresence {
                        member_id: member.clone(),
                        away,
                    },
                );
            }
        }
        ClientMessage::Leave {} => {
            leave(app, inner, conn, member);
            conn.join_timer = TimerCmd::Arm;
        }
        ClientMessage::Sit { seat } => {
            if inner.room.sit(member, seat) == SitResult::SeatTaken {
                send_error(inner, conn.id, ErrorCode::SeatTaken, "seat is taken");
                return;
            }
            get_up(inner, member);
            publish_msg(
                inner,
                &ServerMessage::SeatChanged {
                    member_id: member.clone(),
                    seat,
                },
            );
        }
        ClientMessage::Walk { cell, run, teleport } => match if teleport == Some(true) {
            inner.room.teleport(member, cell)
        } else {
            inner.room.walk(member, cell)
        } {
            WalkResult::Blocked => send_error(inner, conn.id, ErrorCode::BadCell, "you can't stand there"),
            WalkResult::NotMember => {}
            WalkResult::Walked { stood_up } => {
                get_up(inner, member);
                if stood_up {
                    publish_msg(
                        inner,
                        &ServerMessage::SeatChanged {
                            member_id: member.clone(),
                            seat: None,
                        },
                    );
                }
                publish_msg(
                    inner,
                    &ServerMessage::Walked {
                        member_id: member.clone(),
                        cell: Some(cell),
                        run,
                        teleport,
                    },
                );
            }
        },
        ClientMessage::SetTint { tint } => {
            if inner.room.set_tint(member, tint) {
                publish_msg(
                    inner,
                    &ServerMessage::TintChanged {
                        member_id: member.clone(),
                        tint,
                    },
                );
            }
        }
        ClientMessage::SetAccessory { accessory } => {
            if inner.room.set_accessory(member, accessory) {
                publish_msg(
                    inner,
                    &ServerMessage::AccessoryChanged {
                        member_id: member.clone(),
                        accessory,
                    },
                );
            }
        }
        ClientMessage::SetHair { hair } => {
            if inner.room.set_hair(member, hair) {
                publish_msg(
                    inner,
                    &ServerMessage::HairChanged {
                        member_id: member.clone(),
                        hair,
                    },
                );
            }
        }
        ClientMessage::FloorSit { on } => match inner.room.set_floor_sit(member, on) {
            FloorSitResult::NotStanding => send_error(inner, conn.id, ErrorCode::BadCell, "walk to a free cell to sit on the floor"),
            FloorSitResult::Unchanged => {}
            FloorSitResult::Changed => {
                publish_msg(
                    inner,
                    &ServerMessage::FloorSat {
                        member_id: member.clone(),
                        on,
                    },
                );
            }
        },
        ClientMessage::Typing { on } => {
            // A muted member's typing reaches nobody, as their chat doesn't.
            if on && inner.room.is_muted(member) {
                return;
            }
            if on {
                conn.typing_in = Some(TYPING_TIMEOUT_MS as f64);
            }
            if inner.room.set_typing(member, on) {
                publish_msg(
                    inner,
                    &ServerMessage::TypingChanged {
                        member_id: member.clone(),
                        on,
                    },
                );
            }
        }
        ClientMessage::Chat { text } => {
            if inner.room.is_muted(member) {
                send_error(inner, conn.id, ErrorCode::Muted, "the room's owner muted you");
                return;
            }
            clear_typing(inner, member);
            let at = real_wall_ms();
            publish_msg(
                inner,
                &ServerMessage::Chat {
                    member_id: member.clone(),
                    text: text.clone(),
                    at,
                },
            );
            inner.room.conga_chat(member, text.as_str(), at.0);
        }
        ClientMessage::Roll { sides } => {
            if inner.room.is_muted(member) {
                send_error(inner, conn.id, ErrorCode::Muted, "the room's owner muted you");
                return;
            }
            clear_typing(inner, member);
            // No entropy: dropped, nothing logged (the value, like a chat line, never is).
            let Ok(value) = secrets::roll(sides) else {
                return;
            };
            publish_msg(
                inner,
                &ServerMessage::Rolled {
                    member_id: member.clone(),
                    sides,
                    value,
                },
            );
        }
        ClientMessage::PollOpen { question, options } => {
            if inner.room.is_muted(member) {
                send_error(inner, conn.id, ErrorCode::Muted, "the room's owner muted you");
                return;
            }
            clear_typing(inner, member);
            poll::open(app, cell, inner, conn.id, member, question, options);
        }
        ClientMessage::Vote { poll_id, option } => poll::vote(inner, conn.id, member, &poll_id, option),
        ClientMessage::PollClose { poll_id } => poll::close_by(inner, conn.id, member, owner, &poll_id),
        ClientMessage::Control {
            url,
            playing,
            position,
            countdown,
        } => {
            if inner.room.control_policy() == ControlPolicy::Owner && !owner {
                send_error(
                    inner,
                    conn.id,
                    ErrorCode::ControlOwnerOnly,
                    "only the room's owner controls playback here",
                );
                return;
            }
            let control = Control {
                url: url.as_str(),
                playing,
                position: position.get(),
                countdown: countdown.unwrap_or(false),
            };
            let Some(playback) = inner.room.control(member, &control, app.wall()) else {
                send_error(inner, conn.id, ErrorCode::NoEmbed, "that video is not playing here");
                return;
            };
            publish_msg(inner, &ServerMessage::Playback { playback });
        }
        ClientMessage::Status { catching } => status(app, inner, conn, member, catching),
        ClientMessage::LayoutSet { layout } => {
            if !owner {
                not_owner(app, inner, conn);
                return;
            }
            owner_edits::set_layout(app, inner, conn.id, member, layout);
        }
        ClientMessage::TitleSet { title } => {
            if !owner {
                not_owner(app, inner, conn);
                return;
            }
            owner_edits::set_title(app, inner, conn.id, member, title);
        }
        ClientMessage::Emote { kind } => {
            // Fire-and-forget: never stored, never in a snapshot.
            publish_msg(
                inner,
                &ServerMessage::Emoted {
                    member_id: member.clone(),
                    kind: emote_kind(kind),
                },
            );
        }
        // shortcut: refused everywhere until OME-1672 lands the pair (invites, the teleport, `paired`).
        ClientMessage::Pair { .. } => send_error(inner, conn.id, ErrorCode::PairsOff, "no /thrust or /bendover in this room"),
        ClientMessage::Kick { .. } | ClientMessage::Mute { .. } | ClientMessage::ControlPolicy { .. } => {
            moderate(app, inner, conn, member, owner, msg);
        }
        ClientMessage::QueueAdd { url } => {
            let actor = QueueActor {
                member_id: member.clone(),
                owner,
            };
            let refused = queue::admit(app, inner, &actor)
                .err()
                .map(Refusal::from)
                .or_else(|| queue::add(app, inner, &actor, url.as_str()).err().map(Refusal::from));
            if let Some(refused) = refused {
                queue_refused(inner, conn, refused);
            }
        }
        ClientMessage::QueueRemove { item_id } => {
            let actor = QueueActor {
                member_id: member.clone(),
                owner,
            };
            if let Err(refused) = queue::remove(app, inner, &actor, &item_id) {
                queue_refused(inner, conn, refused.into());
            }
        }
        ClientMessage::QueueMove { item_id, to_index } => {
            let actor = QueueActor {
                member_id: member.clone(),
                owner,
            };
            if let Err(refused) = queue::move_item(app, inner, &actor, &item_id, to_index) {
                queue_refused(inner, conn, refused.into());
            }
        }
        ClientMessage::QueueAdvance { from_item_id } => {
            let actor = QueueActor {
                member_id: member.clone(),
                owner,
            };
            if let Err(refused) = queue::advance(app, inner, &actor, &from_item_id) {
                queue_refused(inner, conn, refused.into());
            }
        }
        // Handled above.
        ClientMessage::Join { .. } | ClientMessage::Ping { .. } | ClientMessage::Ended { .. } => {}
        // Contract only (OME-1625): the reaction timeline and its `reacted` relay land with OME-1632.
        ClientMessage::React { .. } => {}
    }
}

fn not_owner(app: &App, inner: &mut RoomInner, conn: &mut Conn) {
    send_error(inner, conn.id, ErrorCode::NotOwner, "only the room's owner can do that");
    count_bad(app, inner, conn);
}

/// ADR 0030 section 1: owner, then the moderation bucket, then the target; nothing is written before all three pass.
fn moderate(app: &Arc<App>, inner: &mut RoomInner, conn: &mut Conn, member: &MemberId, owner: bool, msg: ClientMessage) {
    if !owner {
        not_owner(app, inner, conn);
        return;
    }
    let now = app.mono();
    if let Some(retry) = spend(inner, conn, Some(member), now, |b| &mut b.moderation) {
        refuse(app, inner, conn, retry, "too many moderation actions, slow down");
        return;
    }
    match msg {
        ClientMessage::ControlPolicy { policy } => owner_edits::set_control_policy(app, inner, member, policy),
        ClientMessage::Kick { member_id } | ClientMessage::Mute { member_id, .. } if !target_of(inner, member, &member_id) => {
            // A race with someone leaving is normal: not counted toward 4400.
            send_error(inner, conn.id, ErrorCode::BadTarget, "no such member to moderate");
        }
        ClientMessage::Kick { member_id } => kick(app, inner, &member_id),
        ClientMessage::Mute { member_id, muted } if inner.room.set_muted(&member_id, muted) => {
            publish_msg(
                inner,
                &ServerMessage::MemberMuted {
                    member_id: member_id.clone(),
                    muted,
                },
            );
            if muted {
                clear_typing(inner, &member_id);
            }
        }
        _ => {}
    }
}

/// Clears the member's typing and tells the room, if they were typing (OME-1387): a chat line, a mute, a timeout, a disconnect.
pub fn clear_typing(inner: &mut RoomInner, member: &MemberId) {
    if inner.room.set_typing(member, false) {
        publish_msg(
            inner,
            &ServerMessage::TypingChanged {
                member_id: member.clone(),
                on: false,
            },
        );
    }
}

/// State, not an event: store it, publish on change, at most once per interval per member.
fn status(app: &App, inner: &mut RoomInner, conn: &mut Conn, member: &MemberId, catching: bool) {
    // Catching up means nothing without sync (ADR 0024 section 7).
    if inner.room.has_generic_embed() {
        return;
    }
    inner.room.set_catching(member, catching);
    let now = real_mono_ms();
    let interval = app.ws.status_interval_ms;
    let Some(session) = session_of_mut(inner, Some(member), conn.id) else {
        return;
    };
    if session.status.pending {
        return;
    }
    let wait = session.status.at + interval - now;
    if wait <= 0.0 {
        flush_status(inner, member);
    } else {
        session.status.pending = true;
        conn.status_in = Some(wait);
    }
}

/// Publishes the member's current `catching` if it differs from the last one published. The room keeps what was
/// last published, so a server-side clear (embed switch) is seen here too.
pub fn flush_status(inner: &mut RoomInner, member: &MemberId) {
    let now = real_mono_ms();
    if let Some(session) = inner.sessions.get_mut(member) {
        session.status.pending = false;
    }
    let Some(catching) = inner.room.take_catching_change(member) else {
        return;
    };
    if let Some(session) = inner.sessions.get_mut(member) {
        session.status.at = now;
    }
    publish_msg(
        inner,
        &ServerMessage::MemberStatus {
            member_id: member.clone(),
            catching,
        },
    );
}

/// What the queue refused, as ws.ts's `queueRefused` words it. None of these counts toward the 4400 close
/// (ADR 0031 section 3). A failed store write says nothing, as for owner edits.
enum Refusal {
    OwnerOnly,
    RateLimited(u64),
    UnsupportedUrl,
    Full,
    Silent,
}

impl From<QueueRefusal> for Refusal {
    fn from(r: QueueRefusal) -> Self {
        match r {
            QueueRefusal::ControlOwnerOnly => Self::OwnerOnly,
            QueueRefusal::RateLimited { retry_after_ms } => Self::RateLimited(retry_after_ms),
            QueueRefusal::RoomClosed => Self::Silent,
        }
    }
}

impl From<QueueAddRefusal> for Refusal {
    fn from(r: QueueAddRefusal) -> Self {
        match r {
            QueueAddRefusal::UnsupportedUrl => Self::UnsupportedUrl,
            QueueAddRefusal::QueueFull => Self::Full,
            QueueAddRefusal::Unavailable | QueueAddRefusal::RoomClosed => Self::Silent,
        }
    }
}

fn queue_refused(inner: &mut RoomInner, conn: &Conn, refused: Refusal) {
    match refused {
        Refusal::OwnerOnly => send_error(
            inner,
            conn.id,
            ErrorCode::ControlOwnerOnly,
            "only the room's owner changes the queue here",
        ),
        Refusal::RateLimited(ms) => send_error_after(
            inner,
            conn.id,
            ErrorCode::RateLimited,
            "too many videos queued, slow down",
            Some(ms as f64),
        ),
        Refusal::UnsupportedUrl => send_error(inner, conn.id, ErrorCode::UnsupportedUrl, "not a supported video URL"),
        Refusal::Full => send_error(inner, conn.id, ErrorCode::QueueFull, "the queue is full"),
        Refusal::Silent => {}
    }
}

/// `Date.now()`: ws.ts stamps `pong` and `chat` with the system clock, not the injected `wallNow`, so a test's virtual
/// wall clock does not move them.
fn real_wall_ms() -> ServerTime {
    let ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| u64::try_from(d.as_millis()).unwrap_or(u64::MAX));
    ServerTime(ms)
}

/// Milliseconds on the process's own monotonic clock. The `member-status` interval is measured on this, like the
/// real timer that waits it out: with the injected (possibly frozen) clock a coalesced publish would always wait
/// the full interval.
fn real_mono_ms() -> f64 {
    static START: std::sync::OnceLock<std::time::Instant> = std::sync::OnceLock::new();
    START.get_or_init(std::time::Instant::now).elapsed().as_secs_f64() * 1000.0
}
