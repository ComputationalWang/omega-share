//! Port of `apps/server/src/room.ts`: one in-memory room, pure. No IO, no clock reads: every method that
//! reads `Date.now()` in TS takes `now_wall` (Unix ms) instead, and `item_since` is on the caller's monotonic
//! clock. Randomness is only for ids (OS CSPRNG, `secrets.rs`) and returns `Err` on entropy failure.
//!
//! Layout for speed: members live in a fixed array indexed by their standing slot (a member's slot is
//! unique and stable while they are in the room), found by id through one hash map; `order` keeps join order
//! (a JS `Map`'s insertion order, which snapshots expose). Seats hold slot indices and the flags live in the
//! member's record: no per-member sets, no string clones on the relay path.

use crate::contract::confusables::nickname_key;
use crate::contract::constants::{MAX_ROOM_MEMBERS, MUTE_MEMORY_MS, SEAT_COUNT};
use crate::contract::generic_embed::AnyEmbed;
use crate::contract::ids::{MemberId, QueueItemId, RoomId};
use crate::contract::layout::{RoomLayout, default_layout, door_cell};
use crate::contract::room::{
    Accessory, Avatar, ControlPolicy, DEFAULT_CONTROL_POLICY, FloorCell, Hair, RoomVisibility, SeatIndex, StandingSlot, Tint,
};
use crate::contract::state::{Member, PlaybackState, QueueItem, RoomState, RoomSummary};
use crate::contract::text::{Nickname, RoomTitle};
use crate::playback::{Control, apply_control, load_playback, restored_playback};
use crate::secrets::{EntropyError, hash_secret, mint_item_id, mint_member_id, secret_matches};
use std::collections::{HashMap, VecDeque};

/// Joined members one client key may hold in a room (threat model 6, room squatting). Pending the
/// board's answer to B2 on OME-183: real groups behind one NAT share a key.
pub const MAX_MEMBERS_PER_CLIENT: usize = 5;

/// How long after a restart a seat waits for its member to rejoin under the same name (OME-504, ADR 0032).
pub const SEAT_HOLD_MS: i64 = 30_000;

/// A seated member's name, as SHA-256 of its `nicknameKey`, and seat: what a graceful restart keeps (ADR 0032).
#[derive(Clone, Copy, PartialEq, Eq)]
pub struct HeldSeat {
    pub name_hash: [u8; 32],
    pub seat: SeatIndex,
}

/// The seat only: a name hash identifies a person across restarts (ADR 0032, "name hashes only", on disk and nowhere else).
impl std::fmt::Debug for HeldSeat {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("HeldSeat").field("seat", &self.seat.get()).finish_non_exhaustive()
    }
}

/// Why a join was refused.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum JoinFailure {
    RoomFull,
    TooManyMembers,
    NicknameTaken,
}

/// `SitResult`, plus `NotMember` (TS would seat any string; the relay only passes members).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SitResult {
    Ok,
    SeatTaken,
    NotMember,
}

/// What `Room::walk` did (ADR 0053).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WalkResult {
    /// `stood_up`: they were seated, and that seat is free now.
    Walked {
        stood_up: bool,
    },
    /// A solid piece (seats included) covers the cell.
    Blocked,
    NotMember,
}

/// What `Room::set_embed` changed besides the embed.
#[derive(Debug, Clone, PartialEq)]
pub struct EmbedSwitch {
    pub playback: Option<PlaybackState>,
    /// Members the room must now be told are not catching, in the order they were announced.
    pub uncaught: Vec<MemberId>,
}

/// The item `Room::advance` made current, and the embed switch that came with it.
#[derive(Debug, Clone, PartialEq)]
pub struct Advance {
    pub item: QueueItem,
    pub embed_switch: EmbedSwitch,
}

/// The optional constructor fields of `new Room(id, init)`. Without the ADR 0028 fields the room is a seed:
/// pinned, public, ownerless.
#[derive(Clone, Default)]
pub struct RoomInit {
    pub layout: Option<RoomLayout>,
    /// The last embed shared before a restart: it comes back paused at 0.
    pub embed: Option<AnyEmbed>,
    /// `None` for a seeded room without one.
    pub title: Option<RoomTitle>,
    pub visibility: Option<RoomVisibility>,
    pub pinned: Option<bool>,
    /// Unix ms; defaults to `now_wall`.
    pub created_at: Option<i64>,
    /// SHA-256 of the owner token.
    pub owner_hash: Option<[u8; 32]>,
    pub invite_hash: Option<[u8; 32]>,
    pub last_active_at: Option<i64>,
    pub control_policy: Option<ControlPolicy>,
    /// The stored current item id; one is minted for an embed stored without it.
    pub item_id: Option<QueueItemId>,
    /// The stored upcoming items; after a restart nobody is known to have added them.
    pub queue: Vec<(QueueItemId, AnyEmbed)>,
    /// When the restored item becomes current again, on the server's monotonic clock (the `ended` debounce).
    pub item_since: Option<f64>,
}

/// Which fields are set, never their values: a title, an embed, an owner or invite hash and queued videos must not reach a log.
impl std::fmt::Debug for RoomInit {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("RoomInit")
            .field("title", &self.title.is_some())
            .field("embed", &self.embed.is_some())
            .field("owner_hash", &self.owner_hash.is_some())
            .field("invite_hash", &self.invite_hash.is_some())
            .field("queue", &self.queue.len())
            .finish_non_exhaustive()
    }
}

/// A joined member and what the room tracks about them.
struct Rec {
    member: Member,
    /// `nicknameKey` of the member's nickname: unique per room.
    name_key: String,
    /// Client key the member counts against, or `None` when uncapped. Moves on a resume from elsewhere (ADR 0043).
    client: Option<String>,
    /// Advisory: the player is catching up (ADR 0019).
    catching: bool,
    /// The owner muted them (ADR 0030 section 3). In memory only.
    muted: bool,
    /// Disconnected and held, or hidden (ADR 0043). Advisory, like catching.
    away: bool,
    /// `Some(n)`: the room was last told (`member-status`) they are catching, as its n-th announcement.
    announced: Option<u64>,
    /// Typing a chat line (OME-1387). Ephemeral: never in a snapshot.
    typing: bool,
}

type Slot = u8;

pub struct Room {
    pub id: RoomId,
    pub topic: String,
    /// Fixed at creation; private rooms are never listed (ADR 0028 section 4).
    pub visibility: RoomVisibility,
    /// Never collected by GC: seeded rooms, and rooms the operator pins.
    pub pinned: bool,
    /// Unix ms; the list shows newer rooms first.
    pub created_at: i64,
    /// SHA-256 of the invite key (private rooms).
    pub invite_hash: Option<[u8; 32]>,
    /// Unix ms the room last became occupied or empty; `None` if nobody ever joined.
    pub last_active_at: Option<i64>,
    /// SHA-256 of the owner token, or `None` (pinned). Never the token itself.
    owner_hash: Option<[u8; 32]>,
    slots: [Option<Rec>; MAX_ROOM_MEMBERS],
    index: HashMap<MemberId, Slot>,
    /// Occupied slots in join order.
    order: Vec<Slot>,
    /// `nicknameKey`s in use.
    name_keys: std::collections::HashSet<String>,
    per_client: HashMap<String, usize>,
    /// Client keys to Unix ms: a muted member left from there, so a join from it starts muted until then; and
    /// a member was kicked from there, so joins from it are refused until then (ADR 0030 section 2, 3).
    /// In memory only, never stored or logged; expired entries go on the next write.
    muted_clients: HashMap<String, i64>,
    kicked_clients: HashMap<String, i64>,
    /// How many `member-status` announcements the room has had: orders `Rec::announced`.
    announcements: u64,
    seats: [Option<Slot>; SEAT_COUNT],
    embed: Option<AnyEmbed>,
    /// `None` iff there is no embed or it is generic (ADR 0024 section 7): a generic embed is never synced.
    playback: Option<PlaybackState>,
    /// The current embed's queue item id (ADR 0031 section 1); `None` iff there is no embed.
    current_item_id: Option<QueueItemId>,
    /// When the current item became current, on the caller's monotonic clock (the `ended` debounce).
    current_since: f64,
    /// Upcoming items in play order, at most `QUEUE_MAX` (ADR 0031 section 1).
    upcoming: VecDeque<QueueItem>,
    /// Last rev handed out; survives embed changes so clients never see rev go back.
    rev: i64,
    /// Seats held across a restart, by name hash, until `holds_until` (Unix ms). Each is used at most once.
    holds: HashMap<[u8; 32], SeatIndex>,
    holds_until: i64,
    layout: RoomLayout,
    /// `None` for a seeded room without one; then the list shows no title.
    title: Option<RoomTitle>,
    /// Who controls playback (ADR 0030 section 4); the owner changes it with `control-policy`.
    control_policy: ControlPolicy,
}

/// `Map.get(key)` of an expiry map, then the "live" rule: the entry runs while `now < until`; an expired one is dropped.
fn live(map: &mut HashMap<String, i64>, key: &str, now: i64) -> bool {
    let Some(&until) = map.get(key) else { return false };
    if now < until {
        return true;
    }
    map.remove(key);
    false
}

/// Sets `key` to `until` after sweeping every entry that has expired by `now`.
fn remember(map: &mut HashMap<String, i64>, key: &str, until: i64, now: i64) {
    map.retain(|_, &mut at| at > now);
    map.insert(key.to_owned(), until);
}

impl Room {
    /// `embed` is the last one shared before a restart: it comes back paused at 0 (synced) or unsynced (generic).
    pub fn new(id: RoomId, init: RoomInit, now_wall: i64) -> Result<Self, EntropyError> {
        let current_item_id = match (&init.embed, init.item_id) {
            (None, _) => None,
            (Some(_), Some(item)) => Some(item),
            (Some(_), None) => Some(mint_item_id()?),
        };
        let upcoming = init
            .queue
            .into_iter()
            .filter(|(item, _)| current_item_id.as_ref() != Some(item))
            .map(|(id, embed)| QueueItem { id, embed, by: None })
            .collect();
        let playback = init.embed.as_ref().filter(|e| e.is_synced()).map(|_| restored_playback(now_wall));
        let rev = playback.as_ref().map_or(-1, |p| i64::try_from(p.rev.0).unwrap_or(0));
        Ok(Self {
            topic: format!("room:{}", id.as_str()),
            id,
            visibility: init.visibility.unwrap_or(RoomVisibility::Public),
            pinned: init.pinned.unwrap_or(true),
            created_at: init.created_at.unwrap_or(now_wall),
            invite_hash: init.invite_hash,
            last_active_at: init.last_active_at,
            owner_hash: init.owner_hash,
            slots: std::array::from_fn(|_| None),
            index: HashMap::new(),
            order: Vec::new(),
            name_keys: std::collections::HashSet::new(),
            per_client: HashMap::new(),
            muted_clients: HashMap::new(),
            kicked_clients: HashMap::new(),
            announcements: 0,
            seats: [None; SEAT_COUNT],
            embed: init.embed,
            playback,
            current_item_id,
            current_since: init.item_since.unwrap_or(f64::NEG_INFINITY),
            upcoming,
            rev,
            holds: HashMap::new(),
            holds_until: 0,
            layout: init.layout.unwrap_or_else(default_layout),
            title: init.title,
            control_policy: init.control_policy.unwrap_or(DEFAULT_CONTROL_POLICY),
        })
    }

