//! Port of `apps/server/src/queue.ts`: the playback queue (ADR 0031), the checks, the store-first writes and the
//! frames, for the WebSocket handlers and `POST /rooms/:id/queue` alike.
//!
//! Every function runs synchronously under the room's lock (`inner` is the locked [`RoomInner`]); it may take
//! the store lock (room, then store) and publishes through the room's outboxes. Nothing here awaits.
//!
//! Call order for an add: [`admit`] (checks and spends the buckets, before the URL is looked at), then [`add`].

use crate::app::App;
use crate::contract::capabilities::playback_caps;
use crate::contract::constants::{QUEUE_ENDED_DEBOUNCE_MS, QUEUE_ENDED_TOLERANCE_S, QUEUE_MAX};
use crate::contract::generic_embed::AnyEmbed;
use crate::contract::ids::{MemberId, QueueItemId};
use crate::contract::room::ControlPolicy;
use crate::contract::server_message::ServerMessage;
use crate::contract::state::QueueItem;
use crate::log::{LogEvent, log_error};
use crate::outbox::publish_msg;
use crate::playback::expected_position;
use crate::registry::RoomInner;
use crate::room::Advance;
use crate::secrets::mint_item_id;
use crate::store::{RoomStore, StoreError, StoredQueueItem};

/// Who is changing the queue: the member, and whether they joined as owner. Their add bucket is
/// `RoomInner::member_add_bucket(member_id)`, shared by the socket and HTTP.
#[derive(Debug, Clone)]
pub struct QueueActor {
    pub member_id: MemberId,
    pub owner: bool,
}

/// Why `admit`, `remove` or `advance` refused: the control policy, or an add bucket.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum QueueRefusal {
    ControlOwnerOnly,
    RateLimited { retry_after_ms: u64 },
}

/// Why `add` refused an admitted URL.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum QueueAddRefusal {
    UnsupportedUrl,
    QueueFull,
    /// The store write failed: nothing changed, and the adds were given back.
    Unavailable,
}

/// A `queue-add`'s checks before the URL is looked at (ADR 0031 section 3): control policy, then the member's
/// bucket, then the room's. `Ok` when they pass (the buckets are spent).
pub fn admit(app: &App, inner: &mut RoomInner, actor: &QueueActor) -> Result<(), QueueRefusal> {
    if inner.room.control_policy() == ControlPolicy::Owner && !actor.owner {
        return Err(QueueRefusal::ControlOwnerOnly);
    }
    let now = app.mono();
    let member = inner.member_add_bucket(&actor.member_id, now);
    if !member.take(now) {
        return Err(QueueRefusal::RateLimited {
            retry_after_ms: member.retry_after_ms(now) as u64,
        });
    }
    if !inner.queue_add_bucket.take(now) {
        // The room's limit is everyone's: the member keeps their own add.
        inner.member_add_bucket(&actor.member_id, now).refund(now);
        return Err(QueueRefusal::RateLimited {
            retry_after_ms: inner.queue_add_bucket.retry_after_ms(now) as u64,
        });
    }
    Ok(())
}

fn owner_only(inner: &RoomInner, actor: &QueueActor) -> Result<(), QueueRefusal> {
    if inner.room.control_policy() == ControlPolicy::Owner && !actor.owner {
        Err(QueueRefusal::ControlOwnerOnly)
    } else {
        Ok(())
    }
}

