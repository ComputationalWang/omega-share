//! The test-hooks binary's process behaviour for the black-box harness (feature `test-hooks`).
#![cfg(feature = "test-hooks")]
#![allow(clippy::unwrap_used, clippy::expect_used, reason = "a test")]

use std::io::{BufRead, BufReader, Read};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

const BIN: &str = env!("CARGO_BIN_EXE_omega-server");

fn spawn(guard: bool) -> std::process::Child {
    let mut cmd = Command::new(BIN);
    cmd.env("PORT", "0")
        .env("DB_PATH", ":memory:")
        .env("ADMIN_SOCKET", "off")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if guard {
        cmd.env("OMEGA_TEST_STDIN_GUARD", "1");
    }
    let mut child = cmd.spawn().unwrap();
    let mut line = String::new();
    BufReader::new(child.stdout.take().unwrap()).read_line(&mut line).unwrap();
    assert!(line.contains("omega-share server on"), "{line:?}");
    child
}

fn wait(child: &mut std::process::Child, limit: Duration) -> Option<std::process::ExitStatus> {
    let deadline = Instant::now() + limit;
    while Instant::now() < deadline {
        if let Some(status) = child.try_wait().unwrap() {
            return Some(status);
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    None
}

#[test]
fn with_the_guard_the_server_exits_cleanly_when_its_stdin_closes() {
    let mut child = spawn(true);
    drop(child.stdin.take());
    let status = wait(&mut child, Duration::from_secs(5));
    if status.is_none() {
        child.kill().unwrap();
    }
    let mut stderr = String::new();
    child.stderr.take().unwrap().read_to_string(&mut stderr).unwrap();
    assert_eq!(status.and_then(|s| s.code()), Some(0));
    assert_eq!(stderr, "");
}

#[test]
fn without_the_guard_a_closed_stdin_changes_nothing() {
    let mut child = spawn(false);
    drop(child.stdin.take());
    assert!(wait(&mut child, Duration::from_millis(500)).is_none());
    child.kill().unwrap();
    child.wait().unwrap();
}
