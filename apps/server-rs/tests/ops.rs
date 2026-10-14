//! The operator side of the binary end to end (OME-1168): the admin socket and CLI, the metrics listener, backup,
//! and the shutdown sequence, as `deploy/` uses them.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "test helpers: a broken fixture should fail loudly"
)]

use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpStream;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

const BIN: &str = env!("CARGO_BIN_EXE_omega-server");

/// A running `serve`; killed when the test ends.
struct Server {
    child: Child,
    lines: Vec<String>,
    dir: tempfile::TempDir,
}

impl Drop for Server {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

impl Server {
    fn db(&self) -> PathBuf {
        self.dir.path().join("omega.db")
    }
    fn socket(&self) -> PathBuf {
        self.dir.path().join("admin.sock")
    }
    /// The port the `metrics on http://127.0.0.1:<port>/metrics (loopback only)` line names.
    fn metrics_port(&self) -> u16 {
        let line = self.lines.iter().find(|l| l.starts_with("metrics on ")).unwrap();
        line.trim_start_matches("metrics on http://127.0.0.1:").split('/').next().unwrap().parse().unwrap()
    }
    fn terminate(&mut self, signal: &str) -> std::process::ExitStatus {
        assert!(Command::new("kill").args([&format!("-{signal}"), &self.child.id().to_string()]).status().unwrap().success());
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            if let Some(status) = self.child.try_wait().unwrap() {
                return status;
            }
            assert!(Instant::now() < deadline, "still running 10 s after SIG{signal}");
            std::thread::sleep(Duration::from_millis(20));
        }
    }
    fn stderr(&mut self) -> String {
        let mut err = String::new();
        self.child.stderr.take().unwrap().read_to_string(&mut err).unwrap();
        err
    }
}

/// Starts `serve` on a temp DB with the admin socket beside it and a metrics port; returns once it says it listens.
fn start(extra: &[(&str, &str)]) -> Server {
    let dir = tempfile::tempdir().unwrap();
    let mut command = Command::new(BIN);
    command
        .arg("serve")
        .env("PORT", "0")
        .env("DB_PATH", dir.path().join("omega.db"))
        .env("METRICS_PORT", "0")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    for (k, v) in extra {
        command.env(k, v);
    }
    let mut child = command.spawn().unwrap();
    let reader = BufReader::new(child.stdout.take().unwrap());
    // A thread reads stdout for the life of the server (so it never blocks on a full pipe) and the test waits on it
    // with a limit, so a server that never says it listens fails the test instead of hanging it.
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        for line in reader.lines().map_while(Result::ok) {
            if tx.send(line).is_err() {
                break;
            }
        }
    });
    let metrics_off = extra.iter().any(|(k, v)| *k == "METRICS_PORT" && *v == "off");
    let mut lines: Vec<String> = Vec::new();
    // The metrics line is the last one printed; without metrics, the server line is.
    while !lines.iter().any(|l| l.starts_with(if metrics_off { "omega-share server on " } else { "metrics on " })) {
        match rx.recv_timeout(Duration::from_secs(10)) {
            Ok(line) => lines.push(line),
            Err(_) => {
                let _ = child.kill();
                panic!("the server never finished starting: {lines:?}");
            }
        }
    }
    Server { child, lines, dir }
}

fn cli(args: &[&str], socket: &Path) -> std::process::Output {
    Command::new(BIN).arg("admin").args(args).env("ADMIN_SOCKET", socket).output().unwrap()
}

fn text(out: &[u8]) -> String {
    String::from_utf8_lossy(out).into_owned()
}

// apps/server/src/index.ts:56, :60 (the line order of the TS server)
#[test]
fn startup_says_where_the_cli_socket_and_the_metrics_are_before_and_after_the_server_line() {
    let server = start(&[]);
    let at = |prefix: &str| server.lines.iter().position(|l| l.starts_with(prefix)).unwrap_or_else(|| panic!("{prefix}: {:?}", server.lines));
    assert_eq!(server.lines[at("operator CLI socket at ")], format!("operator CLI socket at {}", server.socket().display()));
    assert!(at("operator CLI socket at ") < at("omega-share server on "));
    assert!(at("omega-share server on ") < at("metrics on "));
    assert!(server.lines[at("metrics on ")].ends_with("/metrics (loopback only)"));
}

