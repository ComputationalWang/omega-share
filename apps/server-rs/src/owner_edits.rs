//! Port of `apps/server/src/ws-owner-edits.ts`: an owner's room edits (ADR 0028 section 6, ADR 0030 section 4),
//! store first. The caller (S6) has checked that the sender is the owner and has taken from their bucket.
//!
//! Each function runs under the room's lock (`inner`); a store failure is logged (`store.layout`,
//! `store.title`, `store.control_policy`) and then nothing changes, so memory never runs ahead of the database.

use crate::app::App;
use crate::contract::ids::MemberId;
use crate::contract::layout::RoomLayout;
use crate::contract::room::ControlPolicy;
use crate::contract::server_message::{ErrorCode, ErrorMessage, ServerMessage};
use crate::contract::text::RoomTitle;
use crate::log::{LogEvent, log_error};
use crate::outbox::{ConnId, encode_frame, publish_msg, send_to};
use crate::registry::RoomInner;
use crate::store::StoreError;

/// Last write wins; seats keep their indices, so nobody is unseated (ADR 0028 section 6).
pub fn set_layout(app: &App, inner: &mut RoomInner, by: &MemberId, layout: RoomLayout) {
    if layout == *inner.room.layout() {
        return;
    }
    let result = app.store().rooms().set_layout(&inner.room.id, &layout);
    if !persisted(LogEvent::StoreLayout, result) {
        return;
    }
    inner.room.set_layout(layout.clone());
    publish_msg(inner, &ServerMessage::LayoutChanged { layout, by: by.clone() });
}

/// Store first: if the write fails nothing changes, so memory never runs ahead of the database.
fn persisted(event: LogEvent, result: Result<(), StoreError>) -> bool {
    match result {
        Ok(()) => true,
        Err(err) => {
            log_error(event, Some(&err));
            false
        }
    }
}

/// A title the blocklist refuses is answered with an `error` (`bad_message`, "that title isn't allowed") to
/// `sender` only: a valid frame, so it doesn't count toward the 4400 close.
pub fn set_title(app: &App, inner: &mut RoomInner, sender: ConnId, by: &MemberId, title: RoomTitle) {
    if inner.room.title() == Some(&title) {
        return;
    }
    if app.title_blocked(title.as_str()) {
        if let Some(message) = ErrorMessage::new("that title isn't allowed")
            && let Some(frame) = encode_frame(&ServerMessage::Error {
                code: ErrorCode::BadMessage,
                message,
                retry_after_ms: None,
            })
        {
            send_to(inner, sender, &frame);
        }
        return;
    }
    let result = app.store().rooms().set_title(&inner.room.id, Some(&title));
    if !persisted(LogEvent::StoreTitle, result) {
        return;
    }
    inner.room.set_title(Some(title.clone()));
    publish_msg(inner, &ServerMessage::TitleChanged { title, by: by.clone() });
}

pub fn set_control_policy(app: &App, inner: &mut RoomInner, by: &MemberId, policy: ControlPolicy) {
    if policy == inner.room.control_policy() {
        return;
    }
    let result = app.store().rooms().set_control_policy(&inner.room.id, policy);
    if !persisted(LogEvent::StoreControlPolicy, result) {
        return;
    }
    inner.room.set_control_policy(policy);
    publish_msg(inner, &ServerMessage::ControlPolicyChanged { policy, by: by.clone() });
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::indexing_slicing, reason = "tests")]
mod tests {
    use super::*;
    use crate::app::testing::*;
    use crate::contract::layout::default_layout;
    use crate::outbox::{Outbound, OutboxRx, channel};
    use crate::registry::RoomCell;
    use crate::room::{Room, RoomInit};
    use serde_json::Value;
    use std::sync::Arc;

    const BY: &str = "owner-1";

    struct Fixture {
        app: Arc<App>,
        cell: Arc<RoomCell>,
        sender: OutboxRx,
        other: OutboxRx,
    }

    /// `stored`: whether the room also has a row (without one every write fails).
    fn fixture(config: crate::config::ServerConfig, stored: bool) -> Fixture {
        let (app, _) = app_with(config);
        let cell = if stored {
            add_room(&app, "film-club", RoomInit::default())
        } else {
            let room = Room::new(rid("film-club"), RoomInit::default(), T0).unwrap();
            app.registry.add_room(room, 0.0).unwrap()
        };
        let (tx1, sender) = channel();
        let (tx2, other) = channel();
        {
            let mut inner = cell.lock();
            for (id, tx) in [(1, tx1), (2, tx2)] {
                inner.subscribers.attach(ConnId(id), tx);
                inner.subscribers.subscribe(ConnId(id));
            }
        }
        Fixture { app, cell, sender, other }
    }

    fn frames(rx: &mut OutboxRx) -> Vec<Value> {
        let mut out = Vec::new();
        while let Some(Outbound::Text(t)) = rx.try_recv() {
            out.push(serde_json::from_str(t.as_str()).unwrap());
        }
        out
    }

    fn by() -> MemberId {
        MemberId::parse(BY).unwrap()
    }

    /// The default layout without its last piece: a valid, different layout.
    fn smaller_layout() -> RoomLayout {
        let mut v: Value = serde_json::from_str(&default_layout().to_json()).unwrap();
        v["furniture"].as_array_mut().unwrap().pop();
        RoomLayout::parse_input(v.to_string().as_bytes()).unwrap()
    }

    fn title(s: &str) -> RoomTitle {
        RoomTitle::parse(s).unwrap()
    }

