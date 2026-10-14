//! S10a: the edge DoS findings (HTTP-1, HTTP-2, HTTP-3, CFG-1, WS-1, L10), each as the attack in miniature over a
//! real socket.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    reason = "tests"
)]

use super::*;
use crate::http::gate;
use crate::http::server::{Admission, Limits, serve_limited};
use axum::routing::get;

async fn listen(router: axum::Router, limits: Limits) -> SocketAddr {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(serve_limited(listener, router, std::future::pending(), limits));
    addr
}

fn quick() -> Limits {
    Limits {
        write_stall: Duration::from_millis(300),
        ..Limits::default()
    }
}

const BIG: usize = 48 << 20;

fn big_router() -> axum::Router {
    axum::Router::new()
        .route("/big", get(|| async { axum::body::Body::from(vec![0u8; BIG]) }))
        .route("/ok", get(|| async { "ok" }))
}

async fn get_ok(addr: SocketAddr) -> String {
    let mut s = TcpStream::connect(addr).await.unwrap();
    s.write_all(b"GET /ok HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n")
        .await
        .unwrap();
    let mut buf = Vec::new();
    let _ = tokio::time::timeout(Duration::from_secs(3), s.read_to_end(&mut buf)).await;
    String::from_utf8_lossy(&buf).into_owned()
}

// HTTP-1: t24/t25. A client that never reads is cut after the write-stall timeout, and its slot is released.
#[tokio::test]
async fn a_reader_that_stalls_is_cut_after_the_write_stall_timeout_and_frees_its_slot() {
    let addr = listen(
        big_router(),
        Limits {
            max_connections: 1,
            ..quick()
        },
    )
    .await;
    let mut stalled = TcpStream::connect(addr).await.unwrap();
    stalled.write_all(b"GET /big HTTP/1.1\r\nHost: x\r\n\r\n").await.unwrap();
    tokio::time::sleep(Duration::from_millis(1200)).await;
    // Now read: the server has hung up, so what is left is only what its socket buffers held.
    let mut got = Vec::new();
    let _ = tokio::time::timeout(Duration::from_secs(10), stalled.read_to_end(&mut got)).await;
    assert!(
        got.len() < BIG,
        "the server kept writing to a client that did not read ({} bytes)",
        got.len()
    );
    // The one connection slot is free again.
    assert!(get_ok(addr).await.starts_with("HTTP/1.1 200"));
}

// L10: past the open-connection cap a connection is closed at once.
#[tokio::test]
async fn a_connection_over_the_global_cap_is_closed_immediately() {
    let addr = listen(
        big_router(),
        Limits {
            max_connections: 2,
            ..quick()
        },
    )
    .await;
    let a = TcpStream::connect(addr).await.unwrap();
    let _b = TcpStream::connect(addr).await.unwrap();
    tokio::time::sleep(Duration::from_millis(100)).await;
    let mut c = TcpStream::connect(addr).await.unwrap();
    let _ = c.write_all(b"GET /ok HTTP/1.1\r\nHost: x\r\n\r\n").await;
    let mut buf = Vec::new();
    let read = tokio::time::timeout(Duration::from_secs(2), c.read_to_end(&mut buf)).await;
    assert!(read.is_ok() && buf.is_empty(), "the third connection was served or kept");
    drop(a);
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert!(get_ok(addr).await.starts_with("HTTP/1.1 200"));
}

// L10: per peer address, loopback excepted (behind the tunnel every client is loopback).
#[test]
fn the_per_address_cap_counts_open_connections_and_exempts_loopback() {
    let admission = Admission::new(100, 2);
    let ip: std::net::IpAddr = "198.51.100.1".parse().unwrap();
    let a = admission.admit(ip);
    let b = admission.admit(ip);
    assert!(a.is_some() && b.is_some());
    assert!(admission.admit(ip).is_none(), "third from one address");
    assert!(admission.admit("198.51.100.2".parse().unwrap()).is_some(), "another address");
    drop(a);
    assert!(admission.admit(ip).is_some(), "a slot came free");
    let lo: std::net::IpAddr = "127.0.0.1".parse().unwrap();
    let held: Vec<_> = (0..5).map(|_| admission.admit(lo)).collect();
    assert!(held.iter().all(Option::is_some), "loopback is not counted per address");
    let tiny = Admission::new(1, 5);
    let first = tiny.admit(ip);
    assert!(first.is_some() && tiny.admit(lo).is_none(), "the global cap covers loopback too");
}

// HTTP-2: t7. One key can't take every slot with slow bodies.
#[tokio::test]
async fn one_key_cannot_hold_every_in_flight_slot() {
    let fx = Fx::proxied(&[]).await;
    fx.app.http.set_key_in_flight(2);
    let mut held = Vec::new();
    for _ in 0..2 {
        let mut s = TcpStream::connect(fx.addr).await.unwrap();
        let head = format!(
            "POST /rooms/lobby/report HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nContent-Type: application/json\r\nX-Forwarded-For: 198.51.100.7\r\nContent-Length: 40\r\n\r\n{{",
            fx.addr.port()
        );
        s.write_all(head.as_bytes()).await.unwrap();
        held.push(s);
    }
    tokio::time::sleep(Duration::from_millis(200)).await;
    let same = fx.get("/healthz", &[("x-forwarded-for", "198.51.100.7")]).await;
    assert_eq!((same.status, same.text().as_str()), (503, "server busy"));
    assert_eq!(fx.get("/healthz", &[("x-forwarded-for", "198.51.100.8")]).await.status, 200);
    drop(held);
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert_eq!(
        fx.get("/healthz", &[("x-forwarded-for", "198.51.100.7")]).await.status,
        200,
        "the slots came back"
    );
}

