//! Which embeds this server accepts, mirroring `apps/server/src/embed-policy.ts`.

use crate::contract::Invalid;
use crate::contract::generic_embed::AnyEmbed;

#[derive(Debug, Clone)]
pub struct EmbedPolicy {
    pub generic_embeds: bool,
}

impl EmbedPolicy {
    /// `own_hosts` and `denylist` are bare hostnames; a bad entry is an error (the server refuses to start).
    pub fn new(generic_embeds: bool, _own_hosts: &[String], _denylist: &[String]) -> Result<Self, Invalid> {
        Ok(Self { generic_embeds })
    }

    pub fn is_denied_host(&self, _host: &str) -> bool {
        false
    }

    pub fn accept(&self, _url: &str) -> Option<AnyEmbed> {
        None
    }

    pub fn restore(&self, _embed: &AnyEmbed) -> Option<AnyEmbed> {
        None
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, reason = "tests")]
mod tests {
    use super::*;

    fn hosts(h: &[&str]) -> Vec<String> {
        h.iter().map(|s| (*s).to_owned()).collect()
    }

    const YOUTUBE: &str = "https://youtu.be/dQw4w9WgXcQ";
    const GENERIC: &str = "https://player.example-host.net/embed/42";

    // apps/server/test/generic-embeds.test.ts:66
    #[test]
    fn a_generic_url_is_accepted_canonically() {
        let p = EmbedPolicy::new(true, &[], &[]).unwrap();
        let e = p.accept("  https://Player.Example-Host.net/embed/42 ").unwrap();
        assert_eq!(e.url(), GENERIC);
        assert!(!e.is_synced());
        assert!(p.accept(YOUTUBE).unwrap().is_synced());
    }

    // apps/server/test/generic-embeds.test.ts:112
    #[test]
    fn own_hosts_and_their_subdomains_are_refused() {
        let p = EmbedPolicy::new(true, &hosts(&["quiet-otter.ngrok-free.app", " Watch.Omega-Site.org. "]), &[]).unwrap();
        for url in [
            "https://cdn.quiet-otter.ngrok-free.app/x",
            "https://quiet-otter.ngrok-free.app/rooms/lobby",
            "https://watch.omega-site.org/",
        ] {
            assert_eq!(p.accept(url), None, "{url}");
        }
        assert!(p.accept("https://notquiet-otter.ngrok-free.app/x").is_some());
    }

    // apps/server/test/generic-embeds.test.ts:126
    #[test]
    fn kill_switch_off_keeps_the_synced_tier() {
        let p = EmbedPolicy::new(false, &[], &[]).unwrap();
        assert_eq!(p.accept(GENERIC), None);
        assert!(p.accept(YOUTUBE).is_some());
    }

    // apps/server/test/generic-embeds.test.ts:137
    #[test]
    fn denylist_matches_whole_labels_for_the_generic_tier_only() {
        let p = EmbedPolicy::new(true, &[], &hosts(&["example-host.net", "youtube.com"])).unwrap();
        assert_eq!(p.accept(GENERIC), None);
        assert_eq!(p.accept("https://example-host.net/v"), None);
        assert!(p.accept("https://notexample-host.net/v").is_some());
        assert!(p.is_denied_host("a.b.example-host.net"));
        assert!(!p.is_denied_host("notexample-host.net"));
        // :150 the denylist applies to the generic tier only
        assert!(p.accept("https://www.youtube.com/watch?v=dQw4w9WgXcQ").is_some());
    }

    // apps/server/test/generic-embeds.test.ts:254
    #[test]
    fn restore_applies_the_current_policy_to_a_stored_embed() {
        let on = EmbedPolicy::new(true, &[], &[]).unwrap();
        let stored = on.accept(GENERIC).unwrap();
        assert_eq!(on.restore(&stored), Some(stored.clone()));
        // :266 kill switch off
        assert_eq!(EmbedPolicy::new(false, &[], &[]).unwrap().restore(&stored), None);
        // :281 a host denied after it was shared
        assert_eq!(
            EmbedPolicy::new(true, &[], &hosts(&["example-host.net"])).unwrap().restore(&stored),
            None
        );
        let synced = on.accept(YOUTUBE).unwrap();
        assert_eq!(EmbedPolicy::new(false, &[], &[]).unwrap().restore(&synced), Some(synced));
    }

    #[test]
    fn a_bad_entry_is_refused_at_construction() {
        for bad in ["https://x.com/", "a b", "x.com:80", ""] {
            assert!(EmbedPolicy::new(true, &hosts(&[bad]), &[]).is_err(), "own host {bad:?}");
            assert!(EmbedPolicy::new(true, &[], &hosts(&[bad])).is_err(), "denylist {bad:?}");
        }
    }

    #[test]
    fn entries_are_normalised() {
        let p = EmbedPolicy::new(true, &[], &hosts(&[" Bücher-Bad.DE. "])).unwrap();
        assert!(p.is_denied_host("xn--bcher-bad-q5a.de"));
    }
}
