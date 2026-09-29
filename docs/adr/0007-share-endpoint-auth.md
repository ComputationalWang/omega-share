# ADR 0007 — Share endpoint is unauthenticated in M1a

**Status:** accepted (2026-09-29) · [OME-5](/OME/issues/OME-5), QA finding in [OME-22](/OME/issues/OME-22) · revisit before M3 safety work

**Decision:** `POST /rooms/:id/share` requires no member token in M1a. Any caller can change the room's video:
- browsers, only from the site or an extension origin (Origin check + CORS);
- non-browser clients (no `Origin`), such as curl.

Abuse is limited by:
- the provider allowlist, re-checked server-side (ADR 0003), so only a canonical YouTube embed can ever be set;
- a per-address rate limit (burst 5, then one per 3 s);
- `embed-changed` with `by: null`, which marks the change as coming from outside the room.

**Why:** the M1a flow is "share from the extension into the room". The extension has no room session to prove membership with, and adding one (a short-lived share token bound to a joined member) touches the contract, extension and site. The damage a stranger can do today is to switch the lobby to another allowlisted YouTube video, which is annoying but not unsafe.

**Revisit when:** there are multiple or private rooms, a public deploy, or moderation (M3). The likely fix is a member-bound share token issued in the `snapshot`, which is a contract change.
