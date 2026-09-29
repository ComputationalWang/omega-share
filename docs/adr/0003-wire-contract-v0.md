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
