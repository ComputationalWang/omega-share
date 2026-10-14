//! The Valibot ↔ Rust comparison test (ADR 0050 §3): every recorded TS decision in `corpus/out/` must
//! be the Rust decision too. Regenerate with `bun apps/server-rs/corpus/gen.ts`.
#![allow(clippy::panic, reason = "a test harness: a bad corpus file should fail loudly")]

use omega_server::contract::constants;
use omega_server::contract::generic_embed::normalize_hostname;
use omega_server::log::redact_addresses;
use omega_server::rate_limit::{address_key, client_key, is_loopback_key};
use serde::Deserialize;
use serde::de::DeserializeOwned;
use serde_json::{Value, json};

/// Every corpus file has a runner below; a new `corpus/out/*.json` without one fails `every_corpus_has_a_runner`.
const RUNNERS: &[&str] = &[
    "address-key",
    "client-key",
    "constants",
    "is-loopback-key",
    "normalize-hostname",
    "redact-addresses",
];

/// One TS decision: refused (`ok: false`) or accepted with `output`. `rust: "refuses"` marks a
/// deliberate difference (PORTING.md): Rust must refuse, whatever TS decided.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Case<I, O> {
    input: I,
    ok: bool,
    output: Option<O>,
    #[serde(default)]
    rust: Option<Deliberate>,
}

#[derive(Deserialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "lowercase")]
enum Deliberate {
    Refuses,
}

fn load<I: DeserializeOwned, O: DeserializeOwned>(json: &str) -> Vec<Case<I, O>> {
    serde_json::from_str(json).unwrap_or_else(|e| panic!("corpus does not parse: {e}"))
}

/// Runs every case through `rust` and lists each disagreement, so one run shows them all.
fn agree<I: std::fmt::Debug, O: PartialEq + std::fmt::Debug>(cases: Vec<Case<I, O>>, rust: impl Fn(&I) -> Option<O>) {
    assert!(!cases.is_empty(), "empty corpus");
    let mut wrong = Vec::new();
    for case in cases {
        // An accepted case must say what it produced, or a Rust refusal would pass as agreement.
        assert!(!case.ok || case.output.is_some(), "{:?}: ok without an output", case.input);
        let want = match (case.rust, case.ok) {
            (Some(Deliberate::Refuses), _) | (None, false) => None,
            (None, true) => case.output,
        };
        let got = rust(&case.input);
        if got != want {
            wrong.push(format!("{:?}: want {want:?}, Rust {got:?}", case.input));
        }
    }
    assert!(wrong.is_empty(), "{} disagreement(s):\n{}", wrong.len(), wrong.join("\n"));
}

#[test]
fn every_corpus_has_a_runner() {
    let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("corpus/out");
    let mut files: Vec<String> = std::fs::read_dir(&dir)
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .filter_map(|name| name.strip_suffix(".json").map(str::to_owned))
        .collect();
    files.sort();
    let mut runners: Vec<String> = RUNNERS.iter().map(|r| (*r).to_owned()).collect();
    runners.sort();
    assert_eq!(files, runners, "corpus files vs runners in tests/corpus.rs");
}

#[test]
fn normalize_hostname_agrees() {
    agree(
        load::<String, String>(include_str!("../corpus/out/normalize-hostname.json")),
        |input| normalize_hostname(input),
    );
}

#[test]
fn redact_addresses_agrees() {
    agree(
        load::<String, String>(include_str!("../corpus/out/redact-addresses.json")),
        |input| Some(redact_addresses(input)),
    );
}

#[test]
fn address_key_agrees() {
    agree(load::<String, String>(include_str!("../corpus/out/address-key.json")), |input| {
        Some(address_key(input))
    });
}

#[test]
fn client_key_agrees() {
    agree(
        load::<(String, Option<String>, bool), String>(include_str!("../corpus/out/client-key.json")),
        |(peer, xff, trust)| Some(client_key(peer, xff.as_deref(), *trust)),
    );
}

#[test]
fn is_loopback_key_agrees() {
    agree(load::<String, bool>(include_str!("../corpus/out/is-loopback-key.json")), |input| {
        Some(is_loopback_key(input))
    });
}

/// Numbers compare by value: TS has one number type, Rust's constants are integers or floats.
fn numeric(v: Value) -> Value {
    match v.as_f64() {
        Some(n) => json!(n),
        None => v,
    }
}