    fn rec(&self, id: &MemberId) -> Option<&Rec> {
        let slot = *self.index.get(id)?;
        self.slots.get(usize::from(slot))?.as_ref()
    }

    fn rec_mut(&mut self, id: &MemberId) -> Option<&mut Rec> {
        let slot = *self.index.get(id)?;
        self.slots.get_mut(usize::from(slot))?.as_mut()
    }

    pub fn layout(&self) -> &RoomLayout {
        &self.layout
    }

    /// Replaces the layout. Seats keep their indices: every valid layout has `SEAT_COUNT` seat cells (ADR 0028 section 6).
    /// Standing members whose cell it covers go to the door, or to their standing spot (`None`) when it covers the
    /// door too (ADR 0053); returns them, in join order, with where they went.
    pub fn set_layout(&mut self, layout: RoomLayout) -> Vec<(MemberId, Option<FloorCell>)> {
        self.layout = layout;
        let door = door_cell().filter(|&d| self.layout.standable(d));
        let mut moved = Vec::new();
        for &s in &self.order {
            let Some(rec) = self.slots.get_mut(usize::from(s)).and_then(Option::as_mut) else {
                continue;
            };
            if rec.member.cell.is_some_and(|c| !self.layout.standable(c)) {
                rec.member.cell = door;
                moved.push((rec.member.id.clone(), door));
            }
        }
        moved
    }

    /// Stands `member` on `cell`, off their seat if they had one (ADR 0053).
    pub fn walk(&mut self, member: &MemberId, cell: FloorCell) -> WalkResult {
        let Some(&slot) = self.index.get(member) else {
            return WalkResult::NotMember;
        };
        if !self.layout.standable(cell) {
            return WalkResult::Blocked;
        }
        let stood_up = self.seats.contains(&Some(slot));
        self.free(slot);
        if let Some(rec) = self.slots.get_mut(usize::from(slot)).and_then(Option::as_mut) {
            rec.member.cell = Some(cell);
        }
        WalkResult::Walked { stood_up }
    }

    /// Sets `member`'s shirt tint; false if unchanged or not a member. Tint 0 is stored as absent (ADR 0053).
    pub fn set_tint(&mut self, member: &MemberId, tint: Tint) -> bool {
        let Some(rec) = self.index.get(member).and_then(|&s| self.slots.get_mut(usize::from(s))?.as_mut()) else {
            return false;
        };
        let next = (tint.get() != 0).then_some(tint);
        let changed = rec.member.tint != next;
        rec.member.tint = next;
        changed
    }

    /// Sets `member`'s accessory; false if unchanged or not a member. Accessory 0 is stored as absent (OME-1387).
    pub fn set_accessory(&mut self, member: &MemberId, accessory: Accessory) -> bool {
        let Some(rec) = self.index.get(member).and_then(|&s| self.slots.get_mut(usize::from(s))?.as_mut()) else {
            return false;
        };
        let next = (accessory.get() != 0).then_some(accessory);
        let changed = rec.member.accessory != next;
        rec.member.accessory = next;
        changed
    }

    /// Sets `member`'s hair colour; false if unchanged or not a member. Hair 0 is stored as absent (OME-1435).
    pub fn set_hair(&mut self, member: &MemberId, hair: Hair) -> bool {
        let Some(rec) = self.index.get(member).and_then(|&s| self.slots.get_mut(usize::from(s))?.as_mut()) else {
            return false;
        };
        let next = (hair.get() != 0).then_some(hair);
        let changed = rec.member.hair != next;
        rec.member.hair = next;
        changed
    }

    /// Sets whether `member` is typing; false if unchanged or not a member (OME-1387).
    pub fn set_typing(&mut self, member: &MemberId, on: bool) -> bool {
        let Some(rec) = self.index.get(member).and_then(|&s| self.slots.get_mut(usize::from(s))?.as_mut()) else {
            return false;
        };
        let changed = rec.typing != on;
        rec.typing = on;
        changed
    }

    pub fn title(&self) -> Option<&RoomTitle> {
        self.title.as_ref()
    }

    pub fn set_title(&mut self, title: Option<RoomTitle>) {
        self.title = title;
    }

    pub fn control_policy(&self) -> ControlPolicy {
        self.control_policy
    }

    pub fn set_control_policy(&mut self, policy: ControlPolicy) {
        self.control_policy = policy;
    }

    pub fn is_muted(&self, member: &MemberId) -> bool {
        self.rec(member).is_some_and(|r| r.muted)
    }

    /// Mutes or unmutes a member; false if that changed nothing. Unmuting also forgets their address (ADR 0030 section 3).
    pub fn set_muted(&mut self, member: &MemberId, muted: bool) -> bool {
        let Some(&slot) = self.index.get(member) else { return false };
        let Some(Some(rec)) = self.slots.get_mut(usize::from(slot)) else {
            return false;
        };
        if rec.muted == muted {
            return false;
        }
        rec.muted = muted;
        if let (false, Some(client)) = (muted, rec.client.as_deref()) {
            self.muted_clients.remove(client);
        }
        true
    }

    /// Mutes a just-joined member if a muted member left from its address less than `MUTE_MEMORY_MS` ago.
    pub fn restore_mute(&mut self, member: &MemberId, now: i64) -> bool {
        let Some(&slot) = self.index.get(member) else { return false };
        let Some(Some(rec)) = self.slots.get_mut(usize::from(slot)) else {
            return false;
        };
        let Some(client) = rec.client.as_deref() else { return false };
        if !live(&mut self.muted_clients, client, now) {
            return false;
        }
        rec.muted = true;
        true
    }

    /// Refuses joins from `client` until `until` (Unix ms): the kick cooldown (ADR 0030 section 2).
    pub fn cool_down(&mut self, client: &str, until: i64, now: i64) {
        remember(&mut self.kicked_clients, client, until, now);
    }

    pub fn is_cooling_down(&mut self, client: &str, now: i64) -> bool {
        live(&mut self.kicked_clients, client, now)
    }

    /// Whether the room has an owner token. Seeded rooms don't.
    pub fn has_owner(&self) -> bool {
        self.owner_hash.is_some()
    }

    pub fn member_count(&self) -> usize {
        self.order.len()
    }

    pub fn member(&self, id: &MemberId) -> Option<&Member> {
        self.rec(id).map(|r| &r.member)
    }

    /// The members in join order, without their flags (see [`Room::view`]).
    pub fn members(&self) -> impl Iterator<Item = &Member> {
        self.order_recs().map(|r| &r.member)
    }

    fn order_recs(&self) -> impl Iterator<Item = &Rec> {
        self.order.iter().filter_map(|&s| self.slots.get(usize::from(s))?.as_ref())
    }

    /// The reason a join from `client` as `name_key` is refused, if any: full room, then the client's quota,
    /// then a taken name.
    fn join_refusal(&self, name_key: &str, client: Option<&str>) -> Option<JoinFailure> {
        if self.order.len() >= MAX_ROOM_MEMBERS {
            return Some(JoinFailure::RoomFull);
        }
        if client.is_some_and(|c| self.per_client.get(c).copied().unwrap_or(0) >= MAX_MEMBERS_PER_CLIENT) {
            return Some(JoinFailure::TooManyMembers);
        }
        self.name_keys.contains(name_key).then_some(JoinFailure::NicknameTaken)
    }

    /// Adds a member, unless the room is full, `client` already holds `MAX_MEMBERS_PER_CLIENT` members here,
    /// or another member's nickname has the same `nicknameKey`. `client` `None` means uncapped. The member id
    /// is minted only once the join is accepted.
    pub fn join(&mut self, nickname: &Nickname, avatar: Avatar, client: Option<&str>) -> Result<Result<Member, JoinFailure>, EntropyError> {
        let name_key = nickname_key(nickname.as_str());
        if let Some(refusal) = self.join_refusal(&name_key, client) {
            return Ok(Err(refusal));
        }
        let id = mint_member_id()?;
        Ok(self.admit(id, nickname, avatar, name_key, client))
    }

    /// `join` with a caller-chosen id (tests, replays): `id` must not belong to a member already.
    pub fn join_with_id(&mut self, id: MemberId, nickname: &Nickname, avatar: Avatar, client: Option<&str>) -> Result<Member, JoinFailure> {
        let name_key = nickname_key(nickname.as_str());
        if let Some(refusal) = self.join_refusal(&name_key, client) {
            return Err(refusal);
        }
        self.admit(id, nickname, avatar, name_key, client)
    }

    /// Seats a checked join in the lowest free standing slot. A reused `id` is refused as a taken name (a bug elsewhere).
    fn admit(
        &mut self,
        id: MemberId,
        nickname: &Nickname,
        avatar: Avatar,
        name_key: String,
        client: Option<&str>,
    ) -> Result<Member, JoinFailure> {
        let free = self.slots.iter().position(Option::is_none);
        let (Some(free), false) = (free, self.index.contains_key(&id)) else {
            return Err(if free.is_none() {
                JoinFailure::RoomFull
            } else {
                JoinFailure::NicknameTaken
            });
        };
        let slot = Slot::try_from(free).map_err(|_| JoinFailure::RoomFull)?;
        let member = Member {
            id,
            nickname: nickname.clone(),
            avatar,
            standing_slot: StandingSlot::new(u64::from(slot)),
            catching: None,
            muted: None,
            away: None,
            cell: None,
            tint: None,
            accessory: None,
            hair: None,
        };
        self.index.insert(member.id.clone(), slot);
        self.name_keys.insert(name_key.clone());
        if let Some(c) = client {
            *self.per_client.entry(c.to_owned()).or_insert(0) += 1;
        }
        let out = member.clone();
        if let Some(cell) = self.slots.get_mut(free) {
            *cell = Some(Rec {
                member,
                name_key,
                client: client.map(str::to_owned),
                catching: false,
                muted: false,
                away: false,
                announced: None,
                typing: false,
            });
        }
        self.order.push(slot);
        Ok(out)
    }

