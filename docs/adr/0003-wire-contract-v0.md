# ADR 0003 — Wire contract v0

**Status:** accepted (2026-09-29) · [OME-4](/OME/issues/OME-4) · details in `packages/shared/README.md`

**Decisions:**
- `POST /rooms/:id/share` takes the **raw URL** (`{ url }`), not `{ provider, videoId }`. The server always runs `canonicalizeEmbed`, so it never trusts the extension's parsing.
- Every embed on the wire carries the **canonical** `url` (`https://www.youtube.com/embed/<id>`), and `EmbedSchema` rejects any other string. Clients may use only a parsed `Embed.url` as an iframe `src`.
- Client→server schemas are **strict** (unknown keys rejected). Server→client schemas **strip** unknown keys, so the server can add fields without breaking deployed clients.
- Frame caps are asymmetric: client→server 4 KB, server→client 16 KB (a worst-case 25-member snapshot is about 4.7 KB). Both are checked before `JSON.parse`.
- Nicknames and chat reject invisible, zero-width, bidi and control characters. Nicknames allow letters with combining marks; chat allows emoji, including ZWJ sequences.
- Playback state (ADR 0002) is **not** in v0. It will arrive in a later contract issue.

**Why:** the extension is the least-trusted component and the iframe is the biggest attack surface, so canonicalization happens server-side and the canonical form is checked again at every parse. Lenient server→client parsing keeps rolling deploys safe.

## M10 amendment: room GC policy exports (2026-10-11)

[OME-916](/OME/issues/OME-916), following [OME-904](/OME/issues/OME-904): remove
`ROOM_GC_NEVER_JOINED_MS`, `ROOM_GC_EMPTY_MS` and `ROOM_GC_SWEEP_MS` from
`@omega/shared`. This supersedes ADR 0028 §8's decision to export GC ages.
The server owns the single 20-minute idle threshold and the 60-second sweep;
clients react to `ROOM_CLOSED` / `room_not_found`, without enforcing timers.
See `packages/shared/README.md` and ADR 0028 §2 for the lifetime rule.

No web or extension code consumes these exports. The old server QA test imports
are replaced in PR #83 before this cleanup merges. Removing the unused shared
policy avoids competing sources of truth without adding a replacement client
API, a dependency or runtime work.
