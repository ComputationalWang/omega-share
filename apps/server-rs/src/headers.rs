//! Port of `apps/server/src/headers.ts`: the security headers on every response (threat model §4) and HSTS.
//! Names are lowercase (HTTP/1.1 header names are case-insensitive; the TS tests read them lowercase).

pub type Header = (&'static str, &'static str);

/// The production policy (always same-origin, ADR 0015 §1); the literal is what follows the three synced
/// frame origins. Header and `<meta>` CSPs intersect, so the meta in `apps/web/index.html` must be a superset.
macro_rules! csp {
    ($frame_extra:literal) => {
        concat!(
            "default-src 'self'; ",
            // The three provider SDK loaders, path-scoped; no inline script or eval.
            "script-src 'self' https://www.youtube.com/iframe_api https://www.youtube.com/s/player/ https://player.twitch.tv/js/embed/v1.js https://player.vimeo.com/api/player.js; ",
            "style-src 'self'; ",
            "img-src 'self' data:; ",
            "connect-src 'self'; ",
            "worker-src 'self'; ",
            "frame-src https://www.youtube-nocookie.com https://player.twitch.tv https://player.vimeo.com",
            $frame_extra,
            "; ",
            "object-src 'none'; ",
            "base-uri 'none'; ",
            "form-action 'none'; ",
            "frame-ancestors 'none'; ",
            // Enforced Trusted Types (ADR 0025): our loader policy plus the real YouTube `iframe_api` policy, nothing else.
            "require-trusted-types-for 'script'; ",
            "trusted-types omega-sdk youtube-widget-api"
        )
    };
}

/// The policy with GENERIC_EMBEDS=off.
pub const CSP: &str = csp!("");
/// The generic tier frames any https page (ADR 0024 §4); the synced origins stay listed.
pub const CSP_WITH_GENERIC: &str = csp!(" https:");

/// Powerful features we never use. Autoplay, fullscreen, picture-in-picture and encrypted-media stay off
/// this list: the player iframes get them through `allow`.
pub const PERMISSIONS_POLICY: &str =
    "camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=(), hid=(), bluetooth=(), display-capture=()";

/// No COEP: `require-corp` would block the provider iframes and scripts, which send no CORP.
macro_rules! headers_with {
    ($csp:expr) => {
        [
            ("x-content-type-options", "nosniff"),
            ("referrer-policy", "strict-origin-when-cross-origin"),
            ("content-security-policy", $csp),
            ("permissions-policy", PERMISSIONS_POLICY),
            ("cross-origin-opener-policy", "same-origin"),
            ("cross-origin-resource-policy", "same-origin"),
        ]
    };
}

static WITH_GENERIC: [Header; 6] = headers_with!(CSP_WITH_GENERIC);
static SYNCED_ONLY: [Header; 6] = headers_with!(CSP);

/// The headers for every response; `frame-src` follows the GENERIC_EMBEDS switch (ADR 0024 §4).
pub fn security_headers(generic_embeds: bool) -> &'static [Header] {
    if generic_embeds { &WITH_GENERIC } else { &SYNCED_ONLY }
}

/// One year, no `includeSubDomains` or `preload` yet (research M4 D1). Sent only to an https `PUBLIC_ORIGIN` host.
pub const HSTS: &str = "max-age=31536000";

#[cfg(test)]
mod tests {
    use super::*;

