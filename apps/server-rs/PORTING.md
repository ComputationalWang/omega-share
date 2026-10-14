# Porting apps/server to Rust

How `apps/server-rs` is built. Read it before you touch the crate. The decision and its gates are in [ADR 0050](../../docs/adr/0050-rust-server.md); the tracking issue is OME-1141.

The TS server in `apps/server` is the reference. It is **frozen**: no feature work lands there until the switch. When the two disagree, the TS behaviour wins, unless a row in [Deliberate differences](#deliberate-differences) says otherwise.

## Commands

```sh
export CARGO_TARGET_DIR=$HOME/.cache/omega-share/cargo-target-<OME-key>  # one build dir per worktree
export CARGO_BUILD_JOBS=4                                               # leave the machine usable
bun run check:rs   # fmt --check, clippy -D warnings, tests, cargo-deny: the Rust half of `bun run check`
cargo test -p omega-server <filter>
cargo run -p omega-server -- serve   # env as in apps/server (PORT, DB_PATH, SITE_ORIGIN, ...)
```

Never share a target dir between worktrees: integration tests run `target/debug/omega-server`, so a shared dir can test another worktree's build. Keep parallel Cargo builds on the dev machine to what its cores can carry (16 cores: four builds at 4 jobs each).

Integration tests (`tests/*.rs`) are separate crates: helper functions there need `#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic, reason = "…")]` at the top, since clippy's in-test allowances only cover `#[test]` functions.

## Module map

| TS (`apps/server/src`, `packages/shared/src`) | Rust (`apps/server-rs/src`) | Slice |
|---|---|---|
| `config.ts` | `config.rs` | S1 ✓ |
| `index.ts` | `main.rs`, `serve.rs` | S1 ✓ (grows in S5–S7) |
| `rate-limit.ts` `Clock`, `monotonic`, `wallNow`, `schedule` | `clock.rs` | S1 ✓ |
| `packages/shared/src/*` (server-used parts) | `contract/*` | S2 |
| `store/db.ts`, `store/rooms.ts`, `store/reports.ts`, `migrations/*.sql` | `store/*` (migrations embedded with `include_str!` from `apps/server/migrations`) | S3 ✓ |
| `room.ts`, `rooms.ts`, `playback.ts`, `queue.ts`, `rate-limit.ts`, `secrets.ts`, `embed-policy.ts`, `presets.ts`, `log.ts`, `headers.ts` | same names, `snake_case.rs` | S4 |
| `http.ts`, `static.ts`, `site-meta.ts`, `server.ts` (routing, Host/Origin gate) | `http/*` | S5 |
| `ws.ts`, `ws-sessions.ts`, `ws-limits.ts`, `ws-owner-edits.ts` | `ws/*` | S6 |
| `rooms-gc.ts`, `reports.ts`, `admin.ts`, `cli.ts`, `metrics.ts`, `scripts/backup.ts`, graceful restart | same names; `omega-server admin …`, `omega-server backup …` | S7 |
| `test/helpers.ts` (black-box mode), test hooks | `test_hooks.rs` (feature `test-hooks`) | S8 |
| `relay-latency.ts` + the load comparison | `perf/server-compare.ts` (TS, external, runs any server command; replaces the planned `src/bin/omega-load.rs`) | S9 |

Not ported: `activity`, `discord-upstream` and `extension-bridge` from shared (the server doesn't use them). `parseServerMessage` only matters to the load generator.

## Rules

1. **No panics on any path input can reach.** `unwrap`, `expect`, `panic!`, `todo!`, `unreachable!`, unchecked indexing and string slicing are denied by clippy (`Cargo.toml` workspace lints; tests may use them). Use `get`, `?`, `let … else`. Arithmetic on input-derived numbers is `checked_`/`saturating_`.
2. **No `unsafe`** (`forbid`).
3. **Parse at the boundary, once.** Bytes from a socket, an HTTP body, a header, a URL, a SQLite row or an env var become a domain type in one `parse` step; nothing past it holds unchecked input. The shape:
   - `serde` deserializes into a *wire* struct (`#[serde(deny_unknown_fields)]` where the TS schema is `strictObject`, default where it is `object`).
   - Every struct- or tagged-enum-typed field is a `contract::Obj<_>` (and `parse_json` reads the top level through one): serde's derive otherwise also accepts a struct's *array form* (`["tv",0,0,"se"]` as a furniture piece), which Valibot refuses. `Vec<Obj<Piece>>`, `Option<Obj<Embed>>`, and so on.
   - `validator` (`#[derive(Validate)]`) checks field rules. JS-semantics rules are custom functions from `contract/js_compat.rs` (`utf16_len`, `js_trim`, `is_js_whitespace`, ...), never the crate's built-in `length` (it counts `char`s, Valibot counts UTF-16 units).
   - `TryFrom<Wire>` builds the domain type (newtypes such as `RoomId`, `MemberId`, `Nickname`) whose constructor is the only way to get one.
   - Oversized input is refused **before** parsing (frame and body caps from `contract/constants.rs`).
4. **Pure core, IO at the edges.** S4's room logic is plain structs and functions with no tokio and no clock reads: time comes in as an argument (`now_mono: f64`, `now_wall: i64`). Only S5–S7 hold the `SharedClock`. That keeps the core unit-testable and lets the `test-hooks` build swap time.
5. **Never block the runtime for long, never hold a lock across `.await`.** SQLite calls are short synchronous calls under the store mutex (see [Runtime architecture](#runtime-architecture-s4s7)); nothing slow happens under a room lock.
6. **Serialize once per broadcast.** A room message is encoded to one `Utf8Bytes` and cloned (refcount) to every member's send queue. Send queues are bounded; a member who can't keep up is closed (the TS server's backpressure close), never buffered without limit.
7. **Output field order = the TS object literal's order**, optional keys omitted with `skip_serializing_if` (the TS server never sends `undefined`; `null` only where the TS code writes `null`). Clients parse JSON, so float formatting may differ (`1.0` vs `1`), key presence may not.
8. **Logging = `log.rs`**: one JSON line per error on stderr, a fixed event name, the message cut at its first quote and scrubbed of IPs and emails (port of `log.ts`). Never log a room id, title, nickname, token or address.
9. **Secrets**: tokens from the OS CSPRNG (`getrandom`), hashed exactly as `secrets.ts` does so stored hashes still verify, compared in constant time (`subtle`).
10. **Every new dependency** needs a line in the PR: why, licence (cargo-deny enforces the allow list in `deny.toml`), and that the std or an existing crate can't do it.
11. **TDD**: the commit with the failing tests comes before the implementation commit (CLAUDE.md, `/mattpocock-skills:tdd`). Port each TS test case for the module as a Rust test, with a `// apps/server/test/<file>.test.ts:<line>` comment, and keep its intent and its expected values.

## Runtime architecture (S4–S7)

The TS server is single-threaded: every handler runs to completion, so a room's state changes and the frames it sends are totally ordered. The port keeps that order per room and runs rooms in parallel.

- **One `Arc<App>`**, built at boot: config, `SharedClock`, `EmbedPolicy`, security headers, `Metrics` (atomics), the store, the room registry, reports, connection counters, limiters. Handlers take `&App`.
- **Registry**: `RwLock<HashMap<RoomId, Arc<RoomCell>>>` (std). Readers hold it only to clone the `Arc`.
- **`RoomCell`**: a `std::sync::Mutex<RoomInner>` with `RoomInner { room: Room /* S4's pure core */, subscribers: … }`. A room's WebSocket messages and HTTP mutations are handled **synchronously under its lock**: parse outside, lock, mutate, write the store if the TS code does, publish, unlock. No `.await` inside. A poisoned lock is recovered (`into_inner`), never `unwrap`ped.
- **Lock order**: registry → room → store. Never take the registry's write lock while holding a room lock: collect what to do, release, then act.
- **Publishing**: Bun has two: `server.publish(topic, …)` reaches every subscriber, `ws.publish(topic, …)` every subscriber *except the sender*. Keep both (`publish_all`, `publish_except`) and use whichever the TS line uses. A frame is serialized once (`Utf8Bytes`) and cloned into each subscriber's bounded queue with `try_send`; no subscriber can slow the others.
- **Backpressure** (`BACKPRESSURE_LIMIT` 256 KiB, `closeOnBackpressureLimit` in ws.ts): count queued bytes per connection; past the limit the connection is dropped without a close frame (the client sees 1006, as with Bun).
- **Connection task**: axum `WebSocketUpgrade` with `max_message_size(MAX_CLIENT_MESSAGE_BYTES)` (an oversize frame drops the connection: 1006, as Bun). A writer task drains the queue to the socket; the reader parses each text frame once and calls the synchronous handler. Idle timeout 60 s with server pings (`IDLE_TIMEOUT_S`, `sendPings`). Binary frames count as bad messages, as in ws.ts.
- **Timers** (join timeout, `member-status` coalescing, grace holds, seat holds, room GC) are tasks awaiting `clock.sleep(ms)` that then re-take the room lock and **re-check** that what they were armed for still exists. The `test-hooks` build swaps in a virtual clock.
- **Store**: `std::sync::Mutex<rusqlite::Connection>`, WAL and the same pragmas as `store/db.ts`. Calls are short and synchronous, made exactly where the TS code writes synchronously (under the room lock when it does), so failure handling (refunds, `unavailable`) stays identical. The relay path (chat, control, presence, status, ping) never touches it.
- **HTTP**: axum `Router`. The Host/Origin gate and the in-flight cap are a layer before routing; body caps apply while reading, never after buffering; hyper's header-read timeout is set (slowloris), since the drain deadline only bounds shutdown.
- **Shutdown** (`index.ts`, ADR 0032): stop accepting, close every socket with `SERVICE_RESTART`, wait at most `DRAIN_GRACE`, save seat holds, `wal_checkpoint(TRUNCATE)`, exit 0.
- **Performance**: no allocation per subscriber per frame beyond the refcount clone; no JSON re-parse of our own output; `HashMap`s keyed by the newtypes; no `format!` on the relay path except the one serialization.

## Contract hazards (S2)

Full spec from the contract inventory, ranked by risk:

1. **WHATWG URL `href` parity.** Embeds are canonicalised by `new URL()` (Bun) and stored; `AnyEmbedSchema` re-checks `url === canonical(url)` when rows load, and a bad room row fails the boot (`apps/server/test/persistence.test.ts:134`). Use the `url` crate (WHATWG) and build a golden corpus from the TS canonicalisers.
2. **JS `trim` / `\s`**: includes U+FEFF, excludes U+0085 (`js_compat::is_js_whitespace`).
3. **Unicode version drift**: NFKC/NFC/NFD (`unicode-normalization`), `\p{L}`/`\p{M}`/`\p{Script=…}` (`regex`), `to_lowercase`, against Bun's ICU. Nickname keys are persisted as SHA-256 in seat holds, so a drift breaks resume after a restart. Golden corpus from the TS side.
4. **UTF-16 `.length`** for every `minLength`/`maxLength` (nickname 20, title 32, chat 280, note 300 and the raw 600, URLs 128/1024/2048).
5. **Lookarounds** the `regex` crate lacks: the chat ZWJ rule, the DNS label rule `^(?!-)[a-z0-9-]{1,63}(?<!-)$`: hand-code them.
6. **`\d`/`\w` are Unicode in Rust `regex`**: write `[0-9]`, `[A-Za-z0-9_]`.
7. **`toLowerCase` on decoded query params** (Twitch channel: U+212A KELVIN SIGN lowercases to `k`). Decode like `URLSearchParams` (`+` is space, lossy UTF-8), then `to_lowercase`.
8. **Confusables** (`nicknameKey`): port the table from `confusables-table.ts` as data (`include_str!` of a generated file), same Unicode 18.0.0 source.

9. **Outbound bytes** (`contract/{state,server_message,responses}.rs`). `encode`/`to_body` write the key order of the TS server's object literals, not the schema's (`Member`: `id, nickname, avatar, standingSlot, catching, muted, away`). `Position`/`Rate` are written by `js_number_string`, a port of `Number.prototype.toString` (`3`, `-0` as `0`, `5e-7`, `1.5e+21`; corpus-checked), so the bytes equal `JSON.stringify`'s, including client-controlled positions the room echoes. `encode`/`to_body` return `Result` (`EncodeError`, fixed text): a failure is logged and skipped, never an empty frame. `playback` is `Option<Option<_>>` (absent / `null` / state) so a parsed message re-encodes to what it was; senders use `RoomState::new` / `ServerMessage::embed_changed`, which always write `null` or a state. The `Deserialize` side exists for tests and the load generator; the corpora there run the other way round (`*-roundtrip`: TS-built bytes must re-encode identically; `*-raw`: Rust refuses/strips what Valibot does).

Schemas, field orders and constants: read the TS source (`packages/shared/src`), it is short. The server sends what it builds with object literals; mirror those literals.

## Rollback interop (S3)

For 7 days after the switch the TS server may be put back on the Rust server's database file. `interop/spec.json` (from `interop/spec.ts`) is replayed through both servers' stores; `interop/dump.json` is what the TS stores read back (raw rows, schema SQL and typed listings). `tests/store_interop.rs` must read the same from the TS-written file and write a file that dumps the same; `interop/interop.test.ts` (in `bun run test`) has the TS stores read the committed `rust-written.db`. Regenerate the TS half with `bun apps/server-rs/interop/gen.ts`, the Rust files (`rust-written.db`, `rust-mixed.db`, written atomically by one test) with `UPDATE_INTEROP=1 cargo test -p omega-server --test store_interop`. The Rust binary embeds the TS migration files, so it never runs a migration the TS server does not know (a test compares the directory with the embedded list).

## The comparison test

Every ported schema or contract function gets a corpus: inputs that the TS side decides (accepted with an output, or refused) and the Rust side must decide the same way.

1. Add a corpus to `corpus/corpora.ts`: a name and `cases()`, using `decided(inputs, tsFunction)` for a function, or `v.safeParse(Schema, input)` for a schema (record the parsed output on success). Cover the edges: limits ±1 in UTF-16 units, emoji and astral characters, U+FEFF and U+0085, NFKC-changing input, unknown keys on `object` vs `strictObject`, nulls and absent keys, wrong types, every literal and picklist value.
2. `bun apps/server-rs/corpus/gen.ts` writes `corpus/out/<name>.json`, one case per line. Commit it.
3. Add a test in `tests/corpus.rs` that loads the file with `include_str!` and runs `agree(...)` with the Rust function, and register the name in `RUNNERS` (a file without a runner fails the suite).

For anything the server reads as JSON text (WebSocket frames, HTTP bodies, stored rows), also add a **raw** corpus with `decidedRaw`: inputs are JSON *text*, so it can hold what `JSON.stringify` never writes (`-0`, `1.0`, `1e2`, duplicate keys, an object's array form, lone surrogate escapes). Mark the deliberate differences `rustRefuses: true`; the harness then requires Rust to refuse them whatever TS decided.

`corpus/corpus.test.ts` (in `bun run test`) fails when a recorded file no longer matches what the TS contract decides, so a `packages/shared` change can't land without regenerating, and regenerating can't land without the Rust side agreeing.

## Deliberate differences

Rust differs from the TS server in a few places that no real client reaches (all but log scrubbing are stricter than Valibot). The comparison test lists them as expected disagreements:

| Input | TS | Rust |
|---|---|---|
| Duplicate JSON keys | last one wins | rejected |
| Integers written `1.0`, `1e2` or `-0` | accepted | rejected (`JSON.stringify` never writes them) |
| Lone surrogates in text (`"\ud800"`) | accepted | rejected |
| Request body that is not valid UTF-8 (`parse_*_request` take bytes) | decoded lossily (`Buffer.toString("utf8")`, `rate-limit.ts:152`), may be accepted | rejected |
| Log scrubbing (`log.rs`) | cuts at the first `"` or `'` | also cuts at the first backtick, because serde errors quote input with backticks |

Anything else that differs is a bug, unless ADR 0050 is amended.

## The black-box suite (S8)

The TS tests in `apps/server/test` are the referee. Of 766 tests:

- **265 run as they are** against the Rust binary (only `start()` options that map to env vars).
- **93 need virtual time**: the fake `now`/`wallNow`/`schedule`. In black-box mode the helper's clock writes go to `POST /__test/time {mono, wall}`, which sets the virtual clock and fires due timers; `GET /__test/time` returns the pending-timer count. Tests change `clock.ms = x` into `await clock.set(x)` (mechanical edits, assertions unchanged).
- **73 need a DB fixture**: the test seeds or inspects a SQLite file the binary opens via `DB_PATH` (WAL, so reads work while it runs).
- **223 reach into internals** (spies, `registry`, pure units): they become Rust unit tests in the slice that ports the module.
- **112 test shell scripts** (deploy kit, monitor, tunnel, backup): not server code, they stay.

Hooks exist only with `--features test-hooks`; CI checks the release binary has none of them (`strings` on `/__test/`).

Behaviour the suite pins that a separate process must keep: an oversized WS frame closes with **1006**; a raw chunked POST over 4 KB gets `HTTP/1.1 413 Payload Too Large` with a `payload_too_large` body; a corrupt room row fails boot naming the room; a clean SIGTERM exits 0 with nothing on stderr; upgrade refusals (421, 403, 404, 429, 503) are plain HTTP responses before the 101; header names are lowercase.
