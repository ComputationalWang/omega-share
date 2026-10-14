//! The accept loop: hyper's HTTP/1 server with a header-read timeout (slowloris), a write-stall timeout, caps on open
//! connections, graceful shutdown, and the peer address on every request (`ConnectInfo<SocketAddr>`, as
//! `axum::serve` would give it). `axum::serve` has no knob for any of it, so the loop is ours; hyper, hyper-util and
//! tower-service are what axum itself uses.

use axum::Router;
use axum::extract::ConnectInfo;
use hyper::body::Incoming;
use hyper::server::conn::http1;
use hyper::service::service_fn;
use hyper_util::rt::{TokioIo, TokioTimer};
use std::collections::HashMap;
use std::convert::Infallible;
use std::future::Future;
use std::net::IpAddr;
use std::pin::Pin;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, PoisonError};
use std::task::{Context, Poll};
use std::time::Duration;
use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::watch;
use tokio::time::Sleep;
use tower_service::Service;

/// How long a client may take to send its request head, and to send the next one on a kept-alive connection
/// (Bun's `idleTimeout` did this in TS).
pub const HEADER_READ_TIMEOUT: Duration = Duration::from_secs(10);

/// The most a request head may take (Bun: 16 KiB, then 431; hyper's default is about 400 KB).
pub const MAX_HEAD_BYTES: usize = 16 * 1024;

/// Caps and timeouts of the listener (HTTP-1, L10 of the S10 audit).
#[derive(Debug, Clone, Copy)]
pub struct Limits {
    pub header_read_timeout: Duration,
    /// A response write that makes no progress for this long cuts the connection (Bun's `idleTimeout`, about 10 s).
    pub write_stall: Duration,
    /// Open connections, WebSockets included: `MAX_CONNECTIONS` plus headroom, under `LimitNOFILE=4096`.
    pub max_connections: usize,
    /// Open connections per non-loopback peer address.
    pub max_per_ip: usize,
}

impl Default for Limits {
    fn default() -> Self {
        Self {
            header_read_timeout: HEADER_READ_TIMEOUT,
            write_stall: Duration::from_secs(10),
            max_connections: 1280,
            max_per_ip: 128,
        }
    }
}

/// Counts open connections, in all and per peer address (loopback peers, the tunnel agent, only in all).
#[derive(Debug, Clone)]
pub struct Admission(Arc<Counts>);

#[derive(Debug)]
struct Counts {
    max: usize,
    max_per_ip: usize,
    open: AtomicUsize,
    per_ip: Mutex<HashMap<IpAddr, usize>>,
}

/// An open connection's place; the slot goes back when it drops.
#[derive(Debug)]
pub struct Permit {
    counts: Arc<Counts>,
    ip: Option<IpAddr>,
}

impl Admission {
    pub fn new(max: usize, max_per_ip: usize) -> Self {
        Self(Arc::new(Counts {
            max,
            max_per_ip,
            open: AtomicUsize::new(0),
            per_ip: Mutex::new(HashMap::new()),
        }))
    }

    /// `None` when the connection is over a cap.
    pub fn admit(&self, peer: IpAddr) -> Option<Permit> {
        let counts = &self.0;
        if counts.open.fetch_add(1, Ordering::AcqRel) >= counts.max {
            counts.open.fetch_sub(1, Ordering::AcqRel);
            return None;
        }
        let ip = (!peer.to_canonical().is_loopback()).then_some(peer);
        if let Some(ip) = ip {
            let mut per_ip = counts.per_ip.lock().unwrap_or_else(PoisonError::into_inner);
            let n = per_ip.entry(ip).or_insert(0);
            if *n >= counts.max_per_ip {
                drop(per_ip);
                counts.open.fetch_sub(1, Ordering::AcqRel);
                return None;
            }
            *n += 1;
        }
        Some(Permit {
            counts: counts.clone(),
            ip,
        })
    }
}

impl Drop for Permit {
    fn drop(&mut self) {
        self.counts.open.fetch_sub(1, Ordering::AcqRel);
        if let Some(ip) = self.ip {
            let mut per_ip = self.counts.per_ip.lock().unwrap_or_else(PoisonError::into_inner);
            if let Some(n) = per_ip.get_mut(&ip) {
                *n = n.saturating_sub(1);
                if *n == 0 {
                    per_ip.remove(&ip);
                }
            }
        }
    }
}

/// The accepted stream, failing a write that makes no progress for `stall` (Bun's `idleTimeout` did this in TS): a
/// client that stops reading would otherwise hold its connection, and the file behind its response, forever.
struct StallGuard {
    inner: TcpStream,
    stall: Duration,
    timer: Option<Pin<Box<Sleep>>>,
    /// Held as long as the stream lives, so an upgraded WebSocket keeps its place too.
    _permit: Permit,
}

