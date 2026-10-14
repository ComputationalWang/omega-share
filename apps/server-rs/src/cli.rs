//! `omega-server admin <verb> …`: the operator CLI (port of `apps/server/src/cli.ts`, docs/ops/rooms.md). It talks
//! only to the server's admin socket (`admin.rs`), so a delete or takedown ends the live room the way an owner
//! delete or GC does. The formatters are pure and corpus-tested against the TS ones.
//!
//! Exit codes: 0 done, 1 failed (no such room or report, no server, server error), 2 usage.

use crate::config::{Env, admin_socket_for};
use crate::contract::Obj;
use crate::contract::ids::RoomId;
use crate::contract::room::RoomVisibility;
use crate::store::ReportId;
use icu_properties::CodePointMapData;
use icu_properties::props::GeneralCategory;
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;
use std::fmt::Write as _;
use std::io::{ErrorKind, Read, Write as _};
use std::os::unix::net::UnixStream;
use std::path::Path;
use std::time::{Duration, Instant};
use validator::{Validate, ValidationError};

const MAX_SAFE: i64 = 9_007_199_254_740_991;
const USAGE: &str = "usage: omega-server admin rooms list | rooms delete <id> | rooms pin <id> | rooms unpin <id> | rooms takedown <id> | reports list | reports dismiss <reportId> | reports dismiss --room <id>";

/// The usage line; the binary name replaces `cli.ts` (the one deliberate difference in the text).
pub fn usage() -> &'static str {
    USAGE
}

/// What one invocation asks the server for (`Command` in cli.ts).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "verb", rename_all = "kebab-case")]
pub enum Command {
    List,
    Delete {
        id: RoomId,
    },
    Pin {
        id: RoomId,
    },
    Unpin {
        id: RoomId,
    },
    Takedown {
        id: RoomId,
    },
    Reports,
    Dismiss {
        #[serde(rename = "reportId")]
        report_id: ReportId,
    },
    DismissRoom {
        id: RoomId,
    },
}

fn parse_reports(verb: Option<&str>, args: &[String]) -> Option<Command> {
    match verb? {
        "list" => args.is_empty().then_some(Command::Reports),
        "dismiss" => {
            if args.first().map(String::as_str) == Some("--room") {
                let id = RoomId::parse(args.get(1)?)?;
                return (args.len() == 2).then_some(Command::DismissRoom { id });
            }
            let report_id = ReportId::parse(args.first()?)?;
            (args.len() == 1).then_some(Command::Dismiss { report_id })
        }
        _ => None,
    }
}

/// `parseArgs`: the arguments after `admin`; `None` is a usage error.
pub fn parse_args(argv: &[String]) -> Option<Command> {
    let noun = argv.first().map(String::as_str);
    let verb = argv.get(1).map(String::as_str);
    let args = argv.get(2..).unwrap_or_default();
    if noun == Some("reports") {
        return parse_reports(verb, args);
    }
    if noun != Some("rooms") || args.len() > 1 {
        return None;
    }
    let id = args.first();
    if verb == Some("list") {
        return id.is_none().then_some(Command::List);
    }
    let id = RoomId::parse(id?)?;
    match verb? {
        "delete" => Some(Command::Delete { id }),
        "pin" => Some(Command::Pin { id }),
        "unpin" => Some(Command::Unpin { id }),
        "takedown" => Some(Command::Takedown { id }),
        _ => None,
    }
}

/// `printable`: titles are user text, so control and format characters (Cc, Cf, Zl, Zp) are escaped, and a
/// title can neither drive the operator's terminal nor break the table.
pub fn printable(text: &str) -> String {
    let categories = CodePointMapData::<GeneralCategory>::new();
    let mut out = String::with_capacity(text.len());
    for ch in text.chars() {
        let escaped = matches!(
            categories.get(ch),
            GeneralCategory::Control | GeneralCategory::Format | GeneralCategory::LineSeparator | GeneralCategory::ParagraphSeparator
        );
        if !escaped {
            out.push(ch);
        } else if u32::from(ch) > 0xffff {
            let _ = write!(out, "\\u{{{:x}}}", u32::from(ch));
        } else {
            let _ = write!(out, "\\u{:04x}", u32::from(ch));
        }
    }
    out
}

/// The `Date` range: ±8.64e15 ms.
const DATE_RANGE_MS: i64 = 8_640_000_000_000_000;

