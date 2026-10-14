//! Port of `apps/server/src/site-meta.ts`: the share card written into every served page.

/// The `<head>` tags for a page: `title` is a public room's title, or `None` for the generic card.
pub fn site_meta(origin: &str, title: Option<&str>) -> String {
    let _ = (origin, title);
    String::new()
}

/// `page` with `meta` added just before `</head>` (or unchanged if it has none).
pub fn with_meta(page: &str, meta: &str) -> String {
    let _ = meta;
    page.to_owned()
}

/// `/.well-known/security.txt` for `origin` (PUBLIC_ORIGIN, else SITE_ORIGIN).
pub fn security_txt(origin: &str) -> String {
    let _ = origin;
    String::new()
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::string_slice, reason = "tests")]
mod tests {
    use super::*;

    const PUBLIC_ORIGIN: &str = "https://quiet-otter.ngrok-free.app";

    fn og_title(html: &str) -> Option<&str> {
        let start = html.find(r#"<meta property="og:title" content=""#)? + r#"<meta property="og:title" content=""#.len();
        html[start..].split('"').next()
    }

    // apps/server/test/site.test.ts:63
    #[test]
    fn the_generic_card_has_title_description_absolute_image_type_and_a_large_twitter_card() {
        let html = site_meta(PUBLIC_ORIGIN, None);
        assert_eq!(og_title(&html), Some("omega-share"));
        for tag in [
            r#"<meta property="og:type" content="website" />"#,
            r#"<meta property="og:image" content="https://quiet-otter.ngrok-free.app/og-image.png" />"#,
            r#"<meta property="og:image:width" content="1200" />"#,
            r#"<meta property="og:image:height" content="630" />"#,
            r#"<meta name="twitter:card" content="summary_large_image" />"#,
        ] {
            assert!(html.contains(tag), "{tag}");
        }
        assert!(html.contains(r#"<meta name="description" content="Watch videos together in a cosy pixel room."#));
    }

    // apps/server/test/site.test.ts:73
    #[test]
    fn a_room_title_is_wrapped_and_attribute_escaped() {
        assert_eq!(
            og_title(&site_meta(PUBLIC_ORIGIN, Some(r#"Tom & "Jerry" <b>'s</b>"#))),
            Some("Tom &amp; &quot;Jerry&quot; &lt;b&gt;&#39;s&lt;/b&gt; · omega-share")
        );
    }

    // apps/server/test/site.test.ts:77
    #[test]
    fn bidi_controls_and_zero_width_characters_are_dropped_and_the_title_is_nfkc_normalised() {
        assert_eq!(
            og_title(&site_meta(PUBLIC_ORIGIN, Some("Film\u{202e} club\u{200b}\u{2066}\u{feff}"))),
            Some("Film club · omega-share")
        );
        assert_eq!(
            og_title(&site_meta(PUBLIC_ORIGIN, Some("\u{ff26}ilm night"))),
            Some("Film night · omega-share")
        );
        // Nothing left after cleaning: the generic card.
        assert_eq!(site_meta(PUBLIC_ORIGIN, Some("\u{200b}\u{202e} ")), site_meta(PUBLIC_ORIGIN, None));
    }

    // apps/server/test/site.test.ts:85
    #[test]
    fn a_legacy_over_long_title_is_cut_to_the_title_limit() {
        let html = site_meta(PUBLIC_ORIGIN, Some(&"a".repeat(200)));
        let title = og_title(&html).unwrap();
        assert_eq!(title, format!("{} · omega-share", "a".repeat(32)));
        assert!(title.chars().count() <= 80);
    }

    // apps/server/test/site.test.ts:191 (OME-767): the served copy keeps only our description, icon and manifest tags
    #[test]
    fn with_meta_drops_the_pages_own_tags_and_adds_ours_before_the_head_ends() {
        let page = r#"<head><meta name="description" content="Built-in words." /><link rel="icon" href="/favicon.ico" sizes="32x32" /><link rel="stylesheet" href="/s.css" /></head><body></body>"#;
        assert_eq!(
            with_meta(page, "<m/>"),
            r#"<head><link rel="stylesheet" href="/s.css" /><m/></head><body></body>"#
        );
        assert_eq!(with_meta("no head", "<m/>"), "no head");
    }

    // apps/server/src/site-meta.ts:67 (RFC 9116)
    #[test]
    fn security_txt_names_the_contact_page_and_the_canonical_url() {
        assert_eq!(
            security_txt(PUBLIC_ORIGIN),
            "Contact: https://quiet-otter.ngrok-free.app/contact.html\nExpires: 2027-10-01T00:00:00Z\nCanonical: https://quiet-otter.ngrok-free.app/.well-known/security.txt\nPreferred-Languages: en\n"
        );
    }
}
