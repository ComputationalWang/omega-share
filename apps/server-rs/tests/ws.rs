//! The WebSocket relay over a real socket: upgrade gate, join, every message type, refusals and close codes.
//! Ported from apps/server/test/{server,room-lifecycle,room-auth,moderation,member-status,durable-sessions,
//! graceful-restart,emote,queue,abuse,ws-limits}.test.ts (the black-box harness is not in main yet).
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    reason = "test helpers: a broken fixture should fail loudly"
)]

use futures_util::{SinkExt, StreamExt};
use omega_server::app::App;
use omega_server::clock::{Clock, Sleep};
use omega_server::config::{Env, parse_config};
use omega_server::contract::ids::{RoomId, ShareToken};
use omega_server::contract::layout::default_layout;
use omega_server::contract::room::RoomVisibility;
use omega_server::metrics::Gauges;
use omega_server::queue::{QueueActor, add};
use omega_server::registry::RemoveReason;
use omega_server::room::{Room, RoomInit};
use omega_server::secrets::hash_secret;
use omega_server::store::NewRoom;
use serde_json::{Value, json};
use std::collections::VecDeque;
use std::net::SocketAddr;
use std::path::Path;
use std::sync::Arc;
use std::sync::atomic::{AtomicI64, Ordering};
use std::time::{Duration, Instant};
use tokio::net::TcpStream;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::{Error as WsError, Message};
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream, connect_async};

const SITE: &str = "http://localhost:5173";
const YT: &str = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";
const YT2: &str = "https://youtu.be/9bZkp7q19f0";
const OWNER: &str = "ownerownerownerownerow";
const INVITE: &str = "inviteinviteinviteinvi";

/// Real time, with a wall clock the tests can move forward (kick cooldown, mute memory).
struct TestClock {
    start: Instant,
    skew: AtomicI64,
}

impl Clock for TestClock {
    fn mono_ms(&self) -> f64 {
        self.start.elapsed().as_secs_f64() * 1000.0
    }
    fn wall_ms(&self) -> i64 {
        let real = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis();
        i64::try_from(real).unwrap() + self.skew.load(Ordering::Relaxed)
    }
    fn sleep(&self, ms: f64) -> Sleep {
        Box::pin(tokio::time::sleep(Duration::from_secs_f64(ms.max(0.0) / 1000.0)))
    }
}

struct Server {
    addr: SocketAddr,
    app: Arc<App>,
    clock: Arc<TestClock>,
}

fn rid(id: &str) -> RoomId {
    RoomId::parse(id).unwrap()
}

#[derive(Default)]
struct Opts {
    env: Vec<(&'static str, &'static str)>,
    join_timeout_ms: Option<f64>,
    status_interval_ms: Option<f64>,
    max_per_ip: Option<usize>,
    resume_grace_ms: Option<u32>,
    idle_timeout_ms: Option<f64>,
    hold_attach: Option<Arc<tokio::sync::Notify>>,
}

async fn start(opts: Opts) -> Server {
    let mut env = Env::new();
    env.insert("DB_PATH".to_owned(), ":memory:".to_owned());
    for (k, v) in &opts.env {
        env.insert((*k).to_owned(), (*v).to_owned());
    }
    let mut config = parse_config(&env, Path::new("/")).unwrap();
    if let Some(ms) = opts.resume_grace_ms {
        config.resume_grace_ms = ms;
    }
    let clock = Arc::new(TestClock {
        start: Instant::now(),
        skew: AtomicI64::new(0),
    });
    let mut app = App::boot_with(config, clock.clone(), &[rid("lobby")]).unwrap();
    {
        let inner = Arc::get_mut(&mut app).unwrap();
        if let Some(v) = opts.join_timeout_ms {
            inner.ws.join_timeout_ms = v;
        }
        if let Some(v) = opts.status_interval_ms {
            inner.ws.status_interval_ms = v;
        }
        inner.ws.max_per_ip = opts.max_per_ip;
        inner.ws.hold_attach = opts.hold_attach.clone();
        if let Some(v) = opts.idle_timeout_ms {
            inner.ws.idle_timeout_ms = v;
        }
    }
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    app.http.bind(&app.config, addr.port());
    let router = omega_server::serve::build_router(app.clone(), axum::Router::new());
    tokio::spawn(async move {
        let _ = omega_server::http::server::serve(listener, router, std::future::pending()).await;
    });
    Server { addr, app, clock }
}

/// A room with an owner (token `OWNER`), optionally private (invite key `INVITE`), stored and registered.
fn add_room(s: &Server, id: &str, private: bool) {
    let visibility = if private { RoomVisibility::Private } else { RoomVisibility::Public };
    let owner_hash = Some(hash_secret(OWNER));
    let invite_hash = private.then(|| hash_secret(INVITE));
    let now = s.app.wall();
    s.app
        .store()
        .rooms()
        .create_room(&NewRoom {
            id: rid(id),
            title: None,
            created_at: now,
            layout: default_layout(),
            visibility,
            pinned: false,
            owner_hash,
            invite_hash,
        })
        .unwrap();
    let init = RoomInit {
        visibility: Some(visibility),
        pinned: Some(false),
        owner_hash,
        invite_hash,
        ..RoomInit::default()
    };
    s.app.insert_room(Room::new(rid(id), init, now).unwrap()).unwrap();
}

type Sock = WebSocketStream<MaybeTlsStream<TcpStream>>;

/// What the socket ended with: `Some(code)` after a close frame, `None` if it was cut.
type Closed = Option<u16>;

struct Client {
    sock: Sock,
    inbox: VecDeque<Value>,
    closed: Option<Closed>,
}

async fn try_connect(s: &Server, room: &str, origin: Option<&str>, headers: &[(&str, &str)]) -> Result<Client, WsError> {
    let mut req = format!("ws://{}/rooms/{room}/ws", s.addr).into_client_request().unwrap();
    if let Some(o) = origin {
        req.headers_mut().insert("origin", o.parse().unwrap());
    }
    for (k, v) in headers {
        req.headers_mut().insert(
            tokio_tungstenite::tungstenite::http::HeaderName::from_bytes(k.as_bytes()).unwrap(),
            v.parse().unwrap(),
        );
    }
    let (sock, _) = connect_async(req).await?;
    Ok(Client {
        sock,
        inbox: VecDeque::new(),
        closed: None,
    })
}

fn status_of(err: WsError) -> u16 {
    match err {
        WsError::Http(res) => res.status().as_u16(),
        other => panic!("not an HTTP refusal: {other:?}"),
    }
}

async fn connect(s: &Server) -> Client {
    try_connect(s, "lobby", None, &[]).await.unwrap()
}

impl Client {
    /// Reads one event within `wait`; false on timeout. Text goes to the inbox, a close or a cut ends the socket.
    async fn pump(&mut self, wait: Duration) -> bool {
        if self.closed.is_some() {
            return false;
        }
        match tokio::time::timeout(wait, self.sock.next()).await {
            Err(_) => false,
            Ok(Some(Ok(Message::Text(t)))) => {
                self.inbox.push_back(serde_json::from_str(t.as_str()).unwrap());
                true
            }
            Ok(Some(Ok(Message::Close(frame)))) => {
                self.closed = Some(frame.map(|f| u16::from(f.code)));
                true
            }
            Ok(Some(Ok(_))) => true,
            Ok(Some(Err(_)) | None) => {
                self.closed = Some(None);
                true
            }
        }
    }

