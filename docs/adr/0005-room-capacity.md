# ADR 0005 — Room capacity: 8 seats, 25 members

**Status:** accepted (2026-09-29) · [OME-5](/OME/issues/OME-5) · contract constants in `packages/shared` (ADR 0003)

**Decision:**
- A room holds up to **`MAX_ROOM_MEMBERS` = 25 members** and has **`SEAT_COUNT` = 8 seats**. Seats and membership are separate.
- Everyone joins **standing**. `sit` takes a free seat, `sit: null` stands up, and sitting on another seat moves you. A seat taken by someone else gets `error seat_taken`. Members who are not seated stand and spectate: they see the video, appear in the room and can chat.
- The **26th** `join` gets `room-full` instead of a `snapshot`, and the server closes the socket (1008). This is the product spec's "Room full". Only joined members count toward the cap. Sockets that have not joined are bounded separately: a join timeout (10 s) and a per-address socket cap (50); see `apps/server/README.md`.
- Leaving (`leave`, or the socket closing) frees the member's seat and sends `member-left`. Clients clear that member's seat when they get `member-left`. No separate `seat-changed` is sent.

**Why:** the spec asks for 8 seats, "Room full" for new arrivals, and budgets measured with 25 people. If the cap were 8 people, the 25-person load test would be impossible. Letting 25 in with only 8 seated matches the Habbo-style "room with some chairs" feel and keeps the perf target meaningful.

**Consequences:** the site must render up to 25 avatars (17 standing), and the 60 fps budget applies to that case. QA's load test uses 25 members. Raising either number is a contract change.
