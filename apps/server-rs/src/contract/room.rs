//! Small room primitives from `room.ts` and `room-ownership.ts`. Members, room state, presets and
//! messages belong to later slices.

use super::constants::{AVATAR_COUNT, MAX_ROOM_MEMBERS, SEAT_COUNT};
use serde::{Deserialize, Serialize};

/// A bounded index: a JSON integer in `0..count`. Floats, strings and negatives are refused.
macro_rules! bounded_index {
    ($(#[$meta:meta])* $name:ident, $count:expr) => {
        $(#[$meta])*
        #[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize)]
        pub struct $name(u8);

        impl $name {
            pub fn new(n: u64) -> Option<Self> {
                u8::try_from(n).ok().filter(|v| usize::from(*v) < $count).map(Self)
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
