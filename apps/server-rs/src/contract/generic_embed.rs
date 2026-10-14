//! Generic embeds (ADR 0024), mirroring `packages/shared/src/generic-embed.ts`.

use super::embed::Embed;
use super::js_compat::{is_js_whitespace, js_trim};
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use url::Url;

/// Longest canonical generic embed URL we store or broadcast (ADR 0024 §1).
pub const MAX_GENERIC_EMBED_URL_LENGTH: usize = 1024;

/// An embed from any other site (ADR 0024). Not synced: every viewer plays it on their own.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GenericEmbed {
    host: String,
    url: String,
}

impl GenericEmbed {
    pub fn host(&self) -> &str {
        &self.host
    }
    pub fn url(&self) -> &str {
        &self.url
    }
}

impl Serialize for GenericEmbed {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_unit()
    }
}

impl<'de> Deserialize<'de> for GenericEmbed {
    fn deserialize<D: Deserializer<'de>>(_: D) -> Result<Self, D::Error> {
        Err(serde::de::Error::custom("stub"))
    }
}

/// What a room can show: a synced embed or a generic one. This is the wire type.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum AnyEmbed {
    Generic(GenericEmbed),
    Synced(Embed),
}

impl AnyEmbed {
    pub fn is_synced(&self) -> bool {
        false
    }
    pub fn url(&self) -> &str {
        ""
    }
}

pub fn is_public_dns_name(_host: &str) -> bool {
    false
}

pub fn canonicalize_generic_embed(_input: &str, _own_hosts: &[String]) -> Option<GenericEmbed> {
    None
}

#[derive(Debug, Clone, Copy)]
pub struct AnyEmbedOptions<'a> {
    /// The `GENERIC_EMBEDS` kill switch; false accepts the synced tier only.
    pub generic: bool,
    pub own_hosts: &'a [String],
}

pub fn canonicalize_any_embed(_input: &str, _opts: AnyEmbedOptions<'_>) -> Option<AnyEmbed> {
    None
}

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
