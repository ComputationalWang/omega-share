//! The Valibot ↔ Rust comparison test (ADR 0050 §3): every recorded TS decision in `corpus/out/` must
//! be the Rust decision too. Regenerate with `bun apps/server-rs/corpus/gen.ts`.
#![allow(clippy::panic, reason = "a test harness: a bad corpus file should fail loudly")]

use omega_server::contract::generic_embed::normalize_hostname;
use serde::Deserialize;
use serde::de::DeserializeOwned;

/// One TS decision: refused (`ok: false`) or accepted with `output`.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Case<I, O> {
    input: I,
    ok: bool,
    output: Option<O>,
}

fn load<I: DeserializeOwned, O: DeserializeOwned>(json: &str) -> Vec<Case<I, O>> {
    serde_json::from_str(json).unwrap_or_else(|e| panic!("corpus does not parse: {e}"))
}

/// Runs every case through `rust` and lists each disagreement, so one run shows them all.
fn agree<I: std::fmt::Debug, O: PartialEq + std::fmt::Debug>(cases: Vec<Case<I, O>>, rust: impl Fn(&I) -> Option<O>) {
    assert!(!cases.is_empty(), "empty corpus");
    let mut wrong = Vec::new();
    for case in cases {
        let ts = if case.ok { case.output } else { None };
        let got = rust(&case.input);
        if got != ts {
            wrong.push(format!("{:?}: TS {ts:?}, Rust {got:?}", case.input));
        }
    }
    assert!(wrong.is_empty(), "{} disagreement(s):\n{}", wrong.len(), wrong.join("\n"));
}

#[test]
fn normalize_hostname_agrees() {
    agree(
        load::<String, String>(include_str!("../corpus/out/normalize-hostname.json")),
        |input| normalize_hostname(input),
    );
}
