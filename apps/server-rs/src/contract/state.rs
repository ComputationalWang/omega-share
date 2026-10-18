//! Room state the server builds and sends: `room.ts` (`MemberSchema`, `RoomStateSchema`),
//! `playback.ts`, `queue.ts` and `rooms-list.ts` (`RoomSummarySchema`), plus the small shared
//! primitives of the outbound side (`Position`, `PingId`, `ServerTime`, `EmoteKind`, ...).
//!
//! The server BUILDS these, so their fields are public and `Serialize` writes the key order of the
//! TS object literals (`Room.snapshot`, `Room.view`, `playback.ts`), optional keys omitted. Each
//! type also has a strict `Deserialize` (tests and the load generator read what the server wrote):
//! a JSON object only (never serde's array form), every schema rule re-checked.

use super::constants::{MAX_POSITION_S, MAX_ROOM_MEMBERS, PING_ID_MAX, PLAYBACK_RATE_MAX, PLAYBACK_RATE_MIN, QUEUE_MAX, SEAT_COUNT};
use super::generic_embed::AnyEmbed;
use super::ids::{MemberId, QueueItemId, RoomId};
use super::layout::RoomLayout;
use super::room::{Avatar, ControlPolicy, FloorCell, StandingSlot, Tint};
use super::text::{Nickname, RoomTitle};
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use std::collections::HashSet;

// ---- helpers shared by the outbound modules

/// `v.optional(X)`: absent is fine, `null` is not (serde's `Option` would read `null` as absent).
/// Pair with `#[serde(default)]`; with `Option<Option<_>>` this is `v.optional(v.nullable(X))`.
pub(crate) fn present<'de, D: Deserializer<'de>, T: Deserialize<'de>>(d: D) -> Result<Option<T>, D::Error> {
    T::deserialize(d).map(Some)
}

/// `v.nullable(X)`: the key must be there (serde's derive would otherwise make a missing `Option` key `None`).
pub(crate) fn nullable<'de, D: Deserializer<'de>, T: Deserialize<'de>>(d: D) -> Result<Option<T>, D::Error> {
    Option::<T>::deserialize(d)
}

/// `RoomLayoutSchema` for a field. `RoomLayout` has no `Deserialize` of its own (layout.rs belongs to
/// the S2c slice), so this reads the JSON value and hands its text to `RoomLayout::parse`: object only,
/// unknown keys stripped. Duplicate keys inside a layout collapse (test-only path; stricter on the wire
/// where `parse_json` reads them directly).
pub(crate) fn layout<'de, D: Deserializer<'de>>(d: D) -> Result<RoomLayout, D::Error> {
    use serde::de::Error;
    let value = serde_json::Value::deserialize(d)?;
    let bytes = serde_json::to_vec(&value).map_err(D::Error::custom)?;
    RoomLayout::parse(&bytes).map_err(D::Error::custom)
}

/// [`layout`] as `v.optional(RoomLayoutSchema)`.
pub(crate) fn layout_present<'de, D: Deserializer<'de>>(d: D) -> Result<Option<RoomLayout>, D::Error> {
    layout(d).map(Some)
}

/// `Number.prototype.toString` for a finite double: integers below 2^53 without a fraction (`-0` as
/// `0`); `1e21` and up, and below `1e-6`, in exponent form with an explicit sign (`1.5e+21`, `5e-7`);
/// everything else as the shortest round-trip digits, never in exponent form.
pub fn js_number_string(n: f64) -> String {
    if n == 0.0 {
        "0".to_owned()
    } else if n.fract() == 0.0 && n.abs() < 9_007_199_254_740_992.0 {
        format!("{}", n as i64)
    } else if n.abs() >= 1e21 || n.abs() < 1e-6 {
        let text = format!("{n:e}");
        match text.split_once('e') {
            Some((mantissa, exp)) if !exp.starts_with('-') => format!("{mantissa}e+{exp}"),
            _ => text,
        }
    } else {
        format!("{n}")
    }
}

/// Writes `n` as [`js_number_string`] does, so the bytes equal `JSON.stringify`'s.
pub(crate) fn js_number<S: Serializer>(n: f64, s: S) -> Result<S::Ok, S::Error> {
    use serde::ser::Error;
    serde_json::value::RawValue::from_string(js_number_string(n))
        .map_err(S::Error::custom)?
        .serialize(s)
}

