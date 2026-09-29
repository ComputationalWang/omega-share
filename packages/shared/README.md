# @omega/shared — wire contract v0 (M1a)

Valibot schemas and types shared by the extension, the site and the server.
The Lead Engineer owns this package: to change it, open a contract issue.
Import from `@omega/shared`. Types are `v.InferOutput` of the schema with the same name.

## Rule: parse at the boundary

- Server, incoming WS frame: `parseClientMessage(raw)` → `ClientMessage | null`
- Client, incoming WS frame: `parseServerMessage(raw)` → `ServerMessage | null`
- HTTP bodies: `v.safeParse(ShareRequestSchema, body)` / `v.safeParse(ShareResponseSchema, json)`

Both parsers reject oversized frames (UTF-8 bytes, counted without allocating) before `JSON.parse`, and never throw. The limit is `MAX_CLIENT_MESSAGE_BYTES` for client→server and `MAX_SERVER_MESSAGE_BYTES` for server→client. The server should also set Bun's `maxPayloadLength` to the client limit.
Client→server schemas are **strict** (unknown keys are rejected). Server→client schemas strip unknown keys, so the server can add fields without breaking older clients.

## Constants

| Name | Value |
|---|---|
| `DEFAULT_ROOM_ID` | `"lobby"` |
| `SEAT_COUNT` | 8 (seat index 0–7) |
| `AVATAR_COUNT` | 4 (avatar 0–3) |
| `MAX_ROOM_MEMBERS` | 25 |
| `NICKNAME_MAX_LENGTH` | 20 |
| `CHAT_MAX_LENGTH` | 280 |
| `MAX_CLIENT_MESSAGE_BYTES` | 4096 |
| `MAX_SERVER_MESSAGE_BYTES` | 16384 |
| `MAX_URL_LENGTH` | 2048 |

## Embeds (provider allowlist)

`canonicalizeEmbed(url: string): Embed | null`. Pure, never throws. Accepts only:

- `youtube.com`, `www.`, `m.` → `/watch?v=ID` (exactly one `v`)
- `youtu.be/ID`
- `youtube.com/embed/ID`, `youtube-nocookie.com/embed/ID` (with or without `www.`)

Scheme must be `http`/`https` (the output is always `https`). No credentials, no explicit port. ID is `[A-Za-z0-9_-]{11}` and not a reserved slug (`videoseries`, `live_stream`). Anything else, such as other hosts, lookalike hosts, `javascript:`/`data:`, `/shorts/` or playlists, returns `null`.

`Embed = { provider: "youtube", videoId, url }`, where `url` is always `https://www.youtube.com/embed/<videoId>`. `EmbedSchema` checks this, so a parsed `Embed.url` is safe to use as an iframe `src`. Never build an iframe from any other string.

## Room state

```ts
Member    = { id: MemberId, nickname: Nickname, avatar: 0..3 }
RoomState = { id: RoomId, seats: (MemberId | null)[8], members: Member[≤25], embed: Embed | null }
```

- `RoomId`: `[a-z0-9-]{1,32}`. `MemberId`: `[A-Za-z0-9_-]{1,64}`, assigned by the server.
- `Nickname`: trimmed and NFC-normalized, 1–20 UTF-16 units of letters (combining marks allowed after a letter), digits and `_ . -`, with single spaces between words. No emoji, controls or invisible characters (including Hangul fillers).
- Invariants: member ids are unique, and every seat occupant is a member seated only once.

## HTTP: `POST /rooms/:id/share`

- Request `ShareRequest`: `{ url: string }` (≤ 2048). This is the raw URL; the server canonicalizes it.
- Response `ShareResponse`:
  - `{ ok: true, embed: Embed }`
  - `{ ok: false, error: { code, message } }`, where `code` ∈ `invalid_body | unsupported_url | room_not_found | rate_limited | payload_too_large`

On success, the server broadcasts `embed-changed` with `by: null`.

## WebSocket messages (discriminated on `type`)

### Client → server (`ClientMessage`)

| type | fields | notes |
|---|---|---|
| `join` | `nickname`, `avatar` | first message on the socket |
| `leave` | — | |
| `sit` | `seat: 0..7 \| null` | `null` = stand up |
| `chat` | `text` | trimmed, 1–280 chars; no control, zero-width, bidi, BOM or line-separator characters (ZWJ allowed for emoji); must contain a visible character |

### Server → client (`ServerMessage`)

| type | fields | notes |
|---|---|---|
| `snapshot` | `self: MemberId`, `room: RoomState` | reply to a successful `join` |
| `member-joined` | `member` | |
| `member-left` | `memberId` | |
| `seat-changed` | `memberId`, `seat: 0..7 \| null` | |
| `chat` | `memberId`, `text`, `at` (server ms epoch) | |
| `embed-changed` | `embed: Embed \| null`, `by: MemberId \| null` | |
| `room-full` | — | sent instead of `snapshot`; the server then closes |
| `error` | `code`, `message` (≤ 200) | `code` ∈ `bad_message \| not_joined \| already_joined \| seat_taken \| rate_limited` |

Playback sync (ADR 0002) is not part of v0; it arrives in a later contract issue.