/// Store first: if the write fails nothing changes, so memory never runs ahead of the database.
fn persisted<T>(app: &App, write: impl FnOnce(&RoomStore<'_>) -> Result<T, StoreError>) -> bool {
    let store = app.store();
    match write(&store.rooms()) {
        Ok(_) => true,
        Err(err) => {
            log_error(LogEvent::StoreQueue, Some(&err));
            false
        }
    }
}

fn queue_changed(inner: &mut RoomInner, by: Option<MemberId>) {
    let queue = inner.room.queue().iter().cloned().collect();
    publish_msg(inner, &ServerMessage::QueueChanged { queue, by });
}

/// Memory and frames of an advance whose write has landed (ADR 0031 section 5): embed-changed (the spread's
/// critical path, by `started_by`), then queue-changed (by `by`), then who stopped catching.
fn started(app: &App, inner: &mut RoomInner, started_by: Option<MemberId>, by: Option<MemberId>) {
    let Some(advanced) = inner.room.advance(app.mono(), started_by.clone(), app.wall()) else {
        return;
    };
    let Advance { item, embed_switch } = advanced;
    publish_msg(
        inner,
        &ServerMessage::embed_changed(Some(item.embed), started_by, embed_switch.playback, Some(item.id)),
    );
    queue_changed(inner, by);
    for member_id in embed_switch.uncaught {
        publish_msg(
            inner,
            &ServerMessage::MemberStatus {
                member_id,
                catching: false,
            },
        );
    }
}

/// One synchronous step (ADR 0031 section 5): store, then memory and frames.
fn advance_now(app: &App, inner: &mut RoomInner, by: Option<MemberId>) {
    let Some(next) = inner.room.queue().front().cloned() else {
        return;
    };
    let stored = StoredQueueItem {
        id: next.id,
        embed: next.embed,
    };
    if !persisted(app, |s| s.advance_queue(&inner.room.id, &stored)) {
        return;
    }
    started(app, inner, None, by);
}

/// After `admit`: parses `url` with the share parser, checks `QUEUE_MAX`, stores, then tells the room. In a room
/// with no current item the same write starts the queue's head (ADR 0031 section 5).
pub fn add(app: &App, inner: &mut RoomInner, actor: &QueueActor, url: &str) -> Result<QueueItem, QueueAddRefusal> {
    // Only the parsed embed is ever stored or relayed (ADR 0031 section 2, ADR 0024).
    let Some(embed) = app.embeds.accept(url) else {
        return Err(QueueAddRefusal::UnsupportedUrl);
    };
    // Refuse, never evict.
    if inner.room.queue().len() >= QUEUE_MAX {
        return Err(QueueAddRefusal::QueueFull);
    }
    let now = app.mono();
    let give_back = |inner: &mut RoomInner| {
        // The server's failure, not the member's: they keep their adds.
        inner.member_add_bucket(&actor.member_id, now).refund(now);
        inner.queue_add_bucket.refund(now);
        QueueAddRefusal::Unavailable
    };
    let Ok(id) = mint_item_id() else {
        return Err(give_back(inner));
    };
    let item = QueueItem {
        id,
        embed,
        by: Some(actor.member_id.clone()),
    };
    let new = StoredQueueItem {
        id: item.id.clone(),
        embed: item.embed.clone(),
    };
    // Nothing for ended or queue-advance to name: the add starts the head itself (normally `item`; a queue left
    // over after a dropped embed row plays first).
    let head = inner.room.item_id().is_none().then(|| {
        inner.room.queue().front().map_or_else(
            || new.clone(),
            |h| StoredQueueItem {
                id: h.id.clone(),
                embed: h.embed.clone(),
            },
        )
    });
    let room_id = inner.room.id.clone();
    let written = persisted(app, |s| match &head {
        None => s.add_queue_item(&room_id, &new),
        Some(head) => s.add_queue_item_and_start(&room_id, &new, head),
    });
    if !written {
        return Err(give_back(inner));
    }
    inner.room.enqueue(item.clone());
    let by = Some(actor.member_id.clone());
    if head.is_none() {
        queue_changed(inner, by);
    } else {
        started(app, inner, by.clone(), by);
    }
    Ok(item)
}

/// `queue-remove`: refused under the owner policy; an item that isn't there is ignored (`Ok`).
pub fn remove(app: &App, inner: &mut RoomInner, actor: &QueueActor, item: &QueueItemId) -> Result<(), QueueRefusal> {
    owner_only(inner, actor)?;
    // Removed already, or advanced: a race, not a mistake.
    if !inner.room.queue().iter().any(|i| i.id == *item) {
        return Ok(());
    }
    if !persisted(app, |s| s.remove_queue_item(&inner.room.id, item)) {
        return Ok(());
    }
    inner.room.dequeue(item);
    queue_changed(inner, Some(actor.member_id.clone()));
    Ok(())
}

/// `queue-advance`: refused under the owner policy; ignored (`Ok`) unless `from` is the current item.
pub fn advance(app: &App, inner: &mut RoomInner, actor: &QueueActor, from: &QueueItemId) -> Result<(), QueueRefusal> {
    owner_only(inner, actor)?;
    // Two clicks from the same item skip one item: the second names what is no longer current.
    if inner.room.item_id() == Some(from) {
        advance_now(app, inner, Some(actor.member_id.clone()));
    }
    Ok(())
}

/// `ended` from a joined member: advances on the first valid report (ADR 0031 section 4), else nothing.
/// Not subject to the control policy.
pub fn ended(app: &App, inner: &mut RoomInner, item: &QueueItemId, position: f64) {
    if inner.room.item_id() != Some(item) {
        return;
    }
    // Live embeds never end and generic ones have no API: they advance by queue-advance only.
    let Some(AnyEmbed::Synced(embed)) = inner.room.current_embed() else {
        return;
    };
    if playback_caps(embed).live {
        return;
    }
    if app.mono() - inner.room.item_since() < QUEUE_ENDED_DEBOUNCE_MS as f64 {
        return;
    }
    let Some(playback) = inner.room.current_playback() else {
        return;
    };
    // Drops reports from before a seek, and local-only seeks (R1 B3).
    if (position - expected_position(playback, app.wall())).abs() > QUEUE_ENDED_TOLERANCE_S {
        return;
    }
    advance_now(app, inner, None);
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::indexing_slicing, reason = "tests")]
mod tests {
    use super::*;
    use crate::app::testing::*;
    use crate::contract::constants::{QUEUE_ADD_MEMBER_BURST, QUEUE_ADD_MEMBER_REFILL_MS, QUEUE_ADD_ROOM_BURST, QUEUE_MAX};
    use crate::contract::room::ControlPolicy;
    use crate::outbox::{ConnId, Outbound, OutboxRx, channel};
    use crate::registry::RoomCell;
    use crate::room::{Room, RoomInit};
    use serde_json::Value;
    use std::sync::Arc;

