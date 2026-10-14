//! Synced embeds (YouTube, Twitch, Vimeo), mirroring `packages/shared/src/embed.ts`.

use serde::{Deserialize, Deserializer, Serialize, Serializer};

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
        ""
    }
}

impl Serialize for Embed {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_unit()
    }
}

impl<'de> Deserialize<'de> for Embed {
    fn deserialize<D: Deserializer<'de>>(_: D) -> Result<Self, D::Error> {
        Err(serde::de::Error::custom("stub"))
    }
}

/// Host is `domain` or one of its subdomains.
pub fn under_domain(_host: &str, _domains: &[&str]) -> bool {
    false
}

/// True when a synced provider owns `host` (`syncedProviderFor(host) !== undefined`).
pub fn is_synced_provider_host(_host: &str) -> bool {
    false
}

/// `canonicalizeEmbed`: a supported video URL as its canonical synced embed.
pub fn canonicalize_embed(_input: &str) -> Option<Embed> {
    None
}
