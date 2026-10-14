//! The HTTP surface end to end, over a real socket, with the app's manual clock: routes, limits, the Host/Origin
//! gate, CORS, body caps, static files. The TS reference is apps/server/test (the `// <path>:<line>` comments).
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    reason = "tests"
)]

use crate::app::App;
use crate::app::testing::{self, ManualClock, T0};
use crate::contract::ids::{MemberId, RoomId};
use crate::outbox::{ConnId, Outbound, OutboxRx, channel};
use crate::registry::ShareGrant;
use crate::room::RoomInit;
use crate::secrets::{mint_member_id, mint_share_token};
use serde_json::Value;
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

const SITE: &str = "http://localhost:5173";
const EXT: &str = "chrome-extension://abcdefghijklmnopabcdefghijklmnop";
const YT: &str = r#"{"url":"https://youtu.be/dQw4w9WgXcQ"}"#;

/// A running server: the app, its manual clock and the address.
struct Fx {
    app: Arc<App>,
    clock: Arc<ManualClock>,
    addr: SocketAddr,
    /// Keeps a built site alive.
    dir: Option<tempfile::TempDir>,
    /// Makes `create` come from a new forwarded client every time.
    clients: std::sync::atomic::AtomicU32,
}

#[derive(Debug)]
struct Resp {
    status: u16,
    reason: String,
    headers: Vec<(String, String)>,
    body: Vec<u8>,
}

impl Resp {
    fn header(&self, name: &str) -> Option<&str> {
        self.headers.iter().find(|(k, _)| k == name).map(|(_, v)| v.as_str())
    }
    fn text(&self) -> String {
        String::from_utf8_lossy(&self.body).into_owned()
    }
    fn json(&self) -> Value {
        serde_json::from_slice(&self.body).unwrap_or_else(|e| panic!("not JSON ({e}): {}", self.text()))
    }
    fn code(&self) -> String {
        self.json()["error"]["code"].as_str().unwrap_or("").to_owned()
    }
}

fn parse(raw: &[u8]) -> Resp {
    let split = raw
        .windows(4)
        .position(|w| w == b"\r\n\r\n")
        .unwrap_or_else(|| panic!("no header end in {:?}", String::from_utf8_lossy(raw)));
    let head = String::from_utf8_lossy(&raw[..split]).into_owned();
    let mut lines = head.split("\r\n");
    let status_line = lines.next().unwrap();
    let mut parts = status_line.splitn(3, ' ');
    assert_eq!(parts.next(), Some("HTTP/1.1"), "{status_line}");
    let status = parts.next().unwrap().parse().unwrap();
    let reason = parts.next().unwrap_or("").to_owned();
    let headers = lines
        .map(|l| {
            let (k, v) = l.split_once(':').unwrap();
            (k.to_owned(), v.trim().to_owned())
        })
        .collect();
    Resp {
        status,
        reason,
        headers,
        body: raw[split + 4..].to_vec(),
    }
}

impl Fx {
    /// A server over a fresh app with the lobby (pinned, no owner).
    async fn start(pairs: &[(&str, &str)]) -> Self {
        let (app, clock) = testing::app_with(testing::config(pairs));
        testing::add_room(
            &app,
            "lobby",
            RoomInit {
                pinned: Some(true),
                ..RoomInit::default()
            },
        );
        Self::serve(app, clock, None).await
    }

    /// With `TRUST_PROXY=loopback`: clients are told apart by `x-forwarded-for` (what the tunnel appends).
    async fn proxied(pairs: &[(&str, &str)]) -> Self {
        let mut all = vec![("TRUST_PROXY", "loopback")];
        all.extend_from_slice(pairs);
        Self::start(&all).await
    }

    /// Over a database file (so a test can break it behind the server's back), with forwarded clients.
    async fn on_file(db: &std::path::Path) -> Self {
        let clock = testing::clock();
        let store = crate::store::Store::open(db.to_str().unwrap()).unwrap();
        let config = testing::config(&[("TRUST_PROXY", "loopback"), ("DB_PATH", db.to_str().unwrap())]);
        let app = Arc::new(App::new(config, clock.clone(), store).unwrap());
        Self::serve(app, clock, None).await
    }

    /// With a built site in `STATIC_DIR`.
    async fn with_site(pairs: &[(&str, &str)]) -> Self {
        let dir = tempfile::Builder::new().prefix("omega-site-").tempdir().unwrap();
        let root = dir.path().join("dist");
        std::fs::create_dir_all(root.join("assets/sub")).unwrap();
        std::fs::write(
            root.join("index.html"),
            r#"<!doctype html><html><head><meta charset="utf-8" /><title>omega</title></head><body><div id="app"></div></body></html>"#,
        )
        .unwrap();
        std::fs::write(
            root.join("privacy.html"),
            r#"<!doctype html><html><head><meta charset="utf-8" /><title>Privacy · omega-share</title><link rel="stylesheet" href="/assets/style-Ab12Cd34.css" /></head><body><main class="privacy"><h1>Privacy</h1><p>We keep nothing.</p></main></body></html>"#,
        )
        .unwrap();
        std::fs::write(root.join("assets/style-Ab12Cd34.css"), "main{}").unwrap();
        std::fs::write(root.join("assets/sub/b.css"), "b{}").unwrap();
        std::fs::write(root.join("assets/noext"), "x").unwrap();
        std::fs::write(root.join("other.txt"), "Z").unwrap();
        std::fs::write(dir.path().join("secret.txt"), "secret").unwrap();
        let site = root.to_str().unwrap().to_owned();
        let mut all = vec![("STATIC_DIR", site.as_str())];
        all.extend_from_slice(pairs);
        let (app, clock) = testing::app_with(testing::config(&all));
        testing::add_room(
            &app,
            "lobby",
            RoomInit {
                pinned: Some(true),
                ..RoomInit::default()
            },
        );
        Self::serve(app, clock, Some(dir)).await
    }

    async fn serve(app: Arc<App>, clock: Arc<ManualClock>, dir: Option<tempfile::TempDir>) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        app.http.bind(&app.config, addr.port());
        let router = crate::serve::build_router(app.clone(), axum::Router::new());
        tokio::spawn(crate::http::server::serve(listener, router, std::future::pending()));
        Self {
            app,
            clock,
            addr,
            dir,
            clients: std::sync::atomic::AtomicU32::new(0),
        }
    }

    fn root(&self) -> std::path::PathBuf {
        self.dir.as_ref().unwrap().path().join("dist")
    }

    fn request(&self, method: &str, path: &str, headers: &[(&str, &str)], body: Option<&[u8]>) -> Vec<u8> {
        let mut out = format!("{method} {path} HTTP/1.1\r\n").into_bytes();
        if !headers.iter().any(|(k, _)| k.eq_ignore_ascii_case("host")) {
            out.extend_from_slice(format!("Host: 127.0.0.1:{}\r\n", self.addr.port()).as_bytes());
        }
        for (k, v) in headers {
            out.extend_from_slice(format!("{k}: {v}\r\n").as_bytes());
        }
        if let Some(body) = body
            && !headers
                .iter()
                .any(|(k, _)| k.eq_ignore_ascii_case("content-length") || k.eq_ignore_ascii_case("transfer-encoding"))
        {
            out.extend_from_slice(format!("Content-Length: {}\r\n", body.len()).as_bytes());
        }
        out.extend_from_slice(b"Connection: close\r\n\r\n");
        if let Some(body) = body {
            out.extend_from_slice(body);
        }
        out
    }

    async fn raw(&self, bytes: &[u8]) -> Resp {
        let mut stream = TcpStream::connect(self.addr).await.unwrap();
        stream.write_all(bytes).await.unwrap();
        let mut buf = Vec::new();
        tokio::time::timeout(Duration::from_secs(10), stream.read_to_end(&mut buf))
            .await
            .expect("the server answers")
            .ok();
        parse(&buf)
    }

    async fn get(&self, path: &str, headers: &[(&str, &str)]) -> Resp {
        self.raw(&self.request("GET", path, headers, None)).await
    }

    async fn send(&self, method: &str, path: &str, headers: &[(&str, &str)], body: &str) -> Resp {
        self.raw(&self.request(method, path, headers, Some(body.as_bytes()))).await
    }

    async fn post_json(&self, path: &str, headers: &[(&str, &str)], body: &str) -> Resp {
        let mut all = vec![("content-type", "application/json")];
        all.extend_from_slice(headers);
        self.send("POST", path, &all, body).await
    }

    /// `POST /rooms/:id/report`.
    async fn report(&self, room: &str, headers: &[(&str, &str)], body: &str) -> Resp {
        self.post_json(&format!("/rooms/{room}/report"), headers, body).await
    }

    /// `POST /rooms` as a forwarded client.
    async fn create_as(&self, xff: &str, title: &str, visibility: &str) -> Resp {
        let body = format!(r#"{{"title":"{title}","visibility":"{visibility}"}}"#);
        self.post_json("/rooms", &[("x-forwarded-for", xff)], &body).await
    }

    async fn create(&self, title: &str, visibility: &str) -> Value {
        let n = self.clients.fetch_add(1, std::sync::atomic::Ordering::Relaxed) + 1;
        let res = self.create_as(&format!("203.0.113.{n}"), title, visibility).await;
        assert_eq!(res.status, 201, "{}", res.text());
        res.json()
    }

    /// A joined member's share token in `room` (what ws.ts mints on join), with the socket's frames.
    fn grant(&self, room: &str, owner: bool) -> (String, MemberId, OutboxRx) {
        let token = mint_share_token().unwrap();
        let member = mint_member_id().unwrap();
        let (outbox, rx) = channel();
        let conn = ConnId::next();
        let id = testing::rid(room);
        let now = self.app.mono();
        let m = member.clone();
        let t = token.clone();
        self.app
            .with_open_room(&id, |inner| {
                inner.insert_grant(&t, ShareGrant::new(m, owner, now));
                inner.attach_socket(conn, outbox).unwrap();
                inner.subscribers.subscribe(conn);
            })
            .expect("room is open");
        (token.as_str().to_owned(), member, rx)
    }
}

fn frames(rx: &mut OutboxRx) -> Vec<Value> {
    let mut out = Vec::new();
    while let Some(Outbound::Text(t)) = rx.try_recv() {
        out.push(serde_json::from_str(t.as_str()).unwrap());
    }
    out
}

fn bearer(token: &str) -> String {
    format!("Bearer {token}")
}

fn assert_secured(res: &Resp) {
    let csp = res.header("content-security-policy").unwrap_or("");
    assert!(
        csp.starts_with("default-src 'self'; script-src 'self' https://www.youtube.com/iframe_api"),
        "{csp}"
    );
    assert!(
        csp.contains("require-trusted-types-for 'script'; trusted-types omega-sdk youtube-widget-api"),
        "{csp}"
    );
    assert_eq!(res.header("x-content-type-options"), Some("nosniff"));
    assert_eq!(res.header("cross-origin-opener-policy"), Some("same-origin"));
    assert_eq!(res.header("cross-origin-resource-policy"), Some("same-origin"));
}