    const YT1: &str = "https://youtu.be/dQw4w9WgXcQ";
    const YT2: &str = "https://youtu.be/9bZkp7q19f0";
    const GENERIC: &str = "https://player.example-host.net/embed/42";
    const TWITCH_LIVE: &str = "https://www.twitch.tv/somechannel";

    fn actor(id: &str, owner: bool) -> QueueActor {
        QueueActor {
            member_id: MemberId::parse(id).unwrap(),
            owner,
        }
    }

    /// A room with a subscribed watcher; frames come back as JSON.
    struct Fixture {
        app: Arc<crate::app::App>,
        clock: Arc<ManualClock>,
        cell: Arc<RoomCell>,
        rx: OutboxRx,
    }

    fn fixture_with(config: crate::config::ServerConfig, init: RoomInit) -> Fixture {
        let (app, clock) = app_with(config);
        let cell = add_room(&app, "film-club", init);
        let (tx, rx) = channel();
        {
            let mut inner = cell.lock();
            inner.subscribers.attach(ConnId(1), tx);
            inner.subscribers.subscribe(ConnId(1));
        }
        Fixture { app, clock, cell, rx }
    }

    fn fixture() -> Fixture {
        fixture_with(config(&[]), RoomInit::default())
    }

    impl Fixture {
        fn frames(&mut self) -> Vec<Value> {
            let mut out = Vec::new();
            while let Some(Outbound::Text(t)) = self.rx.try_recv() {
                out.push(serde_json::from_str(t.as_str()).unwrap());
            }
            out
        }

        fn add(&self, who: &QueueActor, url: &str) -> Result<QueueItem, QueueAddRefusal> {
            let mut inner = self.cell.lock();
            add(&self.app, &mut inner, who, url)
        }

