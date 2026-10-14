//! `GET /metrics` on 127.0.0.1:`METRICS_PORT`, nothing else (OME-504; `startMetrics` in apps/server/src/metrics.ts).
//! Prometheus text, only counts, sizes and durations: no label or value ever names an address, nickname, room or
//! title. The bind address is not configurable; the Host check refuses DNS rebinding from a browser on the box,
//! like the app's own (ADR 0015 section 4).

use crate::app::App;
use crate::metrics::Gauges;
use crate::reports;
use axum::Router;
use axum::extract::State;
use axum::http::{HeaderMap, HeaderName, HeaderValue, Method, StatusCode, Uri, header};
use axum::response::{IntoResponse, Response};
use std::sync::Arc;
use tokio::net::TcpListener;
use tokio::task::JoinHandle;

/// One answer of the listener.
#[derive(Debug, PartialEq, Eq)]
pub struct Answer {
    pub status: u16,
    pub headers: Vec<(&'static str, &'static str)>,
    pub body: String,
}

/// `process.memoryUsage.rss()`: the resident set from `/proc/self/status` (`VmRSS`, in kB); 0 where it is not readable.
fn rss_bytes() -> f64 {
    let Ok(status) = std::fs::read_to_string("/proc/self/status") else {
        return 0.0;
    };
    let kb = status
        .lines()
        .find_map(|l| l.strip_prefix("VmRSS:"))
        .and_then(|v| v.trim().strip_suffix("kB"))
        .and_then(|v| v.trim().parse::<f64>().ok());
    kb.map_or(0.0, |kb| kb * 1024.0)
}

/// The text of one scrape: the counters plus what the live server knows right now. Rooms are locked one at a time,
/// never with the registry held.
pub fn render(app: &App) -> String {
    let cells = app.registry.values();
    let (mut members, mut sockets) = (0u64, 0u64);
    for cell in &cells {
        let inner = cell.lock();
        members += u64::try_from(inner.room.member_count()).unwrap_or(u64::MAX);
        // Attached connections, joined or not: S6's open-connection counter has no other source of truth yet.
        sockets += u64::try_from(inner.subscribers.len()).unwrap_or(u64::MAX);
    }
    app.metrics.render(&Gauges {
        rooms: u64::try_from(cells.len()).unwrap_or(u64::MAX),
        sockets,
        members,
        open_reports: reports::open_count(app).map_or(0, |n| u64::try_from(n).unwrap_or(u64::MAX)),
        rss_bytes: rss_bytes(),
        uptime_seconds: app.ops.uptime_seconds(),
    })
}

const TEXT: (&str, &str) = ("content-type", "text/plain;charset=utf-8");

fn plain(status: u16, body: &str, extra: Option<(&'static str, &'static str)>) -> Answer {
    let mut headers = vec![TEXT];
    headers.extend(extra);
    Answer {
        status,
        headers,
        body: body.to_owned(),
    }
}

/// The listener's routing: `host` is the Host header (if any), `port` the port it listens on.
pub fn respond(app: &App, port: u16, method: &str, host: Option<&str>, path: &str) -> Answer {
    let host = host.map(str::to_ascii_lowercase).unwrap_or_default();
    if host != format!("127.0.0.1:{port}") && host != format!("localhost:{port}") {
        return plain(421, "misdirected request\n", None);
    }
    if path != "/metrics" {
        return plain(404, "not found\n", None);
    }
    if method != "GET" && method != "HEAD" {
        return plain(405, "method not allowed\n", Some(("allow", "GET, HEAD")));
    }
    Answer {
        status: 200,
        headers: vec![
            ("content-type", "text/plain; version=0.0.4; charset=utf-8"),
            ("cache-control", "no-store"),
        ],
        body: render(app),
    }
}

/// The running listener.
pub struct MetricsServer {
    task: JoinHandle<()>,
    port: u16,
}

impl MetricsServer {
    pub fn port(&self) -> u16 {
        self.port
    }

    pub fn stop(self) {
        self.task.abort();
    }
}

