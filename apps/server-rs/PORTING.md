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
| `server.ts` (`startServer` state, `loadRooms`, `titleBlocker`), `index.ts` (database open, seat holds) | `app.rs` | S4d |
| `rooms.ts`, the `perRoom` maps | `registry.rs` (`Registry`, `RoomCell`, `RoomInner`) | S4d |
| `ws.ts` publish and backpressure | `outbox.rs` | S4d |
| `queue.ts`, `reports.ts`, `rooms-gc.ts`, `ws-owner-edits.ts` | `queue.rs`, `reports.rs`, `rooms_gc.rs`, `owner_edits.rs` | S4d |
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
8. **Logging = `log.rs`**: one JSON line per error on stderr, a fixed event name (`LogEvent`: the `store.*` and `gc.*` names of log.ts, `shutdown`, and `ws.encode` for a server message that failed to serialize, which TS cannot do), the message cut at its first quote and scrubbed of IPs and emails (port of `log.ts`). Never log a room id, title, nickname, token or address.
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

### The app core (S4d)

`App::boot(config, clock)` opens the one database, loads the rooms and applies the seat holds; `serve` does it before binding and starts `spawn_room_gc`. Handlers take `&App` and work on a room through `registry.get(&id)`, `cell.lock()` and a `&mut RoomInner`; the domain functions (`queue::add`, `owner_edits::set_title`, `reports::file`, `outbox::publish_msg`, ...) take `(&App, &mut RoomInner, ...)` and are synchronous. A room that is removed (`App::remove_room`, GC, takedown) is unlinked from the registry and marked `RoomInner::closed` under its lock (a handler that fetched the cell earlier must refuse), then its sockets get a close frame, its grants are revoked and its row is deleted, in that order. A per-room map that TS keeps via `perRoom` is a field of `RoomInner`, so it cannot outlive the room. Subscriber queues are bounded `try_send` channels (`outbox.rs`): a subscriber past `BACKPRESSURE_LIMIT` is dropped from the room and its writer ends the connection without a close frame.

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

## HTTP (S5)

