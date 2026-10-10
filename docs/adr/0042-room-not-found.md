# 0042 — "Room not found": one screen for every room you can't get into

- Status: accepted (2026-10-10, Lead Engineer, [OME-768](/OME/issues/OME-768))
- Amends: ADR 0028 §"join.inviteKey" (what the page shows), ADR 0033 §6 (what a later visit to a taken-down id shows)

## Context

M9 W2 asks for a clear "Room not found" screen for an unknown or taken-down `/r/<id>`, one that never reveals whether a
private room exists. Before this:

- An unknown or deleted id was refused at the upgrade with HTTP 404. A browser `WebSocket` can't read that status, so the
  page saw a bare 1006 and retried for ever ("Connection lost, reconnecting…").
- A keyless visit to a private room showed "This room is private", which tells a stranger that the room exists.
- A later visit to a taken-down id showed "This room was closed by the omega-share team after a report".

## Decision

1. **Server:** an upgrade to any well-formed room id that isn't live goes to an unregistered stand-in, like a taken-down
   id already did (ADR 0033 §6). `open` closes it with 4004 (`ROOM_CLOSED`), or 4006 for a taken-down id, before any
   snapshot. A plain request with no WebSocket handshake still gets the 404. The upgrade limiter still runs before the
   lookup (threat model S5), so probing ids costs the same as before.
2. **Page:** a room this page never got into (no snapshot yet) that answers 4004, 4006 or `invite_required` gets the
   `not-found` status and one screen: "This room doesn't exist or was taken down", "Go home", and the open rooms
   (`GET /rooms`). The words are the same for all four cases, and no notice says "private". A room you were in that
   closes, or is taken down, still shows its own card ("This room was closed…").
3. The `invite_required` error code and the server's private-room check are unchanged (ADR 0028). The wire still differs
   (an error frame after `join` versus a close at `open`), so the non-disclosure is in the page, not the protocol. A
   stranger needs the 128-bit id to probe at all, which the threat model already accepts.

## Consequences

- A visitor who has a private room's link without its `#k=` key sees "Room not found". The screen tells them to ask for
  the link again, exactly as it was sent.
- Each probe of an unknown id costs one short-lived socket instead of an HTTP 404. The per-IP upgrade bucket and the
  connection caps bound that.
- Reversing this means restoring the private-room refusal card and the 404 at the upgrade. Both are small and local.