// HTTP-2: the report checks room and key before it reads a body that may never come.
#[tokio::test]
async fn a_report_to_an_unknown_room_is_answered_without_reading_the_body() {
    let fx = Fx::proxied(&[]).await;
    let mut s = TcpStream::connect(fx.addr).await.unwrap();
    let head = format!(
        "POST /rooms/nosuchroom/report HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nContent-Type: application/json\r\nX-Forwarded-For: 198.51.100.9\r\nContent-Length: 40\r\n\r\n",
        fx.addr.port()
    );
    s.write_all(head.as_bytes()).await.unwrap();
    let mut buf = vec![0u8; 4096];
    let n = tokio::time::timeout(Duration::from_secs(2), s.read(&mut buf))
        .await
        .expect("answered while the body is still missing")
        .unwrap();
    assert!(String::from_utf8_lossy(&buf[..n]).starts_with("HTTP/1.1 404"));
}

#[test]
fn a_request_body_gets_five_seconds_in_all() {
    assert_eq!(crate::http::HttpState::default().body_total(), Duration::from_secs(5));
}

// HTTP-3: t4. A head past 16 KiB is refused (Bun: 431).
#[tokio::test]
async fn a_17_kib_request_head_is_refused_with_431() {
    let fx = Fx::start(&[]).await;
    let pad = "a".repeat(17 * 1024);
    let res = fx.get("/healthz", &[("x-pad", pad.as_str())]).await;
    assert_eq!(res.status, 431);
    assert_eq!(fx.get("/healthz", &[("x-pad", "a".repeat(4096).as_str())]).await.status, 200);
}

// CFG-1: t3.
#[test]
fn an_https_public_origin_without_trust_proxy_is_refused_naming_both_variables() {
    let parse = |pairs: &[(&str, &str)]| crate::config::parse_config(&testing::env(pairs), std::path::Path::new("/"));
    let err = parse(&[("PUBLIC_ORIGIN", "https://quiet-otter.ngrok-free.app")]).unwrap_err();
    let text = err.to_string();
    assert!(text.contains("TRUST_PROXY") && text.contains("PUBLIC_ORIGIN"), "{text}");
    assert!(parse(&[("PUBLIC_ORIGIN", "https://quiet-otter.ngrok-free.app"), ("TRUST_PROXY", "loopback")]).is_ok());
    assert!(parse(&[]).is_ok());
}

#[tokio::test]
async fn behind_a_public_origin_a_loopback_client_is_keyed_not_exempt() {
    use axum::http::{HeaderMap, HeaderValue};
    let fx = Fx::start(&[("PUBLIC_ORIGIN", "https://quiet-otter.ngrok-free.app"), ("TRUST_PROXY", "loopback")]).await;
    let peer: std::net::IpAddr = "127.0.0.1".parse().unwrap();
    let mut xff = HeaderMap::new();
    xff.insert("x-forwarded-for", HeaderValue::from_static("127.0.0.1"));
    assert!(!crate::rate_limit::is_loopback_key(&gate::client_key(&fx.app, Some(peer), &xff)));
    xff.insert("x-forwarded-for", HeaderValue::from_static("198.51.100.1"));
    assert_eq!(gate::client_key(&fx.app, Some(peer), &xff), "198.51.100.1");
    // Without a public origin, local dev keeps the exemption.
    let dev = Fx::start(&[]).await;
    assert!(crate::rate_limit::is_loopback_key(&gate::client_key(
        &dev.app,
        Some(peer),
        &HeaderMap::new()
    )));
}

// WS-1: t20. Only a GET upgrade skips the HTTP bucket.
#[tokio::test]
async fn other_methods_on_the_ws_path_are_metered_like_any_route() {
    let fx = Fx::proxied(&[]).await;
    let h = [("x-forwarded-for", "198.51.100.20")];
    let mut limited = false;
    for _ in 0..(gate::HTTP_BURST as usize + 5) {
        if fx.send("POST", "/rooms/lobby/ws", &h, "").await.status == 429 {
            limited = true;
            break;
        }
    }
    assert!(limited, "POST /rooms/x/ws never hit the bucket");
    let h = [("x-forwarded-for", "198.51.100.21")];
    let mut limited = false;
    for _ in 0..(gate::HTTP_BURST as usize + 5) {
        if fx.get("/rooms/lobby/ws", &h).await.status == 429 {
            limited = true;
            break;
        }
    }
    assert!(limited, "a GET without Upgrade never hit the bucket");
}