/// `time`: `new Date(ms).toISOString()`, `never` for none. `None` outside the `Date` range, where JS throws.
pub fn time(ms: Option<i64>) -> Option<String> {
    let Some(ms) = ms else { return Some("never".to_owned()) };
    if !(-DATE_RANGE_MS..=DATE_RANGE_MS).contains(&ms) {
        return None;
    }
    let days = ms.div_euclid(86_400_000);
    let in_day = ms.rem_euclid(86_400_000);
    // Hinnant's civil-from-days.
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    let year = if (0..=9999).contains(&year) {
        format!("{year:04}")
    } else {
        format!("{}{:06}", if year < 0 { '-' } else { '+' }, year.abs())
    };
    Some(format!(
        "{year}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{:03}Z",
        in_day / 3_600_000,
        in_day / 60_000 % 60,
        in_day / 1000 % 60,
        in_day % 1000
    ))
}

/// A key that must be present, even as `null` (`v.nullable`, unlike `v.optional`).
fn required<'de, D: Deserializer<'de>, T: Deserialize<'de>>(d: D) -> Result<Option<T>, D::Error> {
    Option::<T>::deserialize(d)
}

fn known_reason(reason: &str) -> Result<(), ValidationError> {
    if ["sexual", "violence", "hate", "spam", "danger", "other"].contains(&reason) {
        Ok(())
    } else {
        Err(ValidationError::new("reason"))
    }
}

/// One `GET /rooms` entry (`AdminRoomSchema`, strict: a stray field is refused).
#[derive(Deserialize, Validate)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct RoomRow {
    id: RoomId,
    title: String,
    visibility: RoomVisibility,
    #[validate(range(min = -MAX_SAFE, max = MAX_SAFE))]
    created_at: i64,
    #[serde(deserialize_with = "required")]
    #[validate(range(min = -MAX_SAFE, max = MAX_SAFE))]
    last_active_at: Option<i64>,
    pinned: bool,
    #[validate(range(min = 0, max = MAX_SAFE))]
    members: i64,
}

#[derive(Deserialize, Validate)]
#[serde(deny_unknown_fields)]
struct RoomList {
    #[validate(nested)]
    rooms: Vec<Obj<RoomRow>>,
}

#[derive(Deserialize, Validate)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct ReportRow {
    id: ReportId,
    #[validate(range(min = -MAX_SAFE, max = MAX_SAFE))]
    created_at: i64,
    #[validate(custom(function = "known_reason"))]
    reason: String,
    #[serde(deserialize_with = "required")]
    note: Option<String>,
    #[serde(deserialize_with = "required")]
    title: Option<String>,
    #[serde(deserialize_with = "required")]
    embed_url: Option<String>,
}

#[derive(Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum ReportedState {
    Live,
    TakenDown,
    Gone,
}

#[derive(Deserialize, Validate)]
#[serde(deny_unknown_fields)]
struct ReportRoom {
    id: RoomId,
    state: ReportedState,
    #[serde(deserialize_with = "required")]
    title: Option<String>,
    #[serde(deserialize_with = "required")]
    visibility: Option<RoomVisibility>,
    #[serde(deserialize_with = "required")]
    #[validate(range(min = 0, max = MAX_SAFE))]
    members: Option<i64>,
    #[validate(nested)]
    reports: Vec<Obj<ReportRow>>,
}

#[derive(Deserialize, Validate)]
#[serde(deny_unknown_fields)]
struct ReportList {
    #[validate(nested)]
    rooms: Vec<Obj<ReportRoom>>,
}

/// `v.object`: unknown keys are dropped, not refused.
#[derive(Deserialize, Validate)]
struct Dismissed {
    #[validate(range(min = 0, max = MAX_SAFE))]
    dismissed: i64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TakenDown {
    taken_down: RoomId,
    live: bool,
}

/// The body as `T` (a JSON object only, every rule checked), or `None`.
fn read<T: serde::de::DeserializeOwned + Validate>(body: &Value) -> Option<T> {
    let Obj(wire) = Obj::<T>::deserialize(body).ok()?;
    wire.validate().ok()?;
    Some(wire)
}

fn visibility_text(v: RoomVisibility) -> &'static str {
    match v {
        RoomVisibility::Public => "public",
        RoomVisibility::Private => "private",
    }
}

fn table(rooms: &[Obj<RoomRow>]) -> Option<Vec<String>> {
    let mut lines = vec!["id\ttitle\tvisibility\tcreated\tlast active\tpinned\tmembers".to_owned()];
    for Obj(r) in rooms {
        lines.push(format!(
            "{}\t{}\t{}\t{}\t{}\t{}\t{}",
            r.id.as_str(),
            if r.title.is_empty() { "-".to_owned() } else { printable(&r.title) },
            visibility_text(r.visibility),
            time(Some(r.created_at))?,
            time(r.last_active_at)?,
            if r.pinned { "yes" } else { "no" },
            r.members
        ));
    }
    Some(lines)
}

