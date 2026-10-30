//! What the room can do with an embed's player (ADR 0014), mirroring `packages/shared/src/capabilities.ts`.

use super::embed::Embed;
use super::generic_embed::AnyEmbed;
use serde::Serialize;

/// "yes" settable; "probe" depends on the video (Vimeo owner plan); "no" never (Twitch).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum RateSupport {
    Yes,
    Probe,
    No,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct PlaybackCaps {
    /// Position can be set (false: Twitch live).
    pub seek: bool,
    /// Live stream: only playing/paused is shared; position is always 0.
    pub live: bool,
    pub rate: RateSupport,
}

static YOUTUBE: PlaybackCaps = PlaybackCaps {
    seek: true,
    live: false,
    rate: RateSupport::Yes,
};
static VIMEO: PlaybackCaps = PlaybackCaps {
    seek: true,
    live: false,
    rate: RateSupport::Probe,
};
static TWITCH_VOD: PlaybackCaps = PlaybackCaps {
    seek: true,
    live: false,
    rate: RateSupport::No,
};
static TWITCH_LIVE: PlaybackCaps = PlaybackCaps {
    seek: false,
    live: true,
    rate: RateSupport::No,
};

/// ADR 0057 §1: `HTMLMediaElement` through the extension. A live generic stream is detected on the client only.
static GENERIC: PlaybackCaps = PlaybackCaps {
    seek: true,
    live: false,
    rate: RateSupport::Yes,
};

/// Static capabilities of an embed. Pure; returns shared static objects.
pub fn playback_caps(embed: &Embed) -> &'static PlaybackCaps {
    match embed {
        Embed::Youtube(_) => &YOUTUBE,
        Embed::Vimeo(_) => &VIMEO,
        Embed::TwitchLive(_) => &TWITCH_LIVE,
        Embed::TwitchVod(_) => &TWITCH_VOD,
    }
}

/// `playbackCaps` over both tiers (ADR 0057 §1).
pub fn any_playback_caps(embed: &AnyEmbed) -> &'static PlaybackCaps {
    match embed {
        AnyEmbed::Synced(e) => playback_caps(e),
        AnyEmbed::Generic(_) => &GENERIC,
    }
}