    /// Moves a member's quota slot to `client` (a resume from another address, ADR 0043): false, and
    /// nothing moves, if `client` already holds `MAX_MEMBERS_PER_CLIENT` members here.
    pub fn move_client(&mut self, member: &MemberId, client: Option<&str>) -> bool {
        let Some(rec) = self.rec(member) else { return false };
        if rec.client.as_deref() == client {
            return true;
        }
        if client.is_some_and(|c| self.per_client.get(c).copied().unwrap_or(0) >= MAX_MEMBERS_PER_CLIENT) {
            return false;
        }
        let old = rec.client.clone();
        if let Some(old) = old {
            self.uncount(&old);
        }
        if let Some(c) = client {
            *self.per_client.entry(c.to_owned()).or_insert(0) += 1;
        }
        if let Some(rec) = self.rec_mut(member) {
            rec.client = client.map(str::to_owned);
        }
        true
    }

    /// Marks a member away or back; false if that changed nothing.
    pub fn set_away(&mut self, member: &MemberId, away: bool) -> bool {
        match self.rec_mut(member) {
            Some(rec) if rec.away != away => {
                rec.away = away;
                true
            }
            _ => false,
        }
    }

    /// Removes a member and frees their seat, nickname and client slot. A muted member's address stays
    /// muted here for `MUTE_MEMORY_MS` after `now` (Unix ms), so a reconnect doesn't lift it (ADR 0030 section 3).
    pub fn leave(&mut self, member: &MemberId, now: i64) {
        let Some(slot) = self.index.remove(member) else { return };
        self.free(slot);
        self.order.retain(|&s| s != slot);
        let Some(rec) = self.slots.get_mut(usize::from(slot)).and_then(Option::take) else {
            return;
        };
        self.name_keys.remove(&rec.name_key);
        let Some(client) = rec.client else { return };
        if rec.muted {
            let until = now.saturating_add(i64::try_from(MUTE_MEMORY_MS).unwrap_or(i64::MAX));
            remember(&mut self.muted_clients, &client, until, now);
        }
        self.uncount(&client);
    }

    fn uncount(&mut self, client: &str) {
        match self.per_client.get_mut(client) {
            Some(n) if *n > 1 => *n -= 1,
            _ => {
                self.per_client.remove(client);
            }
        }
    }

    /// Empties whichever seat `slot` holds.
    fn free(&mut self, slot: Slot) {
        for seat in &mut self.seats {
            if *seat == Some(slot) {
                *seat = None;
            }
        }
    }

    /// Sits `member` on `seat` (moving from any other seat), or stands up on `None`.
    pub fn sit(&mut self, member: &MemberId, seat: Option<SeatIndex>) -> SitResult {
        let slot = self.index.get(member).copied();
        let Some(slot) = slot else {
            // Standing up is always fine; only a member can take a seat.
            return if seat.is_none() { SitResult::Ok } else { SitResult::NotMember };
        };
        let occupant = seat.and_then(|s| self.seats.get(usize::from(s.get())).copied().flatten());
        if occupant.is_some_and(|o| o != slot) {
            return SitResult::SeatTaken;
        }
        self.free(slot);
        if let Some(cell) = seat.and_then(|s| self.seats.get_mut(usize::from(s.get()))) {
            *cell = Some(slot);
        }
        // Sitting, or standing up to the standing spot: no standing cell either way (ADR 0053).
        if let Some(rec) = self.slots.get_mut(usize::from(slot)).and_then(Option::as_mut) {
            rec.member.cell = None;
        }
        SitResult::Ok
    }

    /// Seated members, for a graceful restart: name hashes only, never the nickname (ADR 0032).
    pub fn held_seats(&self) -> Vec<HeldSeat> {
        let mut held = Vec::new();
        for (i, occupant) in self.seats.iter().enumerate() {
            let rec = occupant.and_then(|s| self.slots.get(usize::from(s))?.as_ref());
            let seat = u64::try_from(i).ok().and_then(SeatIndex::new);
            if let (Some(rec), Some(seat)) = (rec, seat) {
                held.push(HeldSeat {
                    name_hash: hash_secret(&rec.name_key),
                    seat,
                });
            }
        }
        held
    }

    /// Holds these seats for members rejoining under the same name until `until` (Unix ms).
    pub fn hold_seats(&mut self, holds: &[HeldSeat], until: i64) {
        self.holds = holds.iter().map(|h| (h.name_hash, h.seat)).collect();
        self.holds_until = until;
    }

    /// Sits a just-joined member on the seat held for its name, if the hold hasn't expired and the seat is
    /// free; returns the seat, or `None`. The hold is spent either way.
    pub fn claim_held_seat(&mut self, member: &MemberId, now: i64) -> Option<SeatIndex> {
        if self.holds.is_empty() {
            return None;
        }
        if now > self.holds_until {
            self.holds.clear();
            return None;
        }
        let slot = *self.index.get(member)?;
        let key = hash_secret(&self.rec(member)?.name_key);
        let seat = self.holds.remove(&key)?;
        let cell = self.seats.get_mut(usize::from(seat.get()))?;
        if cell.is_some() {
            return None;
        }
        *cell = Some(slot);
        Some(seat)
    }

    /// Records a member's advisory catching-up flag (ADR 0019); never touches playback.
    pub fn set_catching(&mut self, member: &MemberId, catching: bool) {
        if let Some(rec) = self.rec_mut(member) {
            rec.catching = catching;
        }
    }

    pub fn is_catching(&self, member: &MemberId) -> bool {
        self.rec(member).is_some_and(|r| r.catching)
    }

    /// The member's catching if the room was last told otherwise, now recorded as told; else `None`.
    pub fn take_catching_change(&mut self, member: &MemberId) -> Option<bool> {
        let n = self.announcements;
        let rec = self.rec_mut(member)?;
        if rec.catching == rec.announced.is_some() {
            return None;
        }
        rec.announced = rec.catching.then_some(n);
        let catching = rec.catching;
        if catching {
            self.announcements = n.saturating_add(1);
        }
        Some(catching)
    }

    /// True while the room shows a generic (unsynced) embed.
    pub fn has_generic_embed(&self) -> bool {
        self.embed.as_ref().is_some_and(|e| !e.is_synced())
    }

    pub fn current_embed(&self) -> Option<&AnyEmbed> {
        self.embed.as_ref()
    }

    /// The current playback; `None` with no embed or a generic one.
    pub fn current_playback(&self) -> Option<&PlaybackState> {
        self.playback.as_ref()
    }

    /// The current item's id (ADR 0031 section 1); `None` iff there is no embed.
    pub fn item_id(&self) -> Option<&QueueItemId> {
        self.current_item_id.as_ref()
    }

    /// When the current item became current, on the clock its setter used.
    pub fn item_since(&self) -> f64 {
        self.current_since
    }

    /// The upcoming items, in play order.
    pub fn queue(&self) -> &VecDeque<QueueItem> {
        &self.upcoming
    }

    /// Appends an upcoming item. The caller checks `QUEUE_MAX`.
    pub fn enqueue(&mut self, item: QueueItem) {
        self.upcoming.push_back(item);
    }

    /// Drops an upcoming item; false if there was none with that id.
    pub fn dequeue(&mut self, id: &QueueItemId) -> bool {
        let before = self.upcoming.len();
        self.upcoming.retain(|i| i.id != *id);
        self.upcoming.len() != before
    }

    /// Moves the upcoming item at `from` to `to`; both are in range (the caller checks).
    pub fn move_queued(&mut self, from: usize, to: usize) {
        if let Some(item) = self.upcoming.remove(from) {
            self.upcoming.insert(to, item);
        }
    }

    /// Makes the first upcoming item current at `since` (ADR 0031 section 5): its embed loads at 0, by `by`
    /// (nobody for an advance, the adder when an add starts an empty room). `None` with an empty queue.
    pub fn advance(&mut self, since: f64, by: Option<MemberId>, now_wall: i64) -> Option<Advance> {
        let item = self.upcoming.pop_front()?;
        let embed_switch = self.install(Some(item.embed.clone()), by, Some(item.id.clone()), since, now_wall);
        Some(Advance { item, embed_switch })
    }

    /// Sets the embed and restarts playback at 0. `by` is the sharer. The embed becomes the current item
    /// `item_id` (minted if `None`) at `since`; a `None` embed has no item. A `None` or generic embed clears
    /// playback and every catching flag (ADR 0024 section 7): `uncaught` lists the members to tell.
    pub fn set_embed(
        &mut self,
        embed: Option<AnyEmbed>,
        by: Option<MemberId>,
        item_id: Option<QueueItemId>,
        since: f64,
        now_wall: i64,
    ) -> Result<EmbedSwitch, EntropyError> {
        // Minted first: an entropy failure leaves the room as it was.
        let item_id = match (&embed, item_id) {
            (None, _) => None,
            (Some(_), Some(item)) => Some(item),
            (Some(_), None) => Some(mint_item_id()?),
        };
        Ok(self.install(embed, by, item_id, since, now_wall))
    }

    /// `set_embed` with the item id already settled (`None` iff `embed` is).
    fn install(
        &mut self,
        embed: Option<AnyEmbed>,
        by: Option<MemberId>,
        item_id: Option<QueueItemId>,
        since: f64,
        now_wall: i64,
    ) -> EmbedSwitch {
        let synced = embed.as_ref().is_some_and(AnyEmbed::is_synced);
        self.embed = embed;
        self.current_item_id = item_id;
        self.current_since = since;
        self.playback = synced.then(|| load_playback(self.rev, now_wall, by));
        if let Some(playback) = &self.playback {
            self.rev = i64::try_from(playback.rev.0).unwrap_or(i64::MAX);
            return EmbedSwitch {
                playback: Some(playback.clone()),
                uncaught: Vec::new(),
            };
        }
        let mut announced: Vec<(u64, &MemberId)> = Vec::new();
        for rec in self.order_recs() {
            if let Some(n) = rec.announced {
                announced.push((n, &rec.member.id));
            }
        }
        announced.sort_unstable_by_key(|&(n, _)| n);
        let uncaught = announced.into_iter().map(|(_, id)| id.clone()).collect();
        for rec in self.slots.iter_mut().flatten() {
            rec.catching = false;
            rec.announced = None;
        }
        EmbedSwitch { playback: None, uncaught }
    }