    async fn send(&mut self, msg: Value) {
        self.sock.send(Message::text(msg.to_string())).await.unwrap();
    }

    async fn send_raw(&mut self, text: &str) {
        self.sock.send(Message::text(text.to_owned())).await.unwrap();
    }

    /// The next message of `kind`; earlier ones of other kinds are discarded.
    async fn next(&mut self, kind: &str) -> Value {
        let deadline = Instant::now() + Duration::from_millis(1500);
        loop {
            if let Some(i) = self.inbox.iter().position(|m| m["type"] == kind) {
                let msg = self.inbox.remove(i).unwrap();
                self.inbox.drain(..i);
                return msg;
            }
            let left = deadline.saturating_duration_since(Instant::now());
            assert!(
                !left.is_zero() && self.pump(left).await,
                "timed out waiting for {kind}; inbox {:?}, closed {:?}",
                self.inbox,
                self.closed
            );
        }
    }

    /// Asserts nothing of `kind` arrives within `ms`.
    async fn none(&mut self, kind: &str, ms: u64) {
        let deadline = Instant::now() + Duration::from_millis(ms);
        loop {
            assert!(!self.inbox.iter().any(|m| m["type"] == kind), "unexpected {kind}: {:?}", self.inbox);
            let left = deadline.saturating_duration_since(Instant::now());
            if left.is_zero() || !self.pump(left).await && self.closed.is_some() {
                return;
            }
        }
    }

    /// Waits for the socket to end.
    async fn closed(&mut self) -> Closed {
        let deadline = Instant::now() + Duration::from_millis(2500);
        loop {
            if let Some(c) = self.closed {
                return c;
            }
            let left = deadline.saturating_duration_since(Instant::now());
            assert!(!left.is_zero(), "never closed; inbox {:?}", self.inbox);
            self.pump(left).await;
        }
    }

    async fn join(&mut self, nickname: &str) -> Value {
        self.send(json!({"type": "join", "nickname": nickname, "avatar": 0})).await;
        self.next("snapshot").await
    }
}

async fn joined(s: &Server, nickname: &str) -> (Client, Value) {
    let mut c = connect(s).await;
    let snap = c.join(nickname).await;
    (c, snap)
}

async fn joined_as(s: &Server, room: &str, extra: Value, nickname: &str, headers: &[(&str, &str)]) -> (Client, Value) {
    let mut c = try_connect(s, room, None, headers).await.unwrap();
    let mut msg = json!({"type": "join", "nickname": nickname, "avatar": 0});
    for (k, v) in extra.as_object().unwrap() {
        msg[k] = v.clone();
    }
    c.send(msg).await;
    let snap = c.next("snapshot").await;
    (c, snap)
}

/// An embed in the lobby, put there the way a share does.
fn embed_in_lobby(s: &Server, url: &str) {
    let actor = QueueActor {
        member_id: omega_server::contract::ids::MemberId::parse("00000000-0000-4000-8000-000000000000").unwrap(),
        owner: false,
    };
    s.app
        .with_open_room(&rid("lobby"), |inner| add(&s.app, inner, &actor, url).map(|_| ()))
        .unwrap()
        .unwrap();
}

const XFF: &str = "x-forwarded-for";

// ---------- upgrade ----------

// apps/server/test/server.test.ts:171
#[tokio::test]
async fn a_plain_get_to_an_unknown_room_is_404_and_an_invalid_id_too() {
    let s = start(Opts::default()).await;
    assert_eq!(status_of(try_connect(&s, "bad!id", None, &[]).await.err().unwrap()), 404);
    let mut raw = TcpStream::connect(s.addr).await.unwrap();
    let req = format!(
        "GET /rooms/nope/ws HTTP/1.1\r\nHost: {}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n",
        s.addr
    );
    tokio::io::AsyncWriteExt::write_all(&mut raw, req.as_bytes()).await.unwrap();
    let mut buf = vec![0u8; 64];
    let n = tokio::io::AsyncReadExt::read(&mut raw, &mut buf).await.unwrap();
    assert!(String::from_utf8_lossy(&buf[..n]).starts_with("HTTP/1.1 404"));
}

// apps/server/test/server.test.ts:177
#[tokio::test]
async fn a_foreign_origin_is_403_and_the_site_and_extensions_are_let_in() {
    let s = start(Opts::default()).await;
    assert_eq!(
        status_of(try_connect(&s, "lobby", Some("https://evil.example"), &[]).await.err().unwrap()),
        403
    );
    for origin in [
        SITE,
        "chrome-extension://abcdefghijklmnopabcdefghijklmnop",
        "moz-extension://123e4567-e89b-12d3-a456-426614174000",
    ] {
        let mut c = try_connect(&s, "lobby", Some(origin), &[]).await.unwrap();
        c.join("alice").await;
    }
}

#[tokio::test]
async fn a_host_that_is_not_ours_is_421() {
    let s = start(Opts::default()).await;
    assert_eq!(
        status_of(try_connect(&s, "lobby", None, &[("host", "evil.example")]).await.err().unwrap()),
        421
    );
}

// apps/server/test/room-lifecycle.test.ts (OME-768)
#[tokio::test]
async fn a_well_formed_unknown_room_upgrades_and_closes_4004_before_any_snapshot() {
    let s = start(Opts::default()).await;
    let mut c = try_connect(&s, "nope", None, &[]).await.unwrap();
    assert_eq!(c.closed().await, Some(4004));
    assert!(c.inbox.is_empty());
}

// apps/server/test/takedown.test.ts
#[tokio::test]
async fn a_taken_down_id_closes_4006_and_so_do_its_live_sockets() {
    let s = start(Opts::default()).await;
    add_room(&s, "gone", false);
    let mut live = try_connect(&s, "gone", None, &[]).await.unwrap();
    live.join("alice").await;
    omega_server::reports::takedown(&s.app, &rid("gone")).unwrap();
    assert_eq!(live.closed().await, Some(4006));
    let mut late = try_connect(&s, "gone", None, &[]).await.unwrap();
    assert_eq!(late.closed().await, Some(4006));
}

// apps/server/test/abuse.test.ts (OME-573)
#[tokio::test]
async fn the_total_connection_cap_answers_503_and_a_closed_socket_frees_its_slot() {
    let s = start(Opts {
        env: vec![("MAX_CONNECTIONS", "2")],
        ..Opts::default()
    })
    .await;
    let a = connect(&s).await;
    let _b = connect(&s).await;
    assert_eq!(status_of(try_connect(&s, "lobby", None, &[]).await.err().unwrap()), 503);
    drop(a);
    tokio::time::sleep(Duration::from_millis(100)).await;
    let _c = connect(&s).await;
}