`http::router` is one fallback handler that matches (method, decoded path) the way Hono did (`/rooms/:id/...` routes, then the built site, then a plain `404 Not Found`); a wrong method is a 404, never a 405. `http::wrap` is the layer around the merged router (S6's `/rooms/:id/ws` included) and does, in the TS order: resolve the path (`http/path.rs`: Bun's URL parser removes `.`/`..` segments, `%2e` included, and turns `\` into `/`; Hono then `decodeURI`s the rest, keeping `%25` and reserved escapes), refuse a Host that is not ours (421) or an Origin that is not allowed (403), derive the client key (`ipOf`), skip the HTTP limits for a `/rooms/<id>/ws` path, else apply the per-key bucket (429, loopback keys skip it) and the in-flight cap (`MAX_HTTP_IN_FLIGHT`, 503), then set the security headers on every response and HSTS for the https public host. `http/server.rs` is the accept loop: hyper HTTP/1 with a 10 s header-read timeout (slowloris; Bun's `idleTimeout` in TS) and graceful shutdown; request bodies are read under their cap while they arrive, with a 10 s stall timeout between frames (`http/body.rs`). `GET /healthz`, `/rooms` and the site serve from `rooms.rs`/`site.rs`; the `apps/server/public` icons are compiled in.

Corpora: `site-meta`, `with-meta`, `security-txt` (site-meta.ts), `url-pathname` and `route-path` (the URL parser and Hono's `getPath`, 5 866 paths each), `mime-type` (Hono's `getMimeType`).

## Deliberate differences

Rust differs from the TS server in a few places that no real client reaches (all but log scrubbing are stricter than Valibot). The comparison test lists them as expected disagreements:

| Input | TS | Rust |
|---|---|---|
| Duplicate JSON keys | last one wins | rejected |
| Integers written `1.0`, `1e2` or `-0` | accepted | rejected (`JSON.stringify` never writes them) |
| Lone surrogates in text (`"\ud800"`) | accepted | rejected |
| Request body that is not valid UTF-8 (`parse_*_request` take bytes) | decoded lossily (`Buffer.toString("utf8")`, `rate-limit.ts:152`), may be accepted | rejected |
| Log scrubbing (`log.rs`) | cuts at the first `"` or `'` | also cuts at the first backtick, because serde errors quote input with backticks |
| A client that stops reading (WebSocket) | Bun closes it at `BACKPRESSURE_LIMIT` | same (the connection task watches the outbox's death signal, the writer is aborted, no close frame); and every socket write, and the wait for a client's answer to our close, is also bounded (10 s, 1 s) |
| Idle sockets (WebSocket) | Bun's `idleTimeout` 60 s with `sendPings` | pings every 30 s on real time; any received frame (pong included) resets the 60 s |
| Socket timers (join timeout, `member-status` interval) | `setTimeout` (real time) | real time too; only the hold expiry follows the app clock (`schedule` in TS). The status interval is measured on the process's own monotonic clock |
| `pong` and `chat` `at` | `Date.now()` (not the injected `wallNow`) | the system clock, not the virtual one |
| Config knobs `MAX_CONNECTIONS_PER_IP`, `JOIN_TIMEOUT_MS`, `STATUS_INTERVAL_MS` | `startServer` options only | also environment variables (the black-box harness maps the options onto them) |
| HTTP: a static file that is a symlink out of `STATIC_DIR` | served (`Bun.file` follows it) | 404: the real path must stay under the root |
| HTTP: `content-disposition: filename=...` on a served file whose type Bun does not know (`.webmanifest`, no extension) | sent by Bun | not sent (nothing reads it) |
| HTTP: `HEAD` | Bun answers `content-length: 0` | the length of the GET body, as hyper does |
| HTTP: a request body that takes over 30 s in all (a client trickling a byte per stall timeout) | read until Bun's idle timeout, which a trickle never trips | refused (400 as a body that is not JSON) and the in-flight slot freed: stricter than Bun, closes a flood hole |
| HTTP: a static path with a dot segment (`.env`, `.git/...`, `assets/.x`) | served if the file exists | 404; only the explicit `/.well-known/security.txt` route serves a dot path: safety over parity |
| `PUBLIC_ORIGIN=http://...` | `startServer` accepts it in a test (`parseConfig` refuses it) | the config refuses it, as `parseConfig` does: `boundary.test.ts` "no HSTS ... plain-http one" cannot run against the binary |
| HTTP request body with invalid UTF-8 | decoded lossily, then `JSON.parse` | the same (`String::from_utf8_lossy`): the route decodes first, so the `parse_*_request` row above does not apply to HTTP |

Anything else that differs is a bug, unless ADR 0050 is amended.

## The black-box suite (S8)

The TS tests in `apps/server/test` are the referee. `bun run blackbox` (also the last step of `check:rs`, about 20 s on a warm cache) builds the binary with `--features test-hooks`, runs the suite against it with `OMEGA_SERVER_BIN`, and fails if a test listed in `apps/server-rs/blackbox/manifest.json` stops passing. It prints the passing tests that are not listed yet (`--write-manifest` adds them: a slice grows the manifest as its routes and messages land) and a summary: pass, fail, not-black-box (the test needs the in-process server). With `--dump` or `--write-manifest` it also runs a second pass with a binary that cannot start: whatever still passes never starts a server, says nothing about the binary, and is left out of the candidates (the plain `check:rs` run skips that pass, so its `pass` count includes those tests). It runs one test at a time, so the load is one binary.

`apps/server-rs/blackbox/classification.md` lists every one of the 766 tests with its category and owning slice (regenerate with `blackbox/classify.ts`, see its header). Measured on the first run: 242 A (talk to a server with options that map to env vars; 7 pass today), 3 A\* (need a knob: per-IP and in-flight limits, metrics text, drain), 108 B (virtual time), 31 C (DB fixture), 299 D (white-box: Rust unit tests in the slice that ports the module), 82 E (shell scripts, not run), 1 skipped.

How the pieces fit:

- **`start(opts)`** in `apps/server/test/helpers.ts` spawns the binary when `OMEGA_SERVER_BIN` is set (PORT=0, `DB_PATH=:memory:` unless the test says otherwise, stdout polled synchronously for the listening line) and returns the same handle (`http`, `ws()`, `server.port`, `server.stop()` = SIGTERM and wait). `blackbox/env.ts` maps options onto `CONFIG_KEYS`; an option that cannot cross a process boundary (`registry`, `store`, `rooms`, spies, plain functions) throws `NotBlackBox`, as does touching `server.registry`/`publish`/... on the handle, and the runner counts that test as not-black-box instead of failing.
- **`TestClock`** (`blackbox/clock.ts`) replaces the per-file `fakeClock()`s. In process it is `now`/`wallNow`/`schedule` (a task runs when `set` passes its deadline). Against the binary the same object is attached to the server and `await clock.set({ mono, wall })` becomes `POST /__test/time`; the starting time travels as `OMEGA_TEST_MONO`/`OMEGA_TEST_WALL`. Tests change `clock.ms += x` into `await clock.set({ mono: clock.mono + x })`; assertions stay (see `emote.test.ts`).
- **`POST /__test/time {mono, wall}`** sets the virtual clock and fires every due timer, in deadline order, one at a time. It answers `{"fired":n}` only after each fired sleeper has been acknowledged: the awaiting task drops its `Sleep` future the moment it resumes (that is the ack), then the hook yields to the scheduler a few times, which is enough because post-wake work is synchronous by rule (see `src/test_hooks.rs`). A timer a firing task re-arms is due relative to the new time. `GET /__test/time` answers `{"pending":n}`. Bounded: 5 s per ack and 10 000 fires per call; hitting either answers 500 with a reason, never `{"fired":n}`. The work runs in a spawned task, so a client that hangs up cannot leave time moved with due timers unfired.
- **One thread, on purpose.** The ack is only sound because the test-hooks binary runs on a `current_thread` runtime (main.rs, `#[cfg(feature = "test-hooks")]`): a woken task, and anything it spawns, runs while the handler yields, so `set` yields until the pending count and the armed-timer counter are unchanged across two consecutive yields (at most 64 yields per timer). The default and release builds stay multi-thread. Limits: a woken task that waits on something other than the scheduler (IO, another timer) before finishing is not waited for (so timer tasks must not hand their work to `spawn_blocking`: the room GC sweep runs inline under `test-hooks`, `rooms_gc::run_sweep`); and concurrency (lock order, parallel rooms, backpressure) is not exercised by the black-box suite at all. Rust tests and the load comparison (S9) cover it.
- **Process hygiene.** The harness spawns the binary with a piped stdin and `OMEGA_TEST_STDIN_GUARD=1`; the test-hooks binary exits 0 when that pipe closes, so a dead harness leaves no server. The harness also kills its children on exit, SIGINT and SIGTERM, removes its temp dirs, and `stop()` sends SIGKILL after 2 s instead of waiting out the drain grace.
- **No hooks in the default binary**: `tests/no_test_hooks.rs` builds the default lib in the normal target dir (dependencies shared: about 4 s warm, one crate compile cold) and fails if `/__test/`, `OMEGA_TEST_` or `__test/time` is in it. It checks the lib, not the binary, because a default binary built there would replace `debug/omega-server`, which the other integration tests run with the hooks; every hook string lives in the lib, main.rs only calls it.

Behaviour the suite pins that a separate process must keep: an oversized WS frame closes with **1006**; a raw chunked POST over 4 KB gets `HTTP/1.1 413 Payload Too Large` with a `payload_too_large` body; a corrupt room row fails boot naming the room; a clean SIGTERM exits 0 with nothing on stderr; upgrade refusals (421, 403, 404, 429, 503) are plain HTTP responses before the 101; header names are lowercase.
