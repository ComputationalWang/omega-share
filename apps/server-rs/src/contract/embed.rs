//! Synced embeds (YouTube, Twitch, Vimeo), mirroring `packages/shared/src/embed.ts`.
//!
//! Embeds are canonicalised with the WHATWG URL parser (the `url` crate here, `new URL()` in Bun) and
//! stored; when rooms load, the canonical-url check below must accept what the TS server stored.

use super::Obj;
use super::constants::MAX_URL_LENGTH;
use super::js_compat::{js_trim, utf16_len};
use serde::ser::SerializeStruct;
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use url::Url;
use validator::{Validate, ValidationError, ValidationErrors};

const YOUTUBE_EMBED_BASE: &str = "https://www.youtube.com/embed/";
const TWITCH_PLAYER: &str = "https://player.twitch.tv/";
const VIMEO_PLAYER: &str = "https://player.vimeo.com/video/";
/// 11-char path segments YouTube uses for things that are not videos.
const RESERVED_YOUTUBE_IDS: [&str; 2] = ["videoseries", "live_stream"];
/// First path segments on twitch.tv that are pages, not channels.
const TWITCH_RESERVED: [&str; 25] = [
    "directory",
    "videos",
    "settings",
    "subscriptions",
    "inventory",
    "wallet",
    "drops",
    "turbo",
    "prime",
    "friends",
    "messages",
    "search",
    "downloads",
    "jobs",
    "p",
    "store",
    "login",
    "signup",
    "logout",
    "broadcast",
    "moderator",
    "popout",
    "embed",
    "following",
    "u",
];
const YOUTUBE_DOMAINS: [&str; 3] = ["youtube.com", "youtu.be", "youtube-nocookie.com"];
const TWITCH_DOMAINS: [&str; 1] = ["twitch.tv"];
const VIMEO_DOMAINS: [&str; 1] = ["vimeo.com"];

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct YoutubeEmbed {
    video_id: String,
    url: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TwitchLive {
    channel: String,
    url: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TwitchVod {
    video_id: String,
    url: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VimeoEmbed {
    video_id: String,
    hash: Option<String>,
    url: String,
}

/// A validated synced embed. The only constructors canonicalize or validate, and every `url` is
/// rebuilt from the ids, so it is safe as an iframe `src` (ADR 0003, ADR 0014).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Embed {
    Youtube(YoutubeEmbed),
    TwitchLive(TwitchLive),
    TwitchVod(TwitchVod),
    Vimeo(VimeoEmbed),
}

impl Embed {
    pub fn url(&self) -> &str {
        match self {
            Self::Youtube(e) => &e.url,
            Self::TwitchLive(e) => &e.url,
            Self::TwitchVod(e) => &e.url,
            Self::Vimeo(e) => &e.url,
        }
    }
}

// ---- ids (the `*Schema` regexes, hand-coded: `\d` and `\w` are ASCII in JS, Unicode in `regex`)

fn is_youtube_id(id: &str) -> bool {
    id.len() == 11 && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-') && !RESERVED_YOUTUBE_IDS.contains(&id)
}

fn is_twitch_login(s: &str) -> bool {
    (1..=25).contains(&s.len())
        && s.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_')
        && !TWITCH_RESERVED.contains(&s)
}

/// `^[1-9][0-9]{0,11}$`
fn is_numeric_id(s: &str) -> bool {
    (1..=12).contains(&s.len()) && s.bytes().all(|b| b.is_ascii_digit()) && !s.starts_with('0')
}

/// `^[0-9a-f]{6,32}$`
fn is_vimeo_hash(s: &str) -> bool {
    (6..=32).contains(&s.len()) && s.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

fn twitch_live_url(channel: &str) -> String {
    format!("{TWITCH_PLAYER}?channel={channel}")
}

fn twitch_vod_url(video_id: &str) -> String {
    format!("{TWITCH_PLAYER}?video=v{video_id}")
}

fn vimeo_url(id: &str, hash: Option<&str>) -> String {
    match hash {
        None => format!("{VIMEO_PLAYER}{id}"),
        Some(h) => format!("{VIMEO_PLAYER}{id}?h={h}"),
    }
}

// ---- serialization: the TS object literal's key order

impl Serialize for Embed {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        match self {
            Self::Youtube(e) => {
                let mut st = s.serialize_struct("Embed", 3)?;
                st.serialize_field("provider", "youtube")?;
                st.serialize_field("videoId", &e.video_id)?;
                st.serialize_field("url", &e.url)?;
                st.end()
            }
            Self::TwitchLive(e) => {
                let mut st = s.serialize_struct("Embed", 4)?;
                st.serialize_field("provider", "twitch")?;
                st.serialize_field("kind", "live")?;
                st.serialize_field("channel", &e.channel)?;
                st.serialize_field("url", &e.url)?;
                st.end()
            }
            Self::TwitchVod(e) => {
                let mut st = s.serialize_struct("Embed", 4)?;
                st.serialize_field("provider", "twitch")?;
                st.serialize_field("kind", "vod")?;
                st.serialize_field("videoId", &e.video_id)?;
                st.serialize_field("url", &e.url)?;
                st.end()
            }
            Self::Vimeo(e) => {
                let mut st = s.serialize_struct("Embed", 4)?;
                st.serialize_field("provider", "vimeo")?;
                st.serialize_field("videoId", &e.video_id)?;
                st.serialize_field("hash", &e.hash)?;
                st.serialize_field("url", &e.url)?;
                st.end()
            }
        }
    }
}

// ---- parsing (`EmbedSchema`): a plain `v.object`, so unknown keys are ignored and dropped

fn field_error(code: &'static str) -> ValidationError {
    ValidationError::new(code)
}

fn check_youtube_id(id: &str) -> Result<(), ValidationError> {
    if is_youtube_id(id) {
        Ok(())
    } else {
        Err(field_error("youtube_id"))
    }
}

fn check_twitch_login(s: &str) -> Result<(), ValidationError> {
    if is_twitch_login(s) {
        Ok(())
    } else {
        Err(field_error("twitch_login"))
    }
}

fn check_numeric_id(s: &str) -> Result<(), ValidationError> {
    if is_numeric_id(s) { Ok(()) } else { Err(field_error("numeric_id")) }
}

fn check_vimeo_hash(s: &str) -> Result<(), ValidationError> {
    if is_vimeo_hash(s) { Ok(()) } else { Err(field_error("vimeo_hash")) }
}

/// `v.nullable(...)` without `v.optional`: the key must be present, `null` allowed.
fn present_or_null<'de, D: Deserializer<'de>>(d: D) -> Result<Option<String>, D::Error> {
    Option::<String>::deserialize(d)
}

/// A string-only literal tag. serde's own `tag`/unit-enum matching also takes integer variant indices
/// (`"provider": 1` would pick the second variant), which Valibot's `v.literal` never does.
macro_rules! literal {
    ($name:ident, $text:literal) => {
        #[derive(Deserialize)]
        #[serde(try_from = "String")]
        pub(crate) struct $name;

        impl TryFrom<String> for $name {
            type Error = &'static str;

            fn try_from(v: String) -> Result<Self, Self::Error> {
                if v == $text {
                    Ok(Self)
                } else {
                    Err(concat!("expected the literal ", $text))
                }
            }
        }
    };
}
pub(crate) use literal;

literal!(YoutubeTag, "youtube");
literal!(TwitchTag, "twitch");
literal!(VimeoTag, "vimeo");
literal!(LiveTag, "live");
literal!(VodTag, "vod");

// Each variant is its own struct carrying its tags, tried in turn: the tags are disjoint, so this is
// `v.variant` (a wrong tag fails the whole embed, never falls through to a looser variant).
#[derive(Deserialize, Validate)]
struct YoutubeWire {
    #[allow(dead_code, reason = "only the literal is checked")]
    provider: YoutubeTag,
    #[serde(rename = "videoId")]
    #[validate(custom(function = "check_youtube_id"))]
    video_id: String,
    url: String,
}

#[derive(Deserialize, Validate)]
struct TwitchLiveWire {
    #[allow(dead_code, reason = "only the literal is checked")]
    provider: TwitchTag,
    #[allow(dead_code, reason = "only the literal is checked")]
    kind: LiveTag,
    #[validate(custom(function = "check_twitch_login"))]
    channel: String,
    url: String,
}

#[derive(Deserialize, Validate)]
struct TwitchVodWire {
    #[allow(dead_code, reason = "only the literal is checked")]
    provider: TwitchTag,
    #[allow(dead_code, reason = "only the literal is checked")]
    kind: VodTag,
    #[serde(rename = "videoId")]
    #[validate(custom(function = "check_numeric_id"))]
    video_id: String,
    url: String,
}

#[derive(Deserialize, Validate)]
struct VimeoWire {
    #[allow(dead_code, reason = "only the literal is checked")]
    provider: VimeoTag,
    #[serde(rename = "videoId")]
    #[validate(custom(function = "check_numeric_id"))]
    video_id: String,
    #[serde(deserialize_with = "present_or_null")]
    #[validate(custom(function = "check_vimeo_hash"))]
    hash: Option<String>,
    url: String,
}

#[derive(Deserialize)]
#[serde(untagged)]
enum EmbedWire {
    Youtube(YoutubeWire),
    TwitchLive(TwitchLiveWire),
    TwitchVod(TwitchVodWire),
    Vimeo(VimeoWire),
}

impl Validate for EmbedWire {
    fn validate(&self) -> Result<(), ValidationErrors> {
        match self {
            Self::Youtube(w) => w.validate(),
            Self::TwitchLive(w) => w.validate(),
            Self::TwitchVod(w) => w.validate(),
            Self::Vimeo(w) => w.validate(),
        }
    }
}

const NOT_CANONICAL: &str = "url is not the canonical embed url";

impl TryFrom<EmbedWire> for Embed {
    type Error = &'static str;

    fn try_from(wire: EmbedWire) -> Result<Self, Self::Error> {
        let embed = match wire {
            EmbedWire::Youtube(w) => (w.url == format!("{YOUTUBE_EMBED_BASE}{}", w.video_id)).then_some(Self::Youtube(YoutubeEmbed {
                video_id: w.video_id,
                url: w.url,
            })),
            EmbedWire::TwitchLive(w) => (w.url == twitch_live_url(&w.channel)).then_some(Self::TwitchLive(TwitchLive {
                channel: w.channel,
                url: w.url,
            })),
            EmbedWire::TwitchVod(w) => (w.url == twitch_vod_url(&w.video_id)).then_some(Self::TwitchVod(TwitchVod {
                video_id: w.video_id,
                url: w.url,
            })),
            EmbedWire::Vimeo(w) => (w.url == vimeo_url(&w.video_id, w.hash.as_deref())).then_some(Self::Vimeo(VimeoEmbed {
                video_id: w.video_id,
                hash: w.hash,
                url: w.url,
            })),
        };
        embed.ok_or(NOT_CANONICAL)
    }
}

impl<'de> Deserialize<'de> for Embed {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        use serde::de::Error;
        let Obj(wire) = Obj::<EmbedWire>::deserialize(d)?;
        wire.validate().map_err(D::Error::custom)?;
        Self::try_from(wire).map_err(D::Error::custom)
    }
}

// ---- hosts

/// `host === d || host.endsWith("." + d)`.
pub fn under_domain_of(host: &str, domain: &str) -> bool {
    host == domain || host.strip_suffix(domain).is_some_and(|rest| rest.ends_with('.'))
}

/// Host is `domain` or one of its subdomains.
pub fn under_domain(host: &str, domains: &[&str]) -> bool {
    domains.iter().any(|d| under_domain_of(host, d))
}

/// True when a synced provider owns `host` (`syncedProviderFor(host) !== undefined`): such a URL is
/// either its synced embed or nothing, never a generic embed.
pub fn is_synced_provider_host(host: &str) -> bool {
    under_domain(host, &YOUTUBE_DOMAINS) || under_domain(host, &TWITCH_DOMAINS) || under_domain(host, &VIMEO_DOMAINS)
}

// ---- canonicalization

/// The first steps `canonicalizeEmbed` and `canonicalizeGenericEmbed` share: the raw length cap in
/// UTF-16 units, JS `trim`, a WHATWG parse, and no userinfo or non-default port.
pub(crate) fn parse_plain_url(input: &str) -> Option<Url> {
    if utf16_len(input) > MAX_URL_LENGTH {
        return None;
    }
    let url = Url::parse(js_trim(input)).ok()?;
    let no_userinfo = url.username().is_empty() && url.password().is_none_or(str::is_empty);
    (no_userinfo && url.port().is_none()).then_some(url)
}

/// The values of query parameter `name`, decoded like `URLSearchParams.getAll`.
fn param_values<'a>(url: &'a Url, name: &'a str) -> impl Iterator<Item = std::borrow::Cow<'a, str>> {
    url.query_pairs().filter(move |(k, _)| k == name).map(|(_, v)| v)
}

/// The single value of `name`, or `None` if it is absent or repeated.
fn only_param(url: &Url, name: &str) -> Option<String> {
    let mut all = param_values(url, name);
    let first = all.next()?;
    all.next().is_none().then(|| first.into_owned())
}

fn has_param(url: &Url, name: &str) -> bool {
    param_values(url, name).next().is_some()
}

fn youtube_embed(url: &Url, host: &str) -> Option<Embed> {
    let path = url.path();
    let id: String = if host == "youtu.be" {
        path.strip_prefix('/')?.to_owned()
    } else if matches!(host, "youtube.com" | "www.youtube.com" | "m.youtube.com") && path == "/watch" {
        only_param(url, "v")?
    } else if matches!(
        host,
        "youtube.com" | "www.youtube.com" | "m.youtube.com" | "youtube-nocookie.com" | "www.youtube-nocookie.com"
    ) {
        path.strip_prefix("/embed/")?.to_owned()
    } else {
        return None;
    };
    is_youtube_id(&id).then(|| {
        Embed::Youtube(YoutubeEmbed {
            url: format!("{YOUTUBE_EMBED_BASE}{id}"),
            video_id: id,
        })
    })
}

/// Live channels and VODs only; clips and collections have no usable player API (ADR 0014).
fn twitch_embed(url: &Url, host: &str) -> Option<Embed> {
    let path = url.path();
    let (channel, video): (Option<String>, Option<String>) = if host == "player.twitch.tv" {
        if path != "/" || has_param(url, "collection") {
            return None;
        }
        let has_channel = has_param(url, "channel");
        if has_channel == has_param(url, "video") {
            return None; // neither, or ambiguous
        }
        if has_channel {
            (Some(only_param(url, "channel")?.to_lowercase()), None)
        } else {
            let video = only_param(url, "video")?;
            let id = match video.strip_prefix(['v', 'V']) {
                Some(rest) => rest.to_owned(),
                None => video,
            };
            (None, Some(id))
        }
    } else if matches!(host, "twitch.tv" | "www.twitch.tv" | "m.twitch.tv") {
        if let Some(id) = path.strip_prefix("/videos/").filter(|id| !id.is_empty() && !id.contains('/')) {
            (None, Some(id.to_owned()))
        } else {
            // `^/([^/]+)/?$`
            let rest = path.strip_prefix('/')?;
            let name = rest.strip_suffix('/').unwrap_or(rest);
            if name.is_empty() || name.contains('/') {
                return None;
            }
            (Some(name.to_lowercase()), None)
        }
    } else {
        return None;
    };
    match (channel, video) {
        (Some(channel), _) => is_twitch_login(&channel).then(|| {
            Embed::TwitchLive(TwitchLive {
                url: twitch_live_url(&channel),
                channel,
            })
        }),
        (None, Some(video_id)) => is_numeric_id(&video_id).then(|| {
            Embed::TwitchVod(TwitchVod {
                url: twitch_vod_url(&video_id),
                video_id,
            })
        }),
        (None, None) => None,
    }
}

fn all_digits(s: &str) -> bool {
    !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit())
}

