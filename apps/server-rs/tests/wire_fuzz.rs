//! Wire fuzzing (OME-1170): a seeded, deterministic driver throws random and mutated client frames at the real `App`
//! over real sockets, and random HTTP bodies at the real request parsers, then checks what must always hold:
//! no panic anywhere (a hook counts panics in spawned tasks too), only well-formed server frames, snapshots that agree
//! with the room, and every counter back at zero once the sockets are gone.
//!
//! Port of the intent of apps/server/test/fuzz.test.ts, which is not black-box (its `now` auto-advances); the clock
//! here does the same so no limiter trips and frames reach the handlers.
//! `FUZZ_ITERS` (steps per test, default 1500) and `FUZZ_SEED` for a long or different manual run.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    reason = "a test harness"
)]

use futures_util::{FutureExt, SinkExt, StreamExt};
use omega_server::app::App;
use omega_server::clock::{Clock, Sleep};
use omega_server::config::{Env, parse_config};
use omega_server::contract::confusables::nickname_key;
use omega_server::contract::constants::MAX_ROOM_MEMBERS;
use omega_server::contract::ids::RoomId;
use omega_server::contract::layout::default_layout;
use omega_server::contract::room::RoomVisibility;
use omega_server::contract::server_message::parse_server_message;
use omega_server::room::{Room, RoomInit};
use omega_server::secrets::hash_secret;
use omega_server::store::NewRoom;
use serde::Deserialize;
use serde_json::Value;
use std::collections::HashSet;
use std::net::SocketAddr;
use std::path::Path;
use std::sync::Arc;
use std::sync::Once;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::time::{Duration, Instant};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream, connect_async};

const OWNER: &str = "ownerownerownerownerow";
const ROOMS: [&str; 3] = ["lobby", "fuzz-a", "fuzz-b"];
/// Concurrent sockets stay under `MAX_PER_IP`, so the per-IP cap is never what refuses a connection.
const CLIENTS: usize = 6;
const MAX_PER_IP: usize = 8;

struct Rng(u64);

impl Rng {
    /// xorshift64*
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 >> 12;
        self.0 ^= self.0 << 25;
        self.0 ^= self.0 >> 27;
        self.0.wrapping_mul(0x2545_F491_4F6C_DD1D)
    }
    fn below(&mut self, n: usize) -> usize {
        usize::try_from(self.next() % u64::try_from(n).unwrap()).unwrap()
    }
    fn chance(&mut self, percent: usize) -> bool {
        self.below(100) < percent
    }
    fn byte(&mut self) -> u8 {
        u8::try_from(self.next() & 0xff).unwrap()
    }
}

fn env_num(name: &str, default: u64) -> u64 {
    std::env::var(name).ok().and_then(|v| v.parse().ok()).unwrap_or(default)
}

static PANICS: AtomicUsize = AtomicUsize::new(0);
static HOOK: Once = Once::new();

/// A panic in a spawned server task is swallowed by tokio; count every one.
fn count_panics() {
    HOOK.call_once(|| {
        let previous = std::panic::take_hook();
        std::panic::set_hook(Box::new(move |info| {
            PANICS.fetch_add(1, Ordering::SeqCst);
            previous(info);
        }));
    });
}

/// Mono time jumps one second per read, so no limiter trips; the wall clock and sleeps are real.
struct JumpClock {
    start: Instant,
    mono: AtomicU64,
}

impl Clock for JumpClock {
    fn mono_ms(&self) -> f64 {
        self.mono.fetch_add(1000, Ordering::Relaxed) as f64
    }
    fn wall_ms(&self) -> i64 {
        let real = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis();
        i64::try_from(real).unwrap() + i64::try_from(self.start.elapsed().as_millis()).unwrap()
    }
    fn sleep(&self, ms: f64) -> Sleep {
        Box::pin(tokio::time::sleep(Duration::from_secs_f64(ms.max(0.0) / 1000.0)))
    }
}

struct Server {
    addr: SocketAddr,
    app: Arc<App>,
}

fn rid(id: &str) -> RoomId {
    RoomId::parse(id).unwrap()
}