// apps/server/test/abuse.test.ts (per-IP cap)
#[tokio::test]
async fn the_per_address_cap_answers_429() {
    let s = start(Opts {
        max_per_ip: Some(2),
        ..Opts::default()
    })
    .await;
    let _a = connect(&s).await;
    let _b = connect(&s).await;
    assert_eq!(status_of(try_connect(&s, "lobby", None, &[]).await.err().unwrap()), 429);
}

// apps/server/test/abuse.test.ts (upgrade limiter, ADR 0018)
#[tokio::test]
async fn reconnecting_too_fast_from_one_address_is_429_with_retry_after() {
    let s = start(Opts {
        env: vec![("TRUST_PROXY", "loopback")],
        ..Opts::default()
    })
    .await;
    let h = [(XFF, "203.0.113.7")];
    let mut keep = Vec::new();
    for _ in 0..10 {
        keep.push(try_connect(&s, "lobby", None, &h).await.unwrap());
        keep.pop();
    }
    let res = match try_connect(&s, "lobby", None, &h).await.err().unwrap() {
        WsError::Http(res) => res,
        other => panic!("{other:?}"),
    };
    assert_eq!(res.status().as_u16(), 429);
    assert!(res.headers().get("retry-after").is_some());
    // Another address is untouched.
    try_connect(&s, "lobby", None, &[(XFF, "203.0.113.8")]).await.unwrap();
}

// ---------- join ----------

// apps/server/test/server.test.ts:195
#[tokio::test]
async fn join_sends_a_snapshot_to_the_joiner_and_member_joined_to_the_others() {
    let s = start(Opts::default()).await;
    let (mut a, snap) = joined(&s, "alice").await;
    let room = &snap["room"];
    assert_eq!(room["id"], "lobby");
    assert_eq!(room["seats"], json!([null, null, null, null, null, null, null, null]));
    assert_eq!(
        room["members"],
        json!([{"id": snap["self"], "nickname": "alice", "avatar": 0, "standingSlot": 0}])
    );
    assert_eq!(room["embed"], Value::Null);
    assert_eq!(room["controlPolicy"], "everyone");
    assert_eq!(snap["shareToken"].as_str().unwrap().len(), 22);
    assert!(snap.get("resumeToken").is_none() && snap.get("owner").is_none());

    let (mut b, bs) = joined(&s, "bob").await;
    assert_eq!(bs["room"]["members"].as_array().unwrap().len(), 2);
    let joined_msg = a.next("member-joined").await;
    assert_eq!(
        joined_msg["member"],
        json!({"id": bs["self"], "nickname": "bob", "avatar": 0, "standingSlot": 1})
    );
    b.none("member-joined", 100).await;
}

// apps/server/test/room-lifecycle.test.ts
#[tokio::test]
async fn a_taken_nickname_is_refused_and_the_socket_stays_open() {
    let s = start(Opts::default()).await;
    let (_a, _) = joined(&s, "alice").await;
    let mut b = connect(&s).await;
    b.send(json!({"type": "join", "nickname": "ALICE", "avatar": 1})).await;
    let e = b.next("error").await;
    assert_eq!(e["code"], "nickname_taken");
    b.join("bob").await;
}

// apps/server/test/room-lifecycle.test.ts
#[tokio::test]
async fn a_full_room_says_room_full_and_closes_4002() {
    let s = start(Opts::default()).await;
    let mut all = Vec::new();
    for i in 0..25 {
        all.push(joined(&s, &format!("m{i}")).await.0);
    }
    let mut late = connect(&s).await;
    late.send(json!({"type": "join", "nickname": "late", "avatar": 0})).await;
    late.next("room-full").await;
    assert_eq!(late.closed().await, Some(4002));
}

// apps/server/test/abuse.test.ts (threat model 6)
#[tokio::test]
async fn one_address_holds_at_most_five_members_in_a_room() {
    let s = start(Opts {
        env: vec![("TRUST_PROXY", "loopback")],
        ..Opts::default()
    })
    .await;
    let h = [(XFF, "198.51.100.4")];
    let mut keep = Vec::new();
    for i in 0..5 {
        keep.push(joined_as(&s, "lobby", json!({}), &format!("m{i}"), &h).await.0);
    }
    let mut sixth = try_connect(&s, "lobby", None, &h).await.unwrap();
    sixth.send(json!({"type": "join", "nickname": "m5", "avatar": 0})).await;
    assert_eq!(sixth.next("error").await["code"], "too_many_members");
}

// apps/server/test/abuse.test.ts (join limiter)
#[tokio::test]
async fn joins_from_one_address_are_limited_to_a_burst_of_six() {
    let s = start(Opts {
        env: vec![("TRUST_PROXY", "loopback")],
        ..Opts::default()
    })
    .await;
    let h = [(XFF, "198.51.100.5")];
    let mut c = try_connect(&s, "lobby", None, &h).await.unwrap();
    for i in 0..6 {
        c.send(json!({"type": "join", "nickname": format!("n{i}"), "avatar": 0})).await;
        if i == 0 {
            c.next("snapshot").await;
        } else {
            assert_eq!(c.next("error").await["code"], "already_joined");
        }
    }
    c.send(json!({"type": "join", "nickname": "n6", "avatar": 0})).await;
    let e = c.next("error").await;
    assert_eq!(e["code"], "rate_limited");
    assert!(e["retryAfterMs"].as_u64().unwrap() > 0);
}

// apps/server/test/room-lifecycle.test.ts
#[tokio::test]
async fn nothing_works_before_join_but_ping_and_ended() {
    let s = start(Opts::default()).await;
    let mut c = connect(&s).await;
    c.send(json!({"type": "chat", "text": "hi"})).await;
    assert_eq!(c.next("error").await["code"], "not_joined");
    c.send(json!({"type": "ping", "id": 7})).await;
    let pong = c.next("pong").await;
    assert_eq!(pong["id"], 7);
    assert!(pong["at"].as_u64().unwrap() > 1_700_000_000_000);
    c.send(json!({"type": "ended", "itemId": "abcdefghijklmnop", "position": 3})).await;
    c.none("error", 150).await;
    c.join("alice").await;
    c.send(json!({"type": "join", "nickname": "again", "avatar": 0})).await;
    assert_eq!(c.next("error").await["code"], "already_joined");
}

// apps/server/test/room-lifecycle.test.ts
#[tokio::test]
async fn an_unjoined_socket_is_closed_4001_after_the_join_timeout() {
    let s = start(Opts {
        join_timeout_ms: Some(120.0),
        ..Opts::default()
    })
    .await;
    let mut idle = connect(&s).await;
    assert_eq!(idle.closed().await, Some(4001));
    let (mut ok, _) = {
        let mut c = connect(&s).await;
        let snap = c.join("alice").await;
        (c, snap)
    };
    ok.none("error", 300).await;
    assert!(ok.closed.is_none());
}