/// A struct that `Serialize`s with the field order written here and `Deserialize`s strictly: through a
/// private wire struct (same fields, serde attributes shared), read from a JSON object only, then
/// `$check`ed. `Option` fields use `skip_serializing_if`, and `present`/`nullable` for the
/// optional / nullable distinction of Valibot.
macro_rules! wire_type {
    (
        $(#[$meta:meta])* $name:ident, $wire:ident, check = $check:expr,
        $(derive($($derive:ident),*),)?
        { $( $(#[$fm:meta])* $f:ident : $t:ty ),* $(,)? }
    ) => {
        $(#[$meta])*
        #[derive(Debug, Clone, PartialEq, serde::Serialize $(, $($derive),*)?)]
        #[serde(rename_all = "camelCase")]
        pub struct $name { $( $(#[$fm])* pub $f: $t ),* }

        #[derive(serde::Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct $wire { $( $(#[$fm])* $f: $t ),* }

        impl<'de> serde::Deserialize<'de> for $name {
            #[allow(unused_variables, reason = "a type without fields reads no field")]
            fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
                let $crate::contract::Obj(w) = $crate::contract::Obj::<$wire>::deserialize(d)?;
                let this = Self { $( $f: w.$f ),* };
                let check: fn(&Self) -> Result<(), &'static str> = $check;
                check(&this).map_err(serde::de::Error::custom)?;
                Ok(this)
            }
        }
    };
}
pub(crate) use wire_type;

pub(crate) fn always_ok<T>(_: &T) -> Result<(), &'static str> {
    Ok(())
}

// ---- numbers

/// Server time, ms since epoch: `ServerTimeSchema` (a non-negative integer).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct ServerTime(pub u64);

/// `rev`: +1 per accepted playback change.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct Rev(pub u64);

/// `PingIdSchema`: the id a client picks for a `ping`, an integer in `0..=PING_ID_MAX`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize)]
#[serde(transparent)]
pub struct PingId(u32);

impl PingId {
    pub fn new(n: u32) -> Option<Self> {
        (n <= PING_ID_MAX).then_some(Self(n))
    }
    pub fn get(self) -> u32 {
        self.0
    }
}

impl<'de> Deserialize<'de> for PingId {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        Self::new(u32::deserialize(d)?).ok_or_else(|| serde::de::Error::custom("invalid PingId"))
    }
}

/// `PositionSchema`: seconds into the video, finite, `0..=MAX_POSITION_S`.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Position(f64);

impl Position {
    /// The start of a video: `loadPlayback` and `restoredPlayback` write a literal `0`.
    pub const ZERO: Self = Self(0.0);

    pub fn new(s: f64) -> Option<Self> {
        (s.is_finite() && (0.0..=MAX_POSITION_S).contains(&s)).then_some(Self(s))
    }
    pub fn get(self) -> f64 {
        self.0
    }
}

impl Serialize for Position {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        js_number(self.0, s)
    }
}

impl<'de> Deserialize<'de> for Position {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        Self::new(f64::deserialize(d)?).ok_or_else(|| serde::de::Error::custom("invalid Position"))
    }
}

/// Playback rate: finite, `PLAYBACK_RATE_MIN..=PLAYBACK_RATE_MAX`.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Rate(f64);

impl Rate {
    /// Normal speed: the literal `1` every server-built playback state carries.
    pub const ONE: Self = Self(1.0);

    pub fn new(r: f64) -> Option<Self> {
        (r.is_finite() && (PLAYBACK_RATE_MIN..=PLAYBACK_RATE_MAX).contains(&r)).then_some(Self(r))
    }
    pub fn get(self) -> f64 {
        self.0
    }
}

impl Serialize for Rate {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        js_number(self.0, s)
    }
}

impl<'de> Deserialize<'de> for Rate {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        Self::new(f64::deserialize(d)?).ok_or_else(|| serde::de::Error::custom("invalid Rate"))
    }
}

// ---- picklists

/// Why the playback state last changed. `load` = a new embed started at 0.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PlaybackAction {
    Play,
    Pause,
    Seek,
    Load,
}