        fn admit_add(&self, who: &QueueActor, url: &str) -> Result<QueueItem, QueueRefusal> {
            let mut inner = self.cell.lock();
            admit(&self.app, &mut inner, who)?;
            Ok(add(&self.app, &mut inner, who, url).unwrap_or_else(|e| panic!("{e:?}")))
        }

        fn queue_ids(&self) -> Vec<String> {
            self.cell.lock().room.queue().iter().map(|i| i.id.as_str().to_owned()).collect()
        }

        fn current(&self) -> Option<String> {
            self.cell.lock().room.item_id().map(|i| i.as_str().to_owned())
        }

        /// Makes `url` the current embed, as a share would (item since now).
        fn share(&self, url: &str) -> QueueItemId {
            let embed = self.app.embeds.accept(url).unwrap();
            let mut inner = self.cell.lock();
            inner
                .room
                .set_embed(Some(embed), None, None, self.app.mono(), self.app.wall())
                .unwrap();
            inner.room.item_id().unwrap().clone()
        }

        fn stored(&self) -> crate::store::StoredRoom {
            self.app.store().rooms().list_rooms().unwrap().remove(0)
        }
    }

    fn types(frames: &[Value]) -> Vec<&str> {
        frames.iter().map(|f| f["type"].as_str().unwrap()).collect()
    }

    // apps/server/test/queue.test.ts:167
    #[test]
    fn per_member_a_burst_then_rate_limited_with_a_wait_until_the_bucket_refills() {
        let f = fixture();
        let a = actor("alice", false);
        for _ in 0..QUEUE_ADD_MEMBER_BURST {
            f.admit_add(&a, YT1).unwrap();
        }
        let mut inner = f.cell.lock();
        let Err(QueueRefusal::RateLimited { retry_after_ms }) = admit(&f.app, &mut inner, &a) else {
            panic!("expected rate_limited")
        };
        assert!(
            retry_after_ms > 0 && retry_after_ms <= QUEUE_ADD_MEMBER_REFILL_MS,
            "{retry_after_ms}"
        );
        drop(inner);
        f.clock.set_mono(f.app.mono() + QUEUE_ADD_MEMBER_REFILL_MS as f64);
        let mut inner = f.cell.lock();
        assert!(admit(&f.app, &mut inner, &a).is_ok());
    }

    // apps/server/test/queue.test.ts:182
    #[test]
    fn a_refusal_by_the_rooms_bucket_gives_the_members_add_back() {
        let f = fixture();
        // Others drain the room's ten.
        for i in 0..QUEUE_ADD_ROOM_BURST {
            let who = actor(&format!("m{i}"), false);
            let mut inner = f.cell.lock();
            admit(&f.app, &mut inner, &who).unwrap();
        }
        let a = actor("alice", false);
        for _ in 0..5 {
            let mut inner = f.cell.lock();
            assert!(matches!(admit(&f.app, &mut inner, &a), Err(QueueRefusal::RateLimited { .. })));
        }
        // Five refusals by the room did not spend alice's own three.
        let mut inner = f.cell.lock();
        assert!(inner.member_add_bucket(&a.member_id, f.app.mono()).take(f.app.mono()));
        assert!(inner.member_add_bucket(&a.member_id, f.app.mono()).take(f.app.mono()));
        assert!(inner.member_add_bucket(&a.member_id, f.app.mono()).take(f.app.mono()));
    }

    // apps/server/test/queue.test.ts:218
    #[test]
    fn per_room_ten_at_once_from_everyone_together_then_rate_limited() {
        let f = fixture();
        for i in 0..QUEUE_ADD_ROOM_BURST {
            let mut inner = f.cell.lock();
            assert!(admit(&f.app, &mut inner, &actor(&format!("m{i}"), false)).is_ok(), "{i}");
        }
        let mut inner = f.cell.lock();
        assert!(admit(&f.app, &mut inner, &actor("late", false)).is_err());
    }

