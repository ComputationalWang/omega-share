//! Port of `apps/server/src/log.ts` (OME-504): error lines. One JSON object per line on stderr, a fixed
//! event name and the error's class and message, never a room id, title, nickname or address: callers
//! have no free-form field, and the message is cut at its first quote (store and Valibot errors quote ids
//! and input) and scrubbed of IPs and emails.
//!
//! Also the plain stdout/stderr helpers: a closed pipe must never panic the server, so nothing in the
//! crate uses the `print!` family (clippy denies it).

use crate::contract::js_compat::{is_js_whitespace, utf16_len};
use serde::Serialize;
use std::error::Error;
use std::io::Write;

/// The fixed event names; each serializes to the exact string `log.ts` writes.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub enum LogEvent {
    #[serde(rename = "store.new_room")]
    StoreNewRoom,
    #[serde(rename = "store.delete_room")]
    StoreDeleteRoom,
    #[serde(rename = "store.last_active")]
    StoreLastActive,
    #[serde(rename = "store.layout")]
    StoreLayout,
    #[serde(rename = "store.title")]
    StoreTitle,
    #[serde(rename = "store.control_policy")]
    StoreControlPolicy,
    #[serde(rename = "store.seat_holds")]
    StoreSeatHolds,
    #[serde(rename = "store.queue_item")]
    StoreQueueItem,
    #[serde(rename = "store.queue")]
    StoreQueue,
    #[serde(rename = "store.report")]
    StoreReport,
    #[serde(rename = "store.health")]
    StoreHealth,
    #[serde(rename = "gc.remove")]
    GcRemove,
    #[serde(rename = "gc.sweep")]
    GcSweep,
    #[serde(rename = "gc.purge")]
    GcPurge,
    #[serde(rename = "shutdown")]
    Shutdown,
}

const MAX_MESSAGE: usize = 240;
/// The redactions see at most this much of the message (UTF-16 units, as in TS): EMAIL backtracks
/// quadratically in the TS regex on a long run without whitespace. The cut backs up to whitespace: a token cut
/// in half (`alice.secret@`) misses its pattern, and earlier redactions can shrink the line enough for it to
/// show (OME-579).
const MAX_SCRUBBED: usize = 2048;

fn is_ws_unit(u: u16) -> bool {
    char::from_u32(u32::from(u)).is_some_and(is_js_whitespace)
}

/// At most `MAX_SCRUBBED` UTF-16 units of the message, never ending in part of a token.
pub fn head(message: &str) -> String {
    let units: Vec<u16> = message.encode_utf16().take(MAX_SCRUBBED + 1).collect();
    if units.len() <= MAX_SCRUBBED {
        return message.to_owned();
    }
    let mut end = MAX_SCRUBBED;
    while end > 0 && !units.get(end).copied().is_some_and(is_ws_unit) {
        end -= 1;
    }
    String::from_utf16_lossy(units.get(..end).unwrap_or(&[]))
}

fn is_word(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_'
}

/// `[^\s@"'<>()[\]]`
fn is_email_char(c: char) -> bool {
    !is_js_whitespace(c) && !matches!(c, '@' | '"' | '\'' | '<' | '>' | '(' | ')' | '[' | ']')
}

fn at(cs: &[char], i: usize) -> Option<char> {
    cs.get(i).copied()
}

fn run_len(cs: &[char], from: usize, pred: impl Fn(char) -> bool) -> usize {
    cs.iter().skip(from).take_while(|c| pred(**c)).count()
}

/// The end of the domain part of an email whose `@` is just before `d0`: `[^…]+\.[a-z]{2,}` takes the last
/// dot (after at least one char) that is followed by two ASCII letters, then every letter after it.
fn email_domain_end(cs: &[char], d0: usize) -> Option<usize> {
    let e = d0 + run_len(cs, d0, is_email_char);
    let letter = |i: usize| at(cs, i).is_some_and(|c| c.is_ascii_alphabetic());
    let dot = (d0 + 1..e)
        .rev()
        .find(|&d| at(cs, d) == Some('.') && letter(d + 1) && letter(d + 2))?;
    Some(dot + 1 + run_len(cs, dot + 1, |c| c.is_ascii_alphabetic()))
}

