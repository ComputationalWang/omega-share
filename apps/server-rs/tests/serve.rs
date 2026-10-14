//! The binary end to end: startup refusal, a listening server, and shutdown.

use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpStream;
use std::process::{Child, ChildStdout, Command, Stdio};
use std::time::{Duration, Instant};

const BIN: &str = env!("CARGO_BIN_EXE_omega-server");

/// Kills the server when the test ends, pass or fail.
struct Server(Child);

impl Drop for Server {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

/// Starts `serve` on an ephemeral port; returns the server and its `host:port`.
fn start() -> (Server, String) {
    let mut child = Command::new(BIN)
        .arg("serve")
        .env("PORT", "0")
        .env("DB_PATH", ":memory:")
        .env("ADMIN_SOCKET", "off")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let stdout: ChildStdout = child.stdout.take().unwrap();
    let mut line = String::new();
    BufReader::new(stdout).read_line(&mut line).unwrap();
    // `omega-share server on http://127.0.0.1:<port>/ (site origin http://localhost:5173)`
    let url = line.split_whitespace().nth(3).unwrap_or_else(|| panic!("no url in {line:?}"));
    let addr = url.trim_start_matches("http://").trim_end_matches('/').to_owned();
    (Server(child), addr)
}

/// Sends SIGTERM and waits up to `limit` for the exit.
fn terminate(server: &mut Server, limit: Duration) -> Option<std::process::ExitStatus> {
    let sent = Command::new("kill").args(["-TERM", &server.0.id().to_string()]).status().unwrap();
    assert!(sent.success());
    let deadline = Instant::now() + limit;
    while Instant::now() < deadline {
        if let Some(status) = server.0.try_wait().unwrap() {
            return Some(status);
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    None
}

fn stderr_of(server: &mut Server) -> String {
    let mut err = String::new();
    server.0.stderr.take().unwrap().read_to_string(&mut err).unwrap();
    err
}

#[test]
fn a_bad_public_origin_exits_non_zero_before_listening() {
    let out = Command::new(BIN)
        .arg("serve")
        .env("PORT", "0")
        .env("DB_PATH", ":memory:")
        .env("PUBLIC_ORIGIN", "http://plain.example")
        .output()
        .unwrap();
    assert!(!out.status.success());
    assert!(String::from_utf8_lossy(&out.stderr).contains("PUBLIC_ORIGIN"));
    assert!(!String::from_utf8_lossy(&out.stdout).contains("server on"));
}

#[test]
fn a_non_utf8_config_value_is_refused_naming_the_variable() {
    use std::os::unix::ffi::OsStringExt;
    let mut server = Server(
        Command::new(BIN)
            .arg("serve")
            .env("PORT", "0")
            .env("DB_PATH", std::ffi::OsString::from_vec(b"/tmp/omega-\xff.db".to_vec()))
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap(),
    );
    // A server that wrongly accepts the value keeps running: give up after 5 s instead of hanging.
    let deadline = Instant::now() + Duration::from_secs(5);
    let status = loop {
        if let Some(status) = server.0.try_wait().unwrap() {
            break status;
        }
        assert!(Instant::now() < deadline, "still serving with a non-UTF-8 DB_PATH");
        std::thread::sleep(Duration::from_millis(20));
    };
    assert!(!status.success());
    assert!(stderr_of(&mut server).contains("DB_PATH"));
}

#[test]
fn an_unknown_command_exits_non_zero() {
    let out = Command::new(BIN).arg("launch-rockets").output().unwrap();
    assert!(!out.status.success());
    assert!(String::from_utf8_lossy(&out.stderr).contains("usage"));
}

#[test]
fn serves_on_an_ephemeral_port_and_announces_it() {
    let (server, addr) = start();
    let mut stream = TcpStream::connect(&addr).unwrap();
    stream.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
    write!(stream, "GET /no-such-path HTTP/1.1\r\nHost: {addr}\r\nConnection: close\r\n\r\n").unwrap();
    let mut response = String::new();
    stream.read_to_string(&mut response).unwrap();
    assert!(response.starts_with("HTTP/1.1 404"), "{response}");
    drop(server);
}

// apps/server/test/graceful-restart.test.ts: a clean SIGTERM exits 0 with nothing on stderr.
#[test]
fn sigterm_exits_zero_quietly() {
    let (mut server, _) = start();
    let status = terminate(&mut server, Duration::from_secs(5)).expect("still running 5 s after SIGTERM");
    assert!(status.success(), "{status:?}");
    assert_eq!(stderr_of(&mut server), "");
}

// A client stalled mid-request (slowloris) must not hold a restart hostage until systemd's SIGKILL.
#[test]
fn sigterm_exits_promptly_even_with_a_stalled_request() {
    let (mut server, addr) = start();
    let mut stalled = TcpStream::connect(&addr).unwrap();
    write!(stalled, "GET / HTTP/1.1\r\nHost: {addr}\r\nX-A: ").unwrap();
    std::thread::sleep(Duration::from_millis(100));
    let status = terminate(&mut server, Duration::from_secs(6)).expect("a stalled request held the shutdown");
    assert!(status.success(), "{status:?}");
    assert_eq!(stderr_of(&mut server), "");
}