    // apps/server/test/queue.test.ts:111
    #[test]
    fn an_add_stores_only_the_parsed_embed_and_tells_the_room_the_whole_list() {
        let mut f = fixture();
        f.share(YT1);
        f.frames();
        let a = actor("alice", false);
        let item = f.add(&a, "  https://youtu.be/9bZkp7q19f0  ").unwrap();
        assert_eq!(item.embed.url(), "https://www.youtube.com/embed/9bZkp7q19f0");
        assert_eq!(item.by, Some(a.member_id.clone()));
        assert_eq!(item.id.as_str().len(), 16);
        let frames = f.frames();
        assert_eq!(types(&frames), ["queue-changed"]);
        assert_eq!(frames[0]["by"], "alice");
        assert_eq!(frames[0]["queue"].as_array().unwrap().len(), 1);
        assert_eq!(frames[0]["queue"][0]["id"], item.id.as_str());
        assert_eq!(f.stored().queue.len(), 1);
        assert_eq!(f.stored().queue[0].id, item.id);
    }

    // apps/server/test/queue.test.ts:139, :153
    #[test]
    fn an_unsupported_url_is_refused_and_the_generic_tier_follows_the_share_policy() {
        let mut f = fixture();
        let a = actor("alice", false);
        assert_eq!(f.add(&a, "not a url").unwrap_err(), QueueAddRefusal::UnsupportedUrl);
        assert_eq!(
            f.add(&a, "https://youtube.com/watch?v=").unwrap_err(),
            QueueAddRefusal::UnsupportedUrl
        );
        assert!(f.queue_ids().is_empty());
        assert!(f.frames().is_empty());
        assert!(f.add(&a, GENERIC).is_ok());
        let off = fixture_with(config(&[("GENERIC_EMBEDS", "off")]), RoomInit::default());
        assert_eq!(off.add(&a, GENERIC).unwrap_err(), QueueAddRefusal::UnsupportedUrl);
    }

    // apps/server/test/queue.test.ts:241
    #[test]
    fn at_the_cap_the_add_is_refused_and_nothing_is_evicted() {
        let f = fixture();
        f.share(YT1);
        let a = actor("alice", true);
        let mut first = None;
        for _ in 0..QUEUE_MAX {
            let item = f.add(&a, YT2).unwrap();
            first.get_or_insert(item.id);
        }
        assert_eq!(f.add(&a, YT2).unwrap_err(), QueueAddRefusal::QueueFull);
        assert_eq!(f.queue_ids().len(), QUEUE_MAX);
        assert_eq!(f.queue_ids()[0], first.unwrap().as_str());
    }

    // apps/server/test/queue.test.ts:272
    #[test]
    fn remove_drops_an_upcoming_item_for_everyone_and_an_absent_one_is_ignored_silently() {
        let mut f = fixture();
        f.share(YT1);
        let (a, b) = (actor("alice", false), actor("bob", false));
        let keep = f.add(&a, YT2).unwrap();
        let gone = f.add(&a, YT2).unwrap();
        f.frames();
        {
            let mut inner = f.cell.lock();
            assert_eq!(remove(&f.app, &mut inner, &b, &gone.id), Ok(()));
        }
        let frames = f.frames();
        assert_eq!(types(&frames), ["queue-changed"]);
        assert_eq!(frames[0]["by"], "bob");
        assert_eq!(f.queue_ids(), [keep.id.as_str()]);
        assert_eq!(f.stored().queue.len(), 1);
        // apps/server/test/queue.test.ts:288
        {
            let mut inner = f.cell.lock();
            assert_eq!(remove(&f.app, &mut inner, &b, &gone.id), Ok(()));
        }
        assert!(f.frames().is_empty());
    }