// ---- readiness, headers, 404

// apps/server/test/boundary.test.ts:281
#[tokio::test]
async fn healthz_is_ok_uncached_and_every_response_carries_the_security_headers() {
    let fx = Fx::start(&[]).await;
    let res = fx.get("/healthz", &[]).await;
    assert_eq!((res.status, res.text().as_str()), (200, "ok"));
    assert_eq!(res.header("cache-control"), Some("no-store"));
    assert_eq!(res.header("content-type"), Some("text/plain; charset=UTF-8"));
    assert_secured(&res);
    // The same on a 404 and a refusal.
    assert_secured(&fx.get("/nope", &[]).await);
    assert_secured(&fx.get("/healthz", &[("host", "evil.example")]).await);
}

// apps/server/test/server.test.ts:121 (without a static site GET / answers)
#[tokio::test]
async fn the_root_answers_without_a_static_site_and_other_paths_are_a_plain_404() {
    let fx = Fx::start(&[]).await;
    let res = fx.get("/", &[]).await;
    assert_eq!((res.status, res.text().as_str()), (200, "omega-share server"));
    for path in ["/nope", "/rooms/lobby", "/rooms/lobby/", "/index.html"] {
        let res = fx.get(path, &[]).await;
        assert_eq!((res.status, res.text().as_str()), (404, "404 Not Found"), "{path}");
        assert_eq!(res.header("content-type"), Some("text/plain; charset=UTF-8"));
    }
    // Wrong methods are 404s too, not 405s.
    assert_eq!(fx.send("PUT", "/rooms", &[], "").await.status, 404);
    assert_eq!(fx.send("POST", "/healthz", &[], "").await.status, 404);
}

// ---- the gate

// apps/server/test/boundary.test.ts:75
#[tokio::test]
async fn an_unknown_host_is_421_on_every_route_before_routing() {
    let fx = Fx::start(&[]).await;
    for path in ["/healthz", "/rooms", "/", "/nope", "/rooms/lobby/ws"] {
        let res = fx.get(path, &[("host", "evil.example")]).await;
        assert_eq!((res.status, res.text().as_str()), (421, "misdirected request"), "{path}");
        assert_eq!(res.header("content-type"), Some("text/plain;charset=utf-8"));
    }
    let res = fx
        .send(
            "POST",
            "/rooms",
            &[("host", "evil.example"), ("content-type", "application/json")],
            "{}",
        )
        .await;
    assert_eq!(res.status, 421);
    // No Host at all is not ours either.
    let res = fx.raw(b"GET /healthz HTTP/1.1\r\nConnection: close\r\n\r\n").await;
    assert_eq!(res.status, 421);
}

// apps/server/test/boundary.test.ts:94,101
#[tokio::test]
async fn loopback_names_on_our_port_and_the_public_host_are_accepted_in_any_case() {
    let fx = Fx::start(&[("PUBLIC_ORIGIN", "https://quiet-otter.ngrok-free.app")]).await;
    let port = fx.addr.port();
    for host in [
        format!("localhost:{port}"),
        format!("LOCALHOST:{port}"),
        format!("127.0.0.1:{port}"),
        format!("[::1]:{port}"),
        "quiet-otter.ngrok-free.app".to_owned(),
        "Quiet-Otter.ngrok-free.app".to_owned(),
    ] {
        assert_eq!(fx.get("/healthz", &[("host", host.as_str())]).await.status, 200, "{host}");
    }
    for host in [
        format!("localhost:{}", port.wrapping_add(1)),
        "localhost".to_owned(),
        "quiet-otter.ngrok-free.app:8443".to_owned(),
    ] {
        assert_eq!(fx.get("/healthz", &[("host", host.as_str())]).await.status, 421, "{host}");
    }
    // Without a public origin only loopback names count.
    let plain = Fx::start(&[]).await;
    assert_eq!(plain.get("/healthz", &[("host", "quiet-otter.ngrok-free.app")]).await.status, 421);
}

// apps/server/test/boundary.test.ts:113,122,131
#[tokio::test]
async fn hsts_goes_only_to_the_https_public_host_on_every_response() {
    let fx = Fx::start(&[("PUBLIC_ORIGIN", "https://quiet-otter.ngrok-free.app")]).await;
    let public = [("host", "quiet-otter.ngrok-free.app")];
    for res in [
        fx.get("/healthz", &public).await,
        fx.get("/nope", &public).await,
        fx.get(
            "/healthz",
            &[("host", "quiet-otter.ngrok-free.app"), ("origin", "http://evil.example")],
        )
        .await,
    ] {
        assert_eq!(
            res.header("strict-transport-security"),
            Some("max-age=31536000"),
            "{} {:?}",
            res.status,
            res.headers
        );
    }
    // Never to loopback names (plain http), and not without a public origin.
    assert_eq!(fx.get("/healthz", &[]).await.header("strict-transport-security"), None);
    let plain = Fx::start(&[]).await;
    assert_eq!(plain.get("/healthz", &[]).await.header("strict-transport-security"), None);
}

// apps/server/test/boundary.test.ts:143,154,165,175
#[tokio::test]
async fn origins_are_checked_before_routing_and_a_missing_origin_is_fine() {
    let fx = Fx::start(&[("PUBLIC_ORIGIN", "https://quiet-otter.ngrok-free.app")]).await;
    for origin in [
        SITE,
        EXT,
        "https://quiet-otter.ngrok-free.app",
        "moz-extension://12345678-1234-1234-1234-123456789abc",
    ] {
        assert_eq!(fx.get("/rooms", &[("origin", origin)]).await.status, 200, "{origin}");
    }
    assert_eq!(fx.get("/rooms", &[]).await.status, 200);
    for origin in [
        "http://evil.example",
        "null",
        "",
        "https://quiet-otter.ngrok-free.app/",
        "chrome-extension://short",
    ] {
        let res = fx.get("/rooms", &[("origin", origin)]).await;
        assert_eq!((res.status, res.text().as_str()), (403, "forbidden origin"), "{origin:?}");
        assert_eq!(res.header("content-type"), Some("text/plain;charset=utf-8"));
    }
    // Our own page on our own port.
    let own = format!("http://127.0.0.1:{}", fx.addr.port());
    assert_eq!(fx.get("/rooms", &[("origin", own.as_str())]).await.status, 200);
}

// apps/server/test/boundary.test.ts:175,181,202
#[tokio::test]
async fn extension_ids_pin_chromium_extensions_but_not_firefox_ones() {
    let fx = Fx::start(&[("EXTENSION_IDS", "ponmlkjihgfedcbaponmlkjihgfedcba")]).await;
    assert_eq!(fx.get("/rooms", &[("origin", EXT)]).await.status, 403);
    assert_eq!(
        fx.get("/rooms", &[("origin", "chrome-extension://ponmlkjihgfedcbaponmlkjihgfedcba")])
            .await
            .status,
        200
    );
    assert_eq!(
        fx.get("/rooms", &[("origin", "moz-extension://12345678-1234-1234-1234-123456789abc")])
            .await
            .status,
        200
    );
    for bad in [
        "moz-extension://nope",
        "moz-extension://12345678-1234-1234-1234-123456789ABC",
        "moz-extension://12345678-1234-1234-1234-123456789abc/x",
    ] {
        assert_eq!(fx.get("/rooms", &[("origin", bad)]).await.status, 403, "{bad}");
    }
}

// ---- CORS

// apps/server/test/boundary.test.ts:217,234,254, room-create.test.ts:208
#[tokio::test]
async fn preflights_and_cors_headers() {
    let fx = Fx::start(&[]).await;
    let pre = fx
        .send(
            "OPTIONS",
            "/rooms",
            &[
                ("origin", SITE),
                ("access-control-request-method", "POST"),
                ("access-control-request-headers", "content-type"),
            ],
            "",
        )
        .await;
    assert_eq!(pre.status, 204);
    assert_eq!(pre.header("access-control-allow-origin"), Some(SITE));
    assert_eq!(pre.header("access-control-allow-credentials"), None);
    assert_eq!(pre.header("access-control-allow-methods"), Some("GET,POST,DELETE"));
    assert_eq!(
        pre.header("access-control-allow-headers"),
        Some("content-type,authorization,ngrok-skip-browser-warning")
    );
    assert_eq!(pre.header("access-control-max-age"), Some("600"));
    assert_eq!(pre.header("vary"), Some("Origin, Access-Control-Request-Headers"));
    assert_eq!(pre.header("content-type"), None);
    assert_secured(&pre);

    let ext = fx.send("OPTIONS", "/rooms/lobby/share", &[("origin", EXT)], "").await;
    assert_eq!(ext.status, 204);
    assert_eq!(ext.header("access-control-allow-origin"), Some(EXT));
    assert_eq!(ext.header("access-control-allow-credentials"), Some("true"));

    // A response: the allowed origin is echoed; extensions get credentials, the site never does.
    let res = fx.get("/rooms", &[("origin", SITE)]).await;
    assert_eq!(res.header("access-control-allow-origin"), Some(SITE));
    assert_eq!(res.header("access-control-allow-credentials"), None);
    let res = fx.get("/rooms", &[("origin", EXT)]).await;
    assert_eq!(res.header("access-control-allow-credentials"), Some("true"));
    // No Origin: no ACAO, but the response still varies by it. `/rooms` itself matches both of TS's mounts (`Origin, Origin`).
    let res = fx.get("/rooms", &[]).await;
    assert_eq!(res.header("access-control-allow-origin"), None);
    assert_eq!(res.header("vary"), Some("Origin, Origin"));
    assert_eq!(fx.send("DELETE", "/rooms/lobby", &[], "").await.header("vary"), Some("Origin"));
    // Outside /rooms nothing is added.
    assert_eq!(
        fx.get("/healthz", &[("origin", SITE)]).await.header("access-control-allow-origin"),
        None
    );
}

// ---- GET /rooms

// apps/server/test/server.test.ts:137, room-create.test.ts:454,465
#[tokio::test]
async fn the_list_has_pinned_rooms_first_then_busiest_then_newest_and_hides_private_rooms() {
    let fx = Fx::proxied(&[]).await;
    let a = fx.create("Alpha", "public").await["room"]["id"].as_str().unwrap().to_owned();
    fx.clock.set_wall(T0 + 1000);
    let b = fx.create("Bravo", "public").await["room"]["id"].as_str().unwrap().to_owned();
    fx.clock.set_wall(T0 + 2000);
    let c = fx.create("Charlie", "public").await["room"]["id"].as_str().unwrap().to_owned();
    fx.create("Secret", "private").await;
    let list = |res: Resp| -> Vec<String> {
        res.json()["rooms"]
            .as_array()
            .unwrap()
            .iter()
            .map(|r| r["id"].as_str().unwrap().to_owned())
            .collect()
    };
    // lobby (pinned), then newest first among equals.
    assert_eq!(list(fx.get("/rooms", &[]).await), ["lobby", &c, &b, &a]);
    // The busiest created room leads the created ones.
    let id = RoomId::parse(&a).unwrap();
    fx.app.with_open_room(&id, |inner| {
        let m = inner
            .room
            .join_with_id(mint_member_id().unwrap(), &"ann".parse_nickname(), 0.into_avatar(), None);
        assert!(m.is_ok());
    });
    let res = fx.get("/rooms", &[]).await;
    assert_eq!(res.header("content-type"), Some("application/json"));
    assert_eq!(list(res), ["lobby", &a, &c, &b]);
    let body = fx.get("/rooms", &[]).await.json();
    assert_eq!(body["rooms"][0], serde_json::json!({"id":"lobby","memberCount":0,"seatedCount":0}));
    assert_eq!(
        body["rooms"][1],
        serde_json::json!({"id":a,"memberCount":1,"seatedCount":0,"title":"Alpha"})
    );
}