/// The `VIMEO_SITE_PATHS` regexes: the video id and the unlisted hash, if the path names one video.
fn vimeo_site_path(path: &str) -> Option<(&str, Option<&str>)> {
    let segs: Vec<&str> = path.strip_prefix('/')?.split('/').collect();
    match segs.as_slice() {
        [id] if all_digits(id) => Some((id, None)),
        [id, hash] if all_digits(id) && !hash.is_empty() => Some((id, Some(hash))),
        ["channels", name, id] if !name.is_empty() && all_digits(id) => Some((id, None)),
        ["groups", name, "videos", id] if !name.is_empty() && all_digits(id) => Some((id, None)),
        ["album" | "showcase", name, "video", id] if !name.is_empty() && all_digits(id) => Some((id, None)),
        _ => None,
    }
}

/// Public and unlisted videos only; live events are rejected (ADR 0014).
fn vimeo_embed(url: &Url, host: &str) -> Option<Embed> {
    let path = url.path();
    let (id, hash): (&str, Option<String>) = if host == "player.vimeo.com" {
        let id = match path.strip_prefix("/video/") {
            Some(id) if all_digits(id) => id,
            _ => return None,
        };
        let hash = if has_param(url, "h") { Some(only_param(url, "h")?) } else { None };
        (id, hash)
    } else if matches!(host, "vimeo.com" | "www.vimeo.com") {
        let (id, hash) = vimeo_site_path(path)?;
        (id, hash.map(str::to_owned))
    } else {
        return None;
    };
    if !is_numeric_id(id) {
        return None;
    }
    let hash = match hash {
        None => None,
        Some(h) => {
            let lower = h.to_lowercase();
            if !is_vimeo_hash(&lower) {
                return None;
            }
            Some(lower)
        }
    };
    Some(Embed::Vimeo(VimeoEmbed {
        url: vimeo_url(id, hash.as_deref()),
        video_id: id.to_owned(),
        hash,
    }))
}

/// `canonicalizeEmbed`: a supported video URL as its canonical synced embed, or `None` if no synced
/// provider can play it. Pure; never panics.
pub fn canonicalize_embed(input: &str) -> Option<Embed> {
    let url = parse_plain_url(input)?;
    if !matches!(url.scheme(), "https" | "http") {
        return None;
    }
    let host = url.host_str()?;
    if under_domain(host, &YOUTUBE_DOMAINS) {
        youtube_embed(&url, host)
    } else if under_domain(host, &TWITCH_DOMAINS) {
        twitch_embed(&url, host)
    } else if under_domain(host, &VIMEO_DOMAINS) {
        vimeo_embed(&url, host)
    } else {
        None
    }
}