    /// Applies a member's `control`; the new playback, or `None` if it's for no/another/a generic embed.
    pub fn control(&mut self, member: &MemberId, control: &Control<'_>, now_wall: i64) -> Option<PlaybackState> {
        let Some(AnyEmbed::Synced(embed)) = &self.embed else { return None };
        let next = apply_control(self.playback.as_ref(), Some(embed), control, member, now_wall)?;
        self.rev = i64::try_from(next.rev.0).unwrap_or(i64::MAX);
        self.playback = Some(next.clone());
        Some(next)
    }

    pub fn snapshot(&self) -> RoomState {
        let seats = self
            .seats
            .iter()
            .map(|s| s.and_then(|slot| Some(self.slots.get(usize::from(slot))?.as_ref()?.member.id.clone())))
            .collect();
        // Absent means false, so only catching, muted and away members carry the fields.
        let members = self.order_recs().map(Rec::view).collect();
        // Like the summary: an untitled (seeded) room sends no title key; nor an empty queue or no item a queue key.
        RoomState::new(
            self.id.clone(),
            seats,
            members,
            self.embed.clone(),
            self.playback.clone(),
            self.layout.clone(),
            self.control_policy,
        )
        .with_title(self.title.clone())
        .with_item_id(self.current_item_id.clone())
        .with_queue(self.upcoming.iter().cloned().collect())
    }

    /// A member as the room sees it: `catching`, `muted` and `away` only when true.
    pub fn view(&self, member: &Member) -> Member {
        self.rec(&member.id).map_or_else(|| member.clone(), Rec::view)
    }

    /// Whether `token` is this room's owner token (constant-time; a pinned room has no owner).
    pub fn is_owner(&self, token: &str) -> bool {
        secret_matches(self.owner_hash.as_ref().map(<[u8; 32]>::as_slice), token)
    }

    /// Whether `key` is this private room's invite key (constant-time; a public room has none).
    pub fn is_invited(&self, key: &str) -> bool {
        secret_matches(self.invite_hash.as_ref().map(<[u8; 32]>::as_slice), key)
    }

    pub fn summary(&self) -> RoomSummary {
        let seated = self.seats.iter().flatten().count();
        RoomSummary {
            id: self.id.clone(),
            member_count: u8::try_from(self.order.len()).unwrap_or(u8::MAX),
            seated_count: u8::try_from(seated).unwrap_or(u8::MAX),
            title: self.title.clone(),
        }
    }
}

impl Rec {
    fn view(&self) -> Member {
        let mut out = self.member.clone();
        if self.catching {
            out.catching = Some(true);
        }
        if self.muted {
            out.muted = Some(true);
        }
        if self.away {
            out.away = Some(true);
        }
        out
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::indexing_slicing, reason = "tests")]
mod tests {
    use super::*;
    use crate::contract::confusables::nickname_key;
    use crate::contract::constants::{MAX_ROOM_MEMBERS, MUTE_MEMORY_MS, SEAT_COUNT};
    use crate::contract::embed::canonicalize_embed;
    use crate::contract::generic_embed::canonicalize_generic_embed;
    use crate::contract::state::{PlaybackAction, Rev};
    use crate::secrets::hash_secret;

    const T0: i64 = 1_700_000_000_000;
    const YT_URL: &str = "https://www.youtube.com/embed/dQw4w9WgXcQ";