/// `EMOTE_KINDS`: bubbles in the motion atlas plus `wave`, `cheer`, `yawn` and `dance`. Sent by clients in
/// `emote` and echoed by the server in `emoted`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum EmoteKind {
    Clap,
    Exclaim,
    Heart,
    Laugh,
    Question,
    Wave,
    Cheer,
    Yawn,
    Dance,
}

// ---- playback, members, queue

wire_type!(
    /// The room's shared playback clock (ADR 0002, ADR 0011): `PlaybackStateSchema`.
    PlaybackState, PlaybackStateWire, check = always_ok,
    {
        playing: bool,
        position: Position,
        rate: Rate,
        at: ServerTime,
        rev: Rev,
        action: PlaybackAction,
        /// Who caused the change; `null` when it came from `POST /rooms/:id/share`.
        #[serde(deserialize_with = "nullable")]
        by: Option<MemberId>,
    }
);

wire_type!(
    /// A member as the room sees it (`Room.view`): key order `id, nickname, avatar, standingSlot`, then
    /// `catching`, `muted`, `away`, each only when true.
    Member, MemberWire, check = always_ok,
    {
        id: MemberId,
        nickname: Nickname,
        avatar: Avatar,
        #[serde(default, deserialize_with = "present", skip_serializing_if = "Option::is_none")]
        standing_slot: Option<StandingSlot>,
        #[serde(default, deserialize_with = "present", skip_serializing_if = "Option::is_none")]
        catching: Option<bool>,
        #[serde(default, deserialize_with = "present", skip_serializing_if = "Option::is_none")]
        muted: Option<bool>,
        #[serde(default, deserialize_with = "present", skip_serializing_if = "Option::is_none")]
        away: Option<bool>,
        /// Where they stand after a `walk` (ADR 0053); absent when seated or on their standing spot.
        #[serde(default, deserialize_with = "present", skip_serializing_if = "Option::is_none")]
        cell: Option<FloorCell>,
        /// Absent means 0.
        #[serde(default, deserialize_with = "present", skip_serializing_if = "Option::is_none")]
        tint: Option<Tint>,
    }
);

wire_type!(
    /// One upcoming item (ADR 0031): `QueueItemSchema`. `by` is `null` when the adder is unknown.
    QueueItem, QueueItemWire, check = always_ok,
    {
        id: QueueItemId,
        embed: AnyEmbed,
        #[serde(deserialize_with = "nullable")]
        by: Option<MemberId>,
    }
);

/// `QueueSchema`'s array rules: at most `QUEUE_MAX`, distinct ids.
pub fn queue_is_valid(queue: &[QueueItem]) -> bool {
    queue.len() <= QUEUE_MAX && queue.iter().map(|i| i.id.as_str()).collect::<HashSet<_>>().len() == queue.len()
}

/// `playbackMatchesEmbed`: playback exists only for a synced embed (`null` or absent otherwise).
pub fn playback_matches_embed(embed: Option<&AnyEmbed>, playback: Option<&Option<PlaybackState>>) -> bool {
    let has_playback = matches!(playback, Some(Some(_)));
    match embed {
        None => !has_playback,
        Some(e) => e.is_synced() || !has_playback,
    }
}

// ---- room state

wire_type!(
    /// `Room.snapshot()`: key order `id, seats, members, embed, playback, layout, controlPolicy`, then
    /// `title`, `itemId`, `queue` when present. `playback` is `Option<Option<_>>` like the schema's
    /// `optional(nullable(_))`: the server always sends `Some(None)` or `Some(Some(_))`; `None` (absent)
    /// only comes from a pre-M1b server and is read back as absent.
    RoomState, RoomStateWire, check = check_room_state,
    {
        id: RoomId,
        /// Always `SEAT_COUNT` long; `seats[i]` is the occupant or `None` (`null`).
        seats: Vec<Option<MemberId>>,
        members: Vec<Member>,
        #[serde(deserialize_with = "nullable")]
        embed: Option<AnyEmbed>,
        #[serde(default, deserialize_with = "present", skip_serializing_if = "Option::is_none")]
        playback: Option<Option<PlaybackState>>,
        #[serde(default, deserialize_with = "layout_present", skip_serializing_if = "Option::is_none")]
        layout: Option<RoomLayout>,
        #[serde(default, deserialize_with = "present", skip_serializing_if = "Option::is_none")]
        control_policy: Option<ControlPolicy>,
        #[serde(default, deserialize_with = "present", skip_serializing_if = "Option::is_none")]
        title: Option<RoomTitle>,
        #[serde(default, deserialize_with = "present", skip_serializing_if = "Option::is_none")]
        item_id: Option<QueueItemId>,
        #[serde(default, deserialize_with = "present", skip_serializing_if = "Option::is_none")]
        queue: Option<Vec<QueueItem>>,
    }
);