/// Open reports, one header line per room (most reported first), then its reports, newest first. All user text escaped.
fn report_lines(rooms: &[Obj<ReportRoom>]) -> Option<Vec<String>> {
    if rooms.is_empty() {
        return Some(vec!["no open reports".to_owned()]);
    }
    let text = |t: &Option<String>| match t.as_deref() {
        None | Some("") => "-".to_owned(),
        Some(t) => printable(t),
    };
    let mut lines = Vec::new();
    for Obj(room) in rooms {
        // Reason names are ASCII, so the byte order is JS's string order.
        let mut reasons: BTreeMap<&str, usize> = BTreeMap::new();
        for Obj(r) in &room.reports {
            *reasons.entry(r.reason.as_str()).or_insert(0) += 1;
        }
        let counts: Vec<String> = reasons.iter().map(|(reason, n)| format!("{reason} {n}")).collect();
        let title = match room.state {
            ReportedState::Live => text(&room.title),
            ReportedState::TakenDown => "(taken down)".to_owned(),
            ReportedState::Gone => "(gone)".to_owned(),
        };
        lines.push(format!(
            "{}\t{title}\t{}\tmembers {}\t{} open\t{}",
            room.id.as_str(),
            room.visibility.map_or("-", visibility_text),
            room.members.map_or_else(|| "-".to_owned(), |m| m.to_string()),
            room.reports.len(),
            counts.join(", ")
        ));
        for Obj(r) in &room.reports {
            lines.push(format!(
                "  {}\t{}\t{}\tnote: {}\ttitle then: {}\tplaying: {}",
                time(Some(r.created_at))?,
                r.reason,
                r.id.as_str(),
                text(&r.note),
                text(&r.title),
                text(&r.embed_url)
            ));
        }
    }
    Some(lines)
}

/// What a successful answer prints, or `None` if the answer does not parse. One difference from TS: a date outside the
/// `Date` range makes `toISOString` throw there and the CLI dies; here it is an unparseable answer.
pub fn success(cmd: &Command, body: &Value) -> Option<Vec<String>> {
    match cmd {
        Command::List => table(&read::<RoomList>(body)?.rooms),
        Command::Reports => report_lines(&read::<ReportList>(body)?.rooms),
        Command::Dismiss { .. } | Command::DismissRoom { .. } => Some(vec![format!("dismissed {}", read::<Dismissed>(body)?.dismissed)]),
        Command::Takedown { .. } => {
            let Obj(done) = Obj::<TakenDown>::deserialize(body).ok()?;
            Some(vec![format!(
                "taken down {}{}",
                done.taken_down.as_str(),
                if done.live { "" } else { " (it was not live)" }
            )])
        }
        Command::Delete { id } => Some(vec![format!("deleted {}", id.as_str())]),
        Command::Pin { id } => Some(vec![format!("pinned {}", id.as_str())]),
        Command::Unpin { id } => Some(vec![format!("unpinned {}", id.as_str())]),
    }
}

/// `FETCH_TIMEOUT_MS`: the server answers from memory at once; a hung one shouldn't hang the operator's ssh session.
pub const REQUEST_TIMEOUT: Duration = Duration::from_millis(10_000);

/// More than any real answer (a room list is a few hundred bytes per room): a runaway reply is cut off.
const MAX_RESPONSE_BYTES: u64 = 16 * 1024 * 1024;

/// Runs `connect` and waits at most `timeout` for it: a full accept queue blocks a Unix `connect`.
fn connect_bounded(connect: impl FnOnce() -> std::io::Result<UnixStream> + Send + 'static, timeout: Duration) -> Result<UnixStream, String> {
    let (tx, rx) = std::sync::mpsc::channel();
    // A connect that never returns leaves this helper thread behind; the process exits right after the failure.
    std::thread::spawn(move || {
        let _ = tx.send(connect());
    });
    match rx.recv_timeout(timeout) {
        Ok(connected) => connected.map_err(|e| e.to_string()),
        Err(_) => Err(format!("timed out after {} ms", timeout.as_millis())),
    }
}

