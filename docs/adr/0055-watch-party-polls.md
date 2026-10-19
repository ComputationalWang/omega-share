# ADR 0055 — Watch-party polls

**Status:** accepted (2026-10-19) · Lead · [OME-1452](/OME/issues/OME-1452) (part of [OME-1345](/OME/issues/OME-1345))

**Context:** People in a room want a quick show of hands ("Next video? A | B | C"). A poll is shared state that changes while people vote, so it can't be fire-and-forget like `rolled`; but it is gone in a minute, so it doesn't belong in the store.

**Decision:**
- **Memory only.** A room has at most one open poll, in `RoomInner::poll` (`apps/server-rs/src/ws/poll.rs`). It is never written to the store, never in the room's row and never in `GET /rooms`. A restart or a room's removal drops it. The question and the options are never logged; `OpenPoll` has no `Debug`.
- **Client:** `poll-open {question, options}`: the question is `plainTextSchema(80)`, 2–4 options of `plainTextSchema(40)`: chat's rules (trim, NFC, no controls or format characters, no invisible letters, at most 3 marks in a row). `vote {pollId, option}` with `option` in `0..4`. `poll-close {pollId}`. All need `join`.
- **Server:** `poll {pollId, by, question, options, counts, endsAt}` to everyone on open and on every change of the counts; `poll-closed {pollId, counts}` with the final counts. The snapshot carries the open poll as `poll` (beside `room`, not inside it: a poll is not room state the rooms list or the store know about). `endsAt` is server wall time.
- **Rules:**
  - One open poll per room: a second `poll-open` is `bad_message`.
  - It closes after `POLL_DURATION_MS` (60 s), when its opener or the room's owner sends `poll-close` (anyone else gets `not_owner`), or when the last member leaves the room (nobody is left to see it, and its timer task goes too).
  - A member has one vote and may change it; the same vote again changes nothing and sends nothing. A member who leaves (not a grace hold) loses their vote, and the new counts go out.
  - `poll-open` is a chat line: the chat bucket, `muted` for a muted member, and it clears typing. `vote` has its own bucket, `VOTE_BURST` 2 refilled every `VOTE_REFILL_MS` 500 (2/s); over it, `rate_limited`.
  - A `vote` for an option the open poll lacks is `bad_message` (sender only, not counted toward the 4400 close: the frame itself was valid). A `vote` or `poll-close` naming a poll that is not open is dropped silently: it races the close.
- **Poll ids** are 12 random bytes, base64url (like queue item ids), so a late vote never lands on the next poll.

**Frozen TS server.** It ignores the three client messages and never sends a poll (PORTING.md "Deliberate differences"); the black-box cases (`poll.test.ts`) run against the binary only.

**Consequences:** Three client messages, two server messages, one optional snapshot key, seven constants, one per-member bucket. The open poll costs one timer task per room for at most 60 s. A rollback to the TS server would make polls silently do nothing.