trait Shorthand {
    fn parse_nickname(&self) -> crate::contract::text::Nickname;
}
impl Shorthand for &str {
    fn parse_nickname(&self) -> crate::contract::text::Nickname {
        crate::contract::text::Nickname::parse(self).unwrap()
    }
}
trait IntoAvatar {
    fn into_avatar(self) -> crate::contract::room::Avatar;
}
impl IntoAvatar for u8 {
    fn into_avatar(self) -> crate::contract::room::Avatar {
        crate::contract::room::Avatar::new(u64::from(self)).unwrap()
    }
}

// apps/server/test/room-create.test.ts:478,485,497
#[tokio::test]
async fn a_blocklisted_title_is_left_out_and_the_verdict_follows_a_rename() {
    let fx = Fx::start(&[("ROOM_TITLE_BLOCKLIST", "badword")]).await;
    let id = fx.create("Film club", "public").await["room"]["id"].as_str().unwrap().to_owned();
    let listed = |res: Resp| res.json()["rooms"].as_array().unwrap().len();
    assert_eq!(listed(fx.get("/rooms", &[]).await), 2);
    let rid = RoomId::parse(&id).unwrap();
    let rename = |title: &str| {
        fx.app.with_open_room(&rid, |inner| {
            inner.room.set_title(Some(crate::contract::text::RoomTitle::parse(title).unwrap()))
        });
    };
    rename("B.a.d W0rd");
    assert_eq!(listed(fx.get("/rooms", &[]).await), 1);
    rename("Fine again");
    assert_eq!(listed(fx.get("/rooms", &[]).await), 2);
    // The verdict is kept per room, keyed by the title it was made for (OME-439).
    let kept = fx.app.with_open_room(&rid, |inner| inner.title_verdict.title.clone()).unwrap();
    assert_eq!(kept.as_deref(), Some("Fine again"));
}

#[tokio::test]
async fn the_list_is_capped_at_max_listed_rooms() {
    let fx = Fx::start(&[]).await;
    for i in 0..105 {
        testing::add_room(
            &fx.app,
            &format!("room{i:03}aaaaaaaaaaaaaaaaaaaaa"),
            RoomInit {
                pinned: Some(false),
                ..RoomInit::default()
            },
        );
    }
    let res = fx.get("/rooms", &[]).await;
    assert_eq!(
        res.json()["rooms"].as_array().unwrap().len(),
        crate::contract::constants::MAX_LISTED_ROOMS
    );
}

// ---- POST /rooms

// apps/server/test/room-create.test.ts:96,110
#[tokio::test]
async fn create_answers_201_with_the_owner_token_and_an_invite_key_for_private_rooms() {
    let fx = Fx::start(&[]).await;
    let res = fx.create_as("198.51.100.1", "Friday films", "public").await;
    assert_eq!(res.status, 201);
    assert_eq!(res.header("cache-control"), Some("no-store"));
    assert_eq!(res.header("content-type"), Some("application/json"));
    let body = res.json();
    assert_eq!(body["ok"], true);
    assert_eq!(body["room"]["title"], "Friday films");
    assert_eq!(body["room"]["visibility"], "public");
    assert_eq!(body["room"]["id"].as_str().unwrap().len(), 26);
    assert_eq!(body["ownerToken"].as_str().unwrap().len(), 22);
    assert!(body.get("inviteKey").is_none());
    // The room exists, is stored, and its owner token verifies.
    let id = RoomId::parse(body["room"]["id"].as_str().unwrap()).unwrap();
    assert_eq!(
        fx.app
            .with_open_room(&id, |i| i.room.is_owner(body["ownerToken"].as_str().unwrap())),
        Some(true)
    );
    assert!(fx.app.store().rooms().list_rooms().unwrap().iter().any(|r| r.id == id));

    let private = fx.create_as("198.51.100.2", "Secret", "private").await.json();
    assert_eq!(private["inviteKey"].as_str().unwrap().len(), 22);
    let id = RoomId::parse(private["room"]["id"].as_str().unwrap()).unwrap();
    assert_eq!(
        fx.app
            .with_open_room(&id, |i| i.room.is_invited(private["inviteKey"].as_str().unwrap())),
        Some(true)
    );
    assert_ne!(private["ownerToken"], private["inviteKey"]);
}