/// One request on the admin socket (HTTP/1.1, `Connection: close`): the status and the body. Only the Unix socket,
/// never TCP; `timeout` bounds the whole exchange.
pub fn request(socket: &Path, method: &str, path: &str, timeout: Duration) -> Result<(u16, Vec<u8>), String> {
    let deadline = Instant::now() + timeout;
    let timed_out = || format!("timed out after {} ms", timeout.as_millis());
    let target = socket.to_path_buf();
    let mut stream = connect_bounded(move || UnixStream::connect(target), timeout)?;
    let left = || deadline.checked_duration_since(Instant::now()).filter(|d| !d.is_zero());
    stream.set_write_timeout(left()).map_err(|e| e.to_string())?;
    // The host is ignored on a Unix socket; the server listens nowhere else.
    let head = format!("{method} {path} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n");
    stream.write_all(head.as_bytes()).map_err(|e| e.to_string())?;
    let mut raw = Vec::new();
    let mut chunk = [0u8; 8192];
    loop {
        let Some(remaining) = left() else { return Err(timed_out()) };
        stream.set_read_timeout(Some(remaining)).map_err(|e| e.to_string())?;
        match stream.read(&mut chunk) {
            Ok(0) => break,
            Ok(n) => raw.extend_from_slice(chunk.get(..n).unwrap_or_default()),
            Err(e) if matches!(e.kind(), ErrorKind::WouldBlock | ErrorKind::TimedOut) => return Err(timed_out()),
            Err(e) if e.kind() == ErrorKind::Interrupted => {}
            Err(e) => return Err(e.to_string()),
        }
        if raw.len() as u64 > MAX_RESPONSE_BYTES {
            return Err("answer too large".to_owned());
        }
    }
    parse_response(&raw).ok_or_else(|| "malformed answer".to_owned())
}

fn find(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack.windows(needle.len()).position(|w| w == needle)
}

/// A `Transfer-Encoding: chunked` body (extensions ignored, trailers not read).
fn dechunk(mut rest: &[u8]) -> Option<Vec<u8>> {
    let mut body = Vec::new();
    loop {
        let line_end = find(rest, b"\r\n")?;
        let line = std::str::from_utf8(rest.get(..line_end)?).ok()?;
        let size = usize::from_str_radix(line.split(';').next()?.trim(), 16).ok()?;
        rest = rest.get(line_end + 2..)?;
        if size == 0 {
            return Some(body);
        }
        body.extend_from_slice(rest.get(..size)?);
        rest = rest.get(size..)?.strip_prefix(b"\r\n")?;
    }
}

/// Splits a raw HTTP/1.1 answer into its status and body (content-length, chunked, or whatever the close delivered).
pub fn parse_response(raw: &[u8]) -> Option<(u16, Vec<u8>)> {
    let split = find(raw, b"\r\n\r\n")?;
    let head = std::str::from_utf8(raw.get(..split)?).ok()?;
    let body = raw.get(split + 4..)?;
    let mut lines = head.split("\r\n");
    let mut status_line = lines.next()?.split(' ');
    if !status_line.next()?.starts_with("HTTP/1.") {
        return None;
    }
    let status: u16 = status_line.next()?.parse().ok()?;
    let mut length = None;
    let mut chunked = false;
    for line in lines {
        let (name, value) = line.split_once(':')?;
        match name.trim().to_ascii_lowercase().as_str() {
            "content-length" => length = Some(value.trim().parse::<usize>().ok()?),
            "transfer-encoding" => chunked = value.to_ascii_lowercase().contains("chunked"),
            _ => {}
        }
    }
    let body = if chunked {
        dechunk(body)?
    } else if let Some(n) = length {
        body.get(..n)?.to_vec()
    } else {
        body.to_vec()
    };
    Some((status, body))
}

/// Where a run reads its environment and writes its lines.
pub struct Io<'a> {
    /// `ADMIN_SOCKET` or `DB_PATH` locate the socket.
    pub env: &'a Env,
    pub cwd: &'a Path,
    pub out: &'a mut dyn FnMut(&str),
    pub err: &'a mut dyn FnMut(&str),
}

fn call(cmd: &Command) -> (&'static str, String) {
    match cmd {
        Command::List => ("GET", "/rooms".to_owned()),
        Command::Delete { id } => ("DELETE", format!("/rooms/{}", id.as_str())),
        Command::Pin { id } => ("POST", format!("/rooms/{}/pin", id.as_str())),
        Command::Unpin { id } => ("POST", format!("/rooms/{}/unpin", id.as_str())),
        Command::Takedown { id } => ("POST", format!("/rooms/{}/takedown", id.as_str())),
        Command::Reports => ("GET", "/reports".to_owned()),
        Command::Dismiss { report_id } => ("POST", format!("/reports/{}/dismiss", report_id.as_str())),
        Command::DismissRoom { id } => ("POST", format!("/rooms/{}/reports/dismiss", id.as_str())),
    }
}

