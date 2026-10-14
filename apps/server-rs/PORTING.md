# Porting apps/server to Rust

How `apps/server-rs` is built. Read it before you touch the crate. The decision and its gates are in [ADR 0050](../../docs/adr/0050-rust-server.md); the tracking issue is OME-1141.

The TS server in `apps/server` is the reference. It is **frozen**: no feature work lands there until the switch. When the two disagree, the TS behaviour wins, unless a row in [Deliberate differences](#deliberate-differences) says otherwise.

## Commands

```sh
export CARGO_TARGET_DIR=$HOME/.cache/omega-share/cargo-target  # one build dir for every worktree
export CARGO_BUILD_JOBS=8                                      # leave the machine usable
bun run check:rs   # fmt --check, clippy -D warnings, tests, cargo-deny: the Rust half of `bun run check`
cargo test -p omega-server <filter>
cargo run -p omega-server -- serve   # env as in apps/server (PORT, DB_PATH, SITE_ORIGIN, ...)
```

At most 2 Cargo builds at once on the dev machine. The shared target dir serialises them anyway (Cargo's lock), so a waiting build says `Blocking waiting for file lock`: that is expected, not a hang.

## Module map

| TS (`apps/server/src`, `packages/shared/src`) | Rust (`apps/server-rs/src`) | Slice |
|---|---|---|
| `config.ts` | `config.rs` | S1 ✓ |
| `index.ts` | `main.rs`, `serve.rs` | S1 ✓ (grows in S5–S7) |
| `rate-limit.ts` `Clock`, `monotonic`, `wallNow`, `schedule` | `clock.rs` | S1 ✓ |
| `packages/shared/src/*` (server-used parts) | `contract/*` | S2 |
| `store/db.ts`, `store/rooms.ts`, `store/reports.ts`, `migrations/*.sql` | `store/*` (migrations embedded with `include_str!` from `apps/server/migrations`) | S3 |
| `room.ts`, `rooms.ts`, `playback.ts`, `queue.ts`, `rate-limit.ts`, `secrets.ts`, `embed-policy.ts`, `presets.ts`, `log.ts`, `headers.ts` | same names, `snake_case.rs` | S4 |
| `http.ts`, `static.ts`, `site-meta.ts`, `server.ts` (routing, Host/Origin gate) | `http/*` | S5 |
| `ws.ts`, `ws-sessions.ts`, `ws-limits.ts`, `ws-owner-edits.ts` | `ws/*` | S6 |
| `rooms-gc.ts`, `reports.ts`, `admin.ts`, `cli.ts`, `metrics.ts`, `scripts/backup.ts`, graceful restart | same names; `omega-server admin …`, `omega-server backup …` | S7 |
| `test/helpers.ts` (black-box mode), test hooks | `test_hooks.rs` (feature `test-hooks`) | S8 |
| `relay-latency.ts` | `src/bin/omega-load.rs` | S9 |

Not ported: `activity`, `discord-upstream` and `extension-bridge` from shared (the server doesn't use them). `parseServerMessage` only matters to the load generator.

## Rules

1. **No panics on any path input can reach.** `unwrap`, `expect`, `panic!`, `todo!`, `unreachable!`, unchecked indexing and string slicing are denied by clippy (`Cargo.toml` workspace lints; tests may use them). Use `get`, `?`, `let … else`. Arithmetic on input-derived numbers is `checked_`/`saturating_`.
2. **No `unsafe`** (`forbid`).
3. **Parse at the boundary, once.** Bytes from a socket, an HTTP body, a header, a URL, a SQLite row or an env var become a domain type in one `parse` step; nothing past it holds unchecked input. The shape:
   - `serde` deserializes into a *wire* struct (`#[serde(deny_unknown_fields)]` where the TS schema is `strictObject`, default where it is `object`).
   - `validator` (`#[derive(Validate)]`) checks field rules. JS-semantics rules are custom functions from `contract/js_compat.rs` (`utf16_len`, `js_trim`, `is_js_whitespace`, ...), never the crate's built-in `length` (it counts `char`s, Valibot counts UTF-16 units).
   - `TryFrom<Wire>` builds the domain type (newtypes such as `RoomId`, `MemberId`, `Nickname`) whose constructor is the only way to get one.
   - Oversized input is refused **before** parsing (frame and body caps from `contract/constants.rs`).
4. **Pure core, IO at the edges.** S4's room logic is plain structs and functions with no tokio and no clock reads: time comes in as an argument (`now_mono: f64`, `now_wall: i64`). Only S5–S7 hold the `SharedClock`. That keeps the core unit-testable and lets the `test-hooks` build swap time.
5. **Never block the runtime.** SQLite calls go through `tokio::task::spawn_blocking` or a dedicated store thread; never hold a `std::sync::Mutex` across `.await`.
6. **Serialize once per broadcast.** A room message is encoded to one `Utf8Bytes` and cloned (refcount) to every member's send queue. Send queues are bounded; a member who can't keep up is closed (the TS server's backpressure close), never buffered without limit.
7. **Output field order = the TS object literal's order**, optional keys omitted with `skip_serializing_if` (the TS server never sends `undefined`; `null` only where the TS code writes `null`). Clients parse JSON, so float formatting may differ (`1.0` vs `1`), key presence may not.
8. **Logging = `log.rs`**: one JSON line per error on stderr, a fixed event name, the message cut at its first quote and scrubbed of IPs and emails (port of `log.ts`). Never log a room id, title, nickname, token or address.
9. **Secrets**: tokens from the OS CSPRNG (`getrandom`), hashed exactly as `secrets.ts` does so stored hashes still verify, compared in constant time (`subtle`).
10. **Every new dependency** needs a line in the PR: why, licence (cargo-deny enforces the allow list in `deny.toml`), and that the std or an existing crate can't do it.
11. **TDD**: the commit with the failing tests comes before the implementation commit (CLAUDE.md, `/mattpocock-skills:tdd`). Port each TS test case for the module as a Rust test, with a `// apps/server/test/<file>.test.ts:<line>` comment, and keep its intent and its expected values.

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

Schemas, field orders and constants: read the TS source (`packages/shared/src`), it is short. The server sends what it builds with object literals; mirror those literals.

## The comparison test

Every ported schema or contract function gets a corpus: inputs that the TS side decides (accepted with an output, or refused) and the Rust side must decide the same way.

1. Add a corpus to `corpus/corpora.ts`: a name and `cases()`, using `decided(inputs, tsFunction)` for a function, or `v.safeParse(Schema, input)` for a schema (record the parsed output on success). Cover the edges: limits ±1 in UTF-16 units, emoji and astral characters, U+FEFF and U+0085, NFKC-changing input, unknown keys on `object` vs `strictObject`, nulls and absent keys, wrong types, every literal and picklist value.
2. `bun apps/server-rs/corpus/gen.ts` writes `corpus/out/<name>.json`, one case per line. Commit it.
3. Add a test in `tests/corpus.rs` that loads the file with `include_str!` and runs `agree(...)` with the Rust function.

`corpus/corpus.test.ts` (in `bun run test`) fails when a recorded file no longer matches what the TS contract decides, so a `packages/shared` change can't land without regenerating, and regenerating can't land without the Rust side agreeing.

## Deliberate differences

Rust is stricter than Valibot in three places that no real client reaches. The comparison test lists them as expected disagreements:

| Input | TS | Rust |
|---|---|---|
| Duplicate JSON keys | last one wins | rejected |
| Integers written `1.0` or `1e2` | accepted | rejected (`JSON.stringify` never writes them) |
| Lone surrogates in text (`"\ud800"`) | accepted | rejected |

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