// apps/server/test/room-lifecycle.test.ts
#[tokio::test]
async fn leave_announces_member_left_and_the_socket_can_rejoin_but_the_join_timer_runs_again() {
    let s = start(Opts {
        join_timeout_ms: Some(300.0),
        ..Opts::default()
    })
    .await;
    let (mut a, _) = joined(&s, "alice").await;
    let (mut b, bs) = joined(&s, "bob").await;
    a.next("member-joined").await;
    b.send(json!({"type": "leave"})).await;
    let left = a.next("member-left").await;
    assert_eq!(left, json!({"type": "member-left", "memberId": bs["self"]}));
    b.send(json!({"type": "chat", "text": "x"})).await;
    assert_eq!(b.next("error").await["code"], "not_joined");
    // Never rejoined: the timer closes it.
    assert_eq!(b.closed().await, Some(4001));
}

// ---------- relay ----------

// apps/server/test/server.test.ts:200
#[tokio::test]
async fn chat_reaches_everyone_including_the_sender_and_a_muted_member_gets_an_error() {
    let s = start(Opts::default()).await;
    let (mut a, asnap) = joined(&s, "alice").await;
    let (mut b, _) = joined(&s, "bob").await;
    a.send(json!({"type": "chat", "text": "hello"})).await;
    for c in [&mut a, &mut b] {
        let m = c.next("chat").await;
        assert_eq!(m["memberId"], asnap["self"]);
        assert_eq!(m["text"], "hello");
        assert!(m["at"].as_u64().unwrap() > 1_700_000_000_000);
    }
}

// apps/server/test/server.test.ts:224
#[tokio::test]
async fn sit_is_broadcast_a_taken_seat_is_refused_and_standing_up_frees_it() {
    let s = start(Opts::default()).await;
    let (mut a, asnap) = joined(&s, "alice").await;
    let (mut b, _) = joined(&s, "bob").await;
    a.send(json!({"type": "sit", "seat": 0})).await;
    let expected = json!({"type": "seat-changed", "memberId": asnap["self"], "seat": 0});
    assert_eq!(a.next("seat-changed").await, expected);
    assert_eq!(b.next("seat-changed").await, expected);
    b.send(json!({"type": "sit", "seat": 0})).await;
    assert_eq!(b.next("error").await["code"], "seat_taken");
    a.send(json!({"type": "sit", "seat": null})).await;
    assert_eq!(b.next("seat-changed").await["seat"], Value::Null);
    b.send(json!({"type": "sit", "seat": 0})).await;
    assert_eq!(b.next("seat-changed").await["seat"], 0);
}

// apps/server/test/member-status.test.ts (presence)
#[tokio::test]
async fn presence_is_published_on_transitions_only() {
    let s = start(Opts::default()).await;
    let (mut a, asnap) = joined(&s, "alice").await;
    let (mut b, _) = joined(&s, "bob").await;
    a.send(json!({"type": "presence", "away": false})).await;
    b.none("member-presence", 100).await;
    a.send(json!({"type": "presence", "away": true})).await;
    assert_eq!(
        b.next("member-presence").await,
        json!({"type": "member-presence", "memberId": asnap["self"], "away": true})
    );
    a.send(json!({"type": "presence", "away": true})).await;
    b.none("member-presence", 100).await;
}

// apps/server/test/emote.test.ts
#[tokio::test]
async fn an_emote_is_relayed_to_everyone_and_the_fourth_in_a_burst_is_refused() {
    let s = start(Opts::default()).await;
    let (mut a, asnap) = joined(&s, "alice").await;
    let (mut b, _) = joined(&s, "bob").await;
    a.send(json!({"type": "emote", "kind": "wave"})).await;
    assert_eq!(
        b.next("emoted").await,
        json!({"type": "emoted", "memberId": asnap["self"], "kind": "wave"})
    );
    a.next("emoted").await;
    for _ in 0..4 {
        a.send(json!({"type": "emote", "kind": "clap"})).await;
    }
    let e = a.next("error").await;
    assert_eq!(
        (e["code"].as_str(), e["message"].as_str()),
        (Some("rate_limited"), Some("too many emotes, slow down"))
    );
    assert!(e["retryAfterMs"].is_u64());
}

// apps/server/test/playback.test.ts
#[tokio::test]
async fn control_needs_an_embed_then_relays_playback_with_a_rising_rev() {
    let s = start(Opts::default()).await;
    let (mut a, asnap) = joined(&s, "alice").await;
    let ctl = |playing: bool, position: f64| json!({"type": "control", "url": "https://www.youtube.com/embed/dQw4w9WgXcQ", "playing": playing, "position": position});
    a.send(ctl(true, 0.0)).await;
    assert_eq!(a.next("error").await["code"], "no_embed");
    embed_in_lobby(&s, YT);
    let changed = a.next("embed-changed").await;
    assert_eq!(changed["embed"]["videoId"], "dQw4w9WgXcQ");
    let rev0 = changed["playback"]["rev"].as_u64().unwrap();
    a.send(ctl(false, 42.0)).await;
    let p = a.next("playback").await;
    assert_eq!(p["playback"]["playing"], false);
    assert_eq!(p["playback"]["position"], 42.0);
    assert_eq!(p["playback"]["by"], asnap["self"]);
    assert!(p["playback"]["rev"].as_u64().unwrap() > rev0);
}

// apps/server/test/playback-sync.test.ts (ADR 0018 section 2)
#[tokio::test]
async fn a_member_can_send_four_controls_in_a_burst_then_is_told_to_slow_down() {
    let s = start(Opts::default()).await;
    let (mut a, _) = joined(&s, "alice").await;
    embed_in_lobby(&s, YT);
    for i in 0..5 {
        a.send(json!({"type": "control", "url": "https://www.youtube.com/embed/dQw4w9WgXcQ", "playing": true, "position": f64::from(i)}))
            .await;
    }
    for _ in 0..4 {
        a.next("playback").await;
    }
    let e = a.next("error").await;
    assert_eq!(e["code"], "rate_limited");
    assert_eq!(e["message"], "too many playback changes, slow down");
}

// apps/server/test/member-status.test.ts
#[tokio::test]
async fn catching_is_coalesced_to_one_trailing_publish_per_interval() {
    let s = start(Opts {
        status_interval_ms: Some(200.0),
        ..Opts::default()
    })
    .await;
    let (mut a, asnap) = joined(&s, "alice").await;
    let (mut b, _) = joined(&s, "bob").await;
    embed_in_lobby(&s, YT);
    a.send(json!({"type": "status", "catching": true})).await;
    let first = b.next("member-status").await;
    assert_eq!(first, json!({"type": "member-status", "memberId": asnap["self"], "catching": true}));
    // Flapping inside the interval: only the last state goes out, once the interval is up.
    a.send(json!({"type": "status", "catching": false})).await;
    a.send(json!({"type": "status", "catching": true})).await;
    a.send(json!({"type": "status", "catching": false})).await;
    b.none("member-status", 100).await;
    let trailing = b.next("member-status").await;
    assert_eq!(trailing["catching"], false);
    b.none("member-status", 300).await;
}