/// `runCli`: the arguments after `admin`; returns the exit code (0 done, 1 failed, 2 usage). It prints only what the
/// server's answer parses to, and the server's error text escaped like a title.
pub fn run_cli(argv: &[String], io: &mut Io<'_>) -> i32 {
    let Some(cmd) = parse_args(argv) else {
        (io.err)(usage());
        return 2;
    };
    let socket = match admin_socket_for(io.env, io.cwd) {
        Ok(socket) => socket,
        Err(err) => {
            (io.err)(&err.to_string());
            return 2;
        }
    };
    let Some(socket) = socket else {
        (io.err)("the admin socket is off (ADMIN_SOCKET=off or DB_PATH=:memory:)");
        return 1;
    };
    let (method, path) = call(&cmd);
    let (status, body) = match request(&socket, method, &path, REQUEST_TIMEOUT) {
        Ok(answer) => answer,
        Err(err) => {
            (io.err)(&format!("no server on {}: {err}", socket.display()));
            return 1;
        }
    };
    let body: Value = serde_json::from_slice(&body).unwrap_or(Value::Null);
    if !(200..300).contains(&status) {
        match body.get("error").and_then(Value::as_str) {
            Some(text) => (io.err)(&printable(text)),
            None => (io.err)(&format!("server answered {status}")),
        }
        return 1;
    }
    let Some(lines) = success(&cmd, &body) else {
        (io.err)("unexpected answer from the server");
        return 1;
    };
    for line in &lines {
        (io.out)(line);
    }
    0
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::indexing_slicing, reason = "tests")]
mod tests {
    use super::*;

    fn argv(parts: &[&str]) -> Vec<String> {
        parts.iter().map(|p| (*p).to_owned()).collect()
    }

    fn rid(id: &str) -> RoomId {
        RoomId::parse(id).unwrap()
    }

    // apps/server/test/cli.test.ts:224
    #[test]
    fn a_bad_command_or_room_id_is_a_usage_error() {
        for parts in [
            vec![],
            vec!["rooms"],
            vec!["rooms", "nuke"],
            vec!["rooms", "delete"],
            vec!["rooms", "delete", "../lobby"],
            vec!["rooms", "pin", "LOBBY"],
            vec!["rooms", "list", "extra"],
        ] {
            assert_eq!(parse_args(&argv(&parts)), None, "{parts:?}");
        }
    }

    // apps/server/src/cli.ts:54
    #[test]
    fn every_verb_parses() {
        let id = "aaaaaaaaaaaaaaaaaaaaaaaaaa";
        assert_eq!(parse_args(&argv(&["rooms", "list"])), Some(Command::List));
        assert_eq!(parse_args(&argv(&["rooms", "delete", id])), Some(Command::Delete { id: rid(id) }));
        assert_eq!(parse_args(&argv(&["rooms", "pin", id])), Some(Command::Pin { id: rid(id) }));
        assert_eq!(parse_args(&argv(&["rooms", "unpin", id])), Some(Command::Unpin { id: rid(id) }));
        assert_eq!(
            parse_args(&argv(&["rooms", "takedown", id])),
            Some(Command::Takedown { id: rid(id) })
        );
        assert_eq!(parse_args(&argv(&["reports", "list"])), Some(Command::Reports));
        assert_eq!(
            parse_args(&argv(&["reports", "dismiss", "--room", id])),
            Some(Command::DismissRoom { id: rid(id) })
        );
        let report = "AAAAAAAAAAAAAAAAAAAAAA";
        assert_eq!(
            parse_args(&argv(&["reports", "dismiss", report])),
            Some(Command::Dismiss {
                report_id: ReportId::parse(report).unwrap()
            })
        );
    }

    // apps/server/test/cli.test.ts:94
    #[test]
    fn a_titles_control_and_format_characters_are_escaped() {
        let title = "a\u{1b}[2Jb\tc\u{202e}d\ne\u{85}f\u{2028}g\u{e0041}h\u{200b}i";
        assert_eq!(
            printable(title),
            "a\\u001b[2Jb\\u0009c\\u202ed\\u000ae\\u0085f\\u2028g\\u{e0041}h\\u200bi"
        );
    }

