//! Small room primitives from `room.ts` and `room-ownership.ts`. Members, room state, presets and
//! messages belong to later slices.

use super::Obj;
use super::constants::{
    ACCESSORY_COUNT, AVATAR_COUNT, DICE_MAX_SIDES, DICE_MIN_SIDES, FLOOR_CELLS, HAIR_COUNT, MAX_ROOM_MEMBERS, POLL_MAX_OPTIONS, QUEUE_MAX,
    SEAT_COUNT, TINT_COUNT,
};
use serde::{Deserialize, Serialize};

/// A bounded index: a JSON integer in `0..count` (or `min..count`). Floats, strings and negatives are refused.
macro_rules! bounded_index {
    ($(#[$meta:meta])* $name:ident, $count:expr) => {
        bounded_index!($(#[$meta])* $name, 0, $count);
    };
    ($(#[$meta:meta])* $name:ident, $min:expr, $count:expr) => {
        $(#[$meta])*
        #[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize)]
        pub struct $name(u8);

        impl $name {
            pub fn new(n: u64) -> Option<Self> {
                u8::try_from(n).ok().filter(|v| ($min..$count).contains(&usize::from(*v))).map(Self)
            }

            pub fn get(self) -> u8 {
                self.0
            }
        }

        impl<'de> Deserialize<'de> for $name {
            fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
                let n = u64::deserialize(deserializer)?;
                Self::new(n).ok_or_else(|| serde::de::Error::custom(concat!("invalid ", stringify!($name))))
            }
        }
    };
}

bounded_index!(
    /// `AvatarSchema`: an integer in `0..AVATAR_COUNT`.
    Avatar,
    AVATAR_COUNT
);
bounded_index!(
    /// `SeatIndexSchema`: an integer in `0..SEAT_COUNT`.
    SeatIndex,
    SEAT_COUNT
);
bounded_index!(
    /// `StandingSlotSchema`: an integer in `0..MAX_ROOM_MEMBERS`.
    StandingSlot,
    MAX_ROOM_MEMBERS
);
bounded_index!(
    /// `QueueIndexSchema`: a place in the queue, an integer in `0..QUEUE_MAX`.
    QueueIndex,
    QUEUE_MAX
);

bounded_index!(
    /// `TintSchema`: a shirt tint, an integer in `0..TINT_COUNT`; 0 is the avatar's own colours (ADR 0053).
    Tint,
    TINT_COUNT
);
bounded_index!(
    /// `AccessorySchema`: an avatar accessory, an integer in `0..ACCESSORY_COUNT`; 0 is none (OME-1387).
    Accessory,
    ACCESSORY_COUNT
);
bounded_index!(
    /// `HairSchema`: a hair colour, an integer in `0..HAIR_COUNT`; 0 is the avatar's own (OME-1435).
    Hair,
    HAIR_COUNT
);
bounded_index!(
    /// `DiceSidesSchema`: a die's faces, an integer in `DICE_MIN_SIDES..=DICE_MAX_SIDES` (OME-1423).
    DiceSides,
    usize::from(DICE_MIN_SIDES),
    usize::from(DICE_MAX_SIDES) + 1
);
bounded_index!(
    /// A rolled face, `1..=DICE_MAX_SIDES`; `rolled` also checks it is at most its `sides`.
    DieValue,
    1,
    usize::from(DICE_MAX_SIDES) + 1
);
bounded_index!(
    /// `PollOptionIndexSchema`: an index into a poll's options, `0..POLL_MAX_OPTIONS` (OME-1452).
    PollOptionIndex,
    POLL_MAX_OPTIONS
);
bounded_index!(
    /// A poll option's vote count, `0..=MAX_ROOM_MEMBERS`.
    PollCount,
    MAX_ROOM_MEMBERS + 1
);
bounded_index!(
    /// One coordinate of a floor cell: an integer in `0..FLOOR_CELLS`.
    FloorCoord,
    FLOOR_CELLS
);

/// `FloorCellSchema`: column `x`, row `y` (ADR 0053). Read as an object only; unknown keys are stripped.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize)]
pub struct FloorCell {
    pub x: FloorCoord,
    pub y: FloorCoord,
}

impl FloorCell {
    pub fn new(x: u64, y: u64) -> Option<Self> {
        Some(Self {
            x: FloorCoord::new(x)?,
            y: FloorCoord::new(y)?,
        })
    }
}

#[derive(Deserialize)]
struct LooseCell {
    x: FloorCoord,
    y: FloorCoord,
}

impl<'de> Deserialize<'de> for FloorCell {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let Obj(LooseCell { x, y }) = Obj::deserialize(deserializer)?;
        Ok(Self { x, y })
    }
}

/// `FloorCellInputSchema` (`walk`): the same, but unknown keys are refused. Read it through `Obj`.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FloorCellInput {
    x: FloorCoord,
    y: FloorCoord,
}

impl From<FloorCellInput> for FloorCell {
    fn from(c: FloorCellInput) -> Self {
        Self { x: c.x, y: c.y }
    }
}

/// Who may send `control` frames and shares (ADR 0030).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ControlPolicy {
    Everyone,
    Owner,
}

/// Today's behaviour: anyone in the room controls playback.
pub const DEFAULT_CONTROL_POLICY: ControlPolicy = ControlPolicy::Everyone;

/// Fixed at creation: private rooms are never listed and need an invite key.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RoomVisibility {
    Public,
    Private,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ok<'a, T: Deserialize<'a>>(raw: &'a str) -> bool {
        serde_json::from_str::<T>(raw).is_ok()
    }

    #[test]
    fn indexes_are_bounded_integers() {
        // packages/shared/src/room.ts:78-96 (AvatarSchema, SeatIndexSchema, StandingSlotSchema)
        assert!(ok::<Avatar>("0") && ok::<Avatar>("3"));
        assert!(!ok::<Avatar>("4") && !ok::<Avatar>("-1") && !ok::<Avatar>("1.5") && !ok::<Avatar>("\"1\"") && !ok::<Avatar>("null"));
        assert!(ok::<SeatIndex>("7") && !ok::<SeatIndex>("8"));
        assert!(ok::<StandingSlot>("24") && !ok::<StandingSlot>("25") && !ok::<StandingSlot>("256"));
        assert_eq!(serde_json::from_str::<Avatar>("2").map(Avatar::get).ok(), Some(2));
        assert_eq!(serde_json::to_string(&SeatIndex::new(5)).unwrap(), "5");
        assert!(SeatIndex::new(u64::MAX).is_none());
    }

    #[test]
    fn picklists_are_exact_lowercase_words() {
        assert!(ok::<ControlPolicy>("\"everyone\"") && ok::<ControlPolicy>("\"owner\""));
        assert!(!ok::<ControlPolicy>("\"Owner\"") && !ok::<ControlPolicy>("\"\"") && !ok::<ControlPolicy>("0"));
        assert!(ok::<RoomVisibility>("\"public\"") && ok::<RoomVisibility>("\"private\""));
        assert!(!ok::<RoomVisibility>("\"secret\""));
        assert_eq!(DEFAULT_CONTROL_POLICY, ControlPolicy::Everyone);
        assert_eq!(serde_json::to_string(&RoomVisibility::Private).unwrap(), "\"private\"");
    }
}