impl RoomState {
    /// The room as the server sends it: `playback` is `null` or a state, never absent (`Room.snapshot`
    /// always writes the key), and `layout` and `controlPolicy` are always there. `title`, `itemId` and
    /// `queue` are added with the `with_*` methods.
    pub fn new(
        id: RoomId,
        seats: Vec<Option<MemberId>>,
        members: Vec<Member>,
        embed: Option<AnyEmbed>,
        playback: Option<PlaybackState>,
        layout: RoomLayout,
        control_policy: ControlPolicy,
    ) -> Self {
        Self {
            id,
            seats,
            members,
            embed,
            playback: Some(playback),
            layout: Some(layout),
            control_policy: Some(control_policy),
            title: None,
            item_id: None,
            queue: None,
        }
    }

    /// `None` or an empty title sends no `title` key, like an untitled room.
    #[must_use]
    pub fn with_title(mut self, title: Option<RoomTitle>) -> Self {
        self.title = title;
        self
    }

    #[must_use]
    pub fn with_item_id(mut self, item_id: Option<QueueItemId>) -> Self {
        self.item_id = item_id;
        self
    }

    /// An empty queue sends no `queue` key (`snapshot()` only sets it when non-empty).
    #[must_use]
    pub fn with_queue(mut self, queue: Vec<QueueItem>) -> Self {
        self.queue = (!queue.is_empty()).then_some(queue);
        self
    }
}

/// The checks `RoomStateSchema` runs after the shape.
fn check_room_state(r: &RoomState) -> Result<(), &'static str> {
    if r.seats.len() != SEAT_COUNT {
        return Err("seats must be SEAT_COUNT long");
    }
    if r.members.len() > MAX_ROOM_MEMBERS {
        return Err("too many members");
    }
    if r.queue.as_deref().is_some_and(|q| !queue_is_valid(q)) {
        return Err("invalid queue");
    }
    if let Some(item) = &r.item_id {
        if r.embed.is_none() {
            return Err("item id without an embed");
        }
        if r.queue.as_deref().unwrap_or_default().iter().any(|i| i.id == *item) {
            return Err("current item also queued");
        }
    }
    if !playback_matches_embed(r.embed.as_ref(), r.playback.as_ref()) {
        return Err("playback without a synced embed");
    }
    let ids: HashSet<&str> = r.members.iter().map(|m| m.id.as_str()).collect();
    if ids.len() != r.members.len() {
        return Err("duplicate member id");
    }
    let mut slots = 0u32;
    for slot in r.members.iter().filter_map(|m| m.standing_slot) {
        let bit = 1u32 << slot.get(); // MAX_ROOM_MEMBERS is 25: every slot fits a 32-bit mask
        if slots & bit != 0 {
            return Err("duplicate standing slot");
        }
        slots |= bit;
    }
    let seated: Vec<&str> = r.seats.iter().flatten().map(MemberId::as_str).collect();
    if seated.iter().collect::<HashSet<_>>().len() != seated.len() || !seated.iter().all(|s| ids.contains(s)) {
        return Err("seat occupants must be distinct members");
    }
    Ok(())
}

wire_type!(
    /// One row of `GET /rooms`: `RoomSummarySchema`. `title` is absent for an untitled room.
    RoomSummary, RoomSummaryWire, check = check_room_summary,
    {
        id: RoomId,
        member_count: u8,
        seated_count: u8,
        #[serde(default, deserialize_with = "present", skip_serializing_if = "Option::is_none")]
        title: Option<RoomTitle>,
    }
);

fn check_room_summary(r: &RoomSummary) -> Result<(), &'static str> {
    if usize::from(r.member_count) > MAX_ROOM_MEMBERS || usize::from(r.seated_count) > SEAT_COUNT {
        return Err("count out of range");
    }
    if r.seated_count > r.member_count {
        return Err("more seated than members");
    }
    Ok(())
}