    // apps/server/test/cli.test.ts:60
    #[test]
    fn the_list_table_has_a_header_and_one_row_per_room() {
        let body = serde_json::json!({"rooms": [
            {"id": "lobby", "title": "", "visibility": "public", "createdAt": 1_790_000_000_000_i64,
             "lastActiveAt": null, "pinned": true, "members": 0},
            {"id": "aaaaaaaaaaaaaaaaaaaaaaaaaa", "title": "Film club", "visibility": "private", "createdAt": 1_790_000_000_000_i64,
             "lastActiveAt": 1_790_000_003_000_i64, "pinned": false, "members": 1},
        ]});
        let lines = success(&Command::List, &body).unwrap();
        assert_eq!(lines[0], "id\ttitle\tvisibility\tcreated\tlast active\tpinned\tmembers");
        assert_eq!(lines[1], "lobby\t-\tpublic\t2026-09-21T14:13:20.000Z\tnever\tyes\t0");
        assert_eq!(
            lines[2],
            "aaaaaaaaaaaaaaaaaaaaaaaaaa\tFilm club\tprivate\t2026-09-21T14:13:20.000Z\t2026-09-21T14:13:23.000Z\tno\t1"
        );
        assert_eq!(lines.len(), 3);
    }

    // apps/server/test/cli.test.ts:105, apps/server/src/cli.ts:136
    #[test]
    fn the_other_answers_print_one_line() {
        let id = "aaaaaaaaaaaaaaaaaaaaaaaaaa";
        let say = |cmd: Command, body: Value| success(&cmd, &body).unwrap();
        assert_eq!(
            say(Command::Delete { id: rid(id) }, serde_json::json!({"deleted": id})),
            [format!("deleted {id}")]
        );
        assert_eq!(say(Command::Pin { id: rid(id) }, serde_json::json!({})), [format!("pinned {id}")]);
        assert_eq!(
            say(Command::Unpin { id: rid(id) }, serde_json::json!({})),
            [format!("unpinned {id}")]
        );
        assert_eq!(
            say(
                Command::Takedown { id: rid(id) },
                serde_json::json!({"takenDown": id, "live": false})
            ),
            [format!("taken down {id} (it was not live)")]
        );
        assert_eq!(
            say(Command::DismissRoom { id: rid(id) }, serde_json::json!({"dismissed": 3})),
            ["dismissed 3"]
        );
        assert_eq!(
            success(&Command::Reports, &serde_json::json!({"rooms": []})).unwrap(),
            ["no open reports"]
        );
    }

    use crate::admin::start_admin;
    use crate::app::testing::{T0, add_room, app};
    use crate::room::RoomInit;
    use std::io::{Read, Write};
    use std::os::unix::net::{UnixListener, UnixStream};
    use std::path::PathBuf;

    const A: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaa";

    /// Runs the CLI on a blocking thread (it is synchronous, the server is on the runtime), collecting its lines.
    async fn cli(socket: &Path, parts: &[&str]) -> (i32, Vec<String>, Vec<String>) {
        let argv = argv(parts);
        let mut env = Env::new();
        env.insert("ADMIN_SOCKET".to_owned(), socket.display().to_string());
        tokio::task::spawn_blocking(move || {
            let (mut out, mut err) = (Vec::new(), Vec::new());
            let code = run_cli(
                &argv,
                &mut Io {
                    env: &env,
                    cwd: Path::new("/"),
                    out: &mut |l| out.push(l.to_owned()),
                    err: &mut |l| err.push(l.to_owned()),
                },
            );
            (code, out, err)
        })
        .await
        .unwrap()
    }

    fn sock() -> (tempfile::TempDir, PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("admin.sock");
        (dir, path)
    }

    /// A one-shot fake server answering whatever it is asked with `reply` (raw bytes).
    fn fake_server(path: &Path, reply: &'static [u8]) {
        let listener = UnixListener::bind(path).unwrap();
        std::thread::spawn(move || {
            if let Ok((mut stream, _)) = listener.accept() {
                let mut buf = [0u8; 1024];
                let _ = stream.read(&mut buf);
                let _ = stream.write_all(reply);
            }
        });
    }

    // apps/server/test/cli.test.ts:60
    #[tokio::test(flavor = "multi_thread")]
    async fn rooms_list_prints_the_table_over_the_socket() {
        let (app, _) = app();
        add_room(&app, "lobby", RoomInit::default());
        let (_dir, path) = sock();
        let server = start_admin(app, &path).unwrap();
        let (code, out, err) = cli(&path, &["rooms", "list"]).await;
        assert_eq!((code, err), (0, Vec::<String>::new()));
        assert_eq!(out[0], "id\ttitle\tvisibility\tcreated\tlast active\tpinned\tmembers");
        assert_eq!(out[1], format!("lobby\t-\tpublic\t{}\tnever\tyes\t0", time(Some(T0)).unwrap()));
        server.stop().await;
    }

