//! Watch-party polls (OME-1452, ADR 0055): at most one open poll per room, in memory only. Nothing here is stored or
//! logged; the question and the options live in `RoomInner::poll` until the poll closes.

use super::frames::send_error;
use crate::app::App;
use crate::contract::constants::POLL_DURATION_MS;
use crate::contract::ids::{MemberId, PollId};
use crate::contract::room::{PollCount, PollOptionIndex};
use crate::contract::server_message::{ErrorCode, ServerMessage};
use crate::contract::state::{Poll, ServerTime};
use crate::contract::text::{PollOption, PollQuestion};
use crate::outbox::{ConnId, publish_msg};
use crate::registry::{RoomCell, RoomInner};
use crate::secrets;
use std::collections::HashMap;
use std::sync::Arc;
use tokio::task::AbortHandle;

/// The room's open poll. No `Debug`: it holds the question.
pub struct OpenPoll {
    id: PollId,
    by: MemberId,
    question: PollQuestion,
    options: Vec<PollOption>,
    ends_at: ServerTime,
    votes: HashMap<MemberId, PollOptionIndex>,
    /// The POLL_DURATION_MS close; aborted when the poll closes earlier.
    timer: Option<AbortHandle>,
}

/// What a vote did.
#[derive(Debug, PartialEq, Eq)]
pub enum Voted {
    Changed,
    Unchanged,
    NoSuchOption,
}

impl OpenPoll {
    pub fn new(id: PollId, by: MemberId, question: PollQuestion, options: Vec<PollOption>, ends_at: ServerTime) -> Self {
        Self {
            id,
            by,
            question,
            options,
            ends_at,
            votes: HashMap::new(),
            timer: None,
        }
    }

    /// Records `member`'s vote, replacing an earlier one.
    pub fn vote(&mut self, member: &MemberId, option: PollOptionIndex) -> Voted {
        if usize::from(option.get()) >= self.options.len() {
            return Voted::NoSuchOption;
        }
        match self.votes.insert(member.clone(), option) {
            Some(old) if old == option => Voted::Unchanged,
            _ => Voted::Changed,
        }
    }

    /// Drops `member`'s vote; true if they had one.
    pub fn unvote(&mut self, member: &MemberId) -> bool {
        self.votes.remove(member).is_some()
    }

    /// Votes per option. A voter is a member, so a count never passes MAX_ROOM_MEMBERS; `None` if it somehow did.
    pub fn counts(&self) -> Option<Vec<PollCount>> {
        let mut counts = vec![0_u64; self.options.len()];
        for option in self.votes.values() {
            if let Some(c) = counts.get_mut(usize::from(option.get())) {
                *c += 1;
            }
        }
        counts.into_iter().map(PollCount::new).collect()
    }

    /// As the snapshot carries it.
    pub fn view(&self) -> Option<Poll> {
        Some(Poll {
            poll_id: self.id.clone(),
            by: self.by.clone(),
            question: self.question.clone(),
            options: self.options.clone(),
            counts: self.counts()?,
            ends_at: self.ends_at,
        })
    }
}

/// `poll` to everyone: the whole poll, counts included.
fn publish_poll(inner: &mut RoomInner) {
    let Some(Poll {
        poll_id,
        by,
        question,
        options,
        counts,
        ends_at,
    }) = inner.poll.as_ref().and_then(OpenPoll::view)
    else {
        return;
    };
    publish_msg(
        inner,
        &ServerMessage::PollChanged {
            poll_id,
            by,
            question,
            options,
            counts,
            ends_at,
        },
    );
}

/// `poll-open` from a joined, unmuted member (the chat bucket already paid): one poll per room, else `bad_message`.
pub fn open(
    app: &Arc<App>,
    cell: &Arc<RoomCell>,
    inner: &mut RoomInner,
    conn: ConnId,
    member: &MemberId,
    question: PollQuestion,
    options: Vec<PollOption>,
) {
    if inner.poll.is_some() {
        send_error(inner, conn, ErrorCode::BadMessage, "a poll is already open");
        return;
    }
    // No entropy: dropped, like a roll.
    let Ok(id) = secrets::mint_poll_id() else {
        return;
    };
    let ends_at = ServerTime(u64::try_from(app.wall()).unwrap_or(0).saturating_add(POLL_DURATION_MS));
    let mut poll = OpenPoll::new(id.clone(), member.clone(), question, options, ends_at);
    // Armed now, not when the task first runs, so the deadline is POLL_DURATION_MS from this frame.
    let sleep = app.clock.sleep(POLL_DURATION_MS as f64);
    let cell = cell.clone();
    let task = tokio::spawn(async move {
        sleep.await;
        let Some(mut inner) = cell.lock_open() else { return };
        if inner.poll.as_ref().is_some_and(|p| p.id == id) {
            close(&mut inner);
        }
    });
    poll.timer = Some(task.abort_handle());
    inner.poll = Some(poll);
    publish_poll(inner);
}