// apps/server/test/room-create.test.ts:130,144
#[tokio::test]
async fn presets_build_the_room_from_the_judged_layout_and_unknown_ones_are_400() {
    let fx = Fx::proxied(&[]).await;
    let res = fx
        .post_json(
            "/rooms",
            &[("x-forwarded-for", "198.51.100.3")],
            r#"{"title":"Cafe","visibility":"public","preset":"cafe"}"#,
        )
        .await;
    assert_eq!(res.status, 201);
    let id = RoomId::parse(res.json()["room"]["id"].as_str().unwrap()).unwrap();
    let cafe = crate::presets::Presets::load().unwrap();
    let layout = fx.app.with_open_room(&id, |i| i.room.layout().clone()).unwrap();
    assert_eq!(layout, *cafe.preset_layout(crate::contract::layout::RoomPresetId::Cafe));
    for (n, bad) in [r#""Cafe""#, r#""nope""#, "3", "null"].into_iter().enumerate() {
        let body = format!(r#"{{"title":"x","visibility":"public","preset":{bad}}}"#);
        let res = fx
            .post_json("/rooms", &[("x-forwarded-for", &format!("198.51.100.{}", 10 + n))], &body)
            .await;
        assert_eq!((res.status, res.code()), (400, "invalid_body".to_owned()), "{bad}");
    }
}

// apps/server/test/room-create.test.ts:162,193, 178
#[tokio::test]
async fn create_refuses_bad_requests_with_typed_errors() {
    let fx = Fx::proxied(&[]).await;
    let mut n = 0;
    let mut as_key = || {
        n += 1;
        format!("198.51.100.{n}")
    };
    // Not application/json: 415, and the per-key bucket stays full (OME-698).
    let key = as_key();
    for ct in [
        "text/plain",
        "application/x-www-form-urlencoded",
        "multipart/form-data",
        "application/jsonx",
        "application/json2",
    ] {
        let res = fx
            .send("POST", "/rooms", &[("content-type", ct), ("x-forwarded-for", &key)], "{}")
            .await;
        assert_eq!((res.status, res.code()), (415, "invalid_body".to_owned()), "{ct}");
        assert_eq!(res.json()["error"]["message"], "expected application/json");
        assert_eq!(res.header("cache-control"), Some("no-store"));
    }
    assert_eq!(fx.send("POST", "/rooms", &[("x-forwarded-for", &key)], "{}").await.status, 415);
    // Any case, any parameter, is JSON.
    for ct in [
        "application/json",
        "Application/JSON",
        "application/json; charset=utf-8",
        "application/json ;x=y",
    ] {
        let key = as_key();
        let res = fx
            .send(
                "POST",
                "/rooms",
                &[("content-type", ct), ("x-forwarded-for", &key)],
                r#"{"title":"x","visibility":"public"}"#,
            )
            .await;
        assert_eq!(res.status, 201, "{ct}");
    }
    for (body, message) in [
        ("{bad", "body is not JSON"),
        ("", "body is not JSON"),
        (r#"{"title":"","visibility":"public"}"#, "expected { title, visibility, preset? }"),
        (r#"{"title":"x","visibility":"hidden"}"#, "expected { title, visibility, preset? }"),
        (
            r#"{"title":"x","visibility":"public","extra":1}"#,
            "expected { title, visibility, preset? }",
        ),
        (r#"["x"]"#, "expected { title, visibility, preset? }"),
    ] {
        let res = fx.post_json("/rooms", &[("x-forwarded-for", &as_key())], body).await;
        assert_eq!((res.status, res.code()), (400, "invalid_body".to_owned()), "{body}");
        assert_eq!(res.json()["error"]["message"], message, "{body}");
    }
    // The title is normalised (NFKC, trimmed).
    let res = fx
        .post_json(
            "/rooms",
            &[("x-forwarded-for", &as_key())],
            r#"{"title":"  ＦＩＬＭ  ","visibility":"public"}"#,
        )
        .await;
    assert_eq!(res.json()["room"]["title"], "FILM");
}

// apps/server/test/room-create.test.ts:178, reports.test.ts:307
#[tokio::test]
async fn bodies_over_the_cap_are_413_by_content_length_or_by_the_stream_without_buffering() {
    let fx = Fx::proxied(&[]).await;
    let big = format!(r#"{{"title":"{}","visibility":"public"}}"#, "x".repeat(2000));
    let res = fx.post_json("/rooms", &[("x-forwarded-for", "198.51.100.1")], &big).await;
    assert_eq!((res.status, res.code()), (413, "payload_too_large".to_owned()));
    assert_eq!(res.reason, "Payload Too Large");
    // A raw chunked POST over 4 KB (no Content-Length to check): refused while reading, with the reason phrase.
    let (token, _, _rx) = fx.grant("lobby", false);
    let mut req = format!(
        "POST /rooms/lobby/share HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nContent-Type: application/json\r\nAuthorization: {}\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n",
        fx.addr.port(),
        bearer(&token)
    )
    .into_bytes();
    for _ in 0..3 {
        req.extend_from_slice(format!("{:x}\r\n", 2048).as_bytes());
        req.extend_from_slice(&[b'a'; 2048]);
        req.extend_from_slice(b"\r\n");
    }
    req.extend_from_slice(b"0\r\n\r\n");
    let res = fx.raw(&req).await;
    assert_eq!(
        (res.status, res.reason.as_str(), res.code()),
        (413, "Payload Too Large", "payload_too_large".to_owned())
    );
}

// apps/server/test/room-create.test.ts:224,234
#[tokio::test]
async fn a_blocklisted_title_is_refused_whatever_the_spelling() {
    let fx = Fx::proxied(&[("ROOM_TITLE_BLOCKLIST", "badword")]).await;
    for (i, title) in ["badword", "BADW0RD", "bad word", "b.a.d-w_o r d"].into_iter().enumerate() {
        let res = fx.create_as(&format!("198.51.100.{}", i + 1), title, "public").await;
        assert_eq!((res.status, res.code()), (400, "invalid_body".to_owned()), "{title}");
        assert_eq!(res.json()["error"]["message"], "that title isn't allowed");
    }
    assert_eq!(fx.app.registry.len(), 1);
}

// apps/server/test/room-create.test.ts:283,302,319
#[tokio::test]
async fn creation_is_limited_per_key_with_the_real_wait_and_malformed_bodies_count() {
    let fx = Fx::proxied(&[]).await;
    let k1 = "198.51.100.1";
    assert_eq!(fx.create_as(k1, "a", "public").await.status, 201);
    assert_eq!(fx.create_as(k1, "b", "public").await.status, 201);
    let res = fx.create_as(k1, "c", "public").await;
    assert_eq!((res.status, res.code()), (429, "rate_limited".to_owned()));
    // The full refill of one token (10 min), not capped at the usual 60 s.
    let ms = res.json()["error"]["retryAfterMs"].as_u64().unwrap();
    assert!((590_000..=600_000).contains(&ms), "{ms}");
    assert_eq!(res.header("retry-after"), Some(ms.div_ceil(1000).to_string().as_str()));
    assert_eq!(fx.create_as("198.51.100.2", "c", "public").await.status, 201);
    fx.clock.set_mono(fx.app.mono() + 600_000.0);
    assert_eq!(fx.create_as(k1, "d", "public").await.status, 201);
    // Malformed bodies take from the same bucket.
    let k3 = "198.51.100.3";
    for _ in 0..2 {
        assert_eq!(fx.post_json("/rooms", &[("x-forwarded-for", k3)], "{bad").await.status, 400);
    }
    assert_eq!(fx.post_json("/rooms", &[("x-forwarded-for", k3)], "{bad").await.status, 429);
}

// apps/server/test/room-create.test.ts:326,337
#[tokio::test]
async fn creation_is_limited_server_wide_and_at_max_rooms() {
    let fx = Fx::proxied(&[]).await;
    for i in 0..10 {
        assert_eq!(fx.create_as(&format!("198.51.100.{}", i + 1), "x", "public").await.status, 201);
    }
    let res = fx.create_as("198.51.100.99", "x", "public").await;
    assert_eq!((res.status, res.code()), (429, "rate_limited".to_owned()));
    assert!(res.json()["error"]["retryAfterMs"].as_u64().unwrap() >= 1000);
    // One refills a minute on.
    fx.clock.set_mono(fx.app.mono() + 60_000.0);
    assert_eq!(fx.create_as("198.51.100.99", "x", "public").await.status, 201);

    let full = Fx::proxied(&[]).await;
    for i in 0..crate::contract::constants::MAX_ROOMS - 1 {
        testing::add_room(&full.app, &format!("fill{i:04}aaaaaaaaaaaaaaaaaaaaa"), RoomInit::default());
    }
    assert_eq!(full.app.registry.len(), crate::contract::constants::MAX_ROOMS);
    let res = full.create_as("198.51.100.1", "x", "public").await;
    assert_eq!((res.status, res.code()), (503, "too_many_rooms".to_owned()));
    assert_eq!(full.app.registry.len(), crate::contract::constants::MAX_ROOMS);
}

// apps/server/test/room-create.test.ts:244
#[tokio::test]
async fn a_store_that_cannot_write_is_a_typed_503_and_the_creation_is_given_back() {
    let dir = tempfile::tempdir().unwrap();
    let db = dir.path().join("omega.db");
    let fx = Fx::on_file(&db).await;
    assert_eq!(fx.create_as("198.51.100.1", "x", "public").await.status, 201);
    let spoil = rusqlite::Connection::open(&db).unwrap();
    spoil.execute_batch("DROP TABLE rooms").unwrap();
    let before = fx.app.registry.len();
    for _ in 0..4 {
        let res = fx.create_as("198.51.100.1", "x", "public").await;
        assert_eq!((res.status, res.code()), (503, "unavailable".to_owned()));
        assert_eq!(res.header("cache-control"), Some("no-store"));
    }
    // The key kept its creations (one of two is left): the failures were the server's.
    assert_eq!(fx.app.registry.len(), before);
    assert_eq!(fx.create_as("198.51.100.1", "x", "public").await.status, 503);
}

// ---- DELETE /rooms/:id

// apps/server/test/room-create.test.ts:354,410,430,437
#[tokio::test]
async fn delete_is_for_the_owner_only_and_closes_the_room() {
    let fx = Fx::proxied(&[]).await;
    let made = fx.create("Mine", "public").await;
    let id = made["room"]["id"].as_str().unwrap().to_owned();
    let owner = bearer(made["ownerToken"].as_str().unwrap());
    let (token, _, mut rx) = fx.grant(&id, false);

    let path = format!("/rooms/{id}");
    let unknown = fx.send("DELETE", "/rooms/nosuchroom", &[("authorization", &owner)], "").await;
    assert_eq!((unknown.status, unknown.code()), (404, "room_not_found".to_owned()));
    for header in [
        None,
        Some("Bearer nope".to_owned()),
        Some(bearer(&token)),
        Some(owner.replace("Bearer", "Basic")),
    ] {
        let headers: Vec<(&str, &str)> = header.iter().map(|h| ("authorization", h.as_str())).collect();
        let res = fx.send("DELETE", &path, &headers, "").await;
        assert_eq!((res.status, res.code()), (401, "unauthorized".to_owned()), "{header:?}");
    }
    // A seeded room has no owner: nobody can delete the lobby.
    assert_eq!(
        fx.send("DELETE", "/rooms/lobby", &[("authorization", &owner)], "").await.status,
        401
    );

    let res = fx.send("DELETE", &path, &[("authorization", &owner)], "").await;
    assert_eq!((res.status, res.json()), (200, serde_json::json!({"ok": true})));
    assert!(fx.app.registry.get(&RoomId::parse(&id).unwrap()).is_none());
    assert!(fx.app.store().rooms().list_rooms().unwrap().iter().all(|r| r.id.as_str() != id));
    // Sockets close with ROOM_CLOSED (4004), and the share token stops working.
    let closed = std::iter::from_fn(|| rx.try_recv()).any(|o| matches!(o, Outbound::Close(4004, _)));
    assert!(closed);
    let res = fx
        .post_json(&format!("/rooms/{id}/share"), &[("authorization", &bearer(&token))], YT)
        .await;
    assert_eq!(res.status, 404);
    assert!(!fx.get("/rooms", &[]).await.text().contains(&id));
}

// apps/server/test/room-create.test.ts:437
#[tokio::test]
async fn failed_deletes_take_from_a_per_key_bucket() {
    let fx = Fx::proxied(&[]).await;
    let id = fx.create("Mine", "public").await["room"]["id"].as_str().unwrap().to_owned();
    let path = format!("/rooms/{id}");
    for _ in 0..20 {
        assert_eq!(
            fx.send("DELETE", &path, &[("x-forwarded-for", "198.51.100.7")], "").await.status,
            401
        );
    }
    let res = fx.send("DELETE", &path, &[("x-forwarded-for", "198.51.100.7")], "").await;
    assert_eq!((res.status, res.code()), (429, "rate_limited".to_owned()));
    assert_eq!(res.header("retry-after"), Some("1"));
    assert_eq!(res.json()["error"]["retryAfterMs"], 1000);
    assert_eq!(
        fx.send("DELETE", &path, &[("x-forwarded-for", "198.51.100.8")], "").await.status,
        401
    );
}

// apps/server/test/room-create.test.ts:374
#[tokio::test]
async fn a_store_that_cannot_delete_keeps_the_room() {
    let dir = tempfile::tempdir().unwrap();
    let db = dir.path().join("omega.db");
    let fx = Fx::on_file(&db).await;
    let made = fx.create("Mine", "public").await;
    let id = made["room"]["id"].as_str().unwrap().to_owned();
    let (_, _, mut rx) = fx.grant(&id, false);
    let spoil = rusqlite::Connection::open(&db).unwrap();
    spoil.execute_batch("DROP TABLE rooms").unwrap();
    let res = fx
        .send(
            "DELETE",
            &format!("/rooms/{id}"),
            &[("authorization", &bearer(made["ownerToken"].as_str().unwrap()))],
            "",
        )
        .await;
    assert_eq!((res.status, res.code()), (503, "unavailable".to_owned()));
    assert!(fx.app.registry.get(&RoomId::parse(&id).unwrap()).is_some());
    assert!(rx.try_recv().is_none(), "no socket was closed");
}

// ---- POST /rooms/:id/share

fn share_path(room: &str) -> String {
    format!("/rooms/{room}/share")
}

// apps/server/test/server.test.ts:42, share-token.test.ts:71
#[tokio::test]
async fn a_valid_share_sets_the_embed_and_broadcasts_embed_changed_by_the_member() {
    let fx = Fx::start(&[]).await;
    let (token, member, mut rx) = fx.grant("lobby", false);
    let res = fx
        .post_json(
            &share_path("lobby"),
            &[("authorization", &bearer(&token))],
            r#"{"url":"https://youtu.be/dQw4w9WgXcQ?t=5"}"#,
        )
        .await;
    assert_eq!(res.status, 200);
    assert_eq!(res.header("cache-control"), None);
    let embed = serde_json::json!({"provider":"youtube","videoId":"dQw4w9WgXcQ","url":"https://www.youtube.com/embed/dQw4w9WgXcQ"});
    assert_eq!(res.json(), serde_json::json!({"ok": true, "embed": embed}));
    let sent = frames(&mut rx);
    assert_eq!(sent.len(), 1, "{sent:?}");
    assert_eq!(sent[0]["type"], "embed-changed");
    assert_eq!(sent[0]["embed"], embed);
    assert_eq!(sent[0]["by"], member.as_str());
    // A fresh embed starts playing at 0 (playback.ts `loadPlayback`).
    assert_eq!(sent[0]["playback"]["playing"], true);
    assert_eq!(sent[0]["playback"]["position"], 0);
    assert!(sent[0]["itemId"].as_str().is_some());
    // Stored, and the room's item id is the one broadcast.
    let id = testing::rid("lobby");
    let item = fx
        .app
        .with_open_room(&id, |i| i.room.item_id().map(|x| x.as_str().to_owned()))
        .unwrap();
    assert_eq!(item.as_deref(), sent[0]["itemId"].as_str());
    let stored = fx.app.store().rooms().list_rooms().unwrap();
    assert!(stored.iter().find(|r| r.id == id).unwrap().embed.is_some());
}

// apps/server/test/share-token.test.ts:45,65, server.test.ts:82
#[tokio::test]
async fn a_missing_or_bad_token_is_401_and_an_unknown_room_is_404() {
    let fx = Fx::start(&[]).await;
    let (token, _, mut rx) = fx.grant("lobby", false);
    for header in [
        None,
        Some("Bearer short".to_owned()),
        Some("Token abc".to_owned()),
        Some(format!("Bearer  {token}")),
        Some(format!("Bearer {token}x")),
    ] {
        let headers: Vec<(&str, &str)> = header.iter().map(|h| ("authorization", h.as_str())).collect();
        let res = fx.post_json(&share_path("lobby"), &headers, YT).await;
        assert_eq!((res.status, res.code()), (401, "unauthorized".to_owned()), "{header:?}");
        assert_eq!(res.json()["error"]["message"], "join the room to share into it");
    }
    assert!(frames(&mut rx).is_empty());
    // The scheme is case-insensitive.
    assert_eq!(
        fx.post_json(&share_path("lobby"), &[("authorization", &format!("bEaReR {token}"))], YT)
            .await
            .status,
        200
    );
    let res = fx
        .post_json(&share_path("nosuchroom"), &[("authorization", &bearer(&token))], YT)
        .await;
    assert_eq!((res.status, res.code()), (404, "room_not_found".to_owned()));
    // A token for one room can't share into another (T-03).
    let other = fx.create("Other", "public").await["room"]["id"].as_str().unwrap().to_owned();
    let res = fx.post_json(&share_path(&other), &[("authorization", &bearer(&token))], YT).await;
    assert_eq!(res.status, 401);
}

// apps/server/test/share-token.test.ts:117,125
#[tokio::test]
async fn failed_shares_have_their_own_bucket_and_every_429_carries_retry_after() {
    let fx = Fx::proxied(&[]).await;
    let (token, _, _rx) = fx.grant("lobby", false);
    let bad = bearer("A".repeat(22).as_str());
    for _ in 0..20 {
        let res = fx
            .post_json(
                &share_path("lobby"),
                &[("authorization", &bad), ("x-forwarded-for", "198.51.100.9")],
                YT,
            )
            .await;
        assert_eq!(res.status, 401);
    }
    let res = fx
        .post_json(
            &share_path("lobby"),
            &[("authorization", &bad), ("x-forwarded-for", "198.51.100.9")],
            YT,
        )
        .await;
    assert_eq!((res.status, res.code()), (429, "rate_limited".to_owned()));
    assert_eq!(res.header("retry-after"), Some("1"));
    assert_eq!(res.json()["error"]["retryAfterMs"], 1000);
    // A member on the same address is not locked out.
    let res = fx
        .post_json(
            &share_path("lobby"),
            &[("authorization", &bearer(&token)), ("x-forwarded-for", "198.51.100.9")],
            YT,
        )
        .await;
    assert_eq!(res.status, 200);
}

// apps/server/test/server.test.ts:55,66,75
#[tokio::test]
async fn bad_share_bodies_are_400_or_413_and_broadcast_nothing() {
    let fx = Fx::start(&[]).await;
    let (token, _, mut rx) = fx.grant("lobby", false);
    let auth = bearer(&token);
    for (body, code, message) in [
        ("{bad", "invalid_body", "body is not JSON"),
        (r#"{"url":5}"#, "invalid_body", "expected { url: string }"),
        (
            r#"{"url":"https://youtu.be/dQw4w9WgXcQ","x":1}"#,
            "invalid_body",
            "expected { url: string }",
        ),
        (
            r#"{"url":"https://evil.example/video"}"#,
            "unsupported_url",
            "not a supported video URL",
        ),
        (r#"{"url":"javascript:alert(1)"}"#, "unsupported_url", "not a supported video URL"),
    ] {
        let res = fx.post_json(&share_path("lobby"), &[("authorization", &auth)], body).await;
        assert_eq!((res.status, res.code()), (400, code.to_owned()), "{body}");
        assert_eq!(res.json()["error"]["message"], message);
        // A refused share never spends the sender's, the room's or the server's allowance.
        fx.clock.set_mono(fx.app.mono() + 60_000.0);
    }
    let big = format!(r#"{{"url":"https://youtu.be/{}"}}"#, "a".repeat(5000));
    let res = fx.post_json(&share_path("lobby"), &[("authorization", &auth)], &big).await;
    assert_eq!((res.status, res.code()), (413, "payload_too_large".to_owned()));
    assert!(frames(&mut rx).is_empty());
    // Providers canonicalise (apps/server/test/providers.test.ts:36).
    let res = fx
        .post_json(
            &share_path("lobby"),
            &[("authorization", &auth)],
            r#"{"url":"https://vimeo.com/76979871"}"#,
        )
        .await;
    assert_eq!(res.status, 200);
    assert_eq!(res.json()["embed"]["provider"], "vimeo");
}

// apps/server/test/boundary.test.ts:384,406,414,424
#[tokio::test]
async fn the_room_takes_two_switches_then_429s_and_a_refused_url_costs_nothing() {
    let fx = Fx::start(&[]).await;
    let (a, _, _ra) = fx.grant("lobby", false);
    let (b, _, _rb) = fx.grant("lobby", false);
    let (c, _, _rc) = fx.grant("lobby", false);
    // A refused URL doesn't use up a switch.
    let res = fx
        .post_json(
            &share_path("lobby"),
            &[("authorization", &bearer(&a))],
            r#"{"url":"https://evil.example/x"}"#,
        )
        .await;
    assert_eq!(res.status, 400);
    assert_eq!(
        fx.post_json(&share_path("lobby"), &[("authorization", &bearer(&a))], YT)
            .await
            .status,
        200
    );
    assert_eq!(
        fx.post_json(&share_path("lobby"), &[("authorization", &bearer(&b))], YT)
            .await
            .status,
        200
    );
    let res = fx.post_json(&share_path("lobby"), &[("authorization", &bearer(&c))], YT).await;
    assert_eq!((res.status, res.code()), (429, "rate_limited".to_owned()));
    // The wait is the bucket's refill period: 1 / 0.1 per second = 10 s.
    assert_eq!(res.json()["error"]["retryAfterMs"], 10_000);
    assert_eq!(res.header("retry-after"), Some("10"));
    // Another room is unaffected.
    let other = fx.create("Other", "public").await["room"]["id"].as_str().unwrap().to_owned();
    let (d, _, _rd) = fx.grant(&other, false);
    assert_eq!(
        fx.post_json(&share_path(&other), &[("authorization", &bearer(&d))], YT)
            .await
            .status,
        200
    );
    // And one switch comes back after 10 s.
    fx.clock.set_mono(fx.app.mono() + 10_000.0);
    assert_eq!(
        fx.post_json(&share_path("lobby"), &[("authorization", &bearer(&c))], YT)
            .await
            .status,
        200
    );
}

// apps/server/test/share-token.test.ts:146,155,164
#[tokio::test]
async fn shares_are_limited_per_member_per_client_and_globally() {
    let fx = Fx::proxied(&[]).await;
    // Per member: burst 5 (the room's own limit is raised by using a room per share).
    let mut rooms = Vec::new();
    for i in 0..8 {
        rooms.push(
            testing::add_room(&fx.app, &format!("share{i}aaaaaaaaaaaaaaaaaaaaaa"), RoomInit::default())
                .id
                .as_str()
                .to_owned(),
        );
    }
    let (token, _, _rx) = fx.grant("lobby", false);
    // One grant per room for the same client address: 5 at once, then 429 (the per-client limiter, not the member's).
    let mut tokens = vec![];
    for room in &rooms {
        tokens.push(fx.grant(room, false));
    }
    let mut statuses = Vec::new();
    for (i, room) in rooms.iter().enumerate() {
        let res = fx
            .post_json(
                &share_path(room),
                &[("authorization", &bearer(&tokens[i].0)), ("x-forwarded-for", "198.51.100.1")],
                YT,
            )
            .await;
        statuses.push(res.status);
    }
    assert_eq!(statuses, [200, 200, 200, 200, 200, 429, 429, 429]);
    // Another client is unaffected.
    let res = fx
        .post_json(
            &share_path("lobby"),
            &[("authorization", &bearer(&token)), ("x-forwarded-for", "198.51.100.2")],
            YT,
        )
        .await;
    assert_eq!(res.status, 200);
    // Globally: 20 at once, however many clients, members and rooms (this run has used 6 so far).
    let mut ok = 6;
    for i in 0.. {
        let room = format!("global{i:03}aaaaaaaaaaaaaaaaaaa");
        testing::add_room(&fx.app, &room, RoomInit::default());
        let (t, _, _r) = fx.grant(&room, false);
        let res = fx
            .post_json(
                &share_path(&room),
                &[("authorization", &bearer(&t)), ("x-forwarded-for", &format!("203.0.113.{i}"))],
                YT,
            )
            .await;
        if res.status == 429 {
            assert_eq!(res.json()["error"]["retryAfterMs"], 500, "{}", res.text());
            break;
        }
        assert_eq!(res.status, 200);
        ok += 1;
        assert!(ok <= 40, "never limited");
    }
    assert_eq!(ok, 20);
}

// apps/server/test/room-owner.test.ts (owner-only policy)
#[tokio::test]
async fn under_the_owner_policy_only_the_owners_share_is_accepted() {
    let fx = Fx::start(&[]).await;
    let (guest, _, _rg) = fx.grant("lobby", false);
    let (owner, _, _ro) = fx.grant("lobby", true);
    let id = testing::rid("lobby");
    fx.app
        .with_open_room(&id, |i| i.room.set_control_policy(crate::contract::room::ControlPolicy::Owner));
    let res = fx.post_json(&share_path("lobby"), &[("authorization", &bearer(&guest))], YT).await;
    assert_eq!((res.status, res.code()), (403, "control_owner_only".to_owned()));
    assert_eq!(res.json()["error"]["message"], "only the room's owner can change the video here");
    assert_eq!(
        fx.post_json(&share_path("lobby"), &[("authorization", &bearer(&owner))], YT)
            .await
            .status,
        200
    );
}

// ---- POST /rooms/:id/queue

// apps/server/test/queue.test.ts (the extension's Add to queue)
#[tokio::test]
async fn queue_add_answers_the_item_and_the_typed_refusals() {
    let fx = Fx::start(&[]).await;
    let (guest, member, mut rx) = fx.grant("lobby", false);
    let path = "/rooms/lobby/queue";
    let res = fx.post_json(path, &[("authorization", &bearer(&guest))], YT).await;
    assert_eq!(res.status, 200);
    let body = res.json();
    assert_eq!(body["ok"], true);
    assert_eq!(body["item"]["by"], member.as_str());
    assert_eq!(body["item"]["embed"]["videoId"], "dQw4w9WgXcQ");
    // The room had nothing playing, so the add started it: embed-changed then queue-changed.
    let types: Vec<String> = frames(&mut rx).iter().map(|f| f["type"].as_str().unwrap().to_owned()).collect();
    assert_eq!(types, ["embed-changed", "queue-changed"]);

    let res = fx
        .post_json(path, &[("authorization", &bearer(&guest))], r#"{"url":"https://evil.example/x"}"#)
        .await;
    assert_eq!((res.status, res.code()), (400, "unsupported_url".to_owned()));
    assert_eq!(res.json()["error"]["message"], "not a supported video URL");
    let res = fx.post_json(path, &[("authorization", &bearer(&guest))], "{bad").await;
    assert_eq!((res.status, res.code()), (400, "invalid_body".to_owned()));
    let res = fx.post_json(path, &[], YT).await;
    assert_eq!((res.status, res.code()), (401, "unauthorized".to_owned()));
    assert_eq!(res.json()["error"]["message"], "join the room to queue into it");
    assert_eq!(
        fx.post_json("/rooms/nosuchroom/queue", &[("authorization", &bearer(&guest))], YT)
            .await
            .status,
        404
    );
    let big = format!(r#"{{"url":"https://youtu.be/{}"}}"#, "a".repeat(5000));
    fx.clock.set_mono(fx.app.mono() + 600_000.0);
    assert_eq!(fx.post_json(path, &[("authorization", &bearer(&guest))], &big).await.status, 413);
    fx.clock.set_mono(fx.app.mono() + 600_000.0);

    // The owner policy closes the queue to guests.
    fx.app.with_open_room(&testing::rid("lobby"), |i| {
        i.room.set_control_policy(crate::contract::room::ControlPolicy::Owner)
    });
    let res = fx.post_json(path, &[("authorization", &bearer(&guest))], YT).await;
    assert_eq!((res.status, res.code()), (403, "control_owner_only".to_owned()));
    assert_eq!(res.json()["error"]["message"], "only the room's owner changes the queue here");
}

// apps/server/test/queue.test.ts (limits, QUEUE_MAX)
#[tokio::test]
async fn queue_add_is_rate_limited_and_stops_at_the_queue_cap() {
    let fx = Fx::start(&[]).await;
    let (guest, _, _rx) = fx.grant("lobby", false);
    let path = "/rooms/lobby/queue";
    let mut last = None;
    for n in 0..30 {
        // Fresh buckets every time: only the cap should stop us.
        fx.clock.set_mono(fx.app.mono() + 600_000.0);
        let body = format!(r#"{{"url":"https://youtu.be/dQw4w9W{n:04}"}}"#);
        let res = fx.post_json(path, &[("authorization", &bearer(&guest))], &body).await;
        if res.status != 200 {
            last = Some(res);
            break;
        }
    }
    let res = last.expect("the queue fills");
    assert_eq!((res.status, res.code()), (409, "queue_full".to_owned()));
    assert_eq!(res.json()["error"]["message"], "the queue is full");
    // Without time passing the member's own bucket answers 429 with a wait of at least a second.
    let mut limited = None;
    for _ in 0..40 {
        let res = fx.post_json(path, &[("authorization", &bearer(&guest))], YT).await;
        if res.status == 429 {
            limited = Some(res);
            break;
        }
    }
    let res = limited.expect("429");
    assert_eq!(res.code(), "rate_limited");
    assert!(res.json()["error"]["retryAfterMs"].as_u64().unwrap() >= 1000);
    assert!(res.header("retry-after").unwrap().parse::<u64>().unwrap() >= 1);
}

// ---- POST /rooms/:id/report

// apps/server/test/reports.test.ts:77,98,143,285,324,337
#[tokio::test]
async fn reports_are_202_then_already_reported_and_every_refusal_is_typed() {
    let fx = Fx::proxied(&[]).await;
    let key = [("x-forwarded-for", "198.51.100.1")];
    let res = fx.report("lobby", &key, r#"{"reason":"spam","note":"mail me at a@b.co"}"#).await;
    assert_eq!(
        (res.status, res.json()),
        (202, serde_json::json!({"ok": true, "status": "received"}))
    );
    assert_eq!(res.header("cache-control"), Some("no-store"));
    let stored = fx.app.store().reports().list_open().unwrap();
    assert_eq!(stored.len(), 1);
    // The same key reporting the same room again.
    let res = fx.report("lobby", &key, r#"{"reason":"hate"}"#).await;
    assert_eq!(
        (res.status, res.json()),
        (200, serde_json::json!({"ok": true, "status": "already_reported"}))
    );

    let other = [("x-forwarded-for", "198.51.100.2")];
    let res = fx.report("lobby", &other, r#"{"reason":"nope"}"#).await;
    assert_eq!((res.status, res.code()), (400, "invalid_body".to_owned()));
    assert_eq!(res.json()["error"]["message"], "expected { reason, note? }");
    assert_eq!(
        fx.report("lobby", &other, "{bad").await.json()["error"]["message"],
        "body is not JSON"
    );
    // Unknown and malformed ids are the same 404, never echoed.
    for id in ["nosuchroom", "Bad_Id", "a".repeat(40).as_str()] {
        let res = fx.report(id, &other, r#"{"reason":"spam"}"#).await;
        assert_eq!((res.status, res.code()), (404, "room_not_found".to_owned()), "{id}");
        assert!(!res.text().contains(id));
    }
    // Content type first (OME-698), then size.
    let res = fx
        .send(
            "POST",
            "/rooms/lobby/report",
            &[("content-type", "text/plain"), ("x-forwarded-for", "198.51.100.3")],
            r#"{"reason":"spam"}"#,
        )
        .await;
    assert_eq!((res.status, res.code()), (415, "invalid_body".to_owned()));
    let big = format!(r#"{{"reason":"spam","note":"{}"}}"#, "x".repeat(3000));
    assert_eq!(fx.report("lobby", &other, &big).await.status, 413);
}

// apps/server/test/reports.test.ts:202,218
#[tokio::test]
async fn reports_are_limited_per_key_with_retry_after() {
    let fx = Fx::proxied(&[]).await;
    let mut statuses = Vec::new();
    let mut last = None;
    for i in 0..30 {
        let res = fx
            .post_json(
                "/rooms/lobby/report",
                &[("x-forwarded-for", "198.51.100.1")],
                &format!(r#"{{"reason":"spam","note":"n{i}"}}"#),
            )
            .await;
        statuses.push(res.status);
        if res.status == 429 {
            last = Some(res);
            break;
        }
    }
    let res = last.expect("limited");
    assert_eq!(res.code(), "rate_limited");
    assert!(res.header("retry-after").unwrap().parse::<u64>().unwrap() >= 1);
    assert!(res.json()["error"]["retryAfterMs"].as_u64().unwrap() >= 1000);
    assert_eq!(statuses[0], 202);
}

// ---- limits: per key, in flight

// apps/server/test/http-limits.test.ts:48,59
#[tokio::test]
async fn a_burst_over_the_bucket_gets_429_with_retry_after_and_other_keys_are_unaffected() {
    let fx = Fx::proxied(&[]).await;
    let mut refused = None;
    for _ in 0..1000 {
        let res = fx.get("/healthz", &[("x-forwarded-for", "198.51.100.1")]).await;
        if res.status == 429 {
            refused = Some(res);
            break;
        }
    }
    let res = refused.expect("limited");
    assert_eq!(res.text(), "too many requests");
    assert!(res.header("retry-after").unwrap().parse::<u64>().unwrap() >= 1);
    assert_secured(&res);
    assert_eq!(fx.get("/healthz", &[("x-forwarded-for", "198.51.100.2")]).await.status, 200);
    // Prepending to X-Forwarded-For does not make a new key (T-07).
    assert_eq!(
        fx.get("/healthz", &[("x-forwarded-for", "10.9.9.9, 198.51.100.1")]).await.status,
        429
    );
    // A refill lets the key back in.
    fx.clock.set_mono(fx.app.mono() + 60_000.0);
    assert_eq!(fx.get("/healthz", &[("x-forwarded-for", "198.51.100.1")]).await.status, 200);
}

// apps/server/test/http-limits.test.ts:90 and proxy.test.ts: loopback peers without the proxy skip the limit
#[tokio::test]
async fn loopback_peers_without_the_proxy_skip_the_per_key_limit() {
    let fx = Fx::start(&[]).await;
    for _ in 0..300 {
        assert_eq!(fx.get("/healthz", &[]).await.status, 200);
    }
    // And X-Forwarded-For is ignored without TRUST_PROXY.
    for i in 0..300 {
        assert_eq!(
            fx.get("/healthz", &[("x-forwarded-for", &format!("198.51.100.{}", i % 250))])
                .await
                .status,
            200
        );
    }
}

// apps/server/test/http-limits.test.ts:161
#[tokio::test]
async fn a_zero_in_flight_cap_refuses_everything_with_503() {
    let fx = Fx::start(&[("MAX_HTTP_IN_FLIGHT", "0")]).await;
    let res = fx.get("/healthz", &[]).await;
    assert_eq!((res.status, res.text().as_str()), (503, "server busy"));
    assert_eq!(res.header("retry-after"), Some("1"));
    assert_secured(&res);
    assert_eq!(fx.post_json("/rooms/lobby/share", &[], "{}").await.status, 503);
}

// apps/server/test/http-limits.test.ts:132
#[tokio::test]
async fn a_slow_body_holds_its_in_flight_slot_until_it_finishes() {
    let fx = Fx::proxied(&[("MAX_HTTP_IN_FLIGHT", "1")]).await;
    let (token, _, _rx) = fx.grant("lobby", false);
    let mut slow = TcpStream::connect(fx.addr).await.unwrap();
    let head = format!(
        "POST /rooms/lobby/share HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nContent-Type: application/json\r\nAuthorization: {}\r\nX-Forwarded-For: 198.51.100.1\r\nContent-Length: 38\r\n\r\n",
        fx.addr.port(),
        bearer(&token)
    );
    slow.write_all(head.as_bytes()).await.unwrap();
    slow.write_all(br#"{"url":"https://youtu.be/dQw4w9WgXcQ""#).await.unwrap();
    tokio::time::sleep(Duration::from_millis(150)).await;
    let full = fx.get("/healthz", &[("x-forwarded-for", "198.51.100.2")]).await;
    assert_eq!((full.status, full.text().as_str()), (503, "server busy"));
    assert_eq!(full.header("retry-after"), Some("1"));
    slow.write_all(b"}").await.unwrap();
    let mut buf = Vec::new();
    tokio::time::timeout(Duration::from_secs(5), async {
        // Read the whole response head and body of the keep-alive connection.
        let mut chunk = [0u8; 4096];
        loop {
            let n = slow.read(&mut chunk).await.unwrap();
            buf.extend_from_slice(&chunk[..n]);
            if n == 0 || String::from_utf8_lossy(&buf).contains("\"ok\":true") {
                break;
            }
        }
    })
    .await
    .unwrap();
    assert!(
        String::from_utf8_lossy(&buf).starts_with("HTTP/1.1 200"),
        "{}",
        String::from_utf8_lossy(&buf)
    );
    // The slot is free again.
    assert_eq!(fx.get("/healthz", &[("x-forwarded-for", "198.51.100.2")]).await.status, 200);
}

// ---- slowloris

// PORTING.md "Runtime architecture": hyper's header-read timeout (Bun's idleTimeout did this in TS)
#[tokio::test]
async fn a_client_that_never_finishes_its_headers_is_cut_off() {
    let (app, _clock) = testing::app();
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    app.http.bind(&app.config, addr.port());
    let router = crate::serve::build_router(app, axum::Router::new());
    tokio::spawn(crate::http::server::serve_with(
        listener,
        router,
        std::future::pending(),
        Duration::from_millis(300),
    ));
    let mut stream = TcpStream::connect(addr).await.unwrap();
    stream
        .write_all(b"GET /healthz HTTP/1.1\r\nHost: 127.0.0.1\r\nX-Slow: ")
        .await
        .unwrap();
    let mut buf = Vec::new();
    let read = tokio::time::timeout(Duration::from_secs(5), stream.read_to_end(&mut buf)).await;
    assert!(read.is_ok(), "the server kept a half-sent request open");
    // A request that is complete is answered as usual.
    let mut stream = TcpStream::connect(addr).await.unwrap();
    stream
        .write_all(
            format!(
                "GET /healthz HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nConnection: close\r\n\r\n",
                addr.port()
            )
            .as_bytes(),
        )
        .await
        .unwrap();
    let mut buf = Vec::new();
    stream.read_to_end(&mut buf).await.unwrap();
    assert!(String::from_utf8_lossy(&buf).starts_with("HTTP/1.1 200"));
}

// ---- static files

fn page(res: &Resp) -> String {
    res.text()
}

fn og_title(html: &str) -> Option<String> {
    let at = html.find(r#"<meta property="og:title" content=""#)? + r#"<meta property="og:title" content=""#.len();
    Some(html.get(at..)?.split('"').next()?.to_owned())
}

// apps/server/test/site.test.ts:101,109
#[tokio::test]
async fn the_shell_has_the_generic_card_and_is_never_cached() {
    let fx = Fx::with_site(&[("PUBLIC_ORIGIN", "https://quiet-otter.ngrok-free.app")]).await;
    let host = [("host", "quiet-otter.ngrok-free.app")];
    for path in ["/", "/r/lobby", "/r/lobby/", "/r/no-such-room", "/index.html"] {
        let res = fx.get(path, &host).await;
        assert_eq!(res.status, 200, "{path}");
        assert_eq!(res.header("content-type"), Some("text/html; charset=UTF-8"));
        assert_eq!(res.header("cache-control"), Some("no-cache"));
        let html = page(&res);
        assert!(html.contains(r#"<div id="app"></div>"#));
        assert_eq!(og_title(&html).as_deref(), Some("omega-share"));
        assert!(html.contains(r#"content="https://quiet-otter.ngrok-free.app/og-image.png""#));
        assert!(html.contains(r#"<link rel="manifest" href="/manifest.webmanifest" />"#));
        assert_secured(&res);
        assert_eq!(res.header("x-robots-tag").is_some(), path.starts_with("/r/"), "{path}");
    }
}

// apps/server/test/site.test.ts:128,139,150
#[tokio::test]
async fn only_a_public_listable_rooms_title_reaches_the_card() {
    let fx = Fx::with_site(&[("ROOM_TITLE_BLOCKLIST", "badword")]).await;
    let public = fx.create("Film night & co", "public").await["room"]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let private = fx.create("Secret club", "private").await["room"]["id"].as_str().unwrap().to_owned();
    let res = fx.get(&format!("/r/{public}"), &[]).await;
    assert_eq!(og_title(&page(&res)).as_deref(), Some("Film night &amp; co · omega-share"));
    assert_eq!(res.header("x-robots-tag"), Some("noindex, nofollow"));
    let unknown = page(&fx.get(&format!("/r/{}", "x".repeat(private.len())), &[]).await);
    let hidden = page(&fx.get(&format!("/r/{private}"), &[]).await);
    assert!(!hidden.contains("Secret"));
    assert_eq!(hidden, unknown);
    // A title the lobby hides gets the generic card too, and so does a taken-down room.
    let rid = RoomId::parse(&public).unwrap();
    fx.app.with_open_room(&rid, |i| {
        i.room.set_title(Some(crate::contract::text::RoomTitle::parse("Bad Word").unwrap()))
    });
    assert_eq!(page(&fx.get(&format!("/r/{public}"), &[]).await), unknown);
    fx.app.with_open_room(&rid, |i| {
        i.room.set_title(Some(crate::contract::text::RoomTitle::parse("Nice").unwrap()))
    });
    assert_eq!(
        og_title(&page(&fx.get(&format!("/r/{public}"), &[]).await)).as_deref(),
        Some("Nice · omega-share")
    );
    fx.app.reports.mark_taken_down(&rid);
    assert_eq!(page(&fx.get(&format!("/r/{public}"), &[]).await), unknown);
}

// apps/server/test/site.test.ts:161
#[tokio::test]
async fn unknown_paths_and_invalid_room_ids_get_the_not_found_page_in_the_privacy_pages_look() {
    let fx = Fx::with_site(&[]).await;
    for path in [
        "/nope",
        "/privacy",
        "/foo/bar",
        "/r/",
        "/r/Bad_Id",
        "/r/a/b",
        &format!("/r/{}", "a".repeat(33)),
        "/missing.html",
        "/favicon.png",
        "/r/lobby.png",
        "/rooms/lobby",
        "/assets",
    ] {
        let res = fx.get(path, &[]).await;
        assert_eq!(res.status, 404, "{path}");
        if path == "/assets" {
            assert_eq!(res.text(), "404 Not Found");
            continue;
        }
        assert_eq!(res.header("content-type"), Some("text/html; charset=UTF-8"), "{path}");
        let html = page(&res);
        assert!(
            html.contains(r#"<link rel="stylesheet" href="/assets/style-Ab12Cd34.css" />"#),
            "{path}"
        );
        assert!(html.contains(r#"<main class="privacy"><h1>Page not found</h1>"#));
        assert!(!html.contains("We keep nothing"));
        assert_secured(&res);
    }
    // Without a built privacy page: a bare one.
    std::fs::remove_file(fx.root().join("privacy.html")).unwrap();
    let html = page(&fx.get("/nope", &[]).await);
    assert!(
        html.starts_with(r#"<!doctype html><html lang="en"><head><meta charset="utf-8" /><title>Page not found · omega-share</title>"#),
        "{html}"
    );
}

// apps/server/test/site.test.ts:176, 191
#[tokio::test]
async fn html_pages_serve_with_the_card_and_replace_their_own_tags() {
    let fx = Fx::with_site(&[]).await;
    let res = fx.get("/privacy.html", &[]).await;
    assert_eq!(res.status, 200);
    assert!(page(&res).contains("We keep nothing"));
    assert_eq!(og_title(&page(&res)).as_deref(), Some("omega-share"));
    std::fs::write(
        fx.root().join("index.html"),
        r#"<!doctype html><html><head><meta charset="utf-8" /><meta name="description" content="Built-in words." /><link rel="icon" href="/favicon.ico" sizes="32x32" /><link rel="manifest" href="/manifest.webmanifest" /><title>omega</title></head><body><div id="app"></div></body></html>"#,
    )
    .unwrap();
    for path in ["/", "/r/lobby"] {
        let html = page(&fx.get(path, &[]).await);
        assert!(!html.contains("Built-in words."));
        assert_eq!(html.matches(r#"<meta name="description""#).count(), 1);
        assert_eq!(html.matches(r#"<link rel="icon""#).count(), 1);
        assert_eq!(html.matches(r#"<link rel="manifest""#).count(), 1);
    }
}

// apps/server/test/site.test.ts:225-300
#[tokio::test]
async fn robots_security_txt_icons_and_the_manifest_are_served_with_a_days_cache() {
    let fx = Fx::with_site(&[("PUBLIC_ORIGIN", "https://quiet-otter.ngrok-free.app")]).await;
    let host = [("host", "quiet-otter.ngrok-free.app")];
    let robots = fx.get("/robots.txt", &host).await;
    assert_eq!(robots.header("content-type"), Some("text/plain; charset=utf-8"));
    assert_eq!(robots.header("cache-control"), Some("public, max-age=86400"));
    let text = robots.text();
    assert!(text.contains("User-agent: *") && text.contains("Allow: /") && text.contains("Disallow: /rooms") && !text.contains("Sitemap"));
    let sec = fx.get("/.well-known/security.txt", &host).await;
    assert_eq!(sec.header("content-type"), Some("text/plain; charset=utf-8"));
    assert_eq!(sec.header("cache-control"), Some("public, max-age=86400"));
    assert!(sec.text().contains("Contact: https://quiet-otter.ngrok-free.app/contact.html\n"));
    // The judged art, byte for byte (apps/server/public is what TS serves).
    let public = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../server/public");
    for (path, mime) in [
        ("favicon.ico", "image/x-icon"),
        ("apple-touch-icon.png", "image/png"),
        ("icon-192.png", "image/png"),
        ("icon-512.png", "image/png"),
        ("icon-maskable-512.png", "image/png"),
        ("og-image.png", "image/png"),
        ("manifest.webmanifest", "application/manifest+json"),
    ] {
        let res = fx.get(&format!("/{path}"), &host).await;
        assert_eq!(res.status, 200, "{path}");
        assert_eq!(res.header("content-type"), Some(mime), "{path}");
        assert_eq!(res.header("cache-control"), Some("public, max-age=86400"));
        assert_eq!(res.body, std::fs::read(public.join(path)).unwrap(), "{path}");
        assert_secured(&res);
    }
}

// apps/server/test/boundary.test.ts:325
#[tokio::test]
async fn assets_are_immutable_and_a_missing_asset_is_a_404_not_the_shell() {
    let fx = Fx::with_site(&[]).await;
    let res = fx.get("/assets/style-Ab12Cd34.css", &[]).await;
    assert_eq!((res.status, res.text().as_str()), (200, "main{}"));
    assert_eq!(res.header("content-type"), Some("text/css; charset=utf-8"));
    assert_eq!(res.header("cache-control"), Some("public, max-age=31536000, immutable"));
    assert_eq!(fx.get("/assets/sub/b.css", &[]).await.status, 200);
    assert_eq!(
        fx.get("/assets/noext", &[]).await.header("content-type"),
        Some("application/octet-stream")
    );
    for path in ["/assets/missing.js", "/assets/", "/assets", "/assets/sub", "/assets/sub/"] {
        let res = fx.get(path, &[]).await;
        assert_eq!((res.status, res.text().as_str()), (404, "404 Not Found"), "{path}");
    }
    // The assets mount answers any method, as the TS middleware does.
    assert_eq!(fx.send("POST", "/assets/style-Ab12Cd34.css", &[], "").await.status, 200);
    // Other files under the root serve with their type and no cache header.
    let res = fx.get("/other.txt", &[]).await;
    assert_eq!(
        (res.status, res.header("content-type"), res.header("cache-control")),
        (200, Some("text/plain; charset=utf-8"), None)
    );
}

// apps/server/test/boundary.test.ts:339,347
#[tokio::test]
async fn nothing_outside_the_root_is_ever_served_and_a_nul_is_a_plain_404() {
    let fx = Fx::with_site(&[]).await;
    // Dot segments resolve before routing, so they can't climb: `/../secret.txt` is `/secret.txt` under the root.
    for path in [
        "/../secret.txt",
        "/%2e%2e/secret.txt",
        "/%2E%2E/secret.txt",
        "/assets/../../secret.txt",
        "/assets/%2e%2e/%2e%2e/secret.txt",
        "/..%2fsecret.txt",
        "/%2e%2e%2fsecret.txt",
        "/assets/..%5c..%5csecret.txt",
        "/\\..\\secret.txt",
        "/assets/%252e%252e/secret.txt",
    ] {
        let res = fx.get(path, &[]).await;
        assert_eq!(res.status, 404, "{path}");
        assert!(!res.text().contains("secret"), "{path}");
    }
    // NUL bytes, encoded or not.
    for path in ["/assets/%00", "/%00", "/r/bad%00id", "/assets/a%00.js"] {
        let res = fx.get(path, &[]).await;
        assert_eq!((res.status, res.text().as_str()), (404, "404 Not Found"), "{path}");
    }
    // A symlink out of the root is refused (the TS server follows it: a deliberate difference).
    std::os::unix::fs::symlink("../../secret.txt", fx.root().join("assets/link.txt")).unwrap();
    std::os::unix::fs::symlink("..", fx.root().join("up")).unwrap();
    for path in ["/assets/link.txt", "/up/secret.txt"] {
        let res = fx.get(path, &[]).await;
        assert_eq!(res.status, 404, "{path}");
        assert!(!res.text().contains("secret"));
    }
    // A symlink inside the root is fine.
    std::os::unix::fs::symlink("other.txt", fx.root().join("alias.txt")).unwrap();
    assert_eq!(fx.get("/alias.txt", &[]).await.text(), "Z");
    // Percent-encoded names decode once (`%2e` is a dot): the TS server serves them.
    assert_eq!(fx.get("/assets/style-Ab12Cd34%2ecss", &[]).await.status, 200);
}

// apps/server/test/boundary.test.ts:356
#[tokio::test]
async fn the_api_keeps_its_routes_next_to_the_site() {
    let fx = Fx::with_site(&[]).await;
    assert_eq!(fx.get("/healthz", &[]).await.text(), "ok");
    assert_eq!(fx.get("/rooms", &[("origin", SITE)]).await.status, 200);
    // `/` is the shell, not the plain text.
    assert!(fx.get("/", &[]).await.text().contains(r#"<div id="app">"#));
}

// ---- the gate as a function (S6 calls it from its upgrade handler)

// apps/server/test/boundary.test.ts:88
#[tokio::test]
async fn the_gate_function_refuses_what_the_layer_refuses() {
    use crate::http::gate;
    use axum::http::{HeaderMap, HeaderValue};
    let fx = Fx::start(&[("PUBLIC_ORIGIN", "https://quiet-otter.ngrok-free.app")]).await;
    let mut h = HeaderMap::new();
    h.insert("host", HeaderValue::from_str(&format!("127.0.0.1:{}", fx.addr.port())).unwrap());
    assert!(gate::refusal(&fx.app, &h).is_none());
    h.insert("origin", HeaderValue::from_static("http://evil.example"));
    assert_eq!(gate::refusal(&fx.app, &h).map(|r| r.status().as_u16()), Some(403));
    h.insert("host", HeaderValue::from_static("evil.example"));
    assert_eq!(gate::refusal(&fx.app, &h).map(|r| r.status().as_u16()), Some(421));
    assert!(gate::is_allowed_origin(&fx.app, SITE));
    assert!(!gate::is_allowed_origin(&fx.app, "http://evil.example"));
    // The client key as the layer computes it (ipOf).
    let peer: std::net::IpAddr = "127.0.0.1".parse().unwrap();
    let mut xff = HeaderMap::new();
    xff.insert("x-forwarded-for", HeaderValue::from_static("10.9.9.9, 198.51.100.1"));
    assert_eq!(gate::client_key(&fx.app, Some(peer), &xff), "127.0.0.1", "TRUST_PROXY is off");
    let proxied = Fx::proxied(&[]).await;
    assert_eq!(gate::client_key(&proxied.app, Some(peer), &xff), "198.51.100.1");
    assert_eq!(gate::client_key(&proxied.app, None, &xff), "unknown");
}

// ---- review fixes (PR #245)

// A body that trickles in (1 byte under the stall timeout, forever) must not hold an in-flight slot for hours.
#[tokio::test]
async fn a_trickling_body_is_refused_after_the_total_deadline_and_frees_its_slot() {
    let fx = Fx::proxied(&[("MAX_HTTP_IN_FLIGHT", "1")]).await;
    fx.app.http.set_body_total(Duration::from_millis(400));
    let (token, _, _rx) = fx.grant("lobby", false);
    let mut slow = TcpStream::connect(fx.addr).await.unwrap();
    let head = format!(
        "POST /rooms/lobby/share HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nContent-Type: application/json\r\nAuthorization: {}\r\nX-Forwarded-For: 198.51.100.1\r\nContent-Length: 38\r\n\r\n",
        fx.addr.port(),
        bearer(&token)
    );
    slow.write_all(head.as_bytes()).await.unwrap();
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert_eq!(
        fx.get("/healthz", &[("x-forwarded-for", "198.51.100.2")]).await.status,
        503,
        "the slot is held"
    );
    // One byte every 100 ms: always inside the stall timeout.
    let trickle = tokio::spawn(async move {
        for _ in 0..30 {
            if slow.write_all(b"{").await.is_err() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        let mut buf = vec![0u8; 4096];
        let n = tokio::time::timeout(Duration::from_secs(2), slow.read(&mut buf))
            .await
            .unwrap_or(Ok(0))
            .unwrap_or(0);
        String::from_utf8_lossy(&buf[..n]).into_owned()
    });
    tokio::time::sleep(Duration::from_millis(800)).await;
    assert_eq!(
        fx.get("/healthz", &[("x-forwarded-for", "198.51.100.2")]).await.status,
        200,
        "the slot was freed"
    );
    let answer = trickle.await.unwrap();
    assert!(answer.starts_with("HTTP/1.1 400"), "{answer}");
}

#[tokio::test]
async fn dotfiles_are_never_served_but_security_txt_is() {
    let fx = Fx::with_site(&[]).await;
    std::fs::write(fx.root().join(".env"), "SECRET=1").unwrap();
    std::fs::create_dir_all(fx.root().join(".git")).unwrap();
    std::fs::write(fx.root().join(".git/config"), "secret").unwrap();
    std::fs::write(fx.root().join("assets/.hidden.js"), "secret").unwrap();
    for path in ["/.env", "/.git/config", "/assets/.hidden.js", "/%2eenv"] {
        let res = fx.get(path, &[]).await;
        assert_eq!(res.status, 404, "{path}");
        assert!(!res.text().contains("secret") && !res.text().contains("SECRET"), "{path}");
    }
    assert_eq!(fx.get("/.well-known/security.txt", &[]).await.status, 200);
    assert_eq!(fx.get("/other.txt", &[]).await.status, 200);
}

#[tokio::test]
async fn a_large_file_is_served_whole_with_its_length_and_head_has_no_body() {
    let fx = Fx::with_site(&[]).await;
    let data: Vec<u8> = (0..3_000_000u32).map(|i| (i % 251) as u8).collect();
    std::fs::write(fx.root().join("assets/big.bin"), &data).unwrap();
    let res = fx.get("/assets/big.bin", &[]).await;
    assert_eq!(res.header("content-length"), Some("3000000"));
    assert!(res.body == data);
    let head = fx.raw(&fx.request("HEAD", "/assets/big.bin", &[], None)).await;
    assert_eq!(
        (head.status, head.header("content-length"), head.body.len()),
        (200, Some("3000000"), 0)
    );
}

async fn serve_test_router(
    router: axum::Router,
    shutdown: impl std::future::Future<Output = ()> + Send + 'static,
) -> (SocketAddr, tokio::task::JoinHandle<std::io::Result<()>>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    (addr, tokio::spawn(crate::http::server::serve(listener, router, shutdown)))
}

#[tokio::test]
async fn a_websocket_upgrades_and_echoes_through_the_accept_loop() {
    use axum::extract::ws::WebSocketUpgrade;
    let router = axum::Router::new().route(
        "/echo",
        axum::routing::get(|ws: WebSocketUpgrade| async move {
            ws.on_upgrade(|mut socket| async move {
                while let Some(Ok(msg)) = socket.recv().await {
                    if socket.send(msg).await.is_err() {
                        break;
                    }
                }
            })
        }),
    );
    let (addr, _server) = serve_test_router(router, std::future::pending()).await;
    let mut s = TcpStream::connect(addr).await.unwrap();
    let req = format!(
        "GET /echo HTTP/1.1\r\nHost: {addr}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n"
    );
    s.write_all(req.as_bytes()).await.unwrap();
    let mut buf = vec![0u8; 1024];
    let n = s.read(&mut buf).await.unwrap();
    let head = String::from_utf8_lossy(&buf[..n]).into_owned();
    assert!(head.starts_with("HTTP/1.1 101"), "{head}");
    // A masked text frame "hi".
    let mask = [1u8, 2, 3, 4];
    s.write_all(&[0x81, 0x82, mask[0], mask[1], mask[2], mask[3], b'h' ^ mask[0], b'i' ^ mask[1]])
        .await
        .unwrap();
    let mut frame = [0u8; 4];
    tokio::time::timeout(Duration::from_secs(3), s.read_exact(&mut frame))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(frame, [0x81, 0x02, b'h', b'i']);
}

#[tokio::test]
async fn a_request_in_flight_finishes_after_the_shutdown_signal_and_serve_then_returns() {
    let router = axum::Router::new().route(
        "/slow",
        axum::routing::get(|| async {
            tokio::time::sleep(Duration::from_millis(500)).await;
            "done"
        }),
    );
    let (stop, stopped) = tokio::sync::oneshot::channel::<()>();
    let (addr, server) = serve_test_router(router, async move {
        let _ = stopped.await;
    })
    .await;
    let mut s = TcpStream::connect(addr).await.unwrap();
    s.write_all(format!("GET /slow HTTP/1.1\r\nHost: {addr}\r\n\r\n").as_bytes())
        .await
        .unwrap();
    tokio::time::sleep(Duration::from_millis(100)).await;
    stop.send(()).unwrap();
    let mut out = Vec::new();
    tokio::time::timeout(Duration::from_secs(3), s.read_to_end(&mut out))
        .await
        .expect("the answer arrives")
        .ok();
    assert!(String::from_utf8_lossy(&out).ends_with("done"), "{}", String::from_utf8_lossy(&out));
    tokio::time::timeout(Duration::from_secs(3), server)
        .await
        .expect("serve returns within the drain grace")
        .unwrap()
        .unwrap();
}