    // apps/server/test/cli.test.ts:116, :140
    #[tokio::test(flavor = "multi_thread")]
    async fn delete_prints_what_it_did_and_an_unknown_room_exits_1() {
        let (app, _) = app();
        add_room(&app, A, RoomInit::default());
        let (_dir, path) = sock();
        let server = start_admin(app.clone(), &path).unwrap();
        let (code, out, _) = cli(&path, &["rooms", "delete", A]).await;
        assert_eq!((code, out), (0, vec![format!("deleted {A}")]));
        assert!(app.registry.get(&crate::app::testing::rid(A)).is_none());
        let (code, out, err) = cli(&path, &["rooms", "delete", A]).await;
        assert_eq!((code, out, err), (1, vec![], vec![format!("no room {A}")]));
        server.stop().await;
    }

    // apps/server/test/cli.test.ts:200, apps/server/test/takedown.test.ts:106
    #[tokio::test(flavor = "multi_thread")]
    async fn pin_takedown_and_report_commands_print_one_line() {
        let (app, _) = app();
        add_room(&app, "lobby", RoomInit::default());
        let (_dir, path) = sock();
        let server = start_admin(app, &path).unwrap();
        let (code, _, err) = cli(&path, &["rooms", "unpin", "lobby"]).await;
        assert_eq!(
            (code, err),
            (
                1,
                vec!["lobby is a seeded room with no owner: it stays pinned (delete it instead)".to_owned()]
            )
        );
        let (code, out, _) = cli(&path, &["rooms", "pin", "lobby"]).await;
        assert_eq!((code, out), (0, vec!["pinned lobby".to_owned()]));
        let (code, out, _) = cli(&path, &["rooms", "takedown", A]).await;
        assert_eq!((code, out), (0, vec![format!("taken down {A} (it was not live)")]));
        let (code, out, _) = cli(&path, &["reports", "list"]).await;
        assert_eq!((code, out), (0, vec!["no open reports".to_owned()]));
        let (code, out, _) = cli(&path, &["reports", "dismiss", "--room", A]).await;
        assert_eq!((code, out), (0, vec!["dismissed 0".to_owned()]));
        let (code, _, err) = cli(&path, &["reports", "dismiss", "AAAAAAAAAAAAAAAAAAAAAA"]).await;
        assert_eq!((code, err), (1, vec!["no open report AAAAAAAAAAAAAAAAAAAAAA".to_owned()]));
        server.stop().await;
    }

    // apps/server/test/cli.test.ts:224, :337
    #[tokio::test(flavor = "multi_thread")]
    async fn a_bad_command_exits_2_with_usage_without_calling_the_server() {
        let (_dir, path) = sock();
        // No server: reaching it would be exit 1.
        for parts in [
            vec![],
            vec!["rooms", "delete", "../lobby"],
            vec!["reports", "dismiss", "x"],
            vec!["rooms", "list", "extra"],
        ] {
            let (code, out, err) = cli(&path, &parts).await;
            assert_eq!((code, out, err), (2, vec![], vec![usage().to_owned()]), "{parts:?}");
        }
        assert!(usage().starts_with("usage: omega-server admin rooms list | rooms delete <id>"));
    }

    // apps/server/test/cli.test.ts:233
    #[tokio::test(flavor = "multi_thread")]
    async fn no_server_on_the_socket_exits_1_and_names_it() {
        let (_dir, path) = sock();
        let (code, out, err) = cli(&path, &["rooms", "list"]).await;
        assert_eq!((code, out), (1, vec![]));
        assert!(err[0].starts_with(&format!("no server on {}: ", path.display())), "{err:?}");
    }

    // apps/server/src/cli.ts:168
    #[test]
    fn the_socket_setting_decides_where_to_go_or_that_there_is_none() {
        let run = |pairs: &[(&str, &str)]| {
            let env: Env = pairs.iter().map(|(k, v)| ((*k).to_owned(), (*v).to_owned())).collect();
            let (mut out, mut err) = (Vec::new(), Vec::new());
            let code = run_cli(
                &argv(&["rooms", "list"]),
                &mut Io {
                    env: &env,
                    cwd: Path::new("/"),
                    out: &mut |l| out.push(l.to_owned()),
                    err: &mut |l| err.push(l.to_owned()),
                },
            );
            (code, out, err)
        };
        assert_eq!(
            run(&[("ADMIN_SOCKET", "off")]),
            (
                1,
                vec![],
                vec!["the admin socket is off (ADMIN_SOCKET=off or DB_PATH=:memory:)".to_owned()]
            )
        );
        assert_eq!(run(&[("DB_PATH", ":memory:")]).0, 1);
        assert_eq!(
            run(&[("ADMIN_SOCKET", "")]),
            (2, vec![], vec!["invalid ADMIN_SOCKET: must not be empty".to_owned()])
        );
    }