/// `vote`: for the open poll only; anything else is dropped without a word.
pub fn vote(inner: &mut RoomInner, conn: ConnId, member: &MemberId, poll_id: &PollId, option: PollOptionIndex) {
    let Some(poll) = inner.poll.as_mut().filter(|p| p.id == *poll_id) else {
        return;
    };
    match poll.vote(member, option) {
        Voted::Changed => publish_poll(inner),
        Voted::Unchanged => {}
        Voted::NoSuchOption => send_error(inner, conn, ErrorCode::BadMessage, "that poll has no such option"),
    }
}

/// `poll-close`: the opener or the room's owner; a poll that is not open is dropped without a word.
pub fn close_by(inner: &mut RoomInner, conn: ConnId, member: &MemberId, owner: bool, poll_id: &PollId) {
    let Some(poll) = inner.poll.as_ref().filter(|p| p.id == *poll_id) else {
        return;
    };
    if !owner && poll.by != *member {
        send_error(
            inner,
            conn,
            ErrorCode::NotOwner,
            "only the poll's opener or the room's owner can close it",
        );
        return;
    }
    close(inner);
}

/// A member left the room: their vote goes with them, and the last one out closes the poll (its timer task with it).
pub fn member_left(inner: &mut RoomInner, member: &MemberId) {
    if inner.room.member_count() == 0 {
        close(inner);
    } else if inner.poll.as_mut().is_some_and(|p| p.unvote(member)) {
        publish_poll(inner);
    }
}

/// Ends the open poll: `poll-closed` with the final counts to everyone.
fn close(inner: &mut RoomInner) {
    let Some(poll) = inner.poll.take() else { return };
    if let Some(timer) = &poll.timer {
        timer.abort();
    }
    if let Some(counts) = poll.counts() {
        publish_msg(inner, &ServerMessage::PollClosed { poll_id: poll.id, counts });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mid(s: &str) -> MemberId {
        MemberId::parse(s).unwrap()
    }
    fn opt(i: u64) -> PollOptionIndex {
        PollOptionIndex::new(i).unwrap()
    }
    fn counts(p: &OpenPoll) -> Vec<u8> {
        p.counts().unwrap().into_iter().map(PollCount::get).collect()
    }
    fn poll(options: &[&str]) -> OpenPoll {
        OpenPoll::new(
            PollId::parse("p1").unwrap(),
            mid("a"),
            PollQuestion::parse("Next?").unwrap(),
            options.iter().map(|o| PollOption::parse(o).unwrap()).collect(),
            ServerTime(60_000),
        )
    }

    #[test]
    fn a_member_votes_once_and_can_change_the_vote() {
        let mut p = poll(&["A", "B", "C"]);
        assert_eq!(p.vote(&mid("a"), opt(1)), Voted::Changed);
        assert_eq!(p.vote(&mid("b"), opt(1)), Voted::Changed);
        assert_eq!(counts(&p), [0, 2, 0]);
        assert_eq!(p.vote(&mid("b"), opt(1)), Voted::Unchanged);
        assert_eq!(p.vote(&mid("b"), opt(2)), Voted::Changed);
        assert_eq!(counts(&p), [0, 1, 1]);
    }

    #[test]
    fn an_option_the_poll_lacks_counts_nothing() {
        let mut p = poll(&["A", "B"]);
        assert_eq!(p.vote(&mid("a"), opt(2)), Voted::NoSuchOption);
        assert_eq!(counts(&p), [0, 0]);
    }

    #[test]
    fn a_leaver_takes_their_vote_along() {
        let mut p = poll(&["A", "B"]);
        p.vote(&mid("a"), opt(0));
        assert!(p.unvote(&mid("a")));
        assert!(!p.unvote(&mid("a")));
        assert_eq!(counts(&p), [0, 0]);
    }
}
