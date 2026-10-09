# ADR 0030 — Owner moderation: kick, mute and who controls playback

**Status:** accepted (2026-10-09) · Lead · [OME-502](/OME/issues/OME-502) · plan [OME-499](/OME/issues/OME-499#document-plan) · amends [ADR 0028](0028-room-ownership-and-private-rooms.md) §3 ("Share, seek, mute and kick don't depend on ownership") · keeps ADR 0028 §7 (no personal data persisted for abuse controls) · close codes from [ADR 0016](0016-m3-limits-names-and-close-codes.md)

**Context:** M6 is a public beta. A room owner needs to deal with one disruptive person without deleting the room: remove them, silence their chat, or take playback control away from the room. Today only `layout-set`, `title-set` and `DELETE` need the owner token, and anyone in the room can play, pause, seek or share. This ADR records the `packages/shared` contract (C1). The server (S1 [OME-505](/OME/issues/OME-505)) and the site (W1 [OME-507](/OME/issues/OME-507)) build on it.

## Decision

### 1. Three owner frames, checked before any write
- Client → server, all `strictObject` (unknown keys fail the parse, `bad_message`, count toward 4400): `kick { memberId }`, `mute { memberId, muted }`, `control-policy { policy: "everyone" | "owner" }`. `memberId` is `MemberIdSchema` (1–64 of `[A-Za-z0-9_-]`).
- Each needs `join` with a matching owner token (ADR 0028 §3; `ws.data.owner`). The server checks in this order, and **writes, stores or broadcasts nothing until every check has passed**:
  1. joined, else `not_joined`;
  2. owner, else `not_owner` (counts toward 4400, as for `layout-set`);
  3. the owner socket's moderation bucket, `MODERATION_BURST` = 5 at once, then one every `MODERATION_REFILL_MS` = 1 s, else `rate_limited` + `retryAfterMs`. It's separate from the edit bucket so an owner can clear a small raid quickly;
  4. for `kick` and `mute`, the target: a member of this room who isn't the sender and didn't join with the owner token, else `bad_target`. A race with someone leaving is normal, so `bad_target` doesn't count toward 4400.
- Setting the current policy, muting a muted member or unmuting an unmuted one is a no-op: no broadcast.

### 2. Kick
- The target's socket is closed with **`CLOSE_CODES.KICKED` = 4005**, the next free code after `ROOM_CLOSED` (4004); 4029 and 4400 are taken too. No frame comes before the close. The client shows a plain-text notice and **doesn't reconnect**. Leaving revokes the target's share token as usual.
- Everyone else gets `member-left { memberId, reason: "kicked" }`. `reason` is new and optional: `left` for every other departure, absent from pre-M6 servers (read as `left`). The issue called this frame `member-removed`; the existing `member-left` gains the field instead, so old clients keep working.
- **Rejoin cooldown:** for `KICK_COOLDOWN_MS` = 10 min, a `join` to that room from the kicked socket's client address (the same key as every other abuse bucket, ADR 0028 §7) is closed with 4005 before any snapshot. A join with the room's owner token isn't, so an owner behind the same address can't lock themselves out. If the target socket had no usable address (`keyed` false), the kick still closes it, but there's no cooldown.
- The cooldown is an **in-memory map per room, keyed by client address**. A restart clears it, and nothing about who was kicked is written to disk, logged or put in metrics. Shared addresses (a household, a campus NAT) are kept out together for 10 minutes. We accept that for a short cooldown; a longer ban would need the break-glass design in ADR 0028 §7 and its own ADR.

### 3. Mute
- `mute` sets the target's `muted` flag. Everyone gets `member-muted { memberId, muted }`, and room state carries `muted` on each member (absent means false, also from pre-M6 servers). A late joiner learns it from the snapshot.
- A muted member's `chat` is dropped and answered with `error: muted` (not counted toward 4400). Mute covers chat only: emotes, sitting and walking stay, under their own limits.
- To stop a reconnect from lifting it, the server remembers a muted member's client address in that room, **in memory**, for `MUTE_MEMORY_MS` = 10 min after they leave. A join from that address starts muted (`member-joined` carries `muted: true`). Unmuting clears it. The same shared-address caveat and the same no-disk rule as §2 apply.

### 4. Control policy
- `controlPolicy` in room state: `everyone` (today's behaviour) or `owner`. It's absent from pre-M6 servers, so read it as `DEFAULT_CONTROL_POLICY`. Changes are broadcast as `control-policy-changed { policy, by }`.
- **Open board default: `everyone`** for new and seeded rooms (plan [OME-499](/OME/issues/OME-499#document-plan) "open questions"). Owner-only would be safer for public rooms, but it changes how the product feels. If the board picks `owner`, only `DEFAULT_CONTROL_POLICY` and the create path change. The wire stays the same.
- Under `owner`, only owner-authenticated sockets may change playback:
  - `control` from anyone else gets `error: control_owner_only` (not counted toward 4400), and nothing is written;
  - `POST /rooms/:id/share` with a non-owner's share token gets HTTP 403 `control_owner_only` (`SHARE_ERROR_CODES`). The share token is bound to a member, so the server knows whether that member is the owner. Pre-M6 extensions don't know the code and show their generic share error;
  - the C2 queue frames ([OME-503](/OME/issues/OME-503), ADR 0031) follow the same policy.
  
  `status` (catching up) is advisory and stays open to everyone. If the owner leaves, nobody can change playback until they come back. They can switch the policy back to `everyone` at any time.
- The policy is room configuration, not personal data, so it's **persisted with the room** like the title. S1 adds the column in the next free migration. Seeded rooms have no owner and stay `everyone`.

### 5. What it costs
- Wire: two optional fields and three small server frames, all sent rarely. Moderation adds no per-frame work. Room-state size grows by at most `"muted":true` × 25 members plus one policy string, well under `MAX_SERVER_MESSAGE_BYTES`.
- The server's cooldown and mute maps hold at most a few entries per room, and each entry is dropped once it expires.

## Consequences
- Pre-M6 sites drop `member-muted` and `control-policy-changed` (`parseServerMessage` returns null for an unknown `type`) and ignore the new optional fields. Old servers never send them.
- `bad_message` until S1 lands: on `main` before S1, the server answers owner frames with `bad_message` and non-owners with `not_owner`. It writes nothing.
- A kicked person who changes networks can come back at once. This is a social tool for a room owner, not a ban. Lasting bans stay designed-but-unbuilt (ADR 0028 §7).
