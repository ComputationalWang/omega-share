//! Generic embeds (ADR 0024), mirroring `packages/shared/src/generic-embed.ts`.

use super::js_compat::{is_js_whitespace, js_trim};
use url::Url;

/// `normalizeHostname`: a bare hostname, trimmed, one trailing dot dropped, WHATWG-parsed to its
/// lowercase punycode form; `None` for anything with a path, port, credentials or whitespace.
pub fn normalize_hostname(host: &str) -> Option<String> {
    let trimmed = js_trim(host);
    let h = trimmed.strip_suffix('.').unwrap_or(trimmed);
    if h.is_empty()
        || h.chars()
            .any(|c| matches!(c, '/' | ':' | '?' | '#' | '@' | '\\') || is_js_whitespace(c))
    {
        return None;
    }
    let url = Url::parse(&format!("https://{h}/")).ok()?;
    url.host_str().map(str::to_owned)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Expected values come from the TS `normalizeHostname` under Bun 1.4.2.
    #[test]
    fn matches_the_ts_normalizer() {
        let cases: &[(&str, Option<&str>)] = &[
            (" Bad.Video.net. ", Some("bad.video.net")),
            ("evil.tv/path", None),
            ("evil.tv:443", None),
            ("user@evil.tv", None),
            ("", None),
            ("https://evil.tv", None),
            ("münchen.de", Some("xn--mnchen-3ya.de")),
            ("a b", None),
            ("1.2.3.4", Some("1.2.3.4")),
            ("evil.tv..", Some("evil.tv.")),
            ("\u{FEFF}evil.tv", Some("evil.tv")),
            ("\u{85}evil.tv", None),
            ("EXAMPLE.com", Some("example.com")),
            ("%41.com", Some("a.com")),
            ("xn--mnchen-3ya.de", Some("xn--mnchen-3ya.de")),
            ("ex_ample.com", Some("ex_ample.com")),
            ("a..b", Some("a..b")),
            (".", None),
            ("0x7f.1", Some("127.0.0.1")),
            ("[::1]", None),
            ("exa\tmple.com", None),
            ("faß.de", Some("xn--fa-hia.de")),
            ("😀.com", Some("xn--e28h.com")),
        ];
        for (input, want) in cases {
            assert_eq!(normalize_hostname(input).as_deref(), *want, "normalize_hostname({input:?})");
        }
    }
}