/// Replaces every match found by `find(chars, i)` (the end of a match starting at `i`) with `replace(match)`.
fn replace_all(text: &str, find: impl Fn(&[char], usize) -> Option<usize>, replace: impl Fn(&[char]) -> Option<&'static str>) -> String {
    let cs: Vec<char> = text.chars().collect();
    let mut out = String::with_capacity(text.len());
    let (mut copied, mut i) = (0, 0);
    while i < cs.len() {
        let Some(end) = find(&cs, i) else {
            i += 1;
            continue;
        };
        if let Some(with) = replace(cs.get(i..end).unwrap_or(&[])) {
            out.extend(cs.get(copied..i).unwrap_or(&[]));
            out.push_str(with);
            copied = end;
        }
        i = end; // a match that is kept still consumes its text
    }
    out.extend(cs.get(copied..).unwrap_or(&[]));
    out
}

fn redact_emails(text: &str) -> String {
    let cs: Vec<char> = text.chars().collect();
    let mut out = String::with_capacity(text.len());
    let (mut copied, mut i) = (0, 0);
    while i < cs.len() {
        if !at(&cs, i).is_some_and(is_email_char) {
            i += 1;
            continue;
        }
        // A maximal run of email chars; the local part is the whole run (a shorter one is never followed by `@`).
        let b = i + run_len(&cs, i, is_email_char);
        if at(&cs, b) == Some('@')
            && let Some(end) = email_domain_end(&cs, b + 1)
        {
            out.extend(cs.get(copied..i).unwrap_or(&[]));
            out.push_str("<email>");
            copied = end;
            i = end;
        } else {
            i = b;
        }
    }
    out.extend(cs.get(copied..).unwrap_or(&[]));
    out
}

/// `\b\d{1,3}(?:\.\d{1,3}){3}\b`: four dot-separated digit runs of 1-3, not part of a longer word.
fn ipv4_end(cs: &[char], i: usize) -> Option<usize> {
    if i > 0 && at(cs, i - 1).is_some_and(is_word) {
        return None;
    }
    let mut p = i;
    for group in 0..4 {
        let run = run_len(cs, p, |c| c.is_ascii_digit());
        if run == 0 || run > 3 {
            return None;
        }
        p += run;
        if group < 3 {
            if at(cs, p) != Some('.') {
                return None;
            }
            p += 1;
        }
    }
    (!at(cs, p).is_some_and(is_word)).then_some(p)
}

/// `(?<![\w:])(?:[0-9a-f]{0,4}:){2,7}[0-9a-f]{0,4}(?![\w:])`: backtracking never helps, so this is the
/// maximal chain of at most 7 `hex{0,4}:` groups, a tail of at most 4 hex digits and no word char or colon after.
fn ipv6_end(cs: &[char], i: usize) -> Option<usize> {
    if i > 0 && at(cs, i - 1).is_some_and(|c| is_word(c) || c == ':') {
        return None;
    }
    let hex = |c: char| c.is_ascii_hexdigit();
    let (mut p, mut groups) = (i, 0);
    while groups < 7 {
        let run = run_len(cs, p, hex);
        if run > 4 || at(cs, p + run) != Some(':') {
            break;
        }
        p += run + 1;
        groups += 1;
    }
    let tail = run_len(cs, p, hex);
    if groups < 2 || tail > 4 {
        return None;
    }
    let end = p + tail;
    (!at(cs, end).is_some_and(|c| is_word(c) || c == ':')).then_some(end)
}

/// Emails become `<email>`, IPv4 and IPv6 addresses `<ip>`. Also what an abuse report's note goes through
/// before it is stored (ADR 0033 §3).
pub fn redact_addresses(text: &str) -> String {
    let no_email = redact_emails(text);
    let no_v4 = replace_all(
        &no_email,
        |cs, i| at(cs, i).filter(char::is_ascii_digit).and_then(|_| ipv4_end(cs, i)),
        |_| Some("<ip>"),
    );
    replace_all(
        &no_v4,
        ipv6_end,
        // `a: b` prose and `12:30` stay: the match needs a `::` or at least 3 colons.
        |m| {
            let colons = m.iter().filter(|c| **c == ':').count();
            (m.windows(2).any(|w| w == [':', ':']) || colons >= 3).then_some("<ip>")
        },
    )
}

