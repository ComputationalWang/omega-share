//! Port of `apps/server/src/site-meta.ts`: the share card (Open Graph + Twitter) written into every served page,
//! so a pasted link previews without running our JS. Only a public, listable room's title is ever personalised;
//! anything else gets the generic card, byte for byte, so a preview leaks nothing. Corpora: `site-meta`,
//! `with-meta`, `security-txt` against the TS functions.

use crate::contract::constants::ROOM_TITLE_MAX_LENGTH;
use crate::contract::js_compat::{is_js_whitespace, js_trim};
use unicode_normalization::UnicodeNormalization;

const SITE_NAME: &str = "omega-share";
const DESCRIPTION: &str = "Watch videos together in a cosy pixel room. Share a video from any page with the browser extension and sit with friends, in sync.";
/// Our own CC BY-SA card, the same for every room: never a provider thumbnail.
const OG_IMAGE_PATH: &str = "/og-image.png";
const OG_TITLE_MAX: usize = 80;

/// Bidi controls, zero-width characters, the BOM and Hangul fillers: invisible, or they reorder the text around them.
const fn is_invisible(c: char) -> bool {
    matches!(
        c,
        '\u{61C}' | '\u{115F}' | '\u{1160}' | '\u{200B}'..='\u{200F}' | '\u{202A}'..='\u{202E}' | '\u{2060}'..='\u{2064}'
            | '\u{2066}'..='\u{2069}' | '\u{3164}' | '\u{FEFF}' | '\u{FFA0}'
    )
}

fn escape_attr(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&#39;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            c => out.push(c),
        }
    }
    out
}

/// Code points, not UTF-16 units, so a cut never splits a surrogate pair.
fn cut(s: &str, max: usize) -> String {
    s.chars().take(max).collect()
}

fn og_title(title: Option<&str>) -> String {
    // Titles are NFKC and bidi-free by schema; a seeded or legacy row may not be, so clean again.
    let mut clean = String::new();
    let mut in_space = false;
    for c in title.unwrap_or("").nfkc().filter(|c| !is_invisible(*c)) {
        if is_js_whitespace(c) {
            if !in_space {
                clean.push(' ');
            }
            in_space = true;
        } else {
            clean.push(c);
            in_space = false;
        }
    }
    let clean = cut(js_trim(&clean), ROOM_TITLE_MAX_LENGTH);
    let clean = js_trim(&clean);
    if clean.is_empty() {
        SITE_NAME.to_owned()
    } else {
        cut(&format!("{clean} · {SITE_NAME}"), OG_TITLE_MAX)
    }
}

/// The `<head>` tags for a page: `title` is a public room's title, or `None` for the generic card.
pub fn site_meta(origin: &str, title: Option<&str>) -> String {
    let t = escape_attr(&og_title(title));
    let d = escape_attr(DESCRIPTION);
    let image = escape_attr(&format!("{origin}{OG_IMAGE_PATH}"));
    format!(
        concat!(
            r#"<meta name="description" content="{d}" />"#,
            r#"<meta property="og:site_name" content="{site}" />"#,
            r#"<meta property="og:type" content="website" />"#,
            r#"<meta property="og:title" content="{t}" />"#,
            r#"<meta property="og:description" content="{d}" />"#,
            r#"<meta property="og:image" content="{image}" />"#,
            r#"<meta property="og:image:width" content="1200" />"#,
            r#"<meta property="og:image:height" content="630" />"#,
            r#"<meta property="og:image:alt" content="{site}" />"#,
            r#"<meta name="twitter:card" content="summary_large_image" />"#,
            r#"<link rel="icon" href="/favicon.ico" sizes="32x32" />"#,
            r#"<link rel="apple-touch-icon" href="/apple-touch-icon.png" />"#,
            r#"<link rel="manifest" href="/manifest.webmanifest" />"#,
        ),
        d = d,
        t = t,
        image = image,
        site = SITE_NAME,
    )
}

/// The length of the tag at the start of `s` that `OWN_TAGS` removes, with the whitespace after it: the regex
/// `<meta name="description"[^>]*>\s*|<link rel="(?:icon|apple-touch-icon|manifest)"[^>]*>\s*`.
fn own_tag_len(s: &str) -> Option<usize> {
    let after = [
        r#"<meta name="description""#,
        r#"<link rel="icon""#,
        r#"<link rel="apple-touch-icon""#,
        r#"<link rel="manifest""#,
    ]
    .iter()
    .find_map(|prefix| s.strip_prefix(prefix))?;
    let tag_end = after.find('>')? + 1;
    let rest = after.get(tag_end..)?;
    let spaces = rest.len() - rest.trim_start_matches(is_js_whitespace).len();
    Some(s.len() - rest.len() + spaces)
}

/// `page` with `meta` added just before `</head>` (or unchanged if it has none). The page's own description, icon
/// and manifest tags before it are dropped (OME-767): the served copy keeps only ours.
pub fn with_meta(page: &str, meta: &str) -> String {
    let Some(at) = page.find("</head>") else {
        return page.to_owned();
    };
    let (head, tail) = (page.get(..at).unwrap_or(""), page.get(at..).unwrap_or(""));
    let mut out = String::with_capacity(page.len() + meta.len());
    let mut rest = head;
    while let Some(c) = rest.chars().next() {
        if let Some(n) = own_tag_len(rest) {
            rest = rest.get(n..).unwrap_or("");
        } else {
            out.push(c);
            rest = rest.get(c.len_utf8()..).unwrap_or("");
        }
    }
    out.push_str(meta);
    out.push_str(tail);
    out
}

/// RFC 9116 wants Expires under a year out. A TS test fails 30 days before this date: renew it then
/// (docs/ops/hosting.md). Contact is the contact page, never an invented address.
const SECURITY_TXT_EXPIRES: &str = "2027-10-01T00:00:00Z";

/// `/.well-known/security.txt` for `origin` (PUBLIC_ORIGIN, else SITE_ORIGIN).
pub fn security_txt(origin: &str) -> String {
    format!(
        "Contact: {origin}/contact.html\nExpires: {SECURITY_TXT_EXPIRES}\nCanonical: {origin}/.well-known/security.txt\nPreferred-Languages: en\n"
    )
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