    // apps/server/src/ws-owner-edits.ts:30 (same layout: nothing), apps/server/test/room-owner.test.ts layout edits
    #[test]
    fn a_new_layout_is_stored_applied_and_published_to_everyone() {
        let mut f = fixture(config(&[]), true);
        let layout = smaller_layout();
        let mut inner = f.cell.lock();
        set_layout(&f.app, &mut inner, &by(), layout.clone());
        assert_eq!(*inner.room.layout(), layout);
        drop(inner);
        assert_eq!(f.app.store().rooms().list_rooms().unwrap()[0].layout, layout);
        for rx in [&mut f.sender, &mut f.other] {
            let got = frames(rx);
            assert_eq!(got.len(), 1);
            assert_eq!(got[0]["type"], "layout-changed");
            assert_eq!(got[0]["by"], BY);
            assert_eq!(got[0]["layout"]["furniture"].as_array().unwrap().len(), layout.furniture().len());
        }
    }

    #[test]
    fn edits_to_a_room_removed_after_the_lookup_do_nothing() {
        let mut f = fixture(config(&[]), true);
        // Closed but its row still there, so only the closed check can stop the edits.
        f.cell.lock().closed = true;
        let mut inner = f.cell.lock();
        set_layout(&f.app, &mut inner, &by(), smaller_layout());
        set_title(&f.app, &mut inner, ConnId(1), &by(), title("Friday films"));
        set_control_policy(&f.app, &mut inner, &by(), ControlPolicy::Owner);
        assert!(inner.room.title().is_none());
        assert_eq!(inner.room.control_policy(), ControlPolicy::Everyone);
        assert_eq!(*inner.room.layout(), default_layout());
        drop(inner);
        assert!(frames(&mut f.other).is_empty() && frames(&mut f.sender).is_empty());
    }

    #[test]
    fn the_same_layout_changes_nothing_and_says_nothing() {
        let mut f = fixture(config(&[]), true);
        let mut inner = f.cell.lock();
        set_layout(&f.app, &mut inner, &by(), default_layout());
        drop(inner);
        assert!(frames(&mut f.other).is_empty());
    }

    #[test]
    fn a_failed_store_write_changes_nothing_for_every_edit() {
        let mut f = fixture(config(&[]), false);
        let mut inner = f.cell.lock();
        set_layout(&f.app, &mut inner, &by(), smaller_layout());
        set_title(&f.app, &mut inner, ConnId(1), &by(), title("Friday films"));
        set_control_policy(&f.app, &mut inner, &by(), ControlPolicy::Owner);
        assert_eq!(*inner.room.layout(), default_layout());
        assert!(inner.room.title().is_none());
        assert_eq!(inner.room.control_policy(), ControlPolicy::Everyone);
        drop(inner);
        assert!(frames(&mut f.other).is_empty());
    }

    #[test]
    fn a_title_is_stored_applied_and_published_and_the_same_title_is_ignored() {
        let mut f = fixture(config(&[]), true);
        let mut inner = f.cell.lock();
        set_title(&f.app, &mut inner, ConnId(1), &by(), title("Friday films"));
        set_title(&f.app, &mut inner, ConnId(1), &by(), title("Friday films"));
        assert_eq!(inner.room.title().unwrap().as_str(), "Friday films");
        drop(inner);
        assert_eq!(
            f.app.store().rooms().list_rooms().unwrap()[0].title.as_ref().unwrap().as_str(),
            "Friday films"
        );
        let got = frames(&mut f.other);
        assert_eq!(got.len(), 1, "the repeat said nothing");
        assert_eq!(
            (got[0]["type"].as_str(), got[0]["title"].as_str(), got[0]["by"].as_str()),
            (Some("title-changed"), Some("Friday films"), Some(BY))
        );
    }

    // apps/server/test/room-owner.test.ts ROOM_TITLE_BLOCKLIST on rename
    #[test]
    fn a_blocked_title_is_refused_with_an_error_to_the_sender_only() {
        let mut f = fixture(config(&[("ROOM_TITLE_BLOCKLIST", "badword")]), true);
        let mut inner = f.cell.lock();
        set_title(&f.app, &mut inner, ConnId(1), &by(), title("BADW0RD club"));
        assert!(inner.room.title().is_none());
        drop(inner);
        let got = frames(&mut f.sender);
        assert_eq!(got.len(), 1);
        assert_eq!(
            got[0],
            serde_json::json!({"type": "error", "code": "bad_message", "message": "that title isn't allowed"})
        );
        assert!(frames(&mut f.other).is_empty());
        assert!(f.app.store().rooms().list_rooms().unwrap()[0].title.is_none());
    }

    #[test]
    fn a_control_policy_is_stored_applied_and_published_and_the_same_one_is_ignored() {
        let mut f = fixture(config(&[]), true);
        let mut inner = f.cell.lock();
        set_control_policy(&f.app, &mut inner, &by(), ControlPolicy::Everyone);
        set_control_policy(&f.app, &mut inner, &by(), ControlPolicy::Owner);
        assert_eq!(inner.room.control_policy(), ControlPolicy::Owner);
        drop(inner);
        assert_eq!(f.app.store().rooms().list_rooms().unwrap()[0].control_policy, ControlPolicy::Owner);
        let got = frames(&mut f.other);
        assert_eq!(got.len(), 1);
        assert_eq!(
            got[0],
            serde_json::json!({"type": "control-policy-changed", "policy": "owner", "by": BY})
        );
    }
}
