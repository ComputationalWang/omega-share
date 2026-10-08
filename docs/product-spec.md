# omega-share — product spec

## Concept
A Habbo-inspired isometric room on a website. People join a room, pick one of 4 avatars, sit in a seat and watch a show together. The show is an embed that someone shares from the page they're browsing, using the omega-share web extension.

## MVP scope (localhost)
- **One room**, 8 seats, 4 avatar designs (several people may pick the same one; each avatar shows its nickname tag). When the room is full, new arrivals see "Room full". Performance is tested for 25 people.
- **Identity**: nickname only, stored locally. No accounts.
- **Entering**: nickname + avatar → a one-time "Enter room" click. The click satisfies the browser's autoplay rules, so playback can start with sound.
- **Seats**: click a free seat to sit there. Walking/pathfinding comes later (UX phase).
- **Chat**: speech bubbles above avatars. Not saved.
- **Extension**: the popup scans the active tab for supported embeds, turns watch URLs into embed URLs (e.g. `youtube.com/watch?v=X` → `youtube.com/embed/X`), lists them, and the user picks one and a room (a dropdown; only one room for now). The extension POSTs `/rooms/:id/share` to the configured server base URL, which is `http://localhost:<port>` for now and the ngrok/hosted URL later. No content scripts run until the popup is opened, and there is no persistent background worker.
- **Providers** (ADR 0024): two tiers. **Synced**: YouTube (M1b), then Twitch and Vimeo (M2); everyone's play/pause/seek is shared. **Generic** (M4): any other `https:` embed that passes the shared URL validation (no IP literals, private hosts, userinfo or non-https schemes). It is **not synced**: each viewer clicks Load on a card ("Video from host · not synced"), then plays it on their own in a locked-down sandboxed iframe. The server can turn the generic tier off (`GENERIC_EMBEDS=off`) and keeps a host denylist.

## Synced playback (M1b+)
- One embed per room. Play/pause/seek are **shared**: anyone's action applies to everyone. **Volume/mute is per user.**
- The server is authoritative, and the last action to reach it wins. It broadcasts `{playing, position, rate, serverTimestamp, actor}`. Each client works out where the video should be now: drift > ~1 s → seek; smaller drift → a slight playback-rate nudge. People who join late start at the room's current position. The chat shows who paused or skipped.
- The room never waits for a user who is buffering or seeing an ad. They catch up when their player is ready.
- Twitch live streams: only pause/play-from-live is shared (a live stream can't be seeked).

## Persistence
Everything lives in the server's memory until M4 (then SQLite).

## Milestones (you, the board, sign off at each one)
| | Scope |
|---|---|
| **M1a** | Extension finds the embed → site → room shows it, with avatars, seats and chat (localhost, multiple browser contexts) |
| **M1b** | YouTube synced controls |
| **M2** | ngrok tunnel; Twitch + Vimeo sync |
| **M3** | Safety hardening (rate limits, input sanitization, CSP, abuse cases) |
| **M4** | Hosting + SQLite; customizable rooms begin |
| **M5** | Prettify / UX polish (walking, animations, room customization UI) |
| **M6** | Public beta: owner moderation (kick, mute, who controls playback), a playback queue, a 20-room load test and metrics on the hosted box, a Chrome Web Store–ready extension |

Design (avatars, room, furniture) runs alongside from M1a, and engineering uses placeholder shapes until approved sprites land.