async fn start() -> Server {
    let mut env = Env::new();
    env.insert("DB_PATH".to_owned(), ":memory:".to_owned());
    let config = parse_config(&env, Path::new("/")).unwrap();
    let clock = Arc::new(JumpClock {
        start: Instant::now(),
        mono: AtomicU64::new(0),
    });
    let mut app = App::boot_with(config, clock, &[rid("lobby")]).unwrap();
    {
        let inner = Arc::get_mut(&mut app).unwrap();
        inner.ws.join_timeout_ms = 60_000.0;
        inner.ws.max_per_ip = Some(MAX_PER_IP);
    }
    for id in &ROOMS[1..] {
        let now = app.wall();
        let owner_hash = Some(hash_secret(OWNER));
        app.store()
            .rooms()
            .create_room(&NewRoom {
                id: rid(id),
                title: None,
                created_at: now,
                layout: default_layout(),
                visibility: RoomVisibility::Public,
                pinned: false,
                owner_hash,
                invite_hash: None,
            })
            .unwrap();
        let init = RoomInit {
            visibility: Some(RoomVisibility::Public),
            pinned: Some(false),
            owner_hash,
            ..RoomInit::default()
        };
        app.insert_room(Room::new(rid(id), init, now).unwrap()).unwrap();
    }
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    app.http.bind(&app.config, addr.port());
    let router = omega_server::serve::build_router(app.clone(), axum::Router::new());
    tokio::spawn(async move {
        let _ = omega_server::http::server::serve(listener, router, std::future::pending()).await;
    });
    Server { addr, app }
}

type Sock = WebSocketStream<MaybeTlsStream<TcpStream>>;

async fn open(s: &Server, room: &str) -> Option<Sock> {
    let req = format!("ws://{}/rooms/{room}/ws", s.addr).into_client_request().unwrap();
    connect_async(req).await.ok().map(|(sock, _)| sock)
}

#[derive(Deserialize)]
struct Case {
    input: String,
    ok: bool,
}

fn corpus(json: &str) -> Vec<String> {
    let cases: Vec<Case> = serde_json::from_str(json).unwrap();
    cases.into_iter().filter(|c| c.ok).map(|c| c.input).collect()
}

const SNIPPETS: &[&str] = &[
    "{",
    "}",
    "[",
    "]",
    "\"",
    "\\",
    "\\ud800",
    "\\u0000",
    ",",
    ":",
    "null",
    "1e400",
    "-0",
    "{\"type\":",
    "\u{feff}",
    "\u{85}",
    "\u{1f468}\u{200d}\u{1f469}",
];

/// A few random byte-level edits of `seed`; always valid UTF-8 (lossy), since text frames must be.
fn mutate(rng: &mut Rng, seeds: &[String]) -> String {
    let mut b = seeds[rng.below(seeds.len())].clone().into_bytes();
    for _ in 0..=rng.below(4) {
        match rng.below(6) {
            0 if !b.is_empty() => {
                let i = rng.below(b.len());
                b[i] = rng.byte();
            }
            1 if !b.is_empty() => {
                let i = rng.below(b.len());
                b.truncate(i);
            }
            2 => {
                let i = rng.below(b.len() + 1);
                let s = SNIPPETS[rng.below(SNIPPETS.len())].as_bytes();
                b.splice(i..i, s.iter().copied());
            }
            3 if !b.is_empty() => {
                b.remove(rng.below(b.len()));
            }
            4 if b.len() > 1 => {
                let (i, j) = (rng.below(b.len()), rng.below(b.len()));
                b.swap(i, j);
            }
            _ => {
                let other = seeds[rng.below(seeds.len())].as_bytes();
                let i = rng.below(b.len() + 1);
                b.splice(i..i, other.iter().copied());
            }
        }
    }
    String::from_utf8_lossy(&b).into_owned()
}

struct Fuzzer {
    sock: Option<Sock>,
    room: &'static str,
    /// Frames this socket was sent and the server's replies, for a failure message.
    seen: usize,
}

/// Everything the server sent that is waiting, without blocking: each text frame must parse as a server message.
fn drain(f: &mut Fuzzer, members: &mut HashSet<String>, who: usize) {
    while let Some(sock) = f.sock.as_mut() {
        match sock.next().now_or_never() {
            None => return,
            Some(Some(Ok(Message::Text(t)))) => {
                f.seen += 1;
                assert!(
                    parse_server_message(t.as_str()).is_some(),
                    "client {who} got a malformed server frame: {t}"
                );
                let parsed = serde_json::from_str::<Value>(t.as_str()).ok();
                if let Some(list) = parsed.as_ref().and_then(|v| v.get("room")?.get("members")?.as_array()) {
                    members.extend(list.iter().filter_map(|m| m.get("id")?.as_str().map(str::to_owned)));
                }
            }
            Some(Some(Ok(Message::Ping(_) | Message::Pong(_)))) => {}
            Some(Some(Ok(Message::Close(_)))) | Some(Some(Err(_)) | None) => f.sock = None,
            Some(Some(Ok(other))) => panic!("client {who} got a non-text frame: {other:?}"),
        }
    }
}