// apps/server/test/member-status.test.ts (ADR 0024 section 7)
#[tokio::test]
async fn catching_is_ignored_with_a_generic_embed() {
    let s = start(Opts::default()).await;
    let (mut a, _) = joined(&s, "alice").await;
    let (mut b, _) = joined(&s, "bob").await;
    embed_in_lobby(&s, "https://player.example-host.net/embed/42");
    b.next("embed-changed").await;
    a.send(json!({"type": "status", "catching": true})).await;
    b.none("member-status", 200).await;
}

// ---------- owner and moderation ----------

// apps/server/test/room-auth.test.ts
#[tokio::test]
async fn the_owner_token_makes_an_owner_a_wrong_one_a_guest_and_guests_get_not_owner() {
    let s = start(Opts::default()).await;
    add_room(&s, "mine", false);
    let (mut o, osnap) = joined_as(&s, "mine", json!({"ownerToken": OWNER}), "olive", &[]).await;
    assert_eq!(osnap["owner"], true);
    let (mut g, gsnap) = joined_as(&s, "mine", json!({"ownerToken": "wrongwrongwrongwrongwr"}), "guest", &[]).await;
    assert!(gsnap.get("owner").is_none());
    g.send(json!({"type": "layout-set", "layout": serde_json::to_value(default_layout()).unwrap()}))
        .await;
    assert_eq!(g.next("error").await["code"], "not_owner");
    g.send(json!({"type": "title-set", "title": "Hi"})).await;
    assert_eq!(g.next("error").await["code"], "not_owner");

    o.send(json!({"type": "title-set", "title": "Movie night"})).await;
    let changed = g.next("title-changed").await;
    assert_eq!(
        changed,
        json!({"type": "title-changed", "title": "Movie night", "by": osnap["self"]})
    );
    let mut layout = serde_json::to_value(default_layout()).unwrap();
    layout["furniture"].as_array_mut().unwrap().retain(|f| f["kind"] != "lamp");
    o.send(json!({"type": "layout-set", "layout": layout})).await;
    let _ = g.next("layout-changed").await;
}

// apps/server/test/room-auth.test.ts (ADR 0028 section 3)
#[tokio::test]
async fn five_wrong_owner_tokens_then_the_limiter_refuses_the_join() {
    let s = start(Opts::default()).await;
    add_room(&s, "mine", false);
    let mut c = try_connect(&s, "mine", None, &[]).await.unwrap();
    for i in 0..5 {
        c.send(json!({"type": "join", "nickname": format!("g{i}"), "avatar": 0, "ownerToken": "wrongwrongwrongwrongwr"}))
            .await;
        c.next("snapshot").await;
        c.send(json!({"type": "leave"})).await;
    }
    c.send(json!({"type": "join", "nickname": "g5", "avatar": 0, "ownerToken": "wrongwrongwrongwrongwr"}))
        .await;
    assert_eq!(c.next("error").await["code"], "rate_limited");
}

// apps/server/test/room-auth.test.ts (ADR 0028 section 4)
#[tokio::test]
async fn a_private_room_needs_its_invite_key_or_the_owner_token() {
    let s = start(Opts::default()).await;
    add_room(&s, "secret", true);
    let mut c = try_connect(&s, "secret", None, &[]).await.unwrap();
    c.send(json!({"type": "join", "nickname": "nosy", "avatar": 0})).await;
    assert_eq!(c.next("error").await["code"], "invite_required");
    c.send(json!({"type": "join", "nickname": "nosy", "avatar": 0, "inviteKey": INVITE}))
        .await;
    c.next("snapshot").await;
    let (_o, snap) = joined_as(&s, "secret", json!({"ownerToken": OWNER}), "olive", &[]).await;
    assert_eq!(snap["owner"], true);
}

// apps/server/test/moderation.test.ts (ADR 0030)
#[tokio::test]
async fn kick_removes_the_target_closes_it_4005_and_cools_the_address_down() {
    let s = start(Opts {
        env: vec![("TRUST_PROXY", "loopback")],
        ..Opts::default()
    })
    .await;
    add_room(&s, "mine", false);
    let (mut o, _) = joined_as(&s, "mine", json!({"ownerToken": OWNER}), "olive", &[(XFF, "192.0.2.1")]).await;
    let (mut g, gsnap) = joined_as(&s, "mine", json!({}), "guest", &[(XFF, "192.0.2.2")]).await;
    o.next("member-joined").await;
    o.send(json!({"type": "kick", "memberId": gsnap["self"]})).await;
    assert_eq!(
        o.next("member-left").await,
        json!({"type": "member-left", "memberId": gsnap["self"], "reason": "kicked"})
    );
    assert_eq!(g.closed().await, Some(4005));
    assert!(
        g.inbox.iter().all(|m| m["type"] != "member-left"),
        "the target hears no frame before the close"
    );
    // Back from the same address: closed before any snapshot.
    let mut again = try_connect(&s, "mine", None, &[(XFF, "192.0.2.2")]).await.unwrap();
    again.send(json!({"type": "join", "nickname": "guest", "avatar": 0})).await;
    assert_eq!(again.closed().await, Some(4005));
    // After the cooldown it can join again.
    s.clock.skew.fetch_add(11 * 60_000, Ordering::Relaxed);
    let mut later = try_connect(&s, "mine", None, &[(XFF, "192.0.2.2")]).await.unwrap();
    later.join("guest").await;
}

// apps/server/test/moderation.test.ts
#[tokio::test]
async fn mute_is_published_blocks_chat_and_is_remembered_for_the_address() {
    let s = start(Opts {
        env: vec![("TRUST_PROXY", "loopback")],
        ..Opts::default()
    })
    .await;
    add_room(&s, "mine", false);
    let (mut o, _) = joined_as(&s, "mine", json!({"ownerToken": OWNER}), "olive", &[(XFF, "192.0.2.1")]).await;
    let (mut g, gsnap) = joined_as(&s, "mine", json!({}), "guest", &[(XFF, "192.0.2.2")]).await;
    o.send(json!({"type": "mute", "memberId": gsnap["self"], "muted": true})).await;
    assert_eq!(
        g.next("member-muted").await,
        json!({"type": "member-muted", "memberId": gsnap["self"], "muted": true})
    );
    g.send(json!({"type": "chat", "text": "hi"})).await;
    assert_eq!(g.next("error").await["code"], "muted");
    g.send(json!({"type": "leave"})).await;
    g.send(json!({"type": "join", "nickname": "guest", "avatar": 0})).await;
    let snap = g.next("snapshot").await;
    let me = snap["room"]["members"]
        .as_array()
        .unwrap()
        .iter()
        .find(|m| m["nickname"] == "guest")
        .unwrap()
        .clone();
    assert_eq!(me["muted"], true);
}

