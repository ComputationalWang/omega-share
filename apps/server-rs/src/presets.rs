//! The judged D1 room presets (OME-906, CC BY-SA 4.0, `assets/presets`), mirroring
//! `apps/server/src/presets.ts`. A created room starts from the layout of the preset id it names;
//! the id is checked by the create-room request, never a layout from the request.

use crate::contract::layout::{RoomLayout, RoomPresetId};
use std::fmt;

/// A preset asset that is not a valid room layout. Names the file, never the content.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PresetError {
    pub id: RoomPresetId,
}

impl fmt::Display for PresetError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "assets/presets/{}.json is not a valid room layout", self.id.as_str())
    }
}

impl std::error::Error for PresetError {}

/// All six preset layouts, parsed once at startup: a bad asset fails the boot, not a creation.
#[derive(Debug, Clone)]
pub struct Presets {
    classic: RoomLayout,
    cinema: RoomLayout,
    living: RoomLayout,
    lounge: RoomLayout,
    cafe: RoomLayout,
    empty: RoomLayout,
}

impl Presets {
    pub fn load() -> Result<Self, PresetError> {
        Self::from_assets(|id| match id {
            RoomPresetId::Classic => include_str!("../../../assets/presets/classic.json"),
            RoomPresetId::Cinema => include_str!("../../../assets/presets/cinema.json"),
            RoomPresetId::Living => include_str!("../../../assets/presets/living.json"),
            RoomPresetId::Lounge => include_str!("../../../assets/presets/lounge.json"),
            RoomPresetId::Cafe => include_str!("../../../assets/presets/cafe.json"),
            RoomPresetId::Empty => include_str!("../../../assets/presets/empty.json"),
        })
    }

    /// `load` with the asset text injected, so a test can feed it a bad file.
    fn from_assets(asset: impl Fn(RoomPresetId) -> &'static str) -> Result<Self, PresetError> {
        let parse = |id| RoomLayout::parse(asset(id).as_bytes()).map_err(|_| PresetError { id });
        Ok(Self {
            classic: parse(RoomPresetId::Classic)?,
            cinema: parse(RoomPresetId::Cinema)?,
            living: parse(RoomPresetId::Living)?,
            lounge: parse(RoomPresetId::Lounge)?,
            cafe: parse(RoomPresetId::Cafe)?,
            empty: parse(RoomPresetId::Empty)?,
        })
    }

    pub const fn preset_layout(&self, id: RoomPresetId) -> &RoomLayout {
        match id {
            RoomPresetId::Classic => &self.classic,
            RoomPresetId::Cinema => &self.cinema,
            RoomPresetId::Living => &self.living,
            RoomPresetId::Lounge => &self.lounge,
            RoomPresetId::Cafe => &self.cafe,
            RoomPresetId::Empty => &self.empty,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::contract::layout::{DEFAULT_ROOM_PRESET, ROOM_PRESET_IDS, default_layout};

    // apps/server/test/room-create.test.ts:133 the default preset is DEFAULT_LAYOUT
    #[test]
    fn the_default_preset_is_the_default_layout() {
        let presets = Presets::load().unwrap();
        assert_eq!(presets.preset_layout(DEFAULT_ROOM_PRESET), &default_layout());
    }

    #[test]
    fn every_preset_loads_seats_eight_and_round_trips_its_canonical_json() {
        let presets = Presets::load().unwrap();
        for id in ROOM_PRESET_IDS {
            let l = presets.preset_layout(id);
            assert_eq!(l.seats().len(), 8, "{}", id.as_str());
            assert_eq!(RoomLayout::parse_input(l.to_json().as_bytes()).as_ref(), Ok(l), "{}", id.as_str());
        }
    }

    #[test]
    fn a_bad_asset_fails_the_load_naming_the_file() {
        let err = Presets::from_assets(|id| if id == RoomPresetId::Lounge { r#"{"furniture":[]}"# } else { include_str!("../../../assets/presets/classic.json") }).unwrap_err();
        assert_eq!(err.to_string(), "assets/presets/lounge.json is not a valid room layout");
    }
}