impl StallGuard {
    fn guard<T>(&mut self, cx: &mut Context<'_>, polled: Poll<std::io::Result<T>>) -> Poll<std::io::Result<T>> {
        if polled.is_ready() {
            self.timer = None;
            return polled;
        }
        let stall = self.stall;
        let timer = self.timer.get_or_insert_with(|| Box::pin(tokio::time::sleep(stall)));
        if timer.as_mut().poll(cx).is_ready() {
            return Poll::Ready(Err(std::io::ErrorKind::TimedOut.into()));
        }
        Poll::Pending
    }
}

impl AsyncRead for StallGuard {
    fn poll_read(mut self: Pin<&mut Self>, cx: &mut Context<'_>, buf: &mut ReadBuf<'_>) -> Poll<std::io::Result<()>> {
        Pin::new(&mut self.inner).poll_read(cx, buf)
    }
}

impl AsyncWrite for StallGuard {
    fn poll_write(mut self: Pin<&mut Self>, cx: &mut Context<'_>, buf: &[u8]) -> Poll<std::io::Result<usize>> {
        let polled = Pin::new(&mut self.inner).poll_write(cx, buf);
        self.guard(cx, polled)
    }

    fn poll_write_vectored(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        bufs: &[std::io::IoSlice<'_>],
    ) -> Poll<std::io::Result<usize>> {
        let polled = Pin::new(&mut self.inner).poll_write_vectored(cx, bufs);
        self.guard(cx, polled)
    }

    fn is_write_vectored(&self) -> bool {
        self.inner.is_write_vectored()
    }

    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        let polled = Pin::new(&mut self.inner).poll_flush(cx);
        self.guard(cx, polled)
    }

    fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        Pin::new(&mut self.inner).poll_shutdown(cx)
    }
}

/// Serves `router` on `listener` until `shutdown` resolves, then lets open connections finish (the caller bounds
/// how long it waits).
pub async fn serve(listener: TcpListener, router: Router, shutdown: impl Future<Output = ()> + Send) -> std::io::Result<()> {
    serve_limited(listener, router, shutdown, Limits::default()).await
}

/// `serve` with another header-read timeout (tests, the metrics listener).
pub async fn serve_with(
    listener: TcpListener,
    router: Router,
    shutdown: impl Future<Output = ()> + Send,
    header_read_timeout: Duration,
) -> std::io::Result<()> {
    let limits = Limits {
        header_read_timeout,
        ..Limits::default()
    };
    serve_limited(listener, router, shutdown, limits).await
}

/// `serve` under `limits`.
pub async fn serve_limited(
    listener: TcpListener,
    router: Router,
    shutdown: impl Future<Output = ()> + Send,
    limits: Limits,
) -> std::io::Result<()> {
    let admission = Admission::new(limits.max_connections, limits.max_per_ip);
    // Each connection holds a receiver: the sender's `closed` is "every connection has ended".
    let (stop, _) = watch::channel(false);
    let mut shutdown = std::pin::pin!(shutdown);
    loop {
        let (stream, peer) = tokio::select! {
            accepted = listener.accept() => match accepted {
                Ok(connection) => connection,
                // A connection that died before we saw it is not the listener's problem; running out of
                // descriptors is, for a moment: don't spin on it.
                Err(err) if matches!(err.kind(), std::io::ErrorKind::ConnectionAborted | std::io::ErrorKind::ConnectionReset) => continue,
                Err(_) => {
                    tokio::time::sleep(Duration::from_secs(1)).await;
                    continue;
                }
            },
            () = &mut shutdown => break,
        };
        // Over a cap: hang up now, before a byte is read (an idle socket costs a descriptor).
        let Some(permit) = admission.admit(peer.ip()) else {
            continue;
        };
        // Small frames (a chat line, a playback tick) must not wait for Nagle.
        let _ = stream.set_nodelay(true);
        let router = router.clone();
        let service = service_fn(move |mut req: hyper::Request<Incoming>| {
            req.extensions_mut().insert(ConnectInfo(peer));
            let mut router = router.clone();
            async move { Ok::<_, Infallible>(router.call(req).await.unwrap_or_else(|never| match never {})) }
        });
        let io = StallGuard {
            inner: stream,
            stall: limits.write_stall,
            timer: None,
            _permit: permit,
        };
        let connection = http1::Builder::new()
            .timer(TokioTimer::new())
            .header_read_timeout(limits.header_read_timeout)
            .max_buf_size(MAX_HEAD_BYTES)
            .serve_connection(TokioIo::new(io), service)
            .with_upgrades();
        let mut stopping = stop.subscribe();
        tokio::spawn(async move {
            let mut connection = std::pin::pin!(connection);
            tokio::select! {
                _ = connection.as_mut() => return,
                _ = stopping.wait_for(|stop| *stop) => {}
            }
            // Finish the request in flight, answer no more, close.
            connection.as_mut().graceful_shutdown();
            let _ = connection.await;
        });
    }
    let _ = stop.send(true);
    stop.closed().await;
    Ok(())
}