/// A snapshot taken by a fresh probe agrees with the room: members, unique nickname keys, seats held by members.
async fn probe(s: &Server, room: &str) -> bool {
    let Some(mut sock) = open(s, room).await else { return false };
    sock.send(Message::text(r#"{"type":"join","nickname":"probe","avatar":0}"#))
        .await
        .unwrap();
    let snap = loop {
        let next = tokio::time::timeout(Duration::from_secs(5), sock.next())
            .await
            .expect("the probe is answered");
        let Some(Ok(Message::Text(t))) = next else { return false };
        let v: Value = serde_json::from_str(t.as_str()).unwrap();
        match v["type"].as_str() {
            Some("snapshot") => break v,
            // Refused (full room, nickname taken by an earlier probe): nothing to compare.
            Some("error") => return false,
            _ => {}
        }
    };
    let members = snap["room"]["members"].as_array().unwrap();
    assert!(members.len() <= MAX_ROOM_MEMBERS, "{} members", members.len());
    let ids: Vec<&str> = members.iter().map(|m| m["id"].as_str().unwrap()).collect();
    let keys: HashSet<String> = members.iter().map(|m| nickname_key(m["nickname"].as_str().unwrap())).collect();
    assert_eq!(keys.len(), members.len(), "two members share a nickname key in {room}");
    let mut seated = HashSet::new();
    for seat in snap["room"]["seats"].as_array().unwrap() {
        if let Some(id) = seat.as_str() {
            assert!(ids.contains(&id), "seat held by a stranger {id} in {room}");
            assert!(seated.insert(id), "{id} holds two seats in {room}");
        }
    }
    // The room's own view, right after: what the snapshot said was true (others are idle while the probe runs).
    let live: Option<Vec<String>> = s
        .app
        .with_open_room(&rid(room), |i| i.room.members().map(|m| m.id.as_str().to_owned()).collect());
    let live = live.unwrap();
    let mut a: Vec<&str> = live.iter().map(String::as_str).collect();
    let mut b = ids.clone();
    a.sort_unstable();
    b.sort_unstable();
    assert_eq!(a, b, "snapshot and room disagree in {room}");
    let _ = sock.close(None).await;
    true
}

async fn settle() {
    tokio::time::sleep(Duration::from_millis(60)).await;
}

fn deep_json(rng: &mut Rng) -> String {
    let n = 50 + rng.below(20_000);
    match rng.below(3) {
        0 => "[".repeat(n),
        1 => format!("{}1{}", "[".repeat(n), "]".repeat(n)),
        _ => format!(r#"{{"type":"chat","text":{}"x"{}}}"#, r#"{"a":"#.repeat(n), "}".repeat(n)),
    }
}

#[tokio::test]
async fn random_and_mutated_client_frames_keep_the_server_consistent() {
    count_panics();
    let iters = env_num("FUZZ_ITERS", 1500);
    let seed = env_num("FUZZ_SEED", 0x5EED_0001);
    let s = start().await;
    let alive_before = tokio::runtime::Handle::current().metrics().num_alive_tasks();
    let seeds = corpus(include_str!("../corpus/out/client-message-raw.json"));
    assert!(seeds.len() > 50);
    let mut rng = Rng(seed | 1);
    let mut fuzzers: Vec<Fuzzer> = (0..CLIENTS)
        .map(|i| Fuzzer {
            sock: None,
            room: ROOMS[i % ROOMS.len()],
            seen: 0,
        })
        .collect();
    let mut known: HashSet<String> = HashSet::new();
    let mut sent = 0usize;
    let mut probes = 0usize;

    for step in 0..iters {
        let who = rng.below(CLIENTS);
        if fuzzers[who].sock.is_none() {
            fuzzers[who].room = ROOMS[rng.below(ROOMS.len())];
            fuzzers[who].sock = open(&s, fuzzers[who].room).await;
        }
        let owner = rng.chance(25);
        let roll = rng.below(100);
        let f = &mut fuzzers[who];
        let mut cut = false;
        if let Some(sock) = f.sock.as_mut() {
            let msg = match roll {
                0..=44 => {
                    let mut text = mutate(&mut rng, &seeds);
                    // Aim kicks, mutes and the rest at real members now and then.
                    if rng.chance(40)
                        && let Some(id) = known.iter().nth(rng.below(known.len().max(1)))
                    {
                        text = text.replace("m2", id);
                    }
                    Some(Message::text(text))
                }
                45..=56 => {
                    let token = if owner {
                        format!(r#","ownerToken":"{OWNER}""#)
                    } else {
                        String::new()
                    };
                    Some(Message::text(format!(
                        r#"{{"type":"join","nickname":"f{}","avatar":{}{token}}}"#,
                        rng.below(40),
                        rng.below(4)
                    )))
                }
                57..=64 => Some(Message::text(seeds[rng.below(seeds.len())].clone())),
                65..=69 => {
                    let n = rng.below(300);
                    Some(Message::binary((0..n).map(|_| rng.byte()).collect::<Vec<u8>>()))
                }
                70..=72 => Some(Message::text("x".repeat(4097 + rng.below(70_000)))),
                73..=75 => Some(Message::text(deep_json(&mut rng))),
                76..=78 => Some(Message::text(
                    [
                        r#"{"type":"chat","text":"a","text":"b"}"#,
                        r#"{"type":"leave","type":"join","nickname":"x","avatar":0}"#,
                        r#"{"__proto__":{"type":"leave"},"type":"ping","id":1}"#,
                    ][rng.below(3)],
                )),
                79..=84 => {
                    let _ = sock.close(None).await;
                    None
                }
                85..=88 => {
                    cut = true;
                    None
                }
                _ => Some(Message::text(format!(r#"{{"type":"ping","id":{}}}"#, rng.below(1000)))),
            };
            if let Some(m) = msg {
                sent += 1;
                cut = sock.send(m).await.is_err();
            }
        }
        if cut {
            f.sock = None;
        }
        tokio::time::sleep(Duration::from_micros(300)).await;
        for (i, f) in fuzzers.iter_mut().enumerate() {
            drain(f, &mut known, i);
        }
        assert_eq!(
            PANICS.load(Ordering::SeqCst),
            0,
            "a server task panicked at step {step} (seed {seed:#x})"
        );
        if step % 250 == 249 {
            settle().await;
            for f in &mut fuzzers {
                drain(f, &mut known, 99);
            }
            for room in ROOMS {
                probes += usize::from(probe(&s, room).await);
            }
        }
    }
    let frames: usize = fuzzers.iter().map(|f| f.seen).sum();
    println!(
        "sent {sent} frames, saw {frames} replies, {} member ids, {probes} snapshot checks",
        known.len()
    );
    assert!(sent > iters as usize / 2 && known.len() > 3 && probes > 0 || iters < 250);

    // Every socket gone: the counters are back at zero, no room keeps a member, no task is left behind.
    drop(fuzzers);
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        let members: usize = ROOMS
            .iter()
            .map(|r| s.app.with_open_room(&rid(r), |i| i.room.member_count()).unwrap())
            .sum();
        if s.app.ws.connections() == 0 && members == 0 {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "sockets {} and members {members} remain after every client closed",
            s.app.ws.connections()
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    // The per-IP map is empty again: a whole allowance of sockets from the same address connects.
    let mut socks = Vec::new();
    for _ in 0..MAX_PER_IP {
        socks.push(open(&s, "lobby").await.expect("the per-IP count returned to zero"));
    }
    drop(socks);
    let deadline = Instant::now() + Duration::from_secs(5);
    while tokio::runtime::Handle::current().metrics().num_alive_tasks() > alive_before {
        assert!(
            Instant::now() < deadline,
            "tasks leaked: {} alive, {alive_before} at the start",
            tokio::runtime::Handle::current().metrics().num_alive_tasks()
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert_eq!(PANICS.load(Ordering::SeqCst), 0);
}

/// One raw HTTP exchange: the status code, or `None` if the server closed without answering.
async fn http(addr: SocketAddr, method: &str, path: &str, headers: &[(&str, String)], body: &[u8], chunked: bool) -> Option<u16> {
    let mut req = format!(
        "{method} {path} HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nConnection: close\r\n",
        addr.port()
    );
    for (k, v) in headers {
        req.push_str(&format!("{k}: {v}\r\n"));
    }
    let mut bytes = if chunked {
        req.push_str("Transfer-Encoding: chunked\r\n\r\n");
        let mut b = req.into_bytes();
        for piece in body.chunks(700) {
            b.extend_from_slice(format!("{:x}\r\n", piece.len()).as_bytes());
            b.extend_from_slice(piece);
            b.extend_from_slice(b"\r\n");
        }
        b.extend_from_slice(b"0\r\n\r\n");
        b
    } else {
        req.push_str(&format!("Content-Length: {}\r\n\r\n", body.len()));
        let mut b = req.into_bytes();
        b.extend_from_slice(body);
        b
    };
    let mut stream = TcpStream::connect(addr).await.ok()?;
    // The server may answer 413 and hang up before it has read everything: ignore a write that fails.
    let _ = stream.write_all(&bytes).await;
    bytes.clear();
    let read = tokio::time::timeout(Duration::from_secs(10), stream.read_to_end(&mut bytes))
        .await
        .expect("the server answers or hangs up");
    let _ = read;
    let line = String::from_utf8_lossy(bytes.get(..bytes.len().min(32)).unwrap_or_default()).into_owned();
    line.split(' ').nth(1)?.parse().ok()
}

#[tokio::test]
async fn random_http_bodies_are_answered_with_a_status_below_500() {
    count_panics();
    let iters = env_num("FUZZ_ITERS", 1500);
    let seed = env_num("FUZZ_SEED", 0x5EED_0002);
    let s = start().await;
    let mut rng = Rng(seed | 1);
    let create = corpus(include_str!("../corpus/out/create-room-request-raw.json"));
    let report = corpus(include_str!("../corpus/out/report-request-raw.json"));
    let share: Vec<String> = [
        r#"{"url":"https://youtu.be/dQw4w9WgXcQ"}"#,
        r#"{"url":"https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=x"}"#,
        r#"{"url":"https://vimeo.com/76979871"}"#,
        r#"{"url":"https://example.com/watch/1"}"#,
        r#"{"url":""}"#,
    ]
    .map(str::to_owned)
    .to_vec();
    assert!(create.len() > 5 && report.len() > 5);

    // A guest and an owner: their share tokens come from the join snapshot.
    let mut tokens = Vec::new();
    let mut socks = Vec::new();
    for (name, extra) in [("guest", String::new()), ("boss", format!(r#","ownerToken":"{OWNER}""#))] {
        let mut sock = open(&s, "fuzz-a").await.unwrap();
        sock.send(Message::text(format!(r#"{{"type":"join","nickname":"{name}","avatar":0{extra}}}"#)))
            .await
            .unwrap();
        loop {
            let Some(Ok(Message::Text(t))) = tokio::time::timeout(Duration::from_secs(5), sock.next()).await.unwrap() else {
                panic!("no snapshot")
            };
            let v: Value = serde_json::from_str(t.as_str()).unwrap();
            if v["type"] == "snapshot" {
                tokens.push(v["shareToken"].as_str().unwrap().to_owned());
                break;
            }
        }
        socks.push(sock);
    }

    let mut statuses = HashSet::new();
    for step in 0..iters {
        let (path, seeds): (String, &[String]) = match rng.below(4) {
            0 => ("/rooms".to_owned(), &create),
            1 => ("/rooms/fuzz-a/report".to_owned(), &report),
            2 => ("/rooms/fuzz-a/share".to_owned(), &share),
            _ => ("/rooms/fuzz-a/queue".to_owned(), &share),
        };
        let mut headers = vec![("Content-Type", "application/json".to_owned())];
        if rng.chance(85) && (path.ends_with("share") || path.ends_with("queue")) {
            headers.push(("Authorization", format!("Bearer {}", tokens[rng.below(2)])));
        }
        let body = match rng.below(10) {
            0 => (0..rng.below(300)).map(|_| rng.byte()).collect(),
            1 => deep_json(&mut rng).into_bytes(),
            2 => "z".repeat(rng.below(20_000)).into_bytes(),
            3 => seeds[rng.below(seeds.len())].clone().into_bytes(),
            _ => mutate(&mut rng, seeds).into_bytes(),
        };
        let chunked = rng.chance(20);
        let status = http(s.addr, "POST", &path, &headers, &body, chunked).await;
        let status = status.unwrap_or_else(|| panic!("no answer to POST {path} at step {step} (seed {seed:#x})"));
        assert!(
            status < 500,
            "POST {path} gave {status} at step {step} (seed {seed:#x}), body {:?}",
            String::from_utf8_lossy(&body[..body.len().min(200)])
        );
        statuses.insert(status);
        assert_eq!(
            PANICS.load(Ordering::SeqCst),
            0,
            "a server task panicked at step {step} (seed {seed:#x})"
        );
    }
    // Still serving after all of it.
    assert_eq!(http(s.addr, "GET", "/rooms", &[], b"", false).await, Some(200));
    assert!(statuses.len() > 2, "the fuzzer only ever saw {statuses:?}");
    drop(socks);
}