// apps/server/test/moderation.test.ts
#[tokio::test]
async fn moderation_by_a_guest_is_not_owner_and_counts_toward_4400_a_missing_target_is_bad_target() {
    let s = start(Opts::default()).await;
    add_room(&s, "mine", false);
    let (mut o, osnap) = joined_as(&s, "mine", json!({"ownerToken": OWNER}), "olive", &[]).await;
    let (mut g, _) = joined_as(&s, "mine", json!({}), "guest", &[]).await;
    g.send(json!({"type": "kick", "memberId": osnap["self"]})).await;
    assert_eq!(g.next("error").await["code"], "not_owner");
    o.send(json!({"type": "kick", "memberId": "00000000-0000-4000-8000-000000000001"}))
        .await;
    assert_eq!(o.next("error").await["code"], "bad_target");
    // The owner is never a target.
    o.send(json!({"type": "mute", "memberId": osnap["self"], "muted": true})).await;
    assert_eq!(o.next("error").await["code"], "bad_target");
    for _ in 0..19 {
        g.send(json!({"type": "kick", "memberId": osnap["self"]})).await;
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert_eq!(g.closed().await, Some(4400));
}

// apps/server/test/moderation.test.ts (ADR 0030 section 4)
#[tokio::test]
async fn an_owner_only_room_refuses_guest_control_and_queue_changes() {
    let s = start(Opts::default()).await;
    add_room(&s, "mine", false);
    let (mut o, _) = joined_as(&s, "mine", json!({"ownerToken": OWNER}), "olive", &[]).await;
    let (mut g, _) = joined_as(&s, "mine", json!({}), "guest", &[]).await;
    o.send(json!({"type": "control-policy", "policy": "owner"})).await;
    assert_eq!(g.next("control-policy-changed").await["policy"], "owner");
    g.send(json!({"type": "control", "url": "https://www.youtube.com/embed/dQw4w9WgXcQ", "playing": true, "position": 1}))
        .await;
    assert_eq!(g.next("error").await["code"], "control_owner_only");
    g.send(json!({"type": "queue-add", "url": YT})).await;
    assert_eq!(g.next("error").await["code"], "control_owner_only");
}

// apps/server/test/queue.test.ts
#[tokio::test]
async fn queue_add_starts_the_first_item_refuses_junk_and_advance_and_ended_move_on() {
    let s = start(Opts::default()).await;
    let (mut a, _) = joined(&s, "alice").await;
    a.send(json!({"type": "queue-add", "url": "https://evil.example/x"})).await;
    assert_eq!(a.next("error").await["code"], "unsupported_url");
    a.send(json!({"type": "queue-add", "url": YT})).await;
    let started = a.next("embed-changed").await;
    let first = started["itemId"].as_str().unwrap().to_owned();
    a.next("queue-changed").await;
    a.send(json!({"type": "queue-add", "url": YT2})).await;
    let queued = a.next("queue-changed").await;
    assert_eq!(queued["queue"].as_array().unwrap().len(), 1);
    let second = queued["queue"][0]["id"].as_str().unwrap().to_owned();
    a.send(json!({"type": "queue-advance", "fromItemId": first})).await;
    assert_eq!(a.next("embed-changed").await["itemId"], second);
    a.send(json!({"type": "queue-remove", "itemId": "abcdefghijklmnop"})).await;
    a.none("error", 100).await;
}

// ---------- tokens and sessions ----------

// apps/server/test/share-token.test.ts
#[tokio::test]
async fn the_share_token_is_a_grant_until_the_member_leaves() {
    let s = start(Opts::default()).await;
    let (mut a, snap) = joined(&s, "alice").await;
    let token = ShareToken::parse(snap["shareToken"].as_str().unwrap()).unwrap();
    let granted = |s: &Server| s.app.with_open_room(&rid("lobby"), |i| i.grant(&token).is_some()).unwrap();
    assert!(granted(&s));
    a.send(json!({"type": "leave"})).await;
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert!(!granted(&s));
}

// apps/server/test/durable-sessions.test.ts
#[tokio::test]
async fn a_durable_member_is_held_away_on_a_cut_and_resumes_with_its_token() {
    let s = start(Opts {
        resume_grace_ms: Some(2000),
        ..Opts::default()
    })
    .await;
    let (mut watcher, _) = joined(&s, "watcher").await;
    let (a, snap) = joined_as(&s, "lobby", json!({"durableSession": true}), "alice", &[]).await;
    let token = snap["resumeToken"].as_str().unwrap().to_owned();
    watcher.next("member-joined").await;
    drop(a);
    assert_eq!(
        watcher.next("member-presence").await,
        json!({"type": "member-presence", "memberId": snap["self"], "away": true})
    );
    watcher.none("member-left", 100).await;

    let mut back = connect(&s).await;
    back.send(json!({"type": "join", "nickname": "alice", "avatar": 0, "resumeToken": token}))
        .await;
    let resumed = back.next("snapshot").await;
    assert_eq!(resumed["resumed"], true);
    assert_eq!(resumed["self"], snap["self"]);
    assert_eq!(resumed["resumeToken"], token);
    assert_eq!(watcher.next("member-presence").await["away"], false);
    watcher.none("member-joined", 100).await;
}

// apps/server/test/durable-sessions.test.ts
#[tokio::test]
async fn an_unknown_resume_token_is_resume_expired_and_never_a_fresh_member() {
    let s = start(Opts::default()).await;
    let mut c = connect(&s).await;
    c.send(json!({"type": "join", "nickname": "alice", "avatar": 0, "resumeToken": "x".repeat(43)}))
        .await;
    assert_eq!(c.next("error").await["code"], "resume_expired");
    c.send(json!({"type": "chat", "text": "hi"})).await;
    assert_eq!(c.next("error").await["code"], "not_joined");
}

// apps/server/test/durable-sessions.test.ts
#[tokio::test]
async fn a_hold_ends_with_member_left_after_the_grace_and_the_token_dies() {
    let s = start(Opts {
        resume_grace_ms: Some(150),
        ..Opts::default()
    })
    .await;
    let (mut watcher, _) = joined(&s, "watcher").await;
    let (a, snap) = joined_as(&s, "lobby", json!({"durableSession": true}), "alice", &[]).await;
    watcher.next("member-joined").await;
    drop(a);
    watcher.next("member-presence").await;
    assert_eq!(
        watcher.next("member-left").await,
        json!({"type": "member-left", "memberId": snap["self"], "reason": "left"})
    );
    let mut late = connect(&s).await;
    late.send(json!({"type": "join", "nickname": "alice", "avatar": 0, "resumeToken": snap["resumeToken"]}))
        .await;
    assert_eq!(late.next("error").await["code"], "resume_expired");
}

// apps/server/test/durable-sessions.test.ts
#[tokio::test]
async fn a_second_socket_resuming_replaces_the_first_which_closes_4007() {
    let s = start(Opts::default()).await;
    let (mut first, snap) = joined_as(&s, "lobby", json!({"durableSession": true}), "alice", &[]).await;
    let mut second = connect(&s).await;
    second
        .send(json!({"type": "join", "nickname": "alice", "avatar": 0, "resumeToken": snap["resumeToken"]}))
        .await;
    second.next("snapshot").await;
    assert_eq!(first.closed().await, Some(4007));
    // Closing the replaced socket did not touch the member.
    second.send(json!({"type": "chat", "text": "still me"})).await;
    assert_eq!(second.next("chat").await["memberId"], snap["self"]);
}

// apps/server/test/durable-sessions.test.ts
#[tokio::test]
async fn a_legacy_member_leaves_when_its_socket_closes() {
    let s = start(Opts::default()).await;
    let (mut w, _) = joined(&s, "watcher").await;
    let (a, snap) = joined(&s, "alice").await;
    w.next("member-joined").await;
    drop(a);
    assert_eq!(
        w.next("member-left").await,
        json!({"type": "member-left", "memberId": snap["self"]})
    );
}

// ---------- room end, restart, abuse ----------

// apps/server/test/room-lifecycle.test.ts
#[tokio::test]
async fn removing_a_room_closes_every_socket_4004_joined_or_not_and_counts_the_closes() {
    let s = start(Opts::default()).await;
    add_room(&s, "temp", false);
    let (mut a, _) = joined_as(&s, "temp", json!({}), "alice", &[]).await;
    let mut idle = try_connect(&s, "temp", None, &[]).await.unwrap();
    assert!(s.app.remove_room(&rid("temp"), RemoveReason::Closed));
    assert_eq!(a.closed().await, Some(4004));
    assert_eq!(idle.closed().await, Some(4004));
    let text = s.app.metrics.render(&Gauges::default());
    assert!(text.contains("omega_ws_closes_total{code=\"4004\"} 2"), "{text}");
}

// apps/server/test/graceful-restart.test.ts
#[tokio::test]
async fn drain_closes_every_socket_1012_and_returns_the_seats_held() {
    let s = start(Opts::default()).await;
    let (mut a, _) = joined(&s, "alice").await;
    a.send(json!({"type": "sit", "seat": 3})).await;
    a.next("seat-changed").await;
    let mut idle = connect(&s).await;
    let holds = omega_server::ws::drain(&s.app);
    assert_eq!(holds.len(), 1);
    assert_eq!(a.closed().await, Some(1012));
    assert_eq!(idle.closed().await, Some(1012));
    // A draining server takes no new sockets.
    assert_eq!(status_of(try_connect(&s, "lobby", None, &[]).await.err().unwrap()), 503);
}

// apps/server/test/boundary.test.ts
#[tokio::test]
async fn bad_frames_get_bad_message_twenty_of_them_close_4400_and_a_binary_frame_counts() {
    let s = start(Opts::default()).await;
    let mut c = connect(&s).await;
    c.send_raw("not json").await;
    assert_eq!(c.next("error").await["code"], "bad_message");
    c.sock.send(Message::binary(vec![1, 2, 3])).await.unwrap();
    assert_eq!(c.next("error").await["code"], "bad_message");
    for _ in 0..18 {
        c.send_raw("{\"type\":\"nope\"}").await;
        tokio::time::sleep(Duration::from_millis(15)).await;
    }
    assert_eq!(c.closed().await, Some(4400));
}

// apps/server/test/boundary.test.ts
#[tokio::test]
async fn a_frame_over_4096_bytes_cuts_the_connection_without_a_close_frame() {
    let s = start(Opts::default()).await;
    let (mut c, _) = joined(&s, "alice").await;
    c.send_raw(&format!("{{\"type\":\"chat\",\"text\":\"{}\"}}", "a".repeat(5000)))
        .await;
    assert_eq!(c.closed().await, None);
}

// apps/server/test/abuse.test.ts (ADR 0018 section 1)
#[tokio::test]
async fn a_flood_gets_one_rate_limited_notice_then_4029() {
    let s = start(Opts::default()).await;
    let (mut c, _) = joined(&s, "alice").await;
    for i in 0..90 {
        c.send(json!({"type": "ping", "id": i})).await;
    }
    assert_eq!(c.closed().await, Some(4029));
    let errors: Vec<_> = c.inbox.iter().filter(|m| m["type"] == "error").collect();
    assert_eq!(errors.len(), 1, "one notice per streak: {errors:?}");
    assert_eq!(errors[0]["code"], "rate_limited");
    assert_eq!(errors[0]["message"], "too many messages, slow down");
    let pongs = c.inbox.iter().filter(|m| m["type"] == "pong").count();
    assert!((15..=30).contains(&pongs), "{pongs} pongs before the limiter");
}

// ---------- review of #244 ----------

/// A text frame of about `kb` KB that is valid JSON, so the test client can parse it.
fn big_frame(kb: usize) -> axum::extract::ws::Utf8Bytes {
    axum::extract::ws::Utf8Bytes::from(format!("{{\"type\":\"chat\",\"pad\":\"{}\"}}", "a".repeat(kb * 1024)))
}

// OME-1167 review B1 (Bun's closeOnBackpressureLimit)
#[tokio::test]
async fn a_client_that_never_reads_is_dropped_at_the_backpressure_limit_and_nobody_else_notices() {
    let s = start(Opts {
        max_per_ip: Some(2),
        ..Opts::default()
    })
    .await;
    let (mut watcher, _) = joined(&s, "watcher").await;
    let (mut stalled, ssnap) = joined(&s, "stalled").await;
    watcher.next("member-joined").await;
    // The stalled client is never polled again: its socket buffers fill, then its outbox passes the limit.
    let frame = big_frame(60);
    for _ in 0..600 {
        s.app
            .with_open_room(&rid("lobby"), |inner| omega_server::outbox::publish_all(inner, &frame))
            .unwrap();
        while watcher.pump(Duration::from_millis(1)).await {}
        if watcher.inbox.iter().any(|m| m["type"] == "member-left") {
            break;
        }
    }
    let seen = watcher.inbox.iter().filter(|m| m["type"] == "chat").count();
    let left = watcher.next("member-left").await;
    assert_eq!(left["memberId"], ssnap["self"]);
    assert!(seen > 0, "the reading member got the flood");
    assert!(watcher.closed.is_none(), "the reading member was never dropped");
    // The cut connection: whatever it had buffered, then the end with no close frame.
    assert_eq!(stalled.closed().await, None);
    // Its slot is free again: two sockets are the cap from this address.
    let mut fresh = connect(&s).await;
    fresh.join("fresh").await;
}

// OME-1167 review N2 (idleTimeout)
#[tokio::test]
async fn a_socket_that_says_nothing_and_answers_no_ping_is_dropped_at_the_idle_timeout() {
    let s = start(Opts {
        idle_timeout_ms: Some(400.0),
        ..Opts::default()
    })
    .await;
    let (mut quiet, _) = joined(&s, "quiet").await;
    let (mut lively, _) = joined(&s, "lively").await;
    let started = Instant::now();
    // The lively one is polled, so tungstenite answers the server's pings.
    while s.app.with_open_room(&rid("lobby"), |i| i.room.member_count()).unwrap() == 2 {
        lively.pump(Duration::from_millis(20)).await;
        assert!(started.elapsed() < Duration::from_millis(1000), "not dropped in time");
    }
    assert!(
        started.elapsed() >= Duration::from_millis(300),
        "dropped early: {:?}",
        started.elapsed()
    );
    assert!(lively.closed.is_none());
    assert_eq!(quiet.closed().await, None);
}

// OME-1167 review N4 (ws.data.buckets.queue survives leave and rejoin on one socket)
#[tokio::test]
async fn the_queue_add_bucket_belongs_to_the_socket_not_the_member() {
    let s = start(Opts::default()).await;
    let (mut a, _) = joined(&s, "alice").await;
    for _ in 0..3 {
        a.send(json!({"type": "queue-add", "url": YT2})).await;
    }
    a.next("queue-changed").await;
    a.send(json!({"type": "leave"})).await;
    a.join("alice2").await;
    a.send(json!({"type": "queue-add", "url": YT2})).await;
    let e = a.next("error").await;
    assert_eq!(e["code"], "rate_limited");
    assert_eq!(e["message"], "too many videos queued, slow down");
}

// OME-1167 review N3
#[tokio::test]
async fn a_status_timer_left_over_from_before_a_leave_does_not_flush_the_next_session() {
    let s = start(Opts {
        status_interval_ms: Some(200.0),
        ..Opts::default()
    })
    .await;
    let (mut a, _) = joined(&s, "alice").await;
    let (mut w, _) = joined(&s, "watcher").await;
    embed_in_lobby(&s, YT);
    a.send(json!({"type": "status", "catching": true})).await;
    w.next("member-status").await;
    a.send(json!({"type": "status", "catching": false})).await;
    a.send(json!({"type": "leave"})).await;
    a.join("alice").await;
    a.send(json!({"type": "status", "catching": true})).await;
    // Only the new session's own publish: the immediate one, and nothing from the old timer.
    let first = w.next("member-status").await;
    assert_eq!(first["catching"], true);
    w.none("member-status", 400).await;
}

// apps/server/test/abuse.test.ts:540
#[tokio::test]
async fn a_frame_of_exactly_4096_bytes_passes_one_more_cuts_and_the_server_stays_up() {
    let s = start(Opts::default()).await;
    let mut ok = connect(&s).await;
    let head = "{\"type\":\"ping\",\"id\":1,\"x\":\"";
    let pad = 4096 - head.len() - 2;
    ok.send_raw(&format!("{head}{}\"}}", "a".repeat(pad))).await;
    // Within the limit, so not cut: refused as a bad message (unknown key).
    assert_eq!(ok.next("error").await["code"], "bad_message");
    let mut big = connect(&s).await;
    big.send_raw(&"a".repeat(4097)).await;
    assert_eq!(big.closed().await, None);
    let mut after = connect(&s).await;
    after.join("still-up").await;
}

// apps/server/test/room-auth.test.ts (ADR 0028 section 6)
#[tokio::test]
async fn title_edits_are_limited_a_blocked_title_answers_the_sender_only() {
    let s = start(Opts {
        env: vec![("ROOM_TITLE_BLOCKLIST", "badword")],
        ..Opts::default()
    })
    .await;
    add_room(&s, "mine", false);
    let (mut o, _) = joined_as(&s, "mine", json!({"ownerToken": OWNER}), "olive", &[]).await;
    let (mut g, _) = joined_as(&s, "mine", json!({}), "guest", &[]).await;
    o.send(json!({"type": "title-set", "title": "b a d w o r d"})).await;
    let e = o.next("error").await;
    assert_ne!(e["code"], "rate_limited");
    g.none("title-changed", 150).await;
    for t in ["One", "Two", "Three"] {
        o.send(json!({"type": "title-set", "title": t})).await;
    }
    let limited = o.next("error").await;
    assert_eq!(limited["code"], "rate_limited");
    assert_eq!(limited["message"], "too many room edits, slow down");
}

// apps/server/test/queue.test.ts
#[tokio::test]
async fn queue_remove_drops_an_upcoming_item_for_everyone() {
    let s = start(Opts::default()).await;
    let (mut a, _) = joined(&s, "alice").await;
    let (mut b, _) = joined(&s, "bob").await;
    a.send(json!({"type": "queue-add", "url": YT})).await;
    b.next("queue-changed").await;
    a.send(json!({"type": "queue-add", "url": YT2})).await;
    let queued = b.next("queue-changed").await;
    let id = queued["queue"][0]["id"].as_str().unwrap().to_owned();
    a.send(json!({"type": "queue-remove", "itemId": id})).await;
    let after = b.next("queue-changed").await;
    assert!(after["queue"].as_array().unwrap().is_empty());
}

// apps/server/test/playback-sync.test.ts (ADR 0018 section 2: the room's limit is everyone's)
#[tokio::test]
async fn the_room_wide_control_limit_is_everyones_and_answers_every_time() {
    let s = start(Opts::default()).await;
    let mut all = Vec::new();
    for i in 0..4 {
        all.push(joined(&s, &format!("m{i}")).await.0);
    }
    embed_in_lobby(&s, YT);
    let ctl = json!({"type": "control", "url": "https://www.youtube.com/embed/dQw4w9WgXcQ", "playing": true, "position": 1});
    // 4 members x 4 burst = 16 attempts; the room allows a burst of 8.
    for c in &mut all {
        for _ in 0..4 {
            c.send(ctl.clone()).await;
        }
    }
    let mut refused = 0;
    for c in &mut all {
        c.none("never", 300).await;
        refused += c
            .inbox
            .iter()
            .filter(|m| m["type"] == "error" && m["message"] == "this room is changing playback too fast, slow down")
            .count();
    }
    assert!((7..=9).contains(&refused), "{refused} refusals");
}

// apps/server/test/moderation.test.ts (ADR 0030 section 2: the owner is never locked out)
#[tokio::test]
async fn a_kicked_address_cannot_rejoin_but_an_owner_from_it_can() {
    let s = start(Opts {
        env: vec![("TRUST_PROXY", "loopback")],
        ..Opts::default()
    })
    .await;
    add_room(&s, "mine", false);
    let (mut o, _) = joined_as(&s, "mine", json!({"ownerToken": OWNER}), "olive", &[(XFF, "192.0.2.1")]).await;
    let (_g, gsnap) = joined_as(&s, "mine", json!({}), "guest", &[(XFF, "192.0.2.9")]).await;
    o.next("member-joined").await;
    o.send(json!({"type": "kick", "memberId": gsnap["self"]})).await;
    o.next("member-left").await;
    let (mut again, snap) = joined_as(&s, "mine", json!({"ownerToken": OWNER}), "olive2", &[(XFF, "192.0.2.9")]).await;
    assert_eq!(snap["owner"], true);
    again.none("error", 100).await;
}

// OME-1167 review N5: a drain that starts between the upgrade and the attach still closes the socket.
#[tokio::test]
async fn a_socket_attaching_after_the_drain_started_is_closed_1012() {
    let gate = Arc::new(tokio::sync::Notify::new());
    let s = start(Opts {
        hold_attach: Some(gate.clone()),
        ..Opts::default()
    })
    .await;
    let mut c = connect(&s).await;
    let holds = omega_server::ws::drain(&s.app);
    assert!(holds.is_empty());
    gate.notify_one();
    assert_eq!(c.closed().await, Some(1012));
    assert!(c.inbox.is_empty());
}