    // apps/server/test/queue.test.ts:304
    #[test]
    fn advance_from_the_current_item_sends_embed_changed_first_then_queue_changed() {
        let mut f = fixture();
        let current = f.share(YT1);
        let a = actor("alice", false);
        let next = f.add(&a, YT2).unwrap();
        f.frames();
        {
            let mut inner = f.cell.lock();
            advance(&f.app, &mut inner, &a, &current).unwrap();
        }
        let frames = f.frames();
        assert_eq!(types(&frames), ["embed-changed", "queue-changed"]);
        assert_eq!(frames[0]["by"], Value::Null);
        assert_eq!(frames[0]["itemId"], next.id.as_str());
        assert_eq!(frames[0]["playback"]["action"], "load");
        assert_eq!(frames[0]["embed"]["url"], next.embed.url());
        assert_eq!(frames[1]["by"], "alice");
        assert_eq!(frames[1]["queue"].as_array().unwrap().len(), 0);
        assert_eq!(f.current().unwrap(), next.id.as_str());
        // Stored: the advanced item is the room's current one and left the queue.
        let stored = f.stored();
        assert_eq!(stored.item_id, Some(next.id.clone()));
        assert!(stored.queue.is_empty());
    }

    // apps/server/test/queue.test.ts:336, :352
    #[test]
    fn two_clicks_from_the_same_item_skip_one_not_two_and_an_empty_queue_changes_nothing() {
        let mut f = fixture();
        let current = f.share(YT1);
        let a = actor("alice", false);
        f.add(&a, YT2).unwrap();
        f.add(&a, YT2).unwrap();
        f.frames();
        for _ in 0..2 {
            let mut inner = f.cell.lock();
            advance(&f.app, &mut inner, &a, &current).unwrap();
        }
        assert_eq!(f.queue_ids().len(), 1, "one advanced, the stale second click ignored");
        assert_eq!(types(&f.frames()), ["embed-changed", "queue-changed"]);
        let now = f.current().unwrap();
        let mut inner = f.cell.lock();
        advance(&f.app, &mut inner, &a, &QueueItemId::parse(&now).unwrap()).unwrap();
        drop(inner);
        let _ = f.frames();
        let mut inner = f.cell.lock();
        let now = inner.room.item_id().unwrap().clone();
        advance(&f.app, &mut inner, &a, &now).unwrap();
        drop(inner);
        assert!(f.frames().is_empty(), "an empty queue: nothing changes");
    }

    // apps/server/test/queue.test.ts:361
    #[test]
    fn advancing_onto_a_generic_item_has_null_playback_and_announces_who_stopped_catching() {
        let mut f = fixture();
        let current = f.share(YT1);
        let a = actor("alice", false);
        f.add(&a, GENERIC).unwrap();
        let member = {
            let mut inner = f.cell.lock();
            let m = inner
                .room
                .join(
                    &crate::contract::text::Nickname::parse("alice").unwrap(),
                    crate::contract::room::Avatar::new(0).unwrap(),
                    None,
                )
                .unwrap()
                .unwrap();
            inner.room.set_catching(&m.id, true);
            inner.room.take_catching_change(&m.id);
            m.id
        };
        f.frames();
        let mut inner = f.cell.lock();
        advance(&f.app, &mut inner, &a, &current).unwrap();
        drop(inner);
        let frames = f.frames();
        assert_eq!(types(&frames), ["embed-changed", "queue-changed", "member-status"]);
        assert_eq!(frames[0]["playback"], Value::Null);
        assert_eq!(frames[2]["memberId"], member.as_str());
        assert_eq!(frames[2]["catching"], false);
    }

    // apps/server/test/queue.test.ts:390
    #[test]
    fn under_the_owner_policy_a_guest_cannot_touch_the_queue_and_their_adds_are_not_spent() {
        let f = fixture_with(
            config(&[]),
            RoomInit {
                control_policy: Some(ControlPolicy::Owner),
                ..RoomInit::default()
            },
        );
        let current = f.share(YT1);
        let guest = actor("guest", false);
        let owner = actor("owner", true);
        let item = f.add(&owner, YT2).unwrap();
        let mut inner = f.cell.lock();
        for _ in 0..10 {
            assert_eq!(admit(&f.app, &mut inner, &guest), Err(QueueRefusal::ControlOwnerOnly));
        }
        assert_eq!(remove(&f.app, &mut inner, &guest, &item.id), Err(QueueRefusal::ControlOwnerOnly));
        assert_eq!(advance(&f.app, &mut inner, &guest, &current), Err(QueueRefusal::ControlOwnerOnly));
        assert_eq!(inner.room.queue().len(), 1);
        assert!(
            inner.member_add_bucket(&guest.member_id, f.app.mono()).take(f.app.mono()),
            "still all three"
        );
        assert!(admit(&f.app, &mut inner, &owner).is_ok());
    }

