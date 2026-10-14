//! The default build must not contain the `/__test/*` control plane (ADR 0050): the string is
//! absent from a binary built without the `test-hooks` feature.
#![allow(clippy::unwrap_used, clippy::expect_used, reason = "a test")]

use std::path::PathBuf;
use std::process::Command;

#[test]
fn the_default_binary_has_no_test_hooks() {
    // The suite itself builds with all features, so build the default binary into its own target dir
    // (incremental, so a warm cache makes this near-free).
    let target = std::env::var_os("CARGO_TARGET_DIR")
        .map_or_else(|| PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../target"), PathBuf::from)
        .join("no-hooks");
    let cargo = std::env::var_os("CARGO").unwrap_or_else(|| "cargo".into());
    let status = Command::new(cargo)
        .args(["build", "--locked", "--bin", "omega-server", "--manifest-path"])
        .arg(concat!(env!("CARGO_MANIFEST_DIR"), "/Cargo.toml"))
        .env("CARGO_TARGET_DIR", &target)
        .status()
        .expect("cargo runs");
    assert!(status.success());
    let bytes = std::fs::read(target.join("debug/omega-server")).expect("binary");
    assert!(
        !bytes.windows(10).any(|w| w == b"/__test/ti"),
        "the default binary contains /__test/time"
    );
}