fn constant(name: &str) -> Option<Value> {
    use constants::*;
    let v = match name {
        "DEFAULT_ROOM_ID" => json!(DEFAULT_ROOM_ID),
        "SEAT_COUNT" => json!(SEAT_COUNT),
        "FLOOR_CELLS" => json!(FLOOR_CELLS),
        "MAX_FURNITURE" => json!(MAX_FURNITURE),
        "AVATAR_COUNT" => json!(AVATAR_COUNT),
        "MAX_ROOM_MEMBERS" => json!(MAX_ROOM_MEMBERS),
        "ROOM_ID_MAX_LENGTH" => json!(ROOM_ID_MAX_LENGTH),
        "ROOM_TITLE_MAX_LENGTH" => json!(ROOM_TITLE_MAX_LENGTH),
        "NICKNAME_MAX_LENGTH" => json!(NICKNAME_MAX_LENGTH),
        "NICKNAME_MAX_MARK_RUN" => json!(NICKNAME_MAX_MARK_RUN),
        "CHAT_MAX_LENGTH" => json!(CHAT_MAX_LENGTH),
        "CHAT_MAX_MARK_RUN" => json!(CHAT_MAX_MARK_RUN),
        "MAX_URL_LENGTH" => json!(MAX_URL_LENGTH),
        "MAX_EMBED_URL_LENGTH" => json!(MAX_EMBED_URL_LENGTH),
        "MAX_CLIENT_MESSAGE_BYTES" => json!(MAX_CLIENT_MESSAGE_BYTES),
        "MAX_SERVER_MESSAGE_BYTES" => json!(MAX_SERVER_MESSAGE_BYTES),
        "MAX_LISTED_ROOMS" => json!(MAX_LISTED_ROOMS),
        "MAX_CREATE_BODY_BYTES" => json!(MAX_CREATE_BODY_BYTES),
        "ROOM_CREATE_KEY_BURST" => json!(ROOM_CREATE_KEY_BURST),
        "ROOM_CREATE_KEY_REFILL_MS" => json!(ROOM_CREATE_KEY_REFILL_MS),
        "ROOM_CREATE_RETRY_AFTER_MAX_MS" => json!(ROOM_CREATE_RETRY_AFTER_MAX_MS),
        "ROOM_CREATE_GLOBAL_BURST" => json!(ROOM_CREATE_GLOBAL_BURST),
        "ROOM_CREATE_GLOBAL_REFILL_MS" => json!(ROOM_CREATE_GLOBAL_REFILL_MS),
        "MAX_ROOMS" => json!(MAX_ROOMS),
        "ROOM_EDIT_BURST" => json!(ROOM_EDIT_BURST),
        "ROOM_EDIT_REFILL_MS" => json!(ROOM_EDIT_REFILL_MS),
        "EMOTE_BURST" => json!(EMOTE_BURST),
        "EMOTE_REFILL_MS" => json!(EMOTE_REFILL_MS),
        "KICK_COOLDOWN_MS" => json!(KICK_COOLDOWN_MS),
        "MUTE_MEMORY_MS" => json!(MUTE_MEMORY_MS),
        "MODERATION_BURST" => json!(MODERATION_BURST),
        "MODERATION_REFILL_MS" => json!(MODERATION_REFILL_MS),
        "QUEUE_MAX" => json!(QUEUE_MAX),
        "QUEUE_ADD_MEMBER_BURST" => json!(QUEUE_ADD_MEMBER_BURST),
        "QUEUE_ADD_MEMBER_REFILL_MS" => json!(QUEUE_ADD_MEMBER_REFILL_MS),
        "QUEUE_ADD_ROOM_BURST" => json!(QUEUE_ADD_ROOM_BURST),
        "QUEUE_ADD_ROOM_REFILL_MS" => json!(QUEUE_ADD_ROOM_REFILL_MS),
        "QUEUE_ENDED_DEBOUNCE_MS" => json!(QUEUE_ENDED_DEBOUNCE_MS),
        "QUEUE_ENDED_TOLERANCE_S" => json!(QUEUE_ENDED_TOLERANCE_S),
        "ERROR_MESSAGE_MAX_LENGTH" => json!(ERROR_MESSAGE_MAX_LENGTH),
        "MAX_POSITION_S" => json!(MAX_POSITION_S),
        "PLAYBACK_RATE_MIN" => json!(PLAYBACK_RATE_MIN),
        "PLAYBACK_RATE_MAX" => json!(PLAYBACK_RATE_MAX),
        "PING_ID_MAX" => json!(PING_ID_MAX),
        "RETRY_AFTER_MAX_MS" => json!(RETRY_AFTER_MAX_MS),
        "RATE_LIMITED_RECONNECT_MS" => json!(RATE_LIMITED_RECONNECT_MS),
        "REPORT_NOTE_MAX_LENGTH" => json!(REPORT_NOTE_MAX_LENGTH),
        "MAX_REPORT_BODY_BYTES" => json!(MAX_REPORT_BODY_BYTES),
        "REPORT_KEY_BURST" => json!(REPORT_KEY_BURST),
        "REPORT_KEY_REFILL_MS" => json!(REPORT_KEY_REFILL_MS),
        "REPORT_ROOM_BURST" => json!(REPORT_ROOM_BURST),
        "REPORT_ROOM_REFILL_MS" => json!(REPORT_ROOM_REFILL_MS),
        "REPORT_MAX_OPEN" => json!(REPORT_MAX_OPEN),
        "REPORT_RETENTION_MS" => json!(REPORT_RETENTION_MS),
        "close.HANDSHAKE_TIMEOUT" => json!(close::HANDSHAKE_TIMEOUT),
        "close.JOIN_TIMEOUT" => json!(close::JOIN_TIMEOUT),
        "close.ROOM_FULL" => json!(close::ROOM_FULL),
        "close.SLOW_CONSUMER" => json!(close::SLOW_CONSUMER),
        "close.RATE_LIMITED" => json!(close::RATE_LIMITED),
        "close.BAD_MESSAGES" => json!(close::BAD_MESSAGES),
        "close.ROOM_CLOSED" => json!(close::ROOM_CLOSED),
        "close.KICKED" => json!(close::KICKED),
        "close.TAKEN_DOWN" => json!(close::TAKEN_DOWN),
        "close.SESSION_REPLACED" => json!(close::SESSION_REPLACED),
        "close.HANDED_OFF" => json!(close::HANDED_OFF),
        "close.ADMISSION_FAILED" => json!(close::ADMISSION_FAILED),
        "close.SESSION_REVOKED" => json!(close::SESSION_REVOKED),
        _ => return None,
    };
    Some(numeric(v))
}

#[test]
fn constants_agree() {
    let cases: Vec<Case<String, Value>> = load::<String, Value>(include_str!("../corpus/out/constants.json"))
        .into_iter()
        .map(|c| Case {
            output: c.output.map(numeric),
            ..c
        })
        .collect();
    agree(cases, |name| constant(name));
}
