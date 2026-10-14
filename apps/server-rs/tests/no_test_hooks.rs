//! The default build must not contain the test-hooks control plane (ADR 0050): none of its strings
//! is in the library built without the `test-hooks` feature (the hooks, the clock's environment
//! variables and the stdin guard all live in the library; main.rs only calls them).
//!
//! It builds in the normal target directory (nothing but this package's lib recompiles; the
//! dependencies are shared), and checks the lib, not the binary: building the default binary there
//! would replace `debug/omega-server`, which the other integration tests run with the hooks on.
#![allow(clippy::unwrap_used, clippy::expect_used, reason = "a test")]

use std::process::Command;

const MARKERS: [&[u8]; 3] = [b"/__test/", b"OMEGA_TEST_", b"__test/time"];

#[test]
fn the_default_library_has_no_test_hooks() {
    let cargo = std::env::var_os("CARGO").unwrap_or_else(|| "cargo".into());
    let out = Command::new(cargo)
        .args(["build", "--locked", "--lib", "--message-format=json", "--manifest-path"])
        .arg(concat!(env!("CARGO_MANIFEST_DIR"), "/Cargo.toml"))
        .output()
        .expect("cargo runs");
    assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
    let artifact = String::from_utf8_lossy(&out.stdout)
        .lines()
        .filter_map(|l| serde_json::from_str::<serde_json::Value>(l).ok())
        .filter(|m| m["reason"] == "compiler-artifact" && m["target"]["name"] == "omega_server")
        .find_map(|m| {
            m["filenames"]
                .as_array()?
                .iter()
                .filter_map(|f| f.as_str())
                .find(|f| f.ends_with(".rlib"))
                .map(str::to_owned)
        })
        .expect("an rlib artifact");
    let bytes = std::fs::read(&artifact).expect("the rlib");
    assert!(bytes.len() > 1000, "{artifact} is suspiciously small");
    for marker in MARKERS {
        assert!(
            !bytes.windows(marker.len()).any(|w| w == marker),
            "{artifact} contains {}",
            String::from_utf8_lossy(marker)
        );
    }
}