/// Every redaction runs before the cap, so the cap never cuts an address to a fragment the patterns miss (OME-548).
pub fn scrub(message: &str) -> String {
    let head = head(message);
    // From the first quote to the end: a quoted value can itself hold a quote, so no closing quote can be trusted (OME-536).
    let cut = match head.char_indices().find(|(_, c)| matches!(c, '"' | '\'' | '`')) {
        Some((i, q)) => format!("{}{q}…{q}", head.get(..i).unwrap_or("")),
        None => head,
    };
    let redacted = redact_addresses(&cut);
    if utf16_len(&redacted) <= MAX_MESSAGE {
        return redacted;
    }
    // `slice(0, 240)` counts UTF-16 units; a pair cut in half can't be a Rust string, so the half is dropped (PORTING parity note).
    let mut out = String::new();
    let mut units = 0;
    for c in redacted.chars() {
        units += c.len_utf16();
        if units > MAX_MESSAGE {
            break;
        }
        out.push(c);
    }
    out.push('…');
    out
}

#[derive(Serialize)]
struct Line {
    level: &'static str,
    event: LogEvent,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

/// The JSON line for an event; `err` is the error's class name and message (`${name}: ${scrubbed message}`).
pub fn format_log_line(event: LogEvent, err: Option<(&str, &str)>) -> String {
    let line = Line {
        level: "error",
        event,
        error: err.map(|(name, message)| format!("{name}: {}", scrub(message))),
    };
    serde_json::to_string(&line).unwrap_or_default()
}

/// Writes the line for `event` to `w`, ignoring a write error.
pub fn write_error_line(w: &mut impl Write, event: LogEvent, err: Option<(&str, &str)>) {
    let mut line = format_log_line(event, err);
    line.push('\n');
    let _ = w.write_all(line.as_bytes());
}

/// One error line on stderr. Rust errors have no runtime class, so the class name is the fixed `Error`.
pub fn log_error(event: LogEvent, err: Option<&dyn Error>) {
    let message = err.map(ToString::to_string);
    write_error_line(&mut std::io::stderr().lock(), event, message.as_deref().map(|m| ("Error", m)));
}

/// A plain line on stdout; a closed or full pipe is ignored.
pub fn stdout_line(line: &str) {
    let _ = writeln!(std::io::stdout().lock(), "{line}");
}

/// A plain line on stderr; a closed or full pipe is ignored.
pub fn stderr_line(line: &str) {
    let _ = writeln!(std::io::stderr().lock(), "{line}");
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{Value, json};

    fn field(line: &str) -> String {
        let v: Value = serde_json::from_str(line).unwrap();
        v["error"].as_str().unwrap().to_owned()
    }
    fn err_of(event: LogEvent, message: &str) -> String {
        field(&format_log_line(event, Some(("Error", message))))
    }

    // apps/server/test/log.test.ts:21
    #[test]
    fn a_line_is_one_json_object_level_a_fixed_event_name_and_the_errors_class() {
        let line = format_log_line(LogEvent::StoreLastActive, Some(("TypeError", "boom")));
        assert!(!line.contains('\n'));
        let v: Value = serde_json::from_str(&line).unwrap();
        assert_eq!(
            v,
            json!({"level": "error", "event": "store.last_active", "error": "TypeError: boom"})
        );
        assert_eq!(line, r#"{"level":"error","event":"store.last_active","error":"TypeError: boom"}"#);
        assert_eq!(format_log_line(LogEvent::Shutdown, None), r#"{"level":"error","event":"shutdown"}"#);
    }

    // apps/server/src/log.ts:7: every event name is the exact string
    #[test]
    fn every_event_serializes_to_the_exact_name() {
        let all = [
            (LogEvent::StoreNewRoom, "store.new_room"),
            (LogEvent::StoreDeleteRoom, "store.delete_room"),
            (LogEvent::StoreLastActive, "store.last_active"),
            (LogEvent::StoreLayout, "store.layout"),
            (LogEvent::StoreTitle, "store.title"),
            (LogEvent::StoreControlPolicy, "store.control_policy"),
            (LogEvent::StoreSeatHolds, "store.seat_holds"),
            (LogEvent::StoreQueueItem, "store.queue_item"),
            (LogEvent::StoreQueue, "store.queue"),
            (LogEvent::StoreReport, "store.report"),
            (LogEvent::StoreHealth, "store.health"),
            (LogEvent::GcRemove, "gc.remove"),
            (LogEvent::GcSweep, "gc.sweep"),
            (LogEvent::GcPurge, "gc.purge"),
            (LogEvent::Shutdown, "shutdown"),
        ];
        for (event, name) in all {
            assert_eq!(serde_json::to_string(&event).unwrap(), format!("\"{name}\""));
        }
    }

    // apps/server/test/log.test.ts:27
    #[test]
    fn redacts_quoted_values_addresses_and_emails_from_error_messages() {
        let message = r#"write failed from 203.0.113.7, [2001:db8::1]:443 or fe80::1 by mail@example.com: no room "secret-room-id": "My Private Title""#;
        let line = format_log_line(LogEvent::StoreTitle, Some(("Error", message)));
        for secret in [
            "secret-room-id",
            "My Private Title",
            "203.0.113.7",
            "2001:db8::1",
            "fe80::1",
            "mail@example.com",
        ] {
            assert!(!line.contains(secret), "{secret}");
        }
        assert_eq!(
            field(&line),
            r#"Error: write failed from <ip>, [<ip>]:443 or <ip> by <email>: no room "…""#
        );
    }

    // apps/server/test/log.test.ts:41
    #[test]
    fn a_quoted_value_holding_a_quote_leaks_none_of_its_characters() {
        let cases = [
            (
                r#"Invalid type: Expected number but received "Ali"ce Secret""#,
                r#"ValiError: Invalid type: Expected number but received "…""#,
            ),
            (
                "Invalid type: Expected number but received \"Ali'ce Secret\"",
                r#"ValiError: Invalid type: Expected number but received "…""#,
            ),
            (r#"Room "Ali\"ceSecretNick" not found"#, r#"ValiError: Room "…""#),
            ("no room 'Ali'ce Secret' here", "ValiError: no room '…'"),
        ];
        for (message, expected) in cases {
            let line = format_log_line(LogEvent::StoreTitle, Some(("ValiError", message)));
            for secret in ["Ali", "ce Secret", "ceSecret", "Secret", "Nick", "here"] {
                assert!(!line.contains(secret), "{secret} in {line}");
            }
            assert_eq!(field(&line), expected);
        }
    }

    // Rust-only (serde quotes input with backticks): the cut also starts at the first backtick
    #[test]
    fn a_backtick_quoted_value_is_cut_like_a_quote() {
        let line = format_log_line(LogEvent::StoreReport, Some(("Error", "unknown field `secret-room`, expected `a`")));
        assert!(!line.contains("secret-room"));
        assert_eq!(field(&line), "Error: unknown field `…`");
        assert_eq!(scrub("a `b' c\" d"), "a `…`");
    }

    // apps/server/test/log.test.ts:54
    #[test]
    fn a_quoted_value_cut_off_by_the_length_cap_is_still_redacted() {
        let message = format!("no room \"{}\"", "s".repeat(300));
        let line = format_log_line(LogEvent::StoreTitle, Some(("Error", &message)));
        assert!(!line.contains("sss"));
        assert_eq!(field(&line), r#"Error: no room "…""#);
    }

    // apps/server/test/log.test.ts:60
    #[test]
    fn an_ip_or_email_straddling_the_length_cap_is_still_redacted() {
        let pad = format!("{} from ", "x".repeat(225));
        let cases: [(String, String, &[&str]); 3] = [
            (format!("{pad}203.0.113.7"), format!("Error: {pad}<ip>"), &["203", "113"]),
            (format!("{pad}mail@example.com"), format!("Error: {pad}<email>"), &["mail@", "exam"]),
            (
                format!("{pad}2001:db8:85a3::8a2e:370:7334"),
                format!("Error: {pad}<ip>"),
                &["2001", "db8", "85a3"],
            ),
        ];
        for (message, expected, secrets) in cases {
            let line = format_log_line(LogEvent::StoreTitle, Some(("Error", &message)));
            for secret in secrets {
                assert!(!line.contains(secret), "{secret}");
            }
            assert_eq!(field(&line), expected);
        }
    }

    // apps/server/test/log.test.ts:76
    #[test]
    fn an_email_or_ip_straddling_the_redaction_bound_leaks_no_fragment() {
        let mut base = String::new();
        while base.len() < 2030 {
            base.push_str(&format!("{}@example.com ", "u".repeat(90)));
        }
        let cut = |n: usize| base.get(..n).unwrap().to_owned();
        let cases: [(String, &[&str]); 2] = [
            (format!("{} alice.secret@example.com tail", cut(2034)), &["alice", "secr"]),
            (format!("{} 203.0.113.77 tail", cut(2040)), &["203", "113"]),
        ];
        for (message, secrets) in cases {
            let line = format_log_line(LogEvent::Shutdown, Some(("Error", &message)));
            for secret in secrets {
                assert!(!line.contains(secret), "{secret}");
            }
        }
    }

    // apps/server/test/log.test.ts:93
    #[test]
    fn caps_the_message_length() {
        let line = format_log_line(LogEvent::StoreTitle, Some(("Error", &"x".repeat(5000))));
        assert!(line.len() < 400);
        // no whitespace to back up to: head() gives up the whole message
        assert_eq!(err_of(LogEvent::StoreTitle, &"x".repeat(5000)), "Error: ");
        assert_eq!(
            err_of(LogEvent::StoreTitle, &"x".repeat(300)).chars().count(),
            "Error: ".len() + 240 + 1
        );
    }

    // apps/server/test/log.test.ts:99
    #[test]
    fn a_huge_unquoted_message_is_formatted_quickly_and_still_capped() {
        for message in ["x".repeat(200_000), "1:".repeat(100_000), "a.".repeat(100_000)] {
            let start = std::time::Instant::now();
            let line = format_log_line(LogEvent::GcSweep, Some(("Error", &message)));
            assert!(start.elapsed().as_millis() < 100);
            assert!(line.len() < 400);
        }
    }

    // apps/server/src/log.ts:33: head backs up to whitespace, counting UTF-16 units
    #[test]
    fn head_backs_up_to_whitespace_past_the_cap() {
        let short = "a".repeat(2048);
        assert_eq!(head(&short), short);
        let long = format!("{} tail{}", "a".repeat(2040), "b".repeat(100));
        assert_eq!(head(&long), "a".repeat(2040));
        assert_eq!(head(&"b".repeat(3000)), "");
        // astral characters count two units each: 1025 of them are 2050 units
        let emoji = "😀".repeat(1025);
        assert_eq!(head(&emoji), "");
        let spaced = format!("{} {}", "😀".repeat(1000), "😀".repeat(100));
        assert_eq!(head(&spaced), "😀".repeat(1000));
    }

    // apps/server/src/log.ts:61: the 240 cap counts UTF-16 units and adds an ellipsis
    #[test]
    fn the_message_cap_is_240_units_plus_an_ellipsis() {
        let exact = "y".repeat(240);
        assert_eq!(scrub(&exact), exact);
        assert_eq!(scrub(&"y".repeat(241)), format!("{}…", "y".repeat(240)));
        assert_eq!(scrub(&"😀".repeat(121)), format!("{}…", "😀".repeat(120)));
    }

    // apps/server/test/log.test.ts:109, adapted: the line goes to the writer, and a broken writer is ignored
    #[test]
    fn write_error_line_writes_one_line_and_ignores_a_closed_pipe() {
        let mut out = Vec::new();
        write_error_line(&mut out, LogEvent::GcSweep, Some(("Error", "x")));
        assert_eq!(
            String::from_utf8(out).unwrap(),
            format!("{}\n", format_log_line(LogEvent::GcSweep, Some(("Error", "x"))))
        );

        struct Closed;
        impl Write for Closed {
            fn write(&mut self, _: &[u8]) -> std::io::Result<usize> {
                Err(std::io::ErrorKind::BrokenPipe.into())
            }
            fn flush(&mut self) -> std::io::Result<()> {
                Err(std::io::ErrorKind::BrokenPipe.into())
            }
        }
        write_error_line(&mut Closed, LogEvent::GcSweep, None);
    }

    #[test]
    fn log_error_maps_the_error_to_class_error_and_its_display() {
        #[derive(Debug)]
        struct Boom;
        impl std::fmt::Display for Boom {
            fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                write!(f, "boom at 10.0.0.1")
            }
        }
        impl Error for Boom {}
        log_error(LogEvent::GcSweep, Some(&Boom));
        log_error(LogEvent::Shutdown, None);
        stdout_line("x");
        stderr_line("x");
    }

    // apps/server/src/log.ts:53 (ADR 0033 §3: also what an abuse note goes through)
    #[test]
    fn redact_addresses_replaces_emails_and_ips() {
        assert_eq!(
            redact_addresses("a@b.co 1.2.3.4 ::1 1:2:3:4 a: b 12:30"),
            "<email> <ip> <ip> <ip> a: b 12:30"
        );
    }
}