async fn scrape(State((app, port)): State<(Arc<App>, u16)>, method: Method, headers: HeaderMap, uri: Uri) -> Response {
    let host = headers.get(header::HOST).and_then(|h| h.to_str().ok());
    let answer = respond(&app, port, method.as_str(), host, uri.path());
    let mut response = (
        StatusCode::from_u16(answer.status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR),
        answer.body,
    )
        .into_response();
    for (name, value) in answer.headers {
        response
            .headers_mut()
            .insert(HeaderName::from_static(name), HeaderValue::from_static(value));
    }
    response
}

/// Binds 127.0.0.1:`port` (0 for any) and serves scrapes. Loopback only: the address is not configurable.
pub async fn start_metrics(app: Arc<App>, port: u16) -> std::io::Result<MetricsServer> {
    start_metrics_with(app, port, crate::http::server::HEADER_READ_TIMEOUT).await
}

/// `start_metrics` with another header-read timeout (tests).
pub async fn start_metrics_with(app: Arc<App>, port: u16, header_read_timeout: std::time::Duration) -> std::io::Result<MetricsServer> {
    let _ = header_read_timeout;
    let listener = TcpListener::bind(("127.0.0.1", port)).await?;
    let port = listener.local_addr()?.port();
    let router = Router::new().fallback(scrape).with_state((app, port));
    let task = tokio::spawn(async move {
        let _ = axum::serve(listener, router).await;
    });
    Ok(MetricsServer { task, port })
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::indexing_slicing, reason = "tests")]
mod tests {
    use super::*;
    use crate::app::testing::{add_room, app, rid};
    use crate::contract::room::Avatar;
    use crate::contract::text::Nickname;
    use crate::outbox::{ConnId, channel};
    use crate::registry::RemoveReason;
    use crate::room::RoomInit;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    const NICK: &str = "zelda-metrics-nick";
    const ROOM: &str = "metrics-secret-room";
    const TITLE: &str = "Very Private Title";

    fn sample(text: &str, name: &str) -> f64 {
        let line = text
            .lines()
            .find(|l| l.starts_with(&format!("{name} ")))
            .unwrap_or_else(|| panic!("no sample {name}"));
        line.get(name.len() + 1..).unwrap().parse().unwrap()
    }

    // apps/server/test/metrics.test.ts:50
    #[test]
    fn refuses_other_hosts_paths_and_methods_and_serves_prometheus_text() {
        let (app, _) = app();
        let ask = |method: &str, host: Option<&str>, path: &str| respond(&app, 9464, method, host, path);
        let ok = ask("GET", Some("127.0.0.1:9464"), "/metrics");
        assert_eq!(ok.status, 200);
        assert!(ok.headers.contains(&("content-type", "text/plain; version=0.0.4; charset=utf-8")));
        assert!(ok.headers.contains(&("cache-control", "no-store")));
        assert!(ok.body.contains("# TYPE omega_rooms gauge"));
        assert_eq!(ask("GET", Some("localhost:9464"), "/metrics").status, 200);
        assert_eq!(ask("HEAD", Some("LOCALHOST:9464"), "/metrics").status, 200);
        assert_eq!(ask("GET", Some("omega-share.duckdns.org"), "/metrics").status, 421);
        assert_eq!(ask("GET", Some("127.0.0.1:1"), "/metrics").status, 421);
        assert_eq!(ask("GET", None, "/metrics").status, 421);
        assert_eq!(ask("GET", Some("127.0.0.1:9464"), "/").status, 404);
        assert_eq!(ask("GET", Some("127.0.0.1:9464"), "/metrics/x").status, 404);
        let post = ask("POST", Some("127.0.0.1:9464"), "/metrics");
        assert_eq!(post.status, 405);
        assert!(post.headers.contains(&("allow", "GET, HEAD")));
        assert_eq!(ask("GET", Some("evil"), "/").body, "misdirected request\n");
        assert_eq!(ask("GET", Some("127.0.0.1:9464"), "/").body, "not found\n");
        assert_eq!(post.body, "method not allowed\n");
    }

