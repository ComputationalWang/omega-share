//! The binary end to end: startup refusal and a listening server.

use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpStream;
use std::process::{Child, Command, Stdio};
use std::time::Duration;

const BIN: &str = env!("CARGO_BIN_EXE_omega-server");

/// Kills the server when the test ends, pass or fail.
struct Server(Child);

impl Drop for Server {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
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
fn an_unknown_command_exits_non_zero() {
    let out = Command::new(BIN).arg("launch-rockets").output().unwrap();
    assert!(!out.status.success());
    assert!(String::from_utf8_lossy(&out.stderr).contains("usage"));
}

#[test]
fn serves_on_an_ephemeral_port_and_announces_it() {
    let mut child = Command::new(BIN)
        .arg("serve")
        .env("PORT", "0")
        .env("DB_PATH", ":memory:")
        .env("ADMIN_SOCKET", "off")
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let stdout = child.stdout.take().unwrap();
    let server = Server(child);
    let mut line = String::new();
    BufReader::new(stdout).read_line(&mut line).unwrap();
    // `omega-share server on http://127.0.0.1:<port>/ (site origin http://localhost:5173)`
    let url = line.split_whitespace().nth(3).unwrap_or_else(|| panic!("no url in {line:?}"));
    let addr = url.trim_start_matches("http://").trim_end_matches('/');
    let mut stream = TcpStream::connect(addr).unwrap();
    stream.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
    write!(stream, "GET /no-such-path HTTP/1.1\r\nHost: {addr}\r\nConnection: close\r\n\r\n").unwrap();
    let mut response = String::new();
    stream.read_to_string(&mut response).unwrap();
    assert!(response.starts_with("HTTP/1.1 404"), "{response}");
    drop(server);
}
