//! The Valibot ↔ Rust comparison test (ADR 0050 §3): every recorded TS decision in `corpus/out/` must
//! be the Rust decision too. Regenerate with `bun apps/server-rs/corpus/gen.ts`.
#![allow(clippy::panic, reason = "a test harness: a bad corpus file should fail loudly")]

use omega_server::contract::capabilities::playback_caps;
use omega_server::contract::confusables::nickname_key;
use omega_server::contract::constants;
use omega_server::contract::embed::{Embed, canonicalize_embed};
use omega_server::contract::generic_embed::{
    AnyEmbed, AnyEmbedOptions, canonicalize_any_embed, canonicalize_generic_embed, normalize_hostname,
};
use omega_server::contract::ids::{InviteKey, MemberId, OwnerToken, QueueItemId, ResumeToken, RoomId, ShareToken, parse_bearer};
use omega_server::contract::layout::{Facing, Furniture, Kind, RoomLayout, footprint_cells, layout_seats};
use omega_server::contract::room::{Avatar, ControlPolicy, RoomVisibility, SeatIndex, StandingSlot};
use omega_server::contract::text::{ChatText, Nickname, ReportNote, RoomTitle};
use omega_server::embed_policy::EmbedPolicy;
use omega_server::log::redact_addresses;
use omega_server::metrics::{Gauges, Metrics};
use omega_server::rate_limit::{address_key, client_key, is_loopback_key};
use omega_server::secrets::hash_secret;
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

