//! M1: a panic must never print its payload (a std str-slicing panic embeds the string, i.e. a nickname,
//! title or URL) to stderr and so into the journal. One fixed JSON event with the location only.

/// Installs the hook. Called first in `main`.
pub fn install() {}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::panic, reason = "tests")]
mod tests {
    const MARKER: &str = "zq-secret-nickname-7731";
    const CHILD: &str = "OMEGA_PANIC_HOOK_CHILD";
    const NAME: &str = "panic_hook::tests::a_panic_prints_one_fixed_event_with_the_location_and_never_the_payload";

    // The child is this very test binary, re-run on one test with the hook installed: a real panic on a real stderr.
    #[test]
    fn a_panic_prints_one_fixed_event_with_the_location_and_never_the_payload() {
        if std::env::var_os(CHILD).is_some() {
            super::install();
            let nickname = std::hint::black_box(MARKER);
            panic!("boom {nickname}");
        }
        let out = std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", NAME, "--nocapture", "--test-threads=1"])
            .env(CHILD, "1")
            .env("RUST_BACKTRACE", "0")
            .output()
            .unwrap();
        let stderr = String::from_utf8_lossy(&out.stderr);
        assert!(!stderr.contains(MARKER), "{stderr}");
        assert!(!stderr.contains("boom"), "{stderr}");
        let line = stderr
            .lines()
            .find(|l| l.contains("\"panic\""))
            .unwrap_or_else(|| panic!("no panic event: {stderr}"));
        assert!(line.starts_with("{\"level\":\"error\",\"event\":\"panic\""), "{line}");
        assert!(line.contains("panic_hook.rs"), "{line}");
    }
}