    fn yt() -> AnyEmbed {
        AnyEmbed::Synced(canonicalize_embed(YT_URL).unwrap())
    }
    fn vimeo() -> AnyEmbed {
        AnyEmbed::Synced(canonicalize_embed("https://vimeo.com/76979871").unwrap())
    }
    fn live() -> AnyEmbed {
        AnyEmbed::Synced(canonicalize_embed("https://www.twitch.tv/somechannel").unwrap())
    }
    fn generic() -> AnyEmbed {
        AnyEmbed::Generic(canonicalize_generic_embed("https://player.vidsite.com/embed/42", &[]).unwrap())
    }
    fn rid(s: &str) -> RoomId {
        RoomId::parse(s).unwrap()
    }
    fn mid(s: &str) -> MemberId {
        MemberId::parse(s).unwrap()
    }
    fn iid(s: &str) -> QueueItemId {
        QueueItemId::parse(s).unwrap()
    }
    fn nick(s: &str) -> Nickname {
        Nickname::parse(s).unwrap()
    }
    fn avatar(n: u64) -> Avatar {
        Avatar::new(n).unwrap()
    }
    fn seat(n: u64) -> SeatIndex {
        SeatIndex::new(n).unwrap()
    }
    fn room() -> Room {
        Room::new(rid("film-club"), RoomInit::default(), T0).unwrap()
    }
    fn room_with(init: RoomInit) -> Room {
        Room::new(rid("film-club"), init, T0).unwrap()
    }
    /// Joins `name` as member id `id` from `client`, expecting success.
    fn join(room: &mut Room, id: &str, name: &str, client: Option<&str>) -> MemberId {
        let member = room.join_with_id(mid(id), &nick(name), avatar(0), client).unwrap();
        assert_eq!(member.id.as_str(), id);
        member.id
    }
    fn json<T: serde::Serialize>(v: &T) -> String {
        serde_json::to_string(v).unwrap()
    }
    fn ids(members: &[Member]) -> Vec<&str> {
        members.iter().map(|m| m.id.as_str()).collect()
    }
    fn queued(id: &str, embed: AnyEmbed, by: Option<&str>) -> QueueItem {
        QueueItem {
            id: iid(id),
            embed,
            by: by.map(mid),
        }
    }
    fn mute_ms() -> i64 {
        i64::try_from(MUTE_MEMORY_MS).unwrap()
    }
    fn ctl(playing: bool, position: f64) -> Control<'static> {
        Control {
            url: YT_URL,
            playing,
            position,
        }
    }

    // ---- construction

    #[test]
    fn a_room_without_init_is_a_seed_pinned_public_ownerless() {
        let r = room();
        assert_eq!(r.topic, "room:film-club");
        assert_eq!(
            (r.visibility, r.pinned, r.created_at, r.last_active_at),
            (RoomVisibility::Public, true, T0, None)
        );
        assert!(!r.has_owner() && r.invite_hash.is_none());
        assert_eq!(
            (r.control_policy(), r.title().map(RoomTitle::as_str)),
            (ControlPolicy::Everyone, None)
        );
        assert_eq!(r.layout(), &default_layout());
        assert!(r.current_embed().is_none() && r.current_playback().is_none() && r.item_id().is_none());
        assert_eq!(r.item_since(), f64::NEG_INFINITY);
        assert!(r.queue().is_empty());
    }

    #[test]
    fn init_fields_are_kept() {
        let r = room_with(RoomInit {
            title: RoomTitle::parse("Friday films"),
            visibility: Some(RoomVisibility::Private),
            pinned: Some(false),
            created_at: Some(5),
            owner_hash: Some(hash_secret("owner")),
            invite_hash: Some(hash_secret("invite")),
            last_active_at: Some(9),
            control_policy: Some(ControlPolicy::Owner),
            ..RoomInit::default()
        });
        assert_eq!(
            (r.visibility, r.pinned, r.created_at, r.last_active_at),
            (RoomVisibility::Private, false, 5, Some(9))
        );
        assert!(r.has_owner());
        assert_eq!(
            (r.control_policy(), r.title().map(RoomTitle::as_str)),
            (ControlPolicy::Owner, Some("Friday films"))
        );
    }

    // apps/server/test/persistence.test.ts: an embed comes back paused at 0 after a restart (OME-280)
    #[test]
    fn a_restored_synced_embed_is_paused_at_0_and_rev_continues_from_it() {
        let mut r = room_with(RoomInit {
            embed: Some(yt()),
            item_id: Some(iid("cur1")),
            item_since: Some(7.5),
            ..RoomInit::default()
        });
        let p = r.current_playback().unwrap();
        assert_eq!(
            json(p),
            r#"{"playing":false,"position":0,"rate":1,"at":1700000000000,"rev":0,"action":"pause","by":null}"#
        );
        assert_eq!((r.item_id(), r.item_since()), (Some(&iid("cur1")), 7.5));
        let next = r
            .set_embed(Some(vimeo()), None, Some(iid("n1")), 1.0, T0 + 1)
            .unwrap()
            .playback
            .unwrap();
        assert_eq!(next.rev, Rev(1));
    }

    #[test]
    fn a_restored_generic_embed_has_no_playback_and_rev_starts_at_minus_one() {
        let mut r = room_with(RoomInit {
            embed: Some(generic()),
            item_id: Some(iid("cur1")),
            ..RoomInit::default()
        });
        assert!(r.current_playback().is_none() && r.has_generic_embed());
        let next = r.set_embed(Some(yt()), None, Some(iid("n1")), 0.0, T0).unwrap().playback.unwrap();
        assert_eq!(next.rev, Rev(0));
    }

    #[test]
    fn an_embed_stored_without_an_item_id_gets_one_minted() {
        let r = room_with(RoomInit {
            embed: Some(yt()),
            ..RoomInit::default()
        });
        assert_eq!(r.item_id().map(|i| i.as_str().len()), Some(16));
        // No embed: no item, even if the stored row has an id.
        let r = room_with(RoomInit {
            item_id: Some(iid("stale")),
            ..RoomInit::default()
        });
        assert!(r.item_id().is_none());
    }

    #[test]
    fn the_stored_queue_loses_the_current_item_and_every_adder() {
        let r = room_with(RoomInit {
            embed: Some(yt()),
            item_id: Some(iid("cur1")),
            queue: vec![(iid("cur1"), yt()), (iid("q1"), vimeo()), (iid("q2"), live())],
            ..RoomInit::default()
        });
        let q: Vec<_> = r.queue().iter().map(|i| (i.id.as_str(), i.by.is_none())).collect();
        assert_eq!(q, [("q1", true), ("q2", true)]);
        // With no embed there is no current item to drop.
        let r = room_with(RoomInit {
            queue: vec![(iid("q1"), vimeo())],
            ..RoomInit::default()
        });
        assert_eq!(r.queue().len(), 1);
    }

    // ---- join, leave, standing slots

    #[test]
    fn join_assigns_the_lowest_free_standing_slot_and_returns_the_bare_member() {
        let mut r = room();
        let a = r.join_with_id(mid("m1"), &nick("alice"), avatar(2), None).unwrap();
        assert_eq!(json(&a), r#"{"id":"m1","nickname":"alice","avatar":2,"standingSlot":0}"#);
        join(&mut r, "m2", "bob", None);
        join(&mut r, "m3", "carol", None);
        r.leave(&mid("m2"), T0);
        let d = join(&mut r, "m4", "dave", None);
        assert_eq!(r.member(&d).unwrap().standing_slot.map(|s| s.get()), Some(1));
        let e = join(&mut r, "m5", "erin", None);
        assert_eq!(r.member(&e).unwrap().standing_slot.map(|s| s.get()), Some(3));
        assert_eq!(r.member_count(), 4);
    }

    #[test]
    fn join_with_a_minted_id_is_a_uuid_and_the_member_is_findable() {
        let mut r = room();
        let m = r.join(&nick("alice"), avatar(1), Some("k")).unwrap().unwrap();
        assert_eq!(m.id.as_str().len(), 36);
        assert_eq!(r.member(&m.id), Some(&m));
        let m2 = r.join(&nick("bob"), avatar(1), None).unwrap().unwrap();
        assert_ne!(m.id, m2.id);
    }

    #[test]
    fn a_full_room_refuses_the_next_join_and_a_leave_makes_space() {
        let mut r = room();
        for i in 0..MAX_ROOM_MEMBERS {
            join(&mut r, &format!("m{i}"), &format!("guest {i}"), None);
        }
        let slots: Vec<_> = r.members().map(|m| m.standing_slot.unwrap().get()).collect();
        assert_eq!(slots, (0..MAX_ROOM_MEMBERS as u8).collect::<Vec<_>>());
        assert_eq!(r.join_with_id(mid("x"), &nick("late"), avatar(0), None), Err(JoinFailure::RoomFull));
        assert_eq!(r.join(&nick("late"), avatar(0), None).unwrap(), Err(JoinFailure::RoomFull));
        r.leave(&mid("m7"), T0);
        let late = r.join_with_id(mid("x"), &nick("late"), avatar(0), None).unwrap();
        assert_eq!(late.standing_slot.map(|s| s.get()), Some(7));
    }

    // apps/server/test/abuse.test.ts:353
    #[test]
    fn at_most_5_members_per_client_key() {
        let mut r = room();
        for i in 0..MAX_MEMBERS_PER_CLIENT {
            join(&mut r, &format!("m{i}"), &format!("guest {i}"), Some("k1"));
        }
        assert_eq!(
            r.join_with_id(mid("x"), &nick("sixth"), avatar(0), Some("k1")),
            Err(JoinFailure::TooManyMembers)
        );
        join(&mut r, "y", "other key", Some("k2"));
        join(&mut r, "z", "uncapped", None);
        join(&mut r, "z2", "uncapped two", None);
        // A leave frees a quota slot; the refused join took none.
        r.leave(&mid("m0"), T0);
        join(&mut r, "w", "sixth again", Some("k1"));
        assert_eq!(
            r.join_with_id(mid("v"), &nick("seventh"), avatar(0), Some("k1")),
            Err(JoinFailure::TooManyMembers)
        );
    }

    // apps/server/test/abuse.test.ts:380
    #[test]
    fn a_nickname_with_the_same_key_is_taken_even_in_another_case_or_width() {
        let mut r = room();
        join(&mut r, "m1", "Ilya", None);
        // Case folds, and NFKC folds the fullwidth letters (the Nickname parse).
        for clash in ["ILYA", "ilya", "Ilya", "\u{ff49}lya"] {
            assert_eq!(nickname_key(nick(clash).as_str()), nickname_key("Ilya"), "{clash}");
            assert_eq!(
                r.join_with_id(mid("x"), &nick(clash), avatar(0), None),
                Err(JoinFailure::NicknameTaken),
                "{clash}"
            );
        }
        // A different key is free.
        assert_ne!(nickname_key("llya"), nickname_key("Ilya"));
        join(&mut r, "m2", "Ilja", None);
        // Leaving frees the name.
        r.leave(&mid("m1"), T0);
        join(&mut r, "m3", "ILYA", None);
    }

    #[test]
    fn join_failures_are_checked_in_order_room_full_then_client_cap_then_name() {
        let mut r = room();
        for i in 0..MAX_MEMBERS_PER_CLIENT {
            join(&mut r, &format!("m{i}"), &format!("guest {i}"), Some("k"));
        }
        // Capped and name clash at once: the cap wins.
        assert_eq!(
            r.join_with_id(mid("x"), &nick("guest 0"), avatar(0), Some("k")),
            Err(JoinFailure::TooManyMembers)
        );
        assert_eq!(
            r.join_with_id(mid("x"), &nick("guest 0"), avatar(0), Some("other")),
            Err(JoinFailure::NicknameTaken)
        );
        for i in MAX_MEMBERS_PER_CLIENT..MAX_ROOM_MEMBERS {
            join(&mut r, &format!("m{i}"), &format!("guest {i}"), None);
        }
        // Full, capped and clashing at once: full wins.
        assert_eq!(
            r.join_with_id(mid("x"), &nick("guest 0"), avatar(0), Some("k")),
            Err(JoinFailure::RoomFull)
        );
    }

    #[test]
    fn a_failed_join_changes_nothing() {
        let mut r = room();
        join(&mut r, "m1", "alice", Some("k"));
        let before = json(&r.snapshot());
        assert!(r.join_with_id(mid("x"), &nick("alice"), avatar(0), Some("k")).is_err());
        assert_eq!(json(&r.snapshot()), before);
        // The slot the refused join would have used is still the next one.
        assert_eq!(join_slot(&mut r, "m2", "bob"), 1);
    }

    fn join_slot(r: &mut Room, id: &str, name: &str) -> u8 {
        let m = join(r, id, name, None);
        r.member(&m).unwrap().standing_slot.unwrap().get()
    }

    #[test]
    fn leave_frees_seat_name_quota_and_flags_and_is_idempotent() {
        let mut r = room();
        let a = join(&mut r, "m1", "alice", Some("k"));
        r.sit(&a, Some(seat(3)));
        r.set_catching(&a, true);
        r.set_away(&a, true);
        r.take_catching_change(&a);
        r.leave(&a, T0);
        r.leave(&a, T0);
        assert_eq!(r.member_count(), 0);
        assert!(r.snapshot().seats.iter().all(Option::is_none));
        // Same id and name come back clean.
        let back = join(&mut r, "m1", "alice", Some("k"));
        assert!(!r.is_catching(&back));
        assert_eq!(
            json(&r.view(r.member(&back).unwrap())),
            r#"{"id":"m1","nickname":"alice","avatar":0,"standingSlot":0}"#
        );
        assert_eq!(r.take_catching_change(&back), None);
        assert!(!r.set_away(&back, false));
    }

    // ---- seats

    #[test]
    fn sit_stand_move_and_conflict() {
        let mut r = room();
        let a = join(&mut r, "m1", "alice", None);
        let b = join(&mut r, "m2", "bob", None);
        assert_eq!(r.sit(&a, Some(seat(0))), SitResult::Ok);
        assert_eq!(r.sit(&b, Some(seat(0))), SitResult::SeatTaken);
        assert_eq!(r.sit(&a, Some(seat(0))), SitResult::Ok);
        assert_eq!(r.sit(&a, Some(seat(5))), SitResult::Ok);
        assert_eq!(r.sit(&b, Some(seat(0))), SitResult::Ok);
        let seats = r.snapshot().seats;
        assert_eq!(seats[0].as_ref(), Some(&b));
        assert_eq!(seats[5].as_ref(), Some(&a));
        assert_eq!(seats.iter().flatten().count(), 2);
        assert_eq!(r.sit(&a, None), SitResult::Ok);
        assert_eq!(r.snapshot().seats.iter().flatten().count(), 1);
        // A failed sit keeps the member where they were.
        assert_eq!(r.sit(&b, Some(seat(0))), SitResult::Ok);
        assert_eq!(r.sit(&a, Some(seat(0))), SitResult::SeatTaken);
        assert_eq!(r.snapshot().seats[0].as_ref(), Some(&b));
    }

    #[test]
    fn only_members_sit() {
        let mut r = room();
        assert_eq!(r.sit(&mid("ghost"), Some(seat(1))), SitResult::NotMember);
        assert_eq!(r.sit(&mid("ghost"), None), SitResult::Ok);
        assert!(r.snapshot().seats.iter().all(Option::is_none));
    }

    #[test]
    fn a_left_members_seat_is_free_for_the_next() {
        let mut r = room();
        let a = join(&mut r, "m1", "alice", None);
        let b = join(&mut r, "m2", "bob", None);
        r.sit(&a, Some(seat(7)));
        r.leave(&a, T0);
        assert_eq!(r.sit(&b, Some(seat(7))), SitResult::Ok);
    }

    // apps/server/test/graceful-restart.test.ts: seats survive a restart under the same name (ADR 0032)
    #[test]
    fn held_seats_are_hashes_of_the_name_key_of_the_seated_only() {
        let mut r = room();
        let a = join(&mut r, "m1", "Ilya", None);
        let b = join(&mut r, "m2", "bob", None);
        join(&mut r, "m3", "standing", None);
        r.sit(&b, Some(seat(6)));
        r.sit(&a, Some(seat(2)));
        let held = r.held_seats();
        assert_eq!(
            held,
            [
                HeldSeat {
                    name_hash: hash_secret(&nickname_key("Ilya")),
                    seat: seat(2)
                },
                HeldSeat {
                    name_hash: hash_secret(&nickname_key("bob")),
                    seat: seat(6)
                },
            ]
        );
    }

    #[test]
    fn a_hold_seats_the_rejoining_name_once_before_it_expires() {
        let mut src = room();
        let a = join(&mut src, "m1", "alice", None);
        src.sit(&a, Some(seat(4)));
        let held = src.held_seats();

        let mut r = room();
        r.hold_seats(&held, T0 + SEAT_HOLD_MS);
        let b = join(&mut r, "n1", "bob", None);
        assert_eq!(r.claim_held_seat(&b, T0), None);
        let a2 = join(&mut r, "n2", "ALICE", None);
        assert_eq!(r.claim_held_seat(&a2, T0 + SEAT_HOLD_MS), Some(seat(4)));
        assert_eq!(r.snapshot().seats[4].as_ref(), Some(&a2));
        // Spent: the same name rejoining again gets nothing.
        r.leave(&a2, T0);
        let a3 = join(&mut r, "n3", "alice", None);
        assert_eq!(r.claim_held_seat(&a3, T0), None);
    }

    #[test]
    fn an_expired_hold_is_dropped_and_a_taken_seat_spends_the_hold() {
        let held = [HeldSeat {
            name_hash: hash_secret(&nickname_key("alice")),
            seat: seat(1),
        }];
        let mut r = room();
        r.hold_seats(&held, T0 + 100);
        let a = join(&mut r, "m1", "alice", None);
        assert_eq!(r.claim_held_seat(&a, T0 + 101), None);
        // The expiry cleared every hold, even when asked in time later.
        assert_eq!(r.claim_held_seat(&a, T0), None);

        let mut r = room();
        r.hold_seats(&held, T0 + 100);
        let squatter = join(&mut r, "m0", "squatter", None);
        r.sit(&squatter, Some(seat(1)));
        let a = join(&mut r, "m1", "alice", None);
        assert_eq!(r.claim_held_seat(&a, T0), None);
        r.sit(&squatter, None);
        assert_eq!(r.claim_held_seat(&a, T0), None);
    }

    #[test]
    fn claiming_without_holds_or_for_a_non_member_is_none() {
        let mut r = room();
        assert_eq!(r.claim_held_seat(&mid("ghost"), T0), None);
        r.hold_seats(
            &[HeldSeat {
                name_hash: hash_secret("x"),
                seat: seat(0),
            }],
            T0 + 1,
        );
        assert_eq!(r.claim_held_seat(&mid("ghost"), T0), None);
    }

    // ---- moderation memory

    // apps/server/test/moderation.test.ts: a muted member's address stays muted for MUTE_MEMORY_MS
    #[test]
    fn mute_unmute_and_what_changed() {
        let mut r = room();
        let a = join(&mut r, "m1", "alice", Some("k"));
        assert!(!r.is_muted(&a));
        assert!(r.set_muted(&a, true) && r.is_muted(&a));
        assert!(!r.set_muted(&a, true));
        assert!(r.set_muted(&a, false) && !r.is_muted(&a));
        assert!(!r.set_muted(&a, false));
        assert!(!r.set_muted(&mid("ghost"), true));
    }

    #[test]
    fn a_muted_member_who_leaves_is_muted_again_from_that_address_until_the_memory_ends() {
        let mut r = room();
        let a = join(&mut r, "m1", "alice", Some("k"));
        r.set_muted(&a, true);
        r.leave(&a, T0);
        let b = join(&mut r, "m2", "alice", Some("k"));
        assert!(!r.is_muted(&b));
        assert!(r.restore_mute(&b, T0 + mute_ms() - 1));
        assert!(r.is_muted(&b));
        // Another address is not muted.
        let c = join(&mut r, "m3", "carol", Some("other"));
        assert!(!r.restore_mute(&c, T0));
        let d = join(&mut r, "m4", "dave", None);
        assert!(!r.restore_mute(&d, T0));
        // The memory ends at `until`, exactly, and the entry is dropped.
        let e = join(&mut r, "m5", "erin", Some("k"));
        assert!(!r.restore_mute(&e, T0 + mute_ms()));
        assert!(!r.restore_mute(&e, T0));
    }

    #[test]
    fn an_unmuted_member_who_leaves_leaves_no_memory_and_unmuting_forgets_the_address() {
        let mut r = room();
        let a = join(&mut r, "m1", "alice", Some("k"));
        r.leave(&a, T0);
        let b = join(&mut r, "m2", "bob", Some("k"));
        assert!(!r.restore_mute(&b, T0));

        // Mute, leave (remembered), rejoin, mute and unmute: the address is forgotten.
        let c = join(&mut r, "m3", "carol", Some("k"));
        r.set_muted(&c, true);
        r.leave(&c, T0);
        let d = join(&mut r, "m4", "dave", Some("k"));
        assert!(r.restore_mute(&d, T0));
        r.set_muted(&d, false);
        let e = join(&mut r, "m5", "erin", Some("k"));
        assert!(!r.restore_mute(&e, T0));
    }

    // apps/server/test/moderation.test.ts: kick cooldown
    #[test]
    fn a_cool_down_runs_until_its_time_and_is_dropped_then() {
        let mut r = room();
        assert!(!r.is_cooling_down("k", T0));
        r.cool_down("k", T0 + 1000, T0);
        assert!(r.is_cooling_down("k", T0) && r.is_cooling_down("k", T0 + 999));
        assert!(!r.is_cooling_down("other", T0));
        assert!(!r.is_cooling_down("k", T0 + 1000));
        assert!(!r.is_cooling_down("k", T0));
    }

    #[test]
    fn writing_a_cool_down_sweeps_the_expired_and_replaces_the_same_key() {
        let mut r = room();
        r.cool_down("old", T0 + 10, T0);
        r.cool_down("live", T0 + 5000, T0);
        r.cool_down("new", T0 + 9000, T0 + 10);
        // `old` expired at T0 + 10: swept by the write at that time, so it is gone even asked in the past.
        assert!(!r.is_cooling_down("old", T0));
        assert!(r.is_cooling_down("live", T0 + 20) && r.is_cooling_down("new", T0 + 20));
        r.cool_down("live", T0 + 20, T0 + 15);
        assert!(!r.is_cooling_down("live", T0 + 20));
    }

    #[test]
    fn move_client_moves_the_quota_or_refuses() {
        let mut r = room();
        let a = join(&mut r, "m1", "alice", Some("k1"));
        for i in 0..MAX_MEMBERS_PER_CLIENT {
            join(&mut r, &format!("f{i}"), &format!("full {i}"), Some("k2"));
        }
        assert!(r.move_client(&a, Some("k1")));
        assert!(!r.move_client(&a, Some("k2")));
        assert!(r.move_client(&a, Some("k3")));
        // k1 is empty again: five can join from it.
        for i in 0..MAX_MEMBERS_PER_CLIENT {
            join(&mut r, &format!("g{i}"), &format!("again {i}"), Some("k1"));
        }
        assert!(r.move_client(&a, None));
        assert!(!r.move_client(&mid("ghost"), Some("k3")));
        // Moving to None freed k3 and leaving afterwards counts nothing for `a`.
        r.leave(&a, T0);
        let b = join(&mut r, "m9", "bob", Some("k3"));
        assert!(r.move_client(&b, Some("k3")));
    }

    #[test]
    fn a_moved_muted_member_leaves_a_memory_under_the_new_address() {
        let mut r = room();
        let a = join(&mut r, "m1", "alice", Some("k1"));
        r.move_client(&a, Some("k2"));
        r.set_muted(&a, true);
        r.leave(&a, T0);
        let b = join(&mut r, "m2", "bob", Some("k1"));
        let c = join(&mut r, "m3", "carol", Some("k2"));
        assert!(!r.restore_mute(&b, T0) && r.restore_mute(&c, T0));
    }

    // ---- status flags

    #[test]
    fn away_toggles_and_reports_change() {
        let mut r = room();
        let a = join(&mut r, "m1", "alice", None);
        assert!(!r.set_away(&a, false));
        assert!(r.set_away(&a, true) && !r.set_away(&a, true));
        assert_eq!(
            json(&r.snapshot().members),
            r#"[{"id":"m1","nickname":"alice","avatar":0,"standingSlot":0,"away":true}]"#
        );
        assert!(r.set_away(&a, false));
        assert!(!r.set_away(&mid("ghost"), true));
    }

    // apps/server/test/member-status.test.ts
    #[test]
    fn catching_is_announced_by_difference() {
        let mut r = room();
        let a = join(&mut r, "m1", "alice", None);
        assert_eq!(r.take_catching_change(&a), None);
        r.set_catching(&a, true);
        assert!(r.is_catching(&a));
        assert_eq!(r.take_catching_change(&a), Some(true));
        assert_eq!(r.take_catching_change(&a), None);
        r.set_catching(&a, true);
        assert_eq!(r.take_catching_change(&a), None);
        r.set_catching(&a, false);
        assert_eq!(r.take_catching_change(&a), Some(false));
        assert_eq!(r.take_catching_change(&a), None);
        // A flip back before anyone asked is no change.
        r.set_catching(&a, true);
        r.set_catching(&a, false);
        assert_eq!(r.take_catching_change(&a), None);
    }

    #[test]
    fn only_members_can_catch() {
        let mut r = room();
        r.set_catching(&mid("ghost"), true);
        assert!(!r.is_catching(&mid("ghost")));
        assert_eq!(r.take_catching_change(&mid("ghost")), None);
    }

    // ---- embed, playback, rev

    #[test]
    fn sharing_a_synced_embed_loads_it_at_0_by_the_sharer_and_makes_it_the_current_item() {
        let mut r = room();
        let a = join(&mut r, "m1", "alice", None);
        let sw = r.set_embed(Some(yt()), Some(a.clone()), Some(iid("item1")), 12.5, T0 + 5).unwrap();
        assert!(sw.uncaught.is_empty());
        assert_eq!(
            json(&sw.playback),
            r#"{"playing":true,"position":0,"rate":1,"at":1700000000005,"rev":0,"action":"load","by":"m1"}"#
        );
        assert_eq!(r.current_playback(), sw.playback.as_ref());
        assert_eq!(
            (r.item_id(), r.item_since(), r.current_embed()),
            (Some(&iid("item1")), 12.5, Some(&yt()))
        );
        assert!(!r.has_generic_embed());
    }

    #[test]
    fn set_embed_mints_an_item_id_unless_given_or_unset() {
        let mut r = room();
        r.set_embed(Some(yt()), None, None, 0.0, T0).unwrap();
        let first = r.item_id().cloned().unwrap();
        assert_eq!(first.as_str().len(), 16);
        r.set_embed(Some(vimeo()), None, None, 0.0, T0).unwrap();
        assert_ne!(r.item_id(), Some(&first));
        r.set_embed(None, None, Some(iid("ignored")), 3.0, T0).unwrap();
        assert!(r.item_id().is_none() && r.current_embed().is_none());
        assert_eq!(r.item_since(), 3.0);
    }

    #[test]
    fn rev_never_goes_back_across_embed_changes() {
        let mut r = room();
        let a = join(&mut r, "m1", "alice", None);
        let rev = |r: &mut Room, e: Option<AnyEmbed>| r.set_embed(e, None, Some(iid("i")), 0.0, T0).unwrap().playback.map(|p| p.rev.0);
        assert_eq!(rev(&mut r, Some(yt())), Some(0));
        assert_eq!(r.control(&a, &ctl(false, 0.0), T0 + 1).unwrap().rev, Rev(1));
        assert_eq!(rev(&mut r, Some(vimeo())), Some(2));
        assert_eq!(rev(&mut r, None), None);
        assert_eq!(rev(&mut r, Some(generic())), None);
        assert_eq!(rev(&mut r, Some(yt())), Some(3));
    }

    // ADR 0024 section 7
    #[test]
    fn a_generic_or_no_embed_clears_playback_and_every_catching_flag() {
        let mut r = room();
        let a = join(&mut r, "m1", "alice", None);
        let b = join(&mut r, "m2", "bob", None);
        let c = join(&mut r, "m3", "carol", None);
        r.set_embed(Some(yt()), None, Some(iid("i")), 0.0, T0).unwrap();
        for m in [&a, &b, &c] {
            r.set_catching(m, true);
        }
        // Announced b, then a: the room was told in that order; c was never told.
        r.take_catching_change(&b);
        r.take_catching_change(&a);
        let sw = r.set_embed(Some(generic()), None, Some(iid("g")), 0.0, T0).unwrap();
        assert_eq!(sw.playback, None);
        assert_eq!(sw.uncaught, [b.clone(), a.clone()]);
        assert!(r.current_playback().is_none() && r.has_generic_embed());
        assert!([&a, &b, &c].iter().all(|m| !r.is_catching(m)));
        assert!(json(&r.snapshot().members).find("catching").is_none());
        // Nothing left to announce.
        assert_eq!(r.set_embed(None, None, None, 0.0, T0).unwrap().uncaught, []);
    }

    #[test]
    fn a_synced_embed_keeps_catching_flags() {
        let mut r = room();
        let a = join(&mut r, "m1", "alice", None);
        r.set_embed(Some(yt()), None, Some(iid("i")), 0.0, T0).unwrap();
        r.set_catching(&a, true);
        r.take_catching_change(&a);
        let sw = r.set_embed(Some(vimeo()), None, Some(iid("j")), 0.0, T0).unwrap();
        assert!(sw.uncaught.is_empty() && r.is_catching(&a));
    }

    #[test]
    fn re_announcing_moves_a_member_to_the_end_of_the_uncaught_order() {
        let mut r = room();
        let a = join(&mut r, "m1", "alice", None);
        let b = join(&mut r, "m2", "bob", None);
        for m in [&a, &b] {
            r.set_catching(m, true);
            r.take_catching_change(m);
        }
        r.set_catching(&a, false);
        r.take_catching_change(&a);
        r.set_catching(&a, true);
        r.take_catching_change(&a);
        let sw = r.set_embed(None, None, None, 0.0, T0).unwrap();
        assert_eq!(sw.uncaught, [b, a]);
    }

    #[test]
    fn control_applies_only_to_the_current_synced_embed() {
        let mut r = room();
        let a = join(&mut r, "m1", "alice", None);
        assert_eq!(r.control(&a, &ctl(true, 0.0), T0), None);
        r.set_embed(Some(yt()), None, Some(iid("i")), 0.0, T0).unwrap();
        let other = Control {
            url: "https://www.youtube.com/embed/aaaaaaaaaaa",
            playing: true,
            position: 0.0,
        };
        assert_eq!(r.control(&a, &other, T0), None);
        let next = r.control(&a, &ctl(false, 40.0), T0 + 10_000).unwrap();
        assert_eq!((next.action, next.by.as_ref(), next.rev), (PlaybackAction::Seek, Some(&a), Rev(1)));
        assert_eq!(r.current_playback(), Some(&next));
        r.set_embed(Some(generic()), None, Some(iid("g")), 0.0, T0).unwrap();
        let url = r.current_embed().unwrap().url().to_owned();
        assert_eq!(
            r.control(
                &a,
                &Control {
                    url: &url,
                    playing: true,
                    position: 0.0
                },
                T0
            ),
            None
        );
    }

    #[test]
    fn a_live_embed_controls_at_position_0() {
        let mut r = room();
        let a = join(&mut r, "m1", "alice", None);
        let e = live();
        r.set_embed(Some(e.clone()), None, Some(iid("i")), 0.0, T0).unwrap();
        let c = Control {
            url: e.url(),
            playing: false,
            position: 77.0,
        };
        let next = r.control(&a, &c, T0 + 1000).unwrap();
        assert_eq!(
            (next.position.get(), next.action, next.playing),
            (0.0, PlaybackAction::Pause, false)
        );
    }

    // ---- queue

    #[test]
    fn enqueue_dequeue_keep_play_order() {
        let mut r = room();
        r.enqueue(queued("q1", yt(), Some("m1")));
        r.enqueue(queued("q2", vimeo(), None));
        r.enqueue(queued("q3", live(), Some("m2")));
        assert!(r.dequeue(&iid("q2")));
        assert!(!r.dequeue(&iid("q2")));
        assert!(!r.dequeue(&iid("nope")));
        let order: Vec<_> = r.queue().iter().map(|i| i.id.as_str()).collect();
        assert_eq!(order, ["q1", "q3"]);
    }

    // apps/server/test/queue.test.ts
    #[test]
    fn advance_makes_the_first_item_current_by_the_given_member() {
        let mut r = room();
        let a = join(&mut r, "m1", "alice", None);
        assert_eq!(r.advance(1.0, None, T0), None);
        r.enqueue(queued("q1", vimeo(), Some("m1")));
        r.enqueue(queued("q2", live(), None));
        r.set_embed(Some(yt()), None, Some(iid("cur")), 0.0, T0).unwrap();
        let adv = r.advance(500.0, Some(a.clone()), T0 + 9).unwrap();
        assert_eq!(adv.item, queued("q1", vimeo(), Some("m1")));
        let p = adv.embed_switch.playback.unwrap();
        assert_eq!(
            (p.action, p.rev, p.by.as_ref(), p.at.0),
            (PlaybackAction::Load, Rev(1), Some(&a), 1_700_000_000_009)
        );
        assert_eq!(
            (r.item_id(), r.item_since(), r.current_embed()),
            (Some(&iid("q1")), 500.0, Some(&vimeo()))
        );
        assert_eq!(r.queue().len(), 1);
        // Into a generic embed: no playback, nobody to tell.
        let adv = r.advance(600.0, None, T0).unwrap();
        assert!(adv.embed_switch.playback.is_some());
        assert!(r.queue().is_empty());
        assert_eq!(r.advance(1.0, None, T0), None);
    }

    #[test]
    fn advancing_into_a_generic_embed_clears_playback_and_catching() {
        let mut r = room();
        let a = join(&mut r, "m1", "alice", None);
        r.set_embed(Some(yt()), None, Some(iid("cur")), 0.0, T0).unwrap();
        r.set_catching(&a, true);
        r.take_catching_change(&a);
        r.enqueue(queued("g1", generic(), None));
        let adv = r.advance(2.0, None, T0).unwrap();
        assert_eq!((adv.embed_switch.playback, adv.embed_switch.uncaught), (None, vec![a]));
        assert!(r.current_playback().is_none() && r.has_generic_embed());
    }

    // ---- snapshot, view, summary

    #[test]
    fn an_empty_untitled_room_snapshots_without_title_item_or_queue() {
        let r = room();
        let s = json(&r.snapshot());
        assert!(s.starts_with(r#"{"id":"film-club","seats":[null,null,null,null,null,null,null,null],"members":[],"embed":null,"playback":null,"layout":{"#), "{s}");
        assert!(s.ends_with(r#""controlPolicy":"everyone"}"#), "{s}");
    }

    #[test]
    fn a_full_snapshot_has_the_ts_key_order_and_join_order() {
        let mut r = room_with(RoomInit {
            title: RoomTitle::parse("Friday films"),
            ..RoomInit::default()
        });
        let a = join(&mut r, "m1", "alice", None);
        let b = join(&mut r, "m2", "bob", None);
        let c = join(&mut r, "m3", "carol", None);
        r.leave(&b, T0);
        let b2 = join(&mut r, "m4", "bob", None);
        r.sit(&c, Some(seat(2)));
        r.sit(&a, Some(seat(0)));
        r.set_muted(&a, true);
        r.set_away(&c, true);
        r.set_catching(&b2, true);
        r.set_embed(Some(yt()), Some(a.clone()), Some(iid("cur1")), 0.0, T0).unwrap();
        r.enqueue(queued("q1", vimeo(), Some("m3")));
        let snap = r.snapshot();
        assert_eq!(ids(&snap.members), ["m1", "m3", "m4"]);
        let text = json(&snap);
        let (head, rest) = text.split_once(r#","layout":"#).unwrap();
        assert_eq!(
            head,
            concat!(
                r#"{"id":"film-club","seats":["m1",null,"m3",null,null,null,null,null],"members":["#,
                r#"{"id":"m1","nickname":"alice","avatar":0,"standingSlot":0,"muted":true},"#,
                r#"{"id":"m3","nickname":"carol","avatar":0,"standingSlot":2,"away":true},"#,
                r#"{"id":"m4","nickname":"bob","avatar":0,"standingSlot":1,"catching":true}],"#,
                r#""embed":{"provider":"youtube","videoId":"dQw4w9WgXcQ","url":"https://www.youtube.com/embed/dQw4w9WgXcQ"},"#,
                r#""playback":{"playing":true,"position":0,"rate":1,"at":1700000000000,"rev":0,"action":"load","by":"m1"}"#
            )
        );
        assert!(rest.contains(r#""controlPolicy":"everyone","title":"Friday films","itemId":"cur1","queue":[{"id":"q1","embed":{"provider":"vimeo","videoId":"76979871","hash":null,"url":"https://player.vimeo.com/video/76979871"},"by":"m3"}]}"#), "{rest}");
        assert_eq!(snap.seats.len(), SEAT_COUNT);
    }

    #[test]
    fn view_adds_flags_only_when_true() {
        let mut r = room();
        let a = join(&mut r, "m1", "alice", None);
        let bare = r.member(&a).unwrap().clone();
        assert_eq!(r.view(&bare), bare);
        r.set_muted(&a, true);
        r.set_catching(&a, true);
        r.set_away(&a, true);
        let v = r.view(&bare);
        assert_eq!(
            json(&v),
            r#"{"id":"m1","nickname":"alice","avatar":0,"standingSlot":0,"catching":true,"muted":true,"away":true}"#
        );
        r.set_muted(&a, false);
        assert_eq!(r.view(&bare).muted, None);
        // The stored member never carries flags.
        assert_eq!(r.member(&a), Some(&bare));
    }

    #[test]
    fn summary_counts_members_and_seated_and_omits_an_empty_title() {
        let mut r = room();
        assert_eq!(json(&r.summary()), r#"{"id":"film-club","memberCount":0,"seatedCount":0}"#);
        let a = join(&mut r, "m1", "alice", None);
        join(&mut r, "m2", "bob", None);
        r.sit(&a, Some(seat(1)));
        r.set_title(RoomTitle::parse("Friday films"));
        assert_eq!(
            json(&r.summary()),
            r#"{"id":"film-club","memberCount":2,"seatedCount":1,"title":"Friday films"}"#
        );
        r.set_title(None);
        assert!(r.title().is_none());
    }

    #[test]
    fn layout_and_policy_are_replaced() {
        let mut r = room();
        let cafe = crate::presets::Presets::load()
            .unwrap()
            .preset_layout(crate::contract::layout::RoomPresetId::Cafe)
            .clone();
        assert_ne!(r.layout(), &cafe);
        r.set_layout(cafe.clone());
        assert_eq!(r.layout(), &cafe);
        r.set_control_policy(ControlPolicy::Owner);
        assert_eq!(r.control_policy(), ControlPolicy::Owner);
    }

    // ---- secrets

    // apps/server/test/room-auth.test.ts
    #[test]
    fn owner_and_invite_checks_match_the_hash_and_a_missing_hash_matches_nothing() {
        let r = room_with(RoomInit {
            owner_hash: Some(hash_secret("owner-token")),
            invite_hash: Some(hash_secret("invite-key")),
            ..RoomInit::default()
        });
        assert!(r.is_owner("owner-token") && !r.is_owner("owner-tokem") && !r.is_owner("") && !r.is_owner("invite-key"));
        assert!(r.is_invited("invite-key") && !r.is_invited("owner-token"));
        let seed = room();
        assert!(!seed.is_owner("") && !seed.is_invited("") && !seed.is_owner("anything"));
    }
    // ---- free walking and tint (OME-1346, ADR 0053)

    fn cell(x: u64, y: u64) -> FloorCell {
        FloorCell::new(x, y).unwrap()
    }
    /// The default layout plus `extra` pieces (JSON objects).
    fn layout_plus(extra: &[serde_json::Value]) -> RoomLayout {
        let mut v: serde_json::Value = serde_json::from_str(&default_layout().to_json()).unwrap();
        v["furniture"].as_array_mut().unwrap().extend(extra.iter().cloned());
        RoomLayout::parse(v.to_string().as_bytes()).unwrap()
    }
    fn table(col: u8, row: u8) -> serde_json::Value {
        serde_json::json!({"kind":"sidetable","col":col,"row":row,"facing":"se"})
    }

    #[test]
    fn walking_to_free_floor_or_a_rug_sets_the_cell() {
        let mut r = room();
        let a = join(&mut r, "m1", "alice", None);
        assert_eq!(r.walk(&a, cell(3, 3)), WalkResult::Walked { stood_up: false });
        assert_eq!(r.member(&a).unwrap().cell, Some(cell(3, 3)));
        assert_eq!(
            json(&r.snapshot().members[0]),
            r#"{"id":"m1","nickname":"alice","avatar":0,"standingSlot":0,"cell":{"x":3,"y":3}}"#
        );
        assert_eq!(r.walk(&a, cell(9, 9)), WalkResult::Walked { stood_up: false });
        assert_eq!(r.member(&a).unwrap().cell, Some(cell(9, 9)));
    }

    #[test]
    fn solid_pieces_and_seats_refuse_a_walk() {
        let mut r = room();
        let a = join(&mut r, "m1", "alice", None);
        r.walk(&a, cell(3, 3));
        // the tv, an armchair (seat 0), the lamp
        for c in [cell(0, 0), cell(1, 5), cell(9, 0)] {
            assert_eq!(r.walk(&a, c), WalkResult::Blocked);
        }
        assert_eq!(r.member(&a).unwrap().cell, Some(cell(3, 3)));
        assert_eq!(r.walk(&mid("ghost"), cell(3, 3)), WalkResult::NotMember);
    }

    #[test]
    fn walking_off_a_seat_stands_up_and_sitting_clears_the_cell() {
        let mut r = room();
        let a = join(&mut r, "m1", "alice", None);
        r.sit(&a, Some(seat(2)));
        assert_eq!(r.walk(&a, cell(4, 4)), WalkResult::Walked { stood_up: true });
        assert!(r.snapshot().seats.iter().all(Option::is_none));
        assert_eq!(r.sit(&a, Some(seat(2))), SitResult::Ok);
        assert_eq!(r.member(&a).unwrap().cell, None);
        r.walk(&a, cell(4, 4));
        assert_eq!(r.sit(&a, None), SitResult::Ok);
        assert_eq!(r.member(&a).unwrap().cell, None, "standing up goes back to the standing spot");
        // A refused sit keeps the cell.
        let b = join(&mut r, "m2", "bob", None);
        r.sit(&b, Some(seat(2)));
        r.walk(&a, cell(4, 4));
        assert_eq!(r.sit(&a, Some(seat(2))), SitResult::SeatTaken);
        assert_eq!(r.member(&a).unwrap().cell, Some(cell(4, 4)));
    }

    #[test]
    fn a_layout_that_covers_a_standing_cell_moves_them_to_the_door() {
        let mut r = room();
        let a = join(&mut r, "m1", "alice", None);
        let b = join(&mut r, "m2", "bob", None);
        let c = join(&mut r, "m3", "carol", None);
        r.walk(&a, cell(8, 8));
        r.walk(&b, cell(3, 3));
        r.sit(&c, Some(seat(0)));
        assert_eq!(r.set_layout(layout_plus(&[table(8, 8)])), vec![(a.clone(), Some(cell(9, 9)))]);
        assert_eq!(r.member(&a).unwrap().cell, Some(cell(9, 9)));
        assert_eq!(r.member(&b).unwrap().cell, Some(cell(3, 3)));
        // The door itself covered: back to the standing spot.
        assert_eq!(r.set_layout(layout_plus(&[table(8, 8), table(9, 9)])), vec![(a.clone(), None)]);
        assert_eq!(r.member(&a).unwrap().cell, None);
        assert_eq!(r.set_layout(default_layout()), vec![]);
    }

    #[test]
    fn tint_is_absent_at_0_and_changes_once() {
        let mut r = room();
        let a = join(&mut r, "m1", "alice", None);
        assert!(!r.set_tint(&a, Tint::new(0).unwrap()));
        assert!(r.set_tint(&a, Tint::new(4).unwrap()));
        assert!(!r.set_tint(&a, Tint::new(4).unwrap()));
        assert!(!r.set_tint(&mid("ghost"), Tint::new(1).unwrap()));
        assert_eq!(
            json(&r.snapshot().members[0]),
            r#"{"id":"m1","nickname":"alice","avatar":0,"standingSlot":0,"tint":4}"#
        );
        assert!(r.set_tint(&a, Tint::new(0).unwrap()));
        assert_eq!(
            json(&r.snapshot().members[0]),
            r#"{"id":"m1","nickname":"alice","avatar":0,"standingSlot":0}"#
        );
    }

    #[test]
    fn hair_is_absent_at_0_and_changes_once() {
        let mut r = room();
        let a = join(&mut r, "m1", "alice", None);
        assert!(!r.set_hair(&a, Hair::new(0).unwrap()));
        assert!(r.set_hair(&a, Hair::new(5).unwrap()));
        assert!(!r.set_hair(&a, Hair::new(5).unwrap()));
        assert!(!r.set_hair(&mid("ghost"), Hair::new(1).unwrap()));
        assert_eq!(
            json(&r.snapshot().members[0]),
            r#"{"id":"m1","nickname":"alice","avatar":0,"standingSlot":0,"hair":5}"#
        );
        assert!(r.set_hair(&a, Hair::new(0).unwrap()));
        assert_eq!(
            json(&r.snapshot().members[0]),
            r#"{"id":"m1","nickname":"alice","avatar":0,"standingSlot":0}"#
        );
    }

    #[test]
    fn accessory_is_absent_at_0_and_changes_once() {
        let mut r = room();
        let a = join(&mut r, "m1", "alice", None);
        assert!(!r.set_accessory(&a, Accessory::new(0).unwrap()));
        assert!(r.set_accessory(&a, Accessory::new(4).unwrap()));
        assert!(!r.set_accessory(&a, Accessory::new(4).unwrap()));
        assert!(!r.set_accessory(&mid("ghost"), Accessory::new(1).unwrap()));
        assert_eq!(
            json(&r.snapshot().members[0]),
            r#"{"id":"m1","nickname":"alice","avatar":0,"standingSlot":0,"accessory":4}"#
        );
        assert!(r.set_accessory(&a, Accessory::new(0).unwrap()));
        assert_eq!(
            json(&r.snapshot().members[0]),
            r#"{"id":"m1","nickname":"alice","avatar":0,"standingSlot":0}"#
        );
    }

    #[test]
    fn typing_changes_once_and_is_never_in_the_snapshot() {
        let mut r = room();
        let a = join(&mut r, "m1", "alice", None);
        assert!(!r.set_typing(&a, false));
        assert!(r.set_typing(&a, true));
        assert!(!r.set_typing(&a, true));
        assert!(!r.set_typing(&mid("ghost"), true));
        assert_eq!(
            json(&r.snapshot().members[0]),
            r#"{"id":"m1","nickname":"alice","avatar":0,"standingSlot":0}"#
        );
        assert!(r.set_typing(&a, false));
        assert!(!r.set_typing(&a, false));
    }
}

/// ADR 0032 "name hashes only": nothing a room holds that identifies a person or a video reaches a `{:?}`
/// (panic messages and logs print them).
#[cfg(test)]
#[allow(clippy::unwrap_used, reason = "tests")]
mod debug_tests {
    use super::*;
    use crate::contract::text::RoomTitle;
    use crate::embed_policy::EmbedPolicy;

    #[test]
    fn a_held_seats_debug_has_no_name_hash() {
        let held = HeldSeat {
            name_hash: [0xab; 32],
            seat: SeatIndex::new(3).unwrap(),
        };
        let text = format!("{held:?}");
        assert!(text.contains("HeldSeat") && text.contains("seat"), "{text}");
        assert!(!text.contains("171") && !text.contains("ab"), "{text}");
    }

    #[test]
    fn a_room_inits_debug_has_no_title_embed_hashes_or_queue() {
        let embed = EmbedPolicy::new(true, &[], &[])
            .unwrap()
            .accept("https://youtu.be/dQw4w9WgXcQ")
            .unwrap();
        let init = RoomInit {
            title: Some(RoomTitle::parse("Secret club").unwrap()),
            embed: Some(embed.clone()),
            owner_hash: Some([9; 32]),
            invite_hash: Some([8; 32]),
            queue: vec![(mint_item_id().unwrap(), embed)],
            ..RoomInit::default()
        };
        let text = format!("{init:?}");
        assert!(text.contains("RoomInit"), "{text}");
        for leak in ["Secret", "youtube", "dQw4w9WgXcQ", "9, 9", "8, 8"] {
            assert!(!text.contains(leak), "{leak} in {text}");
        }
    }
}