    // apps/server/test/metrics.test.ts:62
    #[test]
    fn counts_rooms_sockets_members_uptime_and_rss() {
        let (app, _) = app();
        let a = add_room(&app, ROOM, RoomInit::default());
        let b = add_room(&app, "lobby", RoomInit::default());
        let mut keep = Vec::new();
        for cell in [&a, &b] {
            let (outbox, rx) = channel();
            let mut inner = cell.lock();
            inner.attach_socket(ConnId::next(), outbox).unwrap();
            keep.push(rx);
        }
        for (cell, id, name) in [(&a, "m1", NICK), (&b, "m2", "other-nick")] {
            cell.lock()
                .room
                .join_with_id(
                    crate::contract::ids::MemberId::parse(id).unwrap(),
                    &Nickname::parse(name).unwrap(),
                    Avatar::new(0).unwrap(),
                    None,
                )
                .unwrap();
        }
        app.metrics.observe_relay(0.2);
        let text = render(&app);
        assert_eq!(sample(&text, "omega_rooms"), 2.0);
        assert_eq!(sample(&text, "omega_sockets"), 2.0);
        assert_eq!(sample(&text, "omega_members"), 2.0);
        assert_eq!(sample(&text, "omega_relay_latency_seconds_count"), 1.0);
        assert!(sample(&text, "process_resident_memory_bytes") > 1_000_000.0);
        assert!(sample(&text, "process_uptime_seconds") > 0.0);
        assert_eq!(sample(&text, "omega_reports_open"), 0.0);
    }

    // apps/server/test/metrics.test.ts:81
    #[test]
    fn counts_4029_and_4004_closes() {
        let (app, _) = app();
        let cell = add_room(&app, ROOM, RoomInit::default());
        let (outbox, _rx) = channel();
        cell.lock().attach_socket(ConnId::next(), outbox).unwrap();
        let before = render(&app);
        assert!(before.contains("omega_ws_closes_total{code=\"4029\"} 0\n") && before.contains("omega_ws_closes_total{code=\"4004\"} 0\n"));
        app.metrics.count_close(4029);
        app.remove_room(&rid(ROOM), RemoveReason::Closed);
        let after = render(&app);
        assert!(
            after.contains("omega_ws_closes_total{code=\"4029\"} 1\n") && after.contains("omega_ws_closes_total{code=\"4004\"} 1\n"),
            "{after}"
        );
    }

    // apps/server/test/metrics.test.ts:102
    #[test]
    fn names_no_address_nickname_room_id_or_title_and_every_line_is_a_known_shape() {
        let (app, _) = app();
        let init = RoomInit {
            title: crate::contract::text::RoomTitle::parse(TITLE),
            ..RoomInit::default()
        };
        let cell = add_room(&app, ROOM, init);
        cell.lock()
            .room
            .join_with_id(
                crate::contract::ids::MemberId::parse("m1").unwrap(),
                &Nickname::parse(NICK).unwrap(),
                Avatar::new(0).unwrap(),
                None,
            )
            .unwrap();
        let text = render(&app);
        for secret in [NICK, ROOM, TITLE, "lobby", "127.0.0.1", "203.0.113.9", "::1"] {
            assert!(!text.contains(secret), "{secret}");
        }
        let lines: Vec<&str> = text.trim_end().split('\n').collect();
        assert!(lines.len() > 10);
        for line in lines {
            if let Some(rest) = line.strip_prefix("# ") {
                let mut parts = rest.splitn(3, ' ');
                assert!(matches!(parts.next(), Some("HELP" | "TYPE")), "{line}");
                assert!(
                    parts.next().is_some_and(|n| n.bytes().all(|b| b.is_ascii_lowercase() || b == b'_')),
                    "{line}"
                );
                assert!(parts.next().is_some_and(|t| !t.is_empty()), "{line}");
                continue;
            }
            let (series, value) = line.rsplit_once(' ').unwrap();
            assert!(value.parse::<f64>().is_ok(), "{line}");
            let (name, label) = series.split_once('{').map_or((series, None), |(n, l)| (n, Some(l)));
            assert!(name.bytes().all(|b| b.is_ascii_lowercase() || b == b'_'), "{line}");
            if let Some(label) = label {
                let label = label.strip_suffix('}').unwrap();
                let (key, value) = label.split_once('=').unwrap();
                let value = value.trim_matches('"');
                let known = match key {
                    "le" | "code" => value == "+Inf" || value.parse::<f64>().is_ok(),
                    "outcome" => [
                        "received",
                        "already_reported",
                        "invalid_body",
                        "payload_too_large",
                        "room_not_found",
                        "rate_limited",
                        "unavailable",
                    ]
                    .contains(&value),
                    "reason" => ["sexual", "violence", "hate", "spam", "danger", "other"].contains(&value),
                    _ => false,
                };
                assert!(known, "{line}");
            }
        }
    }