    // apps/server/src/cli.ts:185
    #[test]
    fn a_failing_or_odd_answer_is_reported_without_trusting_it() {
        let (_dir, path) = sock();
        let run = |reply: &'static [u8]| {
            let path = path.with_file_name(format!("{}.sock", reply.len()));
            fake_server(&path, reply);
            let env: Env = [("ADMIN_SOCKET".to_owned(), path.display().to_string())].into();
            let (mut out, mut err) = (Vec::new(), Vec::new());
            let code = run_cli(
                &argv(&["rooms", "list"]),
                &mut Io {
                    env: &env,
                    cwd: Path::new("/"),
                    out: &mut |l| out.push(l.to_owned()),
                    err: &mut |l| err.push(l.to_owned()),
                },
            );
            (code, out, err)
        };
        // An error text is user-influenced: escaped like a title.
        let hostile = b"HTTP/1.1 500 x\r\ncontent-length: 23\r\n\r\n{\"error\":\"a\\u001b[2Jb\"}";
        assert_eq!(run(hostile), (1, vec![], vec!["a\\u001b[2Jb".to_owned()]));
        assert_eq!(
            run(b"HTTP/1.1 502 x\r\ncontent-length: 4\r\n\r\nnope"),
            (1, vec![], vec!["server answered 502".to_owned()])
        );
        assert_eq!(
            run(b"HTTP/1.1 200 x\r\ncontent-length: 2\r\n\r\n{}"),
            (1, vec![], vec!["unexpected answer from the server".to_owned()])
        );
    }

    #[test]
    fn parse_response_reads_content_length_and_chunked_bodies() {
        assert_eq!(
            parse_response(b"HTTP/1.1 200 OK\r\ncontent-length: 5\r\n\r\nhello"),
            Some((200, b"hello".to_vec()))
        );
        assert_eq!(
            parse_response(b"HTTP/1.1 404 Not Found\r\nTransfer-Encoding: chunked\r\n\r\n3\r\nabc\r\n2\r\nde\r\n0\r\n\r\n"),
            Some((404, b"abcde".to_vec()))
        );
        // No framing at all: the body is what the close delivered.
        assert_eq!(parse_response(b"HTTP/1.1 200 OK\r\n\r\nxyz"), Some((200, b"xyz".to_vec())));
        for bad in [
            &b""[..],
            b"HTTP/1.1",
            b"garbage\r\n\r\n",
            b"HTTP/1.1 abc x\r\n\r\n",
            b"HTTP/1.1 200 OK\r\ncontent-length: 9\r\n\r\nshort",
            b"HTTP/1.1 200 OK\r\ntransfer-encoding: chunked\r\n\r\nzz\r\n",
        ] {
            assert_eq!(parse_response(bad), None, "{bad:?}");
        }
    }

    // apps/server/src/cli.ts: FETCH_TIMEOUT_MS
    #[test]
    fn a_silent_server_times_out() {
        let (_dir, path) = sock();
        let listener = UnixListener::bind(&path).unwrap();
        let held = std::thread::spawn(move || listener.accept().map(|(s, _)| s));
        let err = request(&path, "GET", "/rooms", Duration::from_millis(150)).unwrap_err();
        assert!(err.contains("timed out"), "{err}");
        drop(held.join().unwrap().map(drop::<UnixStream>));
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, reason = "tests")]
mod connect_tests {
    use super::*;

    // apps/server/src/cli.ts FETCH_TIMEOUT_MS covers the whole fetch: a connect that blocks (a full accept queue) is bounded too.
    #[test]
    fn a_connect_that_blocks_is_cut_off_at_the_deadline() {
        let started = Instant::now();
        let slow = || {
            std::thread::sleep(Duration::from_secs(3));
            Err(std::io::Error::other("late"))
        };
        let err = connect_bounded(slow, Duration::from_millis(200)).unwrap_err();
        assert!(err.contains("timed out"), "{err}");
        assert!(started.elapsed() < Duration::from_secs(2));
    }

    #[test]
    fn a_connect_that_fails_fast_says_why() {
        let err = connect_bounded(|| Err(std::io::Error::from(ErrorKind::ConnectionRefused)), Duration::from_secs(1)).unwrap_err();
        assert!(err.to_lowercase().contains("refused"), "{err}");
    }
}
