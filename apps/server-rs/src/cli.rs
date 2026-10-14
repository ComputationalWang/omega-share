//! `omega-server admin <verb> …`: the operator CLI (port of `apps/server/src/cli.ts`, docs/ops/rooms.md). It talks
//! only to the server's admin socket (`admin.rs`), so a delete or takedown ends the live room the way an owner
//! delete or GC does. The formatters are pure and corpus-tested against the TS ones.
//!
//! Exit codes: 0 done, 1 failed (no such room or report, no server, server error), 2 usage.

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
    Delete { id: RoomId },
    Pin { id: RoomId },
    Unpin { id: RoomId },
    Takedown { id: RoomId },
    Reports,
    Dismiss {
        #[serde(rename = "reportId")]
        report_id: ReportId,
    },
    DismissRoom { id: RoomId },
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

fn known_reason(reason: &String) -> Result<(), ValidationError> {
    if ["sexual", "violence", "hate", "spam", "danger", "other"].contains(&reason.as_str()) {
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
        assert_eq!(parse_args(&argv(&["rooms", "takedown", id])), Some(Command::Takedown { id: rid(id) }));
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
        assert_eq!(say(Command::Delete { id: rid(id) }, serde_json::json!({"deleted": id})), [format!("deleted {id}")]);
        assert_eq!(say(Command::Pin { id: rid(id) }, serde_json::json!({})), [format!("pinned {id}")]);
        assert_eq!(say(Command::Unpin { id: rid(id) }, serde_json::json!({})), [format!("unpinned {id}")]);
        assert_eq!(
            say(Command::Takedown { id: rid(id) }, serde_json::json!({"takenDown": id, "live": false})),
            [format!("taken down {id} (it was not live)")]
        );
        assert_eq!(say(Command::DismissRoom { id: rid(id) }, serde_json::json!({"dismissed": 3})), ["dismissed 3"]);
        assert_eq!(success(&Command::Reports, &serde_json::json!({"rooms": []})).unwrap(), ["no open reports"]);
    }
}