/// Every corpus file has a runner below; a new `corpus/out/*.json` without one fails `every_corpus_has_a_runner`.
const RUNNERS: &[&str] = &[
    "address-key",
    "any-embed-raw",
    "any-embed-schema",
    "avatar",
    "canonicalize-any-embed",
    "canonicalize-embed",
    "canonicalize-generic-embed",
    "chat-text",
    "client-key",
    "constants",
    "control-policy",
    "embed-policy-accept",
    "embed-policy-restore",
    "footprint-cells",
    "hash-secret",
    "is-loopback-key",
    "layout-seats",
    "member-id",
    "metrics-render",
    "nickname",
    "nickname-key",
    "normalize-hostname",
    "parse-bearer",
    "playback-caps",
    "queue-item-id",
    "raw-avatar",
    "raw-chat-text",
    "raw-member-id",
    "raw-nickname",
    "raw-seat-index",
    "raw-standing-slot",
    "redact-addresses",
    "report-note",
    "resume-token",
    "room-id",
    "room-layout",
    "room-layout-input",
    "room-layout-input-raw",
    "room-layout-raw",
    "room-title",
    "room-visibility",
    "seat-index",
    "share-token",
    "standing-slot",
    "unicode-digest",
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

fn layout_decision(input: &Value, parse: fn(&[u8]) -> Result<RoomLayout, omega_server::contract::Invalid>) -> Option<Value> {
    let layout = parse(input.to_string().as_bytes()).ok()?;
    serde_json::to_value(&layout).ok()
}

#[test]
fn room_layout_agrees() {
    agree(load::<Value, Value>(include_str!("../corpus/out/room-layout.json")), |input| {
        layout_decision(input, RoomLayout::parse)
    });
}

#[test]
fn room_layout_raw_agrees() {
    agree(load::<String, Value>(include_str!("../corpus/out/room-layout-raw.json")), |text| {
        RoomLayout::parse(text.as_bytes()).ok().and_then(|l| serde_json::to_value(&l).ok())
    });
}

#[test]
fn room_layout_input_raw_agrees() {
    agree(
        load::<String, Value>(include_str!("../corpus/out/room-layout-input-raw.json")),
        |text| {
            RoomLayout::parse_input(text.as_bytes())
                .ok()
                .and_then(|l| serde_json::to_value(&l).ok())
        },
    );
}

#[test]
fn room_layout_input_agrees() {
    agree(
        load::<Value, Value>(include_str!("../corpus/out/room-layout-input.json")),
        |input| layout_decision(input, RoomLayout::parse_input),
    );
}

/// A piece as the corpus writes it, for the functions that take one unchecked.
#[derive(Debug, Deserialize)]
struct PieceIn {
    kind: Kind,
    col: u8,
    row: u8,
    facing: Facing,
}

impl PieceIn {
    fn furniture(&self) -> Furniture {
        Furniture::new(self.kind, self.col, self.row, self.facing)
    }
}

#[derive(Debug, Deserialize)]
struct LayoutIn {
    furniture: Vec<PieceIn>,
}

#[test]
fn footprint_cells_agree() {
    agree(
        load::<PieceIn, Vec<(u32, u32)>>(include_str!("../corpus/out/footprint-cells.json")),
        |p| Some(footprint_cells(&p.furniture())),
    );
}

#[test]
fn layout_seats_agree() {
    agree(load::<LayoutIn, Value>(include_str!("../corpus/out/layout-seats.json")), |l| {
        let pieces: Vec<Furniture> = l.furniture.iter().map(PieceIn::furniture).collect();
        serde_json::to_value(layout_seats(&pieces)).ok()
    });
}

/// A schema case: the wire value goes through `T`'s `Deserialize`, and what comes back out through
/// its `Serialize` is the recorded output. Wrong types are part of the corpus.
fn schema<T: DeserializeOwned + Serialize>(v: &Value) -> Option<Value> {
    let parsed: T = serde_json::from_value(v.clone()).ok()?;
    serde_json::to_value(parsed).ok().map(numeric)
}

fn schema_corpus<T: DeserializeOwned + Serialize>(json: &str) {
    let cases: Vec<Case<Value, Value>> = load::<Value, Value>(json)
        .into_iter()
        .map(|c| Case {
            output: c.output.map(numeric),
            ..c
        })
        .collect();
    agree(cases, |v| schema::<T>(v));
}

#[test]
fn ids_agree() {
    schema_corpus::<MemberId>(include_str!("../corpus/out/member-id.json"));
    schema_corpus::<QueueItemId>(include_str!("../corpus/out/queue-item-id.json"));
    schema_corpus::<RoomId>(include_str!("../corpus/out/room-id.json"));
    schema_corpus::<ResumeToken>(include_str!("../corpus/out/resume-token.json"));
}

#[test]
fn share_owner_and_invite_tokens_agree() {
    schema_corpus::<ShareToken>(include_str!("../corpus/out/share-token.json"));
    schema_corpus::<OwnerToken>(include_str!("../corpus/out/share-token.json"));
    schema_corpus::<InviteKey>(include_str!("../corpus/out/share-token.json"));
}

#[test]
fn parse_bearer_agrees() {
    agree(load::<Value, String>(include_str!("../corpus/out/parse-bearer.json")), |v| {
        v.as_str().and_then(parse_bearer).map(|t| t.as_str().to_owned())
    });
}

#[test]
fn text_schemas_agree() {
    schema_corpus::<Nickname>(include_str!("../corpus/out/nickname.json"));
    schema_corpus::<RoomTitle>(include_str!("../corpus/out/room-title.json"));
    schema_corpus::<ChatText>(include_str!("../corpus/out/chat-text.json"));
    schema_corpus::<ReportNote>(include_str!("../corpus/out/report-note.json"));
}

#[test]
fn nickname_key_agrees() {
    agree(load::<String, String>(include_str!("../corpus/out/nickname-key.json")), |s| {
        Some(nickname_key(s))
    });
}

#[test]
fn room_primitives_agree() {
    schema_corpus::<Avatar>(include_str!("../corpus/out/avatar.json"));
    schema_corpus::<SeatIndex>(include_str!("../corpus/out/seat-index.json"));
    schema_corpus::<StandingSlot>(include_str!("../corpus/out/standing-slot.json"));
    schema_corpus::<ControlPolicy>(include_str!("../corpus/out/control-policy.json"));
    schema_corpus::<RoomVisibility>(include_str!("../corpus/out/room-visibility.json"));
}

/// Raw JSON text through `T`'s `Deserialize` (what the socket delivers), output via `Serialize`.
fn raw_corpus<T: DeserializeOwned + Serialize>(json: &str) {
    let cases: Vec<Case<String, Value>> = load::<String, Value>(json)
        .into_iter()
        .map(|c| Case {
            output: c.output.map(numeric),
            ..c
        })
        .collect();
    agree(cases, |text| {
        serde_json::from_str::<T>(text)
            .ok()
            .and_then(|t| serde_json::to_value(t).ok())
            .map(numeric)
    });
}

#[test]
fn raw_numbers_agree() {
    raw_corpus::<Avatar>(include_str!("../corpus/out/raw-avatar.json"));
    raw_corpus::<SeatIndex>(include_str!("../corpus/out/raw-seat-index.json"));
    raw_corpus::<StandingSlot>(include_str!("../corpus/out/raw-standing-slot.json"));
}

#[test]
fn raw_strings_agree() {
    raw_corpus::<MemberId>(include_str!("../corpus/out/raw-member-id.json"));
    raw_corpus::<Nickname>(include_str!("../corpus/out/raw-nickname.json"));
    raw_corpus::<ChatText>(include_str!("../corpus/out/raw-chat-text.json"));
}

/// `corpus/unicode-digest.ts`, line for line: the SHA-256 of every 0x1000 block of per-code-point
/// lines (normal forms, lowercase, nickname key, property flags). A failing block is a Unicode
/// version drift between Bun's ICU and the Rust tables.
fn unicode_digest_line(cp: u32, out: &mut String) {
    use omega_server::contract::unicode_props as p;
    use std::fmt::Write;
    use unicode_normalization::UnicodeNormalization;
    let Some(c) = char::from_u32(cp) else { return };
    let s = c.to_string();
    let hex = |t: &str| t.chars().map(|c| format!("{:x}", u32::from(c))).collect::<Vec<_>>().join(",");
    let flags = [
        p::is_letter(c),
        p::is_mark(c),
        p::is_number(c),
        p::is_punctuation(c),
        p::is_symbol(c),
        p::is_control(c),
        p::is_format(c),
        p::is_extended_pictographic(c),
        p::is_latin(c),
        p::is_latin_lookalike_script(c),
        p::is_capital(c),
    ];
    let flags: String = flags.iter().map(|f| if *f { '1' } else { '0' }).collect();
    let _ = writeln!(
        out,
        "{cp:x}|{}|{}|{}|{}|{}|{flags}",
        hex(&s.nfkc().collect::<String>()),
        hex(&s.nfc().collect::<String>()),
        hex(&s.nfd().collect::<String>()),
        hex(&s.to_lowercase()),
        hex(&nickname_key(&s)),
    );
}

#[test]
fn unicode_tables_agree_with_buns_icu() {
    use sha2::{Digest, Sha256};
    let cases = load::<String, String>(include_str!("../corpus/out/unicode-digest.json"));
    assert_eq!(cases.len(), 0x110000 / 0x1000);
    // Blocks are independent: spread them over the cores to keep a debug run in a few seconds.
    let threads = std::thread::available_parallelism().map_or(4, std::num::NonZero::get);
    let per = cases.len().div_ceil(threads);
    let mut wrong: Vec<String> = std::thread::scope(|scope| {
        let workers: Vec<_> = cases
            .chunks(per)
            .map(|batch| {
                scope.spawn(move || {
                    let mut wrong = Vec::new();
                    for case in batch {
                        let start = u32::from_str_radix(&case.input, 16).unwrap();
                        let mut text = String::new();
                        for cp in start..start + 0x1000 {
                            unicode_digest_line(cp, &mut text);
                        }
                        let digest: String = Sha256::digest(text.as_bytes()).iter().map(|b| format!("{b:02x}")).collect();
                        if Some(&digest) != case.output.as_ref() {
                            wrong.push(format!("block U+{start:04X}"));
                        }
                    }
                    wrong
                })
            })
            .collect();
        workers.into_iter().flat_map(|w| w.join().unwrap()).collect()
    });
    wrong.sort();
    assert!(wrong.is_empty(), "Unicode drift in {} block(s): {}", wrong.len(), wrong.join(", "));
}

// ---- OME-1156: embeds. Outputs are recorded as `JSON.stringify` text, so key order is compared too.

fn to_json(e: &impl serde::Serialize) -> Option<String> {
    serde_json::to_string(e).ok()
}

#[test]
fn canonicalize_embed_agrees() {
    agree(
        load::<String, String>(include_str!("../corpus/out/canonicalize-embed.json")),
        |input| canonicalize_embed(input).and_then(|e| to_json(&e)),
    );
}

#[test]
fn canonicalize_generic_embed_agrees() {
    agree(
        load::<String, String>(include_str!("../corpus/out/canonicalize-generic-embed.json")),
        |input| canonicalize_generic_embed(input, &[]).and_then(|e| to_json(&e)),
    );
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct AnyInput {
    url: String,
    generic: bool,
    #[serde(rename = "ownHosts")]
    own_hosts: Vec<String>,
}

#[test]
fn canonicalize_any_embed_agrees() {
    agree(
        load::<AnyInput, String>(include_str!("../corpus/out/canonicalize-any-embed.json")),
        |i| {
            canonicalize_any_embed(
                &i.url,
                AnyEmbedOptions {
                    generic: i.generic,
                    own_hosts: &i.own_hosts,
                },
            )
            .and_then(|e| to_json(&e))
        },
    );
}

#[test]
fn any_embed_schema_agrees() {
    agree(
        load::<Value, String>(include_str!("../corpus/out/any-embed-schema.json")),
        |input| serde_json::from_value::<AnyEmbed>(input.clone()).ok().and_then(|e| to_json(&e)),
    );
}

#[test]
fn any_embed_raw_agrees() {
    agree(load::<String, String>(include_str!("../corpus/out/any-embed-raw.json")), |text| {
        serde_json::from_str::<AnyEmbed>(text).ok().and_then(|e| to_json(&e))
    });
}

#[test]
fn playback_caps_agree() {
    agree(load::<Embed, String>(include_str!("../corpus/out/playback-caps.json")), |e| {
        to_json(playback_caps(e))
    });
}

/// The three policies `corpus/embed-corpora.ts` records (`embedPolicies`).
fn policy(mode: &str) -> EmbedPolicy {
    let own: Vec<String> = ["omega.example.org", " Own.Site.NET. "].map(String::from).to_vec();
    let deny: Vec<String> = ["bad.video.net", "bücher-bad.de", "youtube.com", "example-host.net"]
        .map(String::from)
        .to_vec();
    let made = match mode {
        "on" => EmbedPolicy::new(true, &own, &deny),
        "off" => EmbedPolicy::new(false, &own, &deny),
        _ => EmbedPolicy::new(true, &[], &[]),
    };
    made.unwrap_or_else(|e| panic!("{e}"))
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct PolicyUrl {
    mode: String,
    url: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct PolicyEmbed {
    mode: String,
    embed: AnyEmbed,
}

#[test]
fn embed_policy_accept_agrees() {
    agree(
        load::<PolicyUrl, String>(include_str!("../corpus/out/embed-policy-accept.json")),
        |i| policy(&i.mode).accept(&i.url).and_then(|e| to_json(&e)),
    );
}

#[test]
fn embed_policy_restore_agrees() {
    agree(
        load::<PolicyEmbed, String>(include_str!("../corpus/out/embed-policy-restore.json")),
        |i| policy(&i.mode).restore(&i.embed).and_then(|e| to_json(&e)),
    );
}

// ---- OME-1162: secrets and metrics.

#[test]
fn hash_secret_agrees() {
    agree(load::<String, String>(include_str!("../corpus/out/hash-secret.json")), |input| {
        Some(hash_secret(input).iter().map(|b| format!("{b:02x}")).collect())
    });
}

/// Drives `Metrics` with the recorded sequence; the TS side cuts its output before the two process gauges.
#[test]
fn metrics_render_agrees() {
    #[derive(Debug, Deserialize)]
    struct Input {
        gauges: [u64; 4],
        ops: Vec<Vec<Value>>,
    }
    agree(load::<Input, String>(include_str!("../corpus/out/metrics-render.json")), |input| {
        let m = Metrics::new();
        for op in &input.ops {
            let name = op.first().and_then(Value::as_str)?;
            let text = |i: usize| op.get(i).and_then(Value::as_str);
            let applied = match name {
                "relay" => {
                    m.observe_relay(op.get(1).and_then(Value::as_f64)?);
                    true
                }
                "close" => m.count_close(u16::try_from(op.get(1).and_then(Value::as_u64)?).ok()?),
                "report" => m.count_report(text(1)?, text(2)),
                "takedown" => {
                    m.count_takedown();
                    true
                }
                _ => false,
            };
            if !applied {
                return None;
            }
        }
        let [rooms, sockets, members, open_reports] = input.gauges;
        let out = m.render(&Gauges {
            rooms,
            sockets,
            members,
            open_reports,
            rss_bytes: 0.0,
            uptime_seconds: 0.0,
        });
        let cut = out.find("# HELP process_resident_memory_bytes")?;
        out.get(..cut).map(str::to_owned)
    });
}
