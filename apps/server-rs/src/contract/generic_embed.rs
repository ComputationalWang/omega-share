//! Generic embeds (ADR 0024), mirroring `packages/shared/src/generic-embed.ts`.

use super::Obj;
use super::embed::{Embed, canonicalize_embed, is_synced_provider_host, literal, parse_plain_url, under_domain, under_domain_of};
use super::js_compat::{is_js_whitespace, js_trim, utf16_len};
use serde::ser::SerializeStruct;
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use url::Url;
use validator::{Validate, ValidationError};

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
        let mut st = s.serialize_struct("GenericEmbed", 3)?;
        st.serialize_field("provider", "generic")?;
        st.serialize_field("host", &self.host)?;
        st.serialize_field("url", &self.url)?;
        st.end()
    }
}

literal!(GenericTag, "generic");

fn check_url_length(url: &str) -> Result<(), ValidationError> {
    if utf16_len(url) <= MAX_GENERIC_EMBED_URL_LENGTH {
        Ok(())
    } else {
        Err(ValidationError::new("max_length"))
    }
}

/// `GenericEmbedSchema`: a plain `v.object` (unknown keys dropped) plus the canonical check.
#[derive(Deserialize, Validate)]
struct GenericWire {
    #[allow(dead_code, reason = "only the literal is checked")]
    provider: GenericTag,
    host: String,
    #[validate(custom(function = "check_url_length"))]
    url: String,
}

impl<'de> Deserialize<'de> for GenericEmbed {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        use serde::de::Error;
        let Obj(wire) = Obj::<GenericWire>::deserialize(d)?;
        wire.validate().map_err(D::Error::custom)?;
        match canonicalize_generic_embed(&wire.url, &[]) {
            Some(c) if c.url == wire.url && c.host == wire.host => Ok(c),
            _ => Err(D::Error::custom("url is not a canonical generic embed url")),
        }
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
    /// `isSyncedEmbed`: true for the synced tier (YouTube, Twitch, Vimeo).
    pub fn is_synced(&self) -> bool {
        matches!(self, Self::Synced(_))
    }

    pub fn url(&self) -> &str {
        match self {
            Self::Generic(e) => e.url(),
            Self::Synced(e) => e.url(),
        }
    }
}

/// Hostname label: 1-63 of `[a-z0-9-]`, no hyphen at either end (the TS lookarounds, by hand).
fn is_dns_label(l: &str) -> bool {
    (1..=63).contains(&l.len())
        && l.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
        && !l.starts_with('-')
        && !l.ends_with('-')
}

/// Last label must be alphabetic or punycode: `^(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$`. The URL parser turns
/// any host whose last label is numeric (or hex) into a dotted IPv4 address, so this also rejects every IPv4
/// literal; IPv6 literals fail the label rule on `[`.
fn is_tld(l: &str) -> bool {
    let alpha = (2..=63).contains(&l.len()) && l.bytes().all(|b| b.is_ascii_lowercase());
    let puny = l
        .strip_prefix("xn--")
        .is_some_and(|r| (1..=59).contains(&r.len()) && r.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-'));
    alpha || puny
}

/// Special-use, reserved and private-network names: they never resolve publicly, or only inside someone's network.
const PRIVATE_SUFFIXES: [&str; 14] = [
    "localhost",
    "local",
    "internal",
    "localdomain",
    "lan",
    "home",
    "corp",
    "intranet",
    "arpa",
    "test",
    "example",
    "invalid",
    "onion",
    "alt",
];
/// Public wildcard DNS that answers with loopback or with an IP spelled in the name.
const IP_IN_DNS_DOMAINS: [&str; 8] = [
    "localtest.me",
    "lvh.me",
    "vcap.me",
    "localhost.direct",
    "nip.io",
    "sslip.io",
    "xip.io",
    "traefik.me",
];

pub fn is_public_dns_name(host: &str) -> bool {
    if utf16_len(host) > 253 {
        return false;
    }
    let mut count = 0usize;
    let mut last = "";
    for l in host.split('.') {
        if !is_dns_label(l) {
            return false;
        }
        count += 1;
        last = l;
    }
    count >= 2 && is_tld(last) && !under_domain(host, &PRIVATE_SUFFIXES) && !under_domain(host, &IP_IN_DNS_DOMAINS)
}

/// `canonicalizeGenericEmbed`: `https:` only, no userinfo, default port, a public DNS name (no IP literal, no
/// private or special-use name), not one of `own_hosts` and not a synced provider's host. Pure; never panics.
pub fn canonicalize_generic_embed(input: &str, own_hosts: &[String]) -> Option<GenericEmbed> {
    let url = parse_plain_url(input)?;
    if url.scheme() != "https" {
        return None;
    }
    let host = url.host_str()?;
    if !is_public_dns_name(host) || is_synced_provider_host(host) {
        return None;
    }
    if own_hosts
        .iter()
        .filter_map(|h| normalize_hostname(h))
        .any(|own| under_domain_of(host, &own))
    {
        return None;
    }
    let host = host.to_owned();
    let mut url = url;
    // Bun (WebKit) percent-encodes `^` in a path, the `url` crate leaves it; the stored form is Bun's, and
    // the TS server re-canonicalizes stored rows at boot, so a `^` here would be refused after a rollback.
    if url.path().contains('^') {
        let path = url.path().replace('^', "%5E");
        url.set_path(&path);
    }
    let href = url.as_str();
    if utf16_len(href) > MAX_GENERIC_EMBED_URL_LENGTH {
        return None;
    }
    Some(GenericEmbed {
        host,
        url: href.to_owned(),
    })
}

#[derive(Debug, Clone, Copy)]
pub struct AnyEmbedOptions<'a> {
    /// The `GENERIC_EMBEDS` kill switch; false accepts the synced tier only.
    pub generic: bool,
    pub own_hosts: &'a [String],
}

/// `canonicalizeAnyEmbed`, the share path: a synced provider's URL becomes its synced embed or nothing; any
/// other URL becomes a generic embed when `generic` is on.
pub fn canonicalize_any_embed(input: &str, opts: AnyEmbedOptions<'_>) -> Option<AnyEmbed> {
    if let Some(synced) = canonicalize_embed(input) {
        return Some(AnyEmbed::Synced(synced));
    }
    if opts.generic {
        canonicalize_generic_embed(input, opts.own_hosts).map(AnyEmbed::Generic)
    } else {
        None
    }
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
