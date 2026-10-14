//! A refusal never echoes the input: `Invalid.reason` is a fixed category outside the crate's own
//! unit tests (validator's and serde's messages quote values, keys and variant names).

use omega_server::contract::layout::RoomLayout;
use omega_server::contract::requests::{parse_create_room_request, parse_report_request, parse_share_request};

const MARK: &str = "SECRETMARK";

fn assert_quiet(what: &str, reason: &str) {
    assert!(!reason.contains(MARK), "{what}: reason echoes input: {reason}");
}

#[test]
fn refusals_do_not_quote_the_input() {
    let long_url = format!(r#"{{"url":"{MARK}{}"}}"#, "a".repeat(2100));
    let long_note = format!(r#"{{"reason":"spam","note":"{MARK}{}"}}"#, "a".repeat(700));
    let bodies: Vec<(&str, String)> = vec![
        ("long url", long_url),
        ("long note", long_note),
        ("unknown key", format!(r#"{{"url":"x","{MARK}":1}}"#)),
        ("bad variant", format!(r#"{{"reason":"{MARK}"}}"#)),
        ("bad type", format!(r#"{{"reason":["{MARK}"]}}"#)),
        ("bad json", format!(r#"{{"reason":"{MARK}"#)),
        ("duplicate", format!(r#"{{"reason":"spam","{MARK}":1,"{MARK}":2}}"#)),
    ];
    for (what, body) in &bodies {
        for r in [
            parse_share_request(body.as_bytes()).err(),
            parse_report_request(body.as_bytes()).err(),
            parse_create_room_request(body.as_bytes()).err(),
            RoomLayout::parse_input(body.as_bytes()).err(),
            RoomLayout::parse(body.as_bytes()).err(),
        ]
        .into_iter()
        .flatten()
        {
            assert_quiet(what, &r.reason);
            assert_quiet(what, &r.to_string());
        }
    }
    let r = parse_report_request(format!(r#"{{"reason":"{MARK}"}}"#).as_bytes()).err();
    assert!(r.is_some());
}