// apps/server/test/cli.test.ts:244
#[test]
fn the_admin_socket_is_owner_only_and_the_cli_reaches_the_running_server() {
    let server = start(&[]);
    assert_eq!(std::fs::metadata(server.socket()).unwrap().permissions().mode() & 0o777, 0o600);
    let out = cli(&["rooms", "list"], &server.socket());
    assert_eq!(out.status.code(), Some(0), "{}", text(&out.stderr));
    let stdout = text(&out.stdout);
    let mut lines = stdout.lines();
    assert_eq!(lines.next(), Some("id\ttitle\tvisibility\tcreated\tlast active\tpinned\tmembers"));
    let lobby = lines.next().unwrap();
    assert!(lobby.starts_with("lobby\t-\tpublic\t") && lobby.ends_with("\tnever\tyes\t0"), "{lobby}");
    // The same room, taken down over the socket: it is gone from the list and the reports are empty.
    let out = cli(&["reports", "list"], &server.socket());
    assert_eq!((out.status.code(), text(&out.stdout)), (Some(0), "no open reports\n".to_owned()));
    let out = cli(&["rooms", "delete", "lobby"], &server.socket());
    assert_eq!((out.status.code(), text(&out.stdout)), (Some(0), "deleted lobby\n".to_owned()));
    let out = cli(&["rooms", "delete", "lobby"], &server.socket());
    assert_eq!((out.status.code(), text(&out.stderr)), (Some(1), "no room lobby\n".to_owned()));
}

// apps/server/test/cli.test.ts:224, :233
#[test]
fn the_cli_exits_2_on_usage_and_1_without_a_server() {
    let dir = tempfile::tempdir().unwrap();
    let socket = dir.path().join("admin.sock");
    let out = cli(&["rooms", "nuke"], &socket);
    assert_eq!(out.status.code(), Some(2));
    assert!(text(&out.stderr).starts_with("usage: omega-server admin rooms list | rooms delete <id>"));
    let out = cli(&["rooms", "list"], &socket);
    assert_eq!(out.status.code(), Some(1));
    assert!(text(&out.stderr).starts_with(&format!("no server on {}: ", socket.display())), "{}", text(&out.stderr));
    let out = Command::new(BIN).args(["admin", "rooms", "list"]).env("ADMIN_SOCKET", "off").output().unwrap();
    assert_eq!(out.status.code(), Some(1));
    assert_eq!(text(&out.stderr), "the admin socket is off (ADMIN_SOCKET=off or DB_PATH=:memory:)\n");
}

// apps/server/src/index.ts:47: the CLI is optional, the site matters more
#[test]
fn a_path_that_is_not_a_socket_leaves_the_server_serving_without_a_cli_and_the_file_alone() {
    let dir = tempfile::tempdir().unwrap();
    let in_the_way = dir.path().join("taken");
    std::fs::write(&in_the_way, "not a socket").unwrap();
    let mut server = start(&[("ADMIN_SOCKET", in_the_way.to_str().unwrap())]);
    assert!(!server.lines.iter().any(|l| l.starts_with("operator CLI socket")), "{:?}", server.lines);
    assert_eq!(std::fs::read_to_string(&in_the_way).unwrap(), "not a socket");
    let status = server.terminate("TERM");
    assert_eq!(status.code(), Some(0));
    assert_eq!(
        server.stderr(),
        format!(
            "ADMIN_SOCKET {0}: admin socket {0}: exists and is not a socket; the operator CLI is unavailable\n",
            in_the_way.display()
        )
    );
}

// apps/server/test/metrics.test.ts:50
#[test]
fn metrics_are_scraped_over_loopback_with_a_matching_host() {
    let server = start(&[]);
    let port = server.metrics_port();
    let get = |host: &str, path: &str| {
        let mut stream = TcpStream::connect(("127.0.0.1", port)).unwrap();
        stream.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
        write!(stream, "GET {path} HTTP/1.1\r\nHost: {host}\r\nConnection: close\r\n\r\n").unwrap();
        let mut out = String::new();
        stream.read_to_string(&mut out).unwrap();
        out
    };
    let ok = get(&format!("127.0.0.1:{port}"), "/metrics");
    assert!(ok.starts_with("HTTP/1.1 200"), "{ok}");
    assert!(ok.contains("omega_rooms 1\n"), "the lobby: {ok}");
    assert!(ok.contains("process_uptime_seconds "), "{ok}");
    assert!(get("omega-share.duckdns.org", "/metrics").starts_with("HTTP/1.1 421"));
    assert!(get(&format!("127.0.0.1:{port}"), "/other").starts_with("HTTP/1.1 404"));
}

