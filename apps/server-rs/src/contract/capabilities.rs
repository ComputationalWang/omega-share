//! What the room can do with an embed's player (ADR 0014), mirroring `packages/shared/src/capabilities.ts`.

use super::embed::Embed;
use serde::Serialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum RateSupport {
    Yes,
    Probe,
    No,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct PlaybackCaps {
    pub seek: bool,
    pub live: bool,
    pub rate: RateSupport,
}

pub fn playback_caps(_embed: &Embed) -> &'static PlaybackCaps {
    static STUB: PlaybackCaps = PlaybackCaps {
        seek: false,
        live: false,
        rate: RateSupport::No,
    };
    &STUB
}