    fn get(headers: &'static [Header], name: &str) -> Option<&'static str> {
        headers.iter().find(|(n, _)| *n == name).map(|(_, v)| *v)
    }

    // apps/server/test/boundary.test.ts:40
    const BOUNDARY_CSP: &str = concat!(
        "default-src 'self'; ",
        "script-src 'self' https://www.youtube.com/iframe_api https://www.youtube.com/s/player/ https://player.twitch.tv/js/embed/v1.js https://player.vimeo.com/api/player.js; ",
        "style-src 'self'; img-src 'self' data:; connect-src 'self'; worker-src 'self'; ",
        "frame-src https://www.youtube-nocookie.com https://player.twitch.tv https://player.vimeo.com https:; ",
        "object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; ",
        "require-trusted-types-for 'script'; trusted-types omega-sdk youtube-widget-api"
    );
    // apps/server/test/boundary.test.ts:47
    const BOUNDARY_PERMISSIONS: &str =
        "camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=(), hid=(), bluetooth=(), display-capture=()";

    // apps/server/test/boundary.test.ts:51
    #[test]
    fn the_default_headers_are_the_pinned_production_policy() {
        let h = security_headers(true);
        assert_eq!(get(h, "x-content-type-options"), Some("nosniff"));
        assert_eq!(get(h, "referrer-policy"), Some("strict-origin-when-cross-origin"));
        assert_eq!(get(h, "content-security-policy"), Some(BOUNDARY_CSP));
        assert_eq!(get(h, "content-security-policy-report-only"), None);
        assert_eq!(get(h, "permissions-policy"), Some(BOUNDARY_PERMISSIONS));
        assert_eq!(get(h, "cross-origin-opener-policy"), Some("same-origin"));
        assert_eq!(get(h, "cross-origin-resource-policy"), Some("same-origin"));
        assert_eq!(get(h, "cross-origin-embedder-policy"), None);
        assert_eq!(h.len(), 6);
        assert!(h.iter().all(|(n, _)| n.bytes().all(|b| !b.is_ascii_uppercase())));
    }

    // apps/server/src/headers.ts:61: key order of the object literal
    #[test]
    fn the_header_order_is_the_ts_object_literals() {
        let names: Vec<&str> = security_headers(false).iter().map(|(n, _)| *n).collect();
        assert_eq!(
            names,
            [
                "x-content-type-options",
                "referrer-policy",
                "content-security-policy",
                "permissions-policy",
                "cross-origin-opener-policy",
                "cross-origin-resource-policy"
            ]
        );
    }

    // apps/server/test/site.test.ts:41
    #[test]
    fn the_csp_keeps_its_pinned_prefix_and_trusted_types_tail() {
        for generic in [true, false] {
            let csp = get(security_headers(generic), "content-security-policy").unwrap();
            assert!(csp.starts_with("default-src 'self'; script-src 'self' https://www.youtube.com/iframe_api"));
            assert!(csp.contains("require-trusted-types-for 'script'; trusted-types omega-sdk youtube-widget-api"));
        }
    }

    fn directive<'a>(policy: &'a str, name: &str) -> Vec<&'a str> {
        policy
            .split(';')
            .map(|d| d.split_whitespace().collect::<Vec<_>>())
            .find(|d| d.first() == Some(&name))
            .map(|d| d.into_iter().skip(1).collect())
            .unwrap_or_default()
    }
    const SYNCED_FRAMES: [&str; 3] = [
        "https://www.youtube-nocookie.com",
        "https://player.twitch.tv",
        "https://player.vimeo.com",
    ];
    const SCRIPTS: [&str; 5] = [
        "'self'",
        "https://www.youtube.com/iframe_api",
        "https://www.youtube.com/s/player/",
        "https://player.twitch.tv/js/embed/v1.js",
        "https://player.vimeo.com/api/player.js",
    ];

    // apps/server/test/generic-embeds.test.ts:319
    #[test]
    fn generic_on_frame_src_adds_https_and_script_src_is_unchanged() {
        let csp = get(security_headers(true), "content-security-policy").unwrap();
        assert_eq!(
            directive(csp, "frame-src"),
            [SYNCED_FRAMES[0], SYNCED_FRAMES[1], SYNCED_FRAMES[2], "https:"]
        );
        assert_eq!(directive(csp, "script-src"), SCRIPTS);
        assert_eq!(csp, CSP_WITH_GENERIC);
    }

    // apps/server/test/generic-embeds.test.ts:326
    #[test]
    fn generic_off_frame_src_drops_https_and_script_src_is_unchanged() {
        let csp = get(security_headers(false), "content-security-policy").unwrap();
        assert_eq!(directive(csp, "frame-src"), SYNCED_FRAMES);
        assert_eq!(directive(csp, "script-src"), SCRIPTS);
        assert_eq!(csp, CSP);
    }

    // apps/server/test/boundary.test.ts:277
    #[test]
    fn the_permissions_policy_leaves_the_player_features_to_the_iframes() {
        for feature in ["autoplay", "fullscreen", "picture-in-picture", "encrypted-media"] {
            assert!(!PERMISSIONS_POLICY.contains(feature), "{feature}");
        }
        assert_eq!(PERMISSIONS_POLICY, BOUNDARY_PERMISSIONS);
    }

    // apps/server/test/boundary.test.ts:110
    #[test]
    fn hsts_is_one_year_without_include_sub_domains_or_preload() {
        assert_eq!(HSTS, "max-age=31536000");
    }
}