    // apps/server/test/queue.test.ts:816
    #[test]
    fn an_add_into_a_room_with_no_current_item_starts_it_and_stores_it_as_current() {
        let mut f = fixture();
        let a = actor("alice", false);
        let item = f.add(&a, YT1).unwrap();
        let frames = f.frames();
        assert_eq!(types(&frames), ["embed-changed", "queue-changed"]);
        assert_eq!(frames[0]["by"], "alice");
        assert_eq!(frames[0]["itemId"], item.id.as_str());
        assert_eq!(frames[0]["playback"]["action"], "load");
        assert_eq!(frames[0]["playback"]["position"], 0);
        assert_eq!(frames[1]["by"], "alice");
        assert_eq!(frames[1]["queue"].as_array().unwrap().len(), 0);
        assert_eq!(f.current().unwrap(), item.id.as_str());
        let stored = f.stored();
        assert_eq!(stored.item_id, Some(item.id));
        assert!(stored.embed.is_some() && stored.queue.is_empty());
        // Later adds only queue.
        f.add(&a, YT2).unwrap();
        assert_eq!(types(&f.frames()), ["queue-changed"]);
    }

    // apps/server/test/queue.test.ts:896
    #[test]
    fn a_queue_left_over_after_a_dropped_embed_row_plays_its_head_first_and_appends_the_new_item() {
        let mut f = fixture_with(config(&[]), RoomInit::default());
        let a = actor("alice", false);
        let leftover = {
            let embed = f.app.embeds.accept(YT2).unwrap();
            let id = crate::secrets::mint_item_id().unwrap();
            f.app
                .store()
                .rooms()
                .add_queue_item(
                    &rid("film-club"),
                    &crate::store::StoredQueueItem {
                        id: id.clone(),
                        embed: embed.clone(),
                    },
                )
                .unwrap();
            f.cell.lock().room.enqueue(QueueItem {
                id: id.clone(),
                embed,
                by: None,
            });
            id
        };
        let item = f.add(&a, YT1).unwrap();
        let frames = f.frames();
        assert_eq!(types(&frames), ["embed-changed", "queue-changed"]);
        assert_eq!(frames[0]["itemId"], leftover.as_str(), "the head started, not the new item");
        assert_eq!(f.current().unwrap(), leftover.as_str());
        assert_eq!(f.queue_ids(), [item.id.as_str()]);
        let stored = f.stored();
        assert_eq!(stored.item_id, Some(leftover));
        assert_eq!(stored.queue.len(), 1);
    }

    // apps/server/test/queue.test.ts:929
    #[test]
    fn a_failed_store_write_changes_nothing_sends_no_frame_and_gives_the_adds_back() {
        let (app, clock) = app();
        // A room the store has no row for: the write fails.
        let room = Room::new(rid("ghost"), RoomInit::default(), T0).unwrap();
        let cell = app.registry.add_room(room, app.mono()).unwrap();
        let (tx, mut rx) = channel();
        {
            let mut inner = cell.lock();
            inner.subscribers.attach(ConnId(1), tx);
            inner.subscribers.subscribe(ConnId(1));
        }
        let a = actor("alice", false);
        for _ in 0..QUEUE_ADD_MEMBER_BURST + 2 {
            let mut inner = cell.lock();
            admit(&app, &mut inner, &a).unwrap();
            assert_eq!(add(&app, &mut inner, &a, YT1).unwrap_err(), QueueAddRefusal::Unavailable);
            assert!(inner.room.queue().is_empty() && inner.room.item_id().is_none());
        }
        assert!(rx.try_recv().is_none());
    }