    async fn get(addr: std::net::SocketAddr, host: &str, method: &str, path: &str) -> String {
        let mut stream = tokio::net::TcpStream::connect(addr).await.unwrap();
        let request = format!("{method} {path} HTTP/1.1\r\nHost: {host}\r\nConnection: close\r\n\r\n");
        stream.write_all(request.as_bytes()).await.unwrap();
        let mut out = String::new();
        stream.read_to_string(&mut out).await.unwrap();
        out
    }

    // apps/server/test/metrics.test.ts:50 (m?.hostname is 127.0.0.1)
    #[tokio::test]
    async fn the_listener_binds_loopback_only_and_checks_the_host_header() {
        let (app, _) = app();
        let server = start_metrics(app, 0).await.unwrap();
        let addr = std::net::SocketAddr::from(([127, 0, 0, 1], server.port()));
        let port = server.port();
        let ok = get(addr, &format!("127.0.0.1:{port}"), "GET", "/metrics").await;
        assert!(ok.starts_with("HTTP/1.1 200"), "{ok}");
        assert!(
            ok.to_lowercase().contains("content-type: text/plain; version=0.0.4; charset=utf-8"),
            "{ok}"
        );
        assert!(ok.contains("omega_rooms 0"), "{ok}");
        assert!(
            get(addr, &format!("localhost:{port}"), "GET", "/metrics")
                .await
                .starts_with("HTTP/1.1 200")
        );
        assert!(
            get(addr, "omega-share.duckdns.org", "GET", "/metrics")
                .await
                .starts_with("HTTP/1.1 421")
        );
        assert!(
            get(addr, &format!("127.0.0.1:{port}"), "GET", "/")
                .await
                .starts_with("HTTP/1.1 404")
        );
        assert!(
            get(addr, &format!("127.0.0.1:{port}"), "POST", "/metrics")
                .await
                .starts_with("HTTP/1.1 405")
        );
        server.stop();
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, reason = "tests")]
mod timeout_tests {
    use super::*;
    use crate::app::testing::app;
    use std::io::{Read, Write};

    // An idle local connection must not live forever (the HTTP listener's slowloris guard).
    #[tokio::test(flavor = "multi_thread")]
    async fn a_client_that_never_finishes_its_head_is_cut() {
        let (app, _) = app();
        let server = start_metrics_with(app, 0, std::time::Duration::from_millis(200)).await.unwrap();
        let port = server.port();
        let got = tokio::task::spawn_blocking(move || {
            let mut stream = std::net::TcpStream::connect(("127.0.0.1", port)).unwrap();
            stream.set_read_timeout(Some(std::time::Duration::from_secs(3))).unwrap();
            stream.write_all(b"GET /metrics HTTP/1.1\r\nX-A: ").unwrap();
            let mut out = Vec::new();
            stream.read_to_end(&mut out).map(|_| out)
        })
        .await
        .unwrap();
        assert!(got.is_ok(), "still open after 3 s: {got:?}");
        server.stop();
    }
}
