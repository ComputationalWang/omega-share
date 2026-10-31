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

/// All preset layouts, parsed once at startup: a bad asset fails the boot, not a creation.
#[derive(Debug, Clone)]
pub struct Presets {
    classic: RoomLayout,
    cinema: RoomLayout,
    living: RoomLayout,
    lounge: RoomLayout,
    cafe: RoomLayout,
    bar: RoomLayout,
    empty: RoomLayout,
    dank_dungeon: RoomLayout,
}

impl Presets {
    pub fn load() -> Result<Self, PresetError> {
        Self::from_assets(|id| match id {
            RoomPresetId::Classic => include_str!("../../../assets/presets/classic.json"),
            RoomPresetId::Cinema => include_str!("../../../assets/presets/cinema.json"),
            RoomPresetId::Living => include_str!("../../../assets/presets/living.json"),
            RoomPresetId::Lounge => include_str!("../../../assets/presets/lounge.json"),
            RoomPresetId::Cafe => include_str!("../../../assets/presets/cafe.json"),
            RoomPresetId::Bar => include_str!("../../../assets/presets/bar.json"),
            RoomPresetId::Empty => include_str!("../../../assets/presets/empty.json"),
            RoomPresetId::DankDungeon => include_str!("../../../assets/presets/dank-dungeon.json"),
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
            bar: parse(RoomPresetId::Bar)?,
            empty: parse(RoomPresetId::Empty)?,
            dank_dungeon: parse(RoomPresetId::DankDungeon)?,
        })
    }

    pub const fn preset_layout(&self, id: RoomPresetId) -> &RoomLayout {
        match id {
            RoomPresetId::Classic => &self.classic,
            RoomPresetId::Cinema => &self.cinema,
            RoomPresetId::Living => &self.living,
            RoomPresetId::Lounge => &self.lounge,
            RoomPresetId::Cafe => &self.cafe,
            RoomPresetId::Bar => &self.bar,
            RoomPresetId::Empty => &self.empty,
            RoomPresetId::DankDungeon => &self.dank_dungeon,
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

    // assets/src/presets.test.ts (OME-1672): only the dank-dungeon preset turns the pair emote on, under the night mood
    #[test]
    fn only_dank_dungeon_has_pairs() {
        let presets = Presets::load().unwrap();
        for id in ROOM_PRESET_IDS {
            assert_eq!(presets.preset_layout(id).pairs(), id.as_str() == "dank-dungeon", "{}", id.as_str());
            // OME-1989: and only it wears the dungeon shell.
            assert_eq!(
                presets.preset_layout(id).to_json().contains(r#""shell":"dungeon""#),
                id.as_str() == "dank-dungeon",
                "{}",
                id.as_str()
            );
        }
        let l = presets.preset_layout(ROOM_PRESET_IDS[7]);
        assert!(l.to_json().contains(r#""mood":"night""#));
    }

    // assets/src/presets.test.ts (OME-2071, ADR 0058): wave 2 hangs the screen on a wall in four revamps, the lounge pulls a
    // projector screen down, and the two swap rooms wear their own shells.
    #[test]
    fn wave2_screens_and_shells() {
        let presets = Presets::load().unwrap();
        let screen = |id: &str| match id {
            "living" | "cafe" | "bar" | "penthouse" | "studio" => "wallscreen",
            "lounge" => "projector",
            "cinema" => "bigscreen",
            _ => "tv",
        };
        for (want, shell) in [("penthouse", "penthouse"), ("studio", "studio")] {
            let id = ROOM_PRESET_IDS.into_iter().find(|i| i.as_str() == want);
            let json = id.map(|i| presets.preset_layout(i).to_json()).unwrap_or_default();
            assert!(json.contains(&format!(r#""shell":"{shell}""#)), "{want}");
        }
        for id in ROOM_PRESET_IDS {
            let json = presets.preset_layout(id).to_json();
            for kind in ["tv", "bigscreen", "wallscreen", "projector"] {
                let has = json.contains(&format!(r#""kind":"{kind}""#));
                assert_eq!(has, screen(id.as_str()) == kind, "{} {kind}", id.as_str());
            }
        }
    }

    #[test]
    fn a_bad_asset_fails_the_load_naming_the_file() {
        let err = Presets::from_assets(|id| {
            if id == RoomPresetId::Lounge {
                r#"{"furniture":[]}"#
            } else {
                include_str!("../../../assets/presets/classic.json")
            }
        })
        .unwrap_err();
        assert_eq!(err.to_string(), "assets/presets/lounge.json is not a valid room layout");
    }
}