    // apps/server/test/queue.test.ts:425
    #[test]
    fn the_first_valid_ended_advances_for_everyone_by_null_and_later_reports_change_nothing() {
        let mut f = fixture();
        let current = f.share(YT1);
        let a = actor("alice", false);
        let next = f.add(&a, YT2).unwrap();
        f.frames();
        f.clock.set_mono(f.app.mono() + 3000.0);
        let mut inner = f.cell.lock();
        ended(&f.app, &mut inner, &current, 0.0);
        ended(&f.app, &mut inner, &current, 0.0);
        drop(inner);
        let frames = f.frames();
        assert_eq!(types(&frames), ["embed-changed", "queue-changed"]);
        assert_eq!(frames[0]["by"], Value::Null);
        assert_eq!(frames[1]["by"], Value::Null);
        assert_eq!(f.current().unwrap(), next.id.as_str());
    }

    // apps/server/test/queue.test.ts:458, :472
    #[test]
    fn ended_is_ignored_inside_the_debounce_for_a_stale_item_and_far_from_the_room_clock() {
        let mut f = fixture();
        let current = f.share(YT1);
        f.add(&actor("alice", false), YT2).unwrap();
        f.frames();
        let mut inner = f.cell.lock();
        // Inside the 3 s debounce.
        f.clock.set_mono(f.app.mono() + 2999.0);
        ended(&f.app, &mut inner, &current, 0.0);
        f.clock.set_mono(f.app.mono() + 1.0);
        // A stale item id.
        ended(&f.app, &mut inner, &QueueItemId::parse("stale").unwrap(), 0.0);
        // Position more than 5 s from the room clock (the room has played 0 s).
        ended(&f.app, &mut inner, &current, 5.5);
        // Within 5 s it counts.
        assert_eq!(inner.room.queue().len(), 1);
        drop(inner);
        assert!(f.frames().is_empty());
        let mut inner = f.cell.lock();
        ended(&f.app, &mut inner, &current, 4.9);
        assert_eq!(inner.room.queue().len(), 0);
    }

    // apps/server/test/queue.test.ts:486, :496, :510
    #[test]
    fn a_live_or_generic_current_item_never_advances_on_ended_and_an_empty_queue_changes_nothing() {
        let mut f = fixture();
        let live = f.share(TWITCH_LIVE);
        f.add(&actor("alice", false), YT2).unwrap();
        f.frames();
        f.clock.set_mono(f.app.mono() + 10_000.0);
        let mut inner = f.cell.lock();
        ended(&f.app, &mut inner, &live, 0.0);
        drop(inner);
        let generic = f.share(GENERIC);
        f.clock.set_mono(f.app.mono() + 10_000.0);
        let mut inner = f.cell.lock();
        ended(&f.app, &mut inner, &generic, 0.0);
        assert_eq!(inner.room.queue().len(), 1);
        drop(inner);
        assert!(f.frames().is_empty());
        let yt = f.share(YT1);
        let mut inner = f.cell.lock();
        let head = inner.room.queue()[0].id.clone();
        inner.room.dequeue(&head);
        f.clock.set_mono(f.app.mono() + 10_000.0);
        ended(&f.app, &mut inner, &yt, 0.0);
        drop(inner);
        assert!(f.frames().is_empty());
    }

    // apps/server/test/queue.test.ts:521
    #[test]
    fn ended_is_not_subject_to_the_control_policy() {
        let f = fixture_with(
            config(&[]),
            RoomInit {
                control_policy: Some(ControlPolicy::Owner),
                ..RoomInit::default()
            },
        );
        let current = f.share(YT1);
        f.add(&actor("owner", true), YT2).unwrap();
        f.clock.set_mono(f.app.mono() + 3000.0);
        let mut inner = f.cell.lock();
        ended(&f.app, &mut inner, &current, 0.0);
        assert!(inner.room.queue().is_empty());
    }
}
