//! `omega-server admin <verb> …`: the operator CLI (port of `apps/server/src/cli.ts`, docs/ops/rooms.md). It talks
//! only to the server's admin socket (`admin.rs`), so a delete or takedown ends the live room the way an owner
//! delete or GC does. The formatters are pure and corpus-tested against the TS ones.
//!
//! Exit codes: 0 done, 1 failed (no such room or report, no server, server error), 2 usage.

use crate::contract::ids::RoomId;
use crate::store::ReportId;
use serde::Serialize;
use serde_json::Value;

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

/// `parseArgs`: the arguments after `admin`; `None` is a usage error.
pub fn parse_args(argv: &[String]) -> Option<Command> {
    let _ = argv;
    None
}

/// `printable`: titles are user text, so control and format characters are escaped.
pub fn printable(text: &str) -> String {
    let _ = text;
    String::new()
}

/// `time`: `new Date(ms).toISOString()`, `never` for none. `None` outside the `Date` range, where JS throws.
pub fn time(ms: Option<i64>) -> Option<String> {
    let _ = ms;
    None
}

/// What a successful answer prints, or `None` if the answer does not parse.
pub fn success(cmd: &Command, body: &Value) -> Option<Vec<String>> {
    let _ = (cmd, body);
    None
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