// apps/server/test/graceful-restart.test.ts:234
#[test]
fn sigterm_and_sigint_exit_zero_quietly_remove_the_socket_and_checkpoint_the_wal() {
    for signal in ["TERM", "INT"] {
        let mut server = start(&[]);
        assert!(server.socket().exists());
        let status = server.terminate(signal);
        assert_eq!(status.code(), Some(0), "SIG{signal}: {status:?}");
        assert_eq!(server.stderr(), "", "SIG{signal}");
        assert!(!server.socket().exists(), "the admin socket is removed");
        let wal = PathBuf::from(format!("{}-wal", server.db().display()));
        assert_eq!(std::fs::metadata(&wal).map_or(0, |m| m.len()), 0, "the WAL is checkpointed and truncated");
        // The database is whole: the lobby is in the file.
        let conn = rusqlite::Connection::open_with_flags(server.db(), rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
        let rooms: i64 = conn.query_row("SELECT count(*) FROM rooms WHERE id = 'lobby'", [], |r| r.get(0)).unwrap();
        assert_eq!(rooms, 1);
    }
}

// apps/server/src/index.ts:64: a second signal during the shutdown does not change the outcome
#[test]
fn a_second_signal_is_ignored_while_shutting_down() {
    let mut server = start(&[]);
    let line = server.lines.iter().find(|l| l.starts_with("omega-share server on ")).unwrap();
    let addr = line.split_whitespace().nth(3).unwrap().trim_start_matches("http://").trim_end_matches('/').to_owned();
    // A stalled request keeps the drain open for its grace period: the window for the second signal.
    let mut stalled = TcpStream::connect(&addr).unwrap();
    write!(stalled, "GET / HTTP/1.1\r\nHost: {addr}\r\nX-A: ").unwrap();
    std::thread::sleep(Duration::from_millis(100));
    let pid = server.child.id().to_string();
    assert!(Command::new("kill").args(["-TERM", &pid]).status().unwrap().success());
    std::thread::sleep(Duration::from_millis(300));
    assert!(server.child.try_wait().unwrap().is_none(), "still draining");
    assert!(Command::new("kill").args(["-TERM", &pid]).status().unwrap().success());
    assert!(Command::new("kill").args(["-INT", &pid]).status().unwrap().success());
    let deadline = Instant::now() + Duration::from_secs(10);
    let status = loop {
        if let Some(status) = server.child.try_wait().unwrap() {
            break status;
        }
        assert!(Instant::now() < deadline);
        std::thread::sleep(Duration::from_millis(20));
    };
    assert_eq!(status.code(), Some(0), "{status:?}");
    assert_eq!(server.stderr(), "");
    drop(stalled);
}

// apps/server/test/backup.test.ts:311, :317
#[test]
fn backup_runs_as_a_subcommand_with_the_ts_lines_and_exit_codes() {
    let dir = tempfile::tempdir().unwrap();
    let db = dir.path().join("omega.db");
    // A database the server made.
    let mut server = start(&[("DB_PATH", db.to_str().unwrap()), ("ADMIN_SOCKET", "off"), ("METRICS_PORT", "off")]);
    assert_eq!(server.terminate("TERM").code(), Some(0));
    let backups = dir.path().join("backups");
    let run = |args: &[&str]| Command::new(BIN).arg("backup").args(args).env("DB_PATH", &db).env("BACKUP_DIR", &backups).output().unwrap();
    let out = run(&["snapshot"]);
    assert_eq!(out.status.code(), Some(0), "{}", text(&out.stderr));
    let line = text(&out.stdout);
    assert!(line.starts_with(&format!("snapshot {}/omega-", backups.display())) && line.trim_end().ends_with(".db"), "{line}");
    let snap = line.trim_end().trim_start_matches("snapshot ").to_owned();
    assert_eq!(std::fs::metadata(&snap).unwrap().permissions().mode() & 0o777, 0o600);
    let out = run(&["verify", &snap]);
    assert_eq!(text(&out.stdout), format!("ok {snap}: 1 rooms\n"));
    let out = run(&["bogus"]);
    assert_eq!(out.status.code(), Some(2));
    assert_eq!(text(&out.stderr), "usage: omega-server backup snapshot | verify <file> | restore <file> | prune   (env: DB_PATH, BACKUP_DIR)\n");
    let bad = dir.path().join("omega-2026-10-08.db");
    std::fs::write(&bad, "garbage").unwrap();
    let out = run(&["restore", bad.to_str().unwrap()]);
    assert_eq!(out.status.code(), Some(1));
    assert!(text(&out.stderr).contains("refus"), "{}", text(&out.stderr));
}
