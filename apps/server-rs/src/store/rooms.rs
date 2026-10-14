//! Port of `apps/server/src/store/rooms.ts`: write-through persistence for rooms, queues and seat holds.
//!
//! Only rare mutations land here, never the relay path. Every value is typed on write (the contract
//! newtypes cannot hold an invalid one) and every row is parsed on read: a corrupt `rooms` row fails the
//! whole load, naming the room; a corrupt queue row or seat hold is dropped.

use super::StoreError;
use crate::contract::Obj;
use crate::contract::generic_embed::AnyEmbed;
use crate::contract::ids::{QueueItemId, RoomId};
use crate::contract::layout::RoomLayout;
use crate::contract::room::{ControlPolicy, RoomVisibility, SeatIndex};
use crate::contract::text::RoomTitle;
use crate::log::{LogEvent, log_error};
use rusqlite::types::Value;
use rusqlite::{Connection, params};
use std::collections::HashMap;

/// Largest integer a JS number holds exactly: `v.safeInteger()`.
const MAX_SAFE_INTEGER: i64 = (1 << 53) - 1;

/// A room as stored. `title` is `None` for a seeded room that has none (stored as `''`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoredRoom {
    pub id: RoomId,
    pub title: Option<RoomTitle>,
    /// Unix ms.
    pub created_at: i64,
    pub layout: RoomLayout,
    pub embed: Option<AnyEmbed>,
    /// Fixed at creation (ADR 0028 §4).
    pub visibility: RoomVisibility,
    /// Seeded rooms: never collected, no owner (ADR 0028 §2).
    pub pinned: bool,
    /// SHA-256 of the owner token; `None` for a pinned room.
    pub owner_hash: Option<[u8; 32]>,
    /// SHA-256 of the invite key; private rooms only.
    pub invite_hash: Option<[u8; 32]>,
    /// Unix ms the room last became empty or occupied; `None` if nobody ever joined.
    pub last_active_at: Option<i64>,
    pub control_policy: ControlPolicy,
    /// The current embed's queue item id; `None` with no embed, or one stored before migration 0005.
    pub item_id: Option<QueueItemId>,
    /// Upcoming items in play order. Rows that fail to parse are left out.
    pub queue: Vec<StoredQueueItem>,
}

/// An upcoming queue item as stored: no `by` (ADR 0031 §6).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoredQueueItem {
    pub id: QueueItemId,
    pub embed: AnyEmbed,
}

/// A seat held across a graceful restart (ADR 0032): the name only as SHA-256 of its nickname key.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SeatHold {
    pub room_id: RoomId,
    pub name_hash: [u8; 32],
    pub seat: SeatIndex,
}

/// What `create_room` takes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NewRoom {
    pub id: RoomId,
    pub title: Option<RoomTitle>,
    pub created_at: i64,
    pub layout: RoomLayout,
    pub visibility: RoomVisibility,
    pub pinned: bool,
    pub owner_hash: Option<[u8; 32]>,
    pub invite_hash: Option<[u8; 32]>,
}

impl NewRoom {
    /// A seed: pinned, public, ownerless (`createRoom` without the ADR 0028 fields).
    pub fn seed(id: RoomId, title: Option<RoomTitle>, created_at: i64, layout: RoomLayout) -> Self {
        Self {
            id,
            title,
            created_at,
            layout,
            visibility: RoomVisibility::Public,
            pinned: true,
            owner_hash: None,
            invite_hash: None,
        }
    }
}

/// `UnixMsSchema`: a safe integer, at least 0.
pub(super) fn unix_ms(n: i64, what: &'static str) -> Result<i64, StoreError> {
    if (0..=MAX_SAFE_INTEGER).contains(&n) {
        Ok(n)
    } else {
        Err(StoreError::Invalid(what))
    }
}

fn title_text(title: Option<&RoomTitle>) -> &str {
    title.map_or("", RoomTitle::as_str)
}

fn policy_text(p: ControlPolicy) -> &'static str {
    match p {
        ControlPolicy::Everyone => "everyone",
        ControlPolicy::Owner => "owner",
    }
}

fn embed_json(embed: &AnyEmbed) -> Result<String, StoreError> {
    serde_json::to_string(embed).map_err(|_| StoreError::Invalid("embed"))
}

// ---- row parsing: SQLite values, as dynamic as the TS `unknown` rows, through the contract

/// All `N` columns of a row as dynamic values, or `None` if any cannot be read (invalid UTF-8 text).
pub(super) fn read_row<const N: usize>(row: &rusqlite::Row<'_>) -> Option<[Value; N]> {
    let values: Vec<Value> = (0..N).map(|i| row.get::<_, Value>(i)).collect::<Result<_, _>>().ok()?;
    values.try_into().ok()
}

fn text(v: &Value) -> Option<&str> {
    if let Value::Text(s) = v { Some(s) } else { None }
}

fn hash(v: &Value) -> Option<[u8; 32]> {
    if let Value::Blob(b) = v {
        <[u8; 32]>::try_from(b.as_slice()).ok()
    } else {
        None
    }
}

fn nullable<T>(v: &Value, parse: impl FnOnce(&Value) -> Option<T>) -> Option<Option<T>> {
    if matches!(v, Value::Null) { Some(None) } else { parse(v).map(Some) }
}

fn unix_ms_value(v: &Value) -> Option<i64> {
    if let Value::Integer(n) = v { unix_ms(*n, "").ok() } else { None }
}

fn embed_value(v: &Value) -> Option<AnyEmbed> {
    serde_json::from_str::<Obj<AnyEmbed>>(text(v)?).ok().map(|o| o.0)
}

/// One `rooms` row in `ROOMS_SELECT` order, or `None` when it fails the contract. `queue` is looked up
/// by the parsed id.
fn parse_room(row: &[Value; 12], queues: &mut HashMap<String, Vec<StoredQueueItem>>) -> Option<StoredRoom> {
    let [
        id,
        title,
        created_at,
        layout,
        embed,
        visibility,
        pinned,
        owner,
        invite,
        last_active,
        policy,
        item,
    ] = row;
    let id = RoomId::parse(text(id)?)?;
    let title = match text(title)? {
        "" => None,
        t => Some(RoomTitle::parse(t)?),
    };
    let embed = nullable(embed, embed_value)?;
    let item_id = nullable(item, |v| QueueItemId::parse(text(v)?))?;
    Some(StoredRoom {
        title,
        created_at: unix_ms_value(created_at)?,
        layout: RoomLayout::parse(text(layout)?.as_bytes()).ok()?,
        visibility: match text(visibility)? {
            "public" => RoomVisibility::Public,
            "private" => RoomVisibility::Private,
            _ => return None,
        },
        pinned: match pinned {
            Value::Integer(0) => false,
            Value::Integer(1) => true,
            _ => return None,
        },
        owner_hash: nullable(owner, hash)?,
        invite_hash: nullable(invite, hash)?,
        last_active_at: nullable(last_active, unix_ms_value)?,
        control_policy: match text(policy)? {
            "everyone" => ControlPolicy::Everyone,
            "owner" => ControlPolicy::Owner,
            _ => return None,
        },
        // An item id without an embed means nothing (a hand edit): dropped.
        item_id: if embed.is_none() { None } else { item_id },
        embed,
        queue: queues.remove(id.as_str()).unwrap_or_default(),
        id,
    })
}

/// How a corrupt row is named: its id JSON-quoted (`?` when the id is not text), as TS does.
fn row_label(id: &Value) -> String {
    text(id)
        .and_then(|s| serde_json::to_string(s).ok())
        .unwrap_or_else(|| "?".to_owned())
}

/// The room tables over the process's connection.
pub struct RoomStore<'a> {
    conn: &'a Connection,
}

const ROOMS_SELECT: &str = "SELECT id, title, created_at, layout, embed, visibility, pinned, owner_hash, invite_hash, last_active_at, control_policy, item_id FROM rooms ORDER BY created_at, id";
// Appended after the room's last item; the room must exist (foreign key).
const INSERT_QUEUE_ITEM: &str = "INSERT INTO queue_items (room_id, id, position, embed) SELECT ?1, ?2, coalesce(max(position), 0) + 1, ?3 FROM queue_items WHERE room_id = ?4";
const DELETE_QUEUE_ITEM: &str = "DELETE FROM queue_items WHERE room_id = ? AND id = ?";
const SET_EMBED: &str = "UPDATE rooms SET embed = ?, item_id = ? WHERE id = ?";

impl<'a> RoomStore<'a> {
    pub fn new(conn: &'a Connection) -> Self {
        Self { conn }
    }

    /// Every room, oldest first. One corrupt row fails the whole load with [`StoreError::CorruptRoom`].
    pub fn list_rooms(&self) -> Result<Vec<StoredRoom>, StoreError> {
        let mut queues = self.queues()?;
        let mut stmt = self.conn.prepare_cached(ROOMS_SELECT)?;
        let mut rows = stmt.query([])?;
        let mut rooms = Vec::new();
        while let Some(row) = rows.next()? {
            // A column that cannot be read is corruption like one that fails the contract: never "absent".
            match read_row::<12>(row).and_then(|values| parse_room(&values, &mut queues)) {
                Some(room) => rooms.push(room),
                None => {
                    return Err(StoreError::CorruptRoom {
                        id: row_label(&row.get::<_, Value>(0).unwrap_or(Value::Null)),
                    });
                }
            }
        }
        Ok(rooms)
    }

    /// Every room's upcoming items, in play order. A row that fails to parse is dropped and logged without its ids (ADR 0031 §6).
    fn queues(&self) -> Result<HashMap<String, Vec<StoredQueueItem>>, StoreError> {
        let mut stmt = self
            .conn
            .prepare_cached("SELECT room_id, id, embed FROM queue_items ORDER BY room_id, position")?;
        let mut rows = stmt.query([])?;
        let mut queues: HashMap<String, Vec<StoredQueueItem>> = HashMap::new();
        while let Some(row) = rows.next()? {
            let parsed = read_row::<3>(row).and_then(|[room, id, embed]| {
                text(&room)
                    .and_then(RoomId::parse)
                    .zip(text(&id).and_then(QueueItemId::parse))
                    .zip(embed_value(&embed))
            });
            match parsed {
                Some(((room, id), embed)) => queues
                    .entry(room.as_str().to_owned())
                    .or_default()
                    .push(StoredQueueItem { id, embed }),
                None => log_error(LogEvent::StoreQueueItem, Some(&StoreError::Invalid("queue row"))),
            }
        }
        Ok(queues)
    }

    pub fn create_room(&self, room: &NewRoom) -> Result<(), StoreError> {
        let created_at = unix_ms(room.created_at, "created_at")?;
        self.conn.prepare_cached(
            "INSERT INTO rooms (id, title, created_at, layout, visibility, pinned, owner_hash, invite_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        )?
        .execute(params![
            room.id.as_str(),
            title_text(room.title.as_ref()),
            created_at,
            room.layout.to_json(),
            match room.visibility {
                RoomVisibility::Public => "public",
                RoomVisibility::Private => "private",
            },
            i64::from(room.pinned),
            room.owner_hash.as_ref().map(<[u8; 32]>::as_slice),
            room.invite_hash.as_ref().map(<[u8; 32]>::as_slice),
        ])?;
        Ok(())
    }

    /// Deletes the room's row (owner delete, GC, operator). False if there was none.
    pub fn delete_room(&self, id: &RoomId) -> Result<bool, StoreError> {
        Ok(self.conn.prepare_cached("DELETE FROM rooms WHERE id = ?")?.execute([id.as_str()])? > 0)
    }

    /// One row changed, or `NoRoom`.
    fn expect_room(changes: usize) -> Result<(), StoreError> {
        if changes == 0 { Err(StoreError::NoRoom) } else { Ok(()) }
    }

    pub fn set_layout(&self, id: &RoomId, layout: &RoomLayout) -> Result<(), StoreError> {
        let n = self
            .conn
            .prepare_cached("UPDATE rooms SET layout = ? WHERE id = ?")?
            .execute(params![layout.to_json(), id.as_str()])?;
        Self::expect_room(n)
    }

    pub fn set_title(&self, id: &RoomId, title: Option<&RoomTitle>) -> Result<(), StoreError> {
        let n = self
            .conn
            .prepare_cached("UPDATE rooms SET title = ? WHERE id = ?")?
            .execute(params![title_text(title), id.as_str()])?;
        Self::expect_room(n)
    }

    /// A share: the new embed and its item id in one write (ADR 0031 §1). A `None` embed has no item id.
    pub fn set_embed(&self, id: &RoomId, embed: Option<&AnyEmbed>, item_id: Option<&QueueItemId>) -> Result<(), StoreError> {
        let json = embed.map(embed_json).transpose()?;
        let item = embed.and(item_id).map(QueueItemId::as_str);
        Self::expect_room(self.conn.prepare_cached(SET_EMBED)?.execute(params![json, item, id.as_str()])?)
    }

    /// `queue-add` (ADR 0031 §6): appends one item. Fails for an unknown room or a taken id.
    pub fn add_queue_item(&self, room_id: &RoomId, item: &StoredQueueItem) -> Result<(), StoreError> {
        self.insert_queue_item(room_id, item)
    }

    fn insert_queue_item(&self, room_id: &RoomId, item: &StoredQueueItem) -> Result<(), StoreError> {
        let (room, embed) = (room_id.as_str(), embed_json(&item.embed)?);
        self.conn
            .prepare_cached(INSERT_QUEUE_ITEM)?
            .execute(params![room, item.id.as_str(), embed, room])?;
        Ok(())
    }

    fn take_queue_item(&self, room_id: &RoomId, id: &QueueItemId) -> Result<(), StoreError> {
        match self
            .conn
            .prepare_cached(DELETE_QUEUE_ITEM)?
            .execute([room_id.as_str(), id.as_str()])?
        {
            0 => Err(StoreError::NoQueueItem),
            _ => Ok(()),
        }
    }

    /// An add into a room with no current item (ADR 0031 §5), in one transaction: appends `item`, then
    /// `head` (usually `item`) leaves the queue and becomes current. Changes nothing if either step fails.
    pub fn add_queue_item_and_start(&self, room_id: &RoomId, item: &StoredQueueItem, head: &StoredQueueItem) -> Result<(), StoreError> {
        let tx = self.conn.unchecked_transaction()?;
        self.insert_queue_item(room_id, item)?;
        self.take_queue_item(room_id, &head.id)?;
        Self::expect_room(self.conn.prepare_cached(SET_EMBED)?.execute(params![
            embed_json(&head.embed)?,
            head.id.as_str(),
            room_id.as_str()
        ])?)?;
        Ok(tx.commit()?)
    }

    /// `queue-remove`: false if the room had no such item.
    pub fn remove_queue_item(&self, room_id: &RoomId, item_id: &QueueItemId) -> Result<bool, StoreError> {
        Ok(self
            .conn
            .prepare_cached(DELETE_QUEUE_ITEM)?
            .execute([room_id.as_str(), item_id.as_str()])?
            > 0)
    }

    /// An advance (ADR 0031 §5), in one transaction: the upcoming `item` leaves the queue and becomes the
    /// room's current embed. Changes nothing if the room doesn't hold that item.
    pub fn advance_queue(&self, room_id: &RoomId, item: &StoredQueueItem) -> Result<(), StoreError> {
        let tx = self.conn.unchecked_transaction()?;
        self.take_queue_item(room_id, &item.id)?;
        // As in TS, a missing room is not an error here: the queue row's foreign key already proved it exists.
        self.conn
            .prepare_cached(SET_EMBED)?
            .execute(params![embed_json(&item.embed)?, item.id.as_str(), room_id.as_str()])?;
        Ok(tx.commit()?)
    }

    /// Room GC's clock (threat model §1.3): written when the room fills or empties, never per message.
    pub fn set_last_active(&self, id: &RoomId, at: i64) -> Result<(), StoreError> {
        let at = unix_ms(at, "at")?;
        Self::expect_room(
            self.conn
                .prepare_cached("UPDATE rooms SET last_active_at = ? WHERE id = ?")?
                .execute(params![at, id.as_str()])?,
        )
    }

    /// The owner's `control-policy` (ADR 0030 §4): a rare owner edit, never on the relay path.
    pub fn set_control_policy(&self, id: &RoomId, policy: ControlPolicy) -> Result<(), StoreError> {
        Self::expect_room(
            self.conn
                .prepare_cached("UPDATE rooms SET control_policy = ? WHERE id = ?")?
                .execute(params![policy_text(policy), id.as_str()])?,
        )
    }

    /// Pins (GC never collects it) or unpins a room (operator CLI).
    pub fn set_pinned(&self, id: &RoomId, pinned: bool) -> Result<(), StoreError> {
        Self::expect_room(
            self.conn
                .prepare_cached("UPDATE rooms SET pinned = ? WHERE id = ?")?
                .execute(params![i64::from(pinned), id.as_str()])?,
        )
    }

    /// Replaces the stored holds with these (graceful restart, ADR 0032). Holds for unknown rooms fail the write.
    pub fn save_seat_holds(&self, holds: &[SeatHold]) -> Result<(), StoreError> {
        let tx = self.conn.unchecked_transaction()?;
        self.conn.execute("DELETE FROM seat_holds", [])?;
        let mut insert = self
            .conn
            .prepare_cached("INSERT OR REPLACE INTO seat_holds (room_id, name_hash, seat) VALUES (?, ?, ?)")?;
        for h in holds {
            insert.execute(params![h.room_id.as_str(), h.name_hash.as_slice(), i64::from(h.seat.get())])?;
        }
        Ok(tx.commit()?)
    }

    /// The stored holds, deleted as they are read: a hold is used by one boot at most. Bad rows are dropped.
    pub fn take_seat_holds(&self) -> Result<Vec<SeatHold>, StoreError> {
        let tx = self.conn.unchecked_transaction()?;
        let mut holds = Vec::new();
        {
            let mut stmt = self
                .conn
                .prepare_cached("SELECT room_id, name_hash, seat FROM seat_holds ORDER BY room_id, seat")?;
            let mut rows = stmt.query([])?;
            while let Some(row) = rows.next()? {
                let Some([room, name, seat]) = read_row::<3>(row) else { continue };
                let seat = if let Value::Integer(n) = seat {
                    u64::try_from(n).ok().and_then(SeatIndex::new)
                } else {
                    None
                };
                if let (Some(room_id), Some(name_hash), Some(seat)) = (text(&room).and_then(RoomId::parse), hash(&name), seat) {
                    holds.push(SeatHold { room_id, name_hash, seat });
                }
            }
        }
        self.conn.execute("DELETE FROM seat_holds", [])?;
        tx.commit()?;
        Ok(holds)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::contract::layout::{Furniture, Kind, default_layout};
    use crate::store::db::{MIGRATIONS, open_database, open_database_with};
    use rusqlite::params;

    const YOUTUBE: &str = r#"{"provider":"youtube","videoId":"dQw4w9WgXcQ","url":"https://www.youtube.com/embed/dQw4w9WgXcQ"}"#;
    const VIMEO: &str = r#"{"provider":"vimeo","videoId":"76979871","hash":null,"url":"https://player.vimeo.com/video/76979871"}"#;
    const TWITCH: &str = r#"{"provider":"twitch","kind":"vod","videoId":"1234567890","url":"https://player.twitch.tv/?video=v1234567890"}"#;

    fn embed(json: &str) -> AnyEmbed {
        serde_json::from_str(json).unwrap()
    }
    fn rid(s: &str) -> RoomId {
        RoomId::parse(s).unwrap()
    }
    fn qid(s: &str) -> QueueItemId {
        QueueItemId::parse(s).unwrap()
    }
    fn item(id: &str, json: &str) -> StoredQueueItem {
        StoredQueueItem {
            id: qid(id),
            embed: embed(json),
        }
    }
    fn title(s: &str) -> Option<RoomTitle> {
        Some(RoomTitle::parse(s).unwrap())
    }
    fn mem() -> Connection {
        open_database(":memory:").unwrap()
    }
    fn seed(c: &Connection, id: &str) {
        RoomStore::new(c)
            .create_room(&NewRoom::seed(rid(id), None, 1, default_layout()))
            .unwrap();
    }
    fn layout_json() -> String {
        default_layout().to_json()
    }
    fn count(c: &Connection, table: &str) -> i64 {
        c.query_row(&format!("SELECT count(*) FROM {table}"), [], |r| r.get(0)).unwrap()
    }
    fn only_room(c: &Connection) -> StoredRoom {
        let mut rooms = RoomStore::new(c).list_rooms().unwrap();
        assert_eq!(rooms.len(), 1);
        rooms.remove(0)
    }
    fn expect_corrupt(c: &Connection, id: &str) {
        let err = RoomStore::new(c).list_rooms().unwrap_err();
        assert_eq!(err.corrupt_room_id(), Some(format!("\"{id}\"").as_str()), "{err:?}");
    }

    // apps/server/test/store.test.ts:176
    #[test]
    fn create_room_then_list_rooms_gives_the_room_back() {
        let c = mem();
        RoomStore::new(&c)
            .create_room(&NewRoom::seed(rid("lobby"), title("Lobby"), 1_700_000_000_000, default_layout()))
            .unwrap();
        assert_eq!(
            RoomStore::new(&c).list_rooms().unwrap(),
            [StoredRoom {
                id: rid("lobby"),
                title: title("Lobby"),
                created_at: 1_700_000_000_000,
                layout: default_layout(),
                embed: None,
                visibility: RoomVisibility::Public,
                pinned: true,
                owner_hash: None,
                invite_hash: None,
                last_active_at: None,
                control_policy: ControlPolicy::Everyone,
                item_id: None,
                queue: vec![],
            }]
        );
    }

    // apps/server/test/store.test.ts:199
    #[test]
    fn set_layout_and_set_embed_write_through_and_none_clears_the_tv() {
        let c = mem();
        seed(&c, "lobby");
        let moved = RoomLayout::parse_input(
            layout_json()
                .replace(r#""kind":"plant","col":0,"row":9"#, r#""kind":"plant","col":9,"row":9"#)
                .as_bytes(),
        )
        .unwrap();
        assert_ne!(moved, default_layout());
        let s = RoomStore::new(&c);
        s.set_layout(&rid("lobby"), &moved).unwrap();
        s.set_embed(&rid("lobby"), Some(&embed(YOUTUBE)), None).unwrap();
        let r = only_room(&c);
        assert_eq!((r.layout, r.embed), (moved, Some(embed(YOUTUBE))));
        s.set_embed(&rid("lobby"), None, Some(&qid("ignored"))).unwrap();
        let r = only_room(&c);
        assert_eq!((r.embed, r.item_id), (None, None));
    }

    // apps/server/test/store.test.ts:213: what TS checks at write time, Rust refuses at the types
    #[test]
    fn invalid_layouts_embeds_and_ids_cannot_be_built_and_the_row_is_untouched() {
        let c = mem();
        seed(&c, "lobby");
        let no_tv: Vec<Furniture> = default_layout()
            .furniture()
            .iter()
            .filter(|f| f.kind != Kind::Tv)
            .copied()
            .collect();
        let json = serde_json::to_string(&serde_json::json!({ "furniture": no_tv })).unwrap();
        assert!(RoomLayout::parse_input(json.as_bytes()).is_err());
        assert!(serde_json::from_str::<AnyEmbed>(&YOUTUBE.replace("www.youtube.com", "evil.example")).is_err());
        assert!(RoomId::parse("Not A Room").is_none());
        assert!(RoomTitle::parse("<b>").is_none());
        let r = only_room(&c);
        assert_eq!((r.layout, r.embed), (default_layout(), None));
    }

    // apps/server/test/store.test.ts:224
    #[test]
    fn writes_to_an_unknown_room_fail_without_naming_it() {
        let c = mem();
        let s = RoomStore::new(&c);
        let ghost = rid("ghost");
        assert_eq!(s.set_layout(&ghost, &default_layout()), Err(StoreError::NoRoom));
        assert_eq!(s.set_embed(&ghost, Some(&embed(YOUTUBE)), None), Err(StoreError::NoRoom));
        assert_eq!(s.set_title(&ghost, None), Err(StoreError::NoRoom));
        assert_eq!(s.set_last_active(&ghost, 5), Err(StoreError::NoRoom));
        assert_eq!(s.set_control_policy(&ghost, ControlPolicy::Owner), Err(StoreError::NoRoom));
        assert_eq!(s.set_pinned(&ghost, false), Err(StoreError::NoRoom));
        assert!(!StoreError::NoRoom.to_string().contains("ghost"));
    }

    // apps/server/test/store.test.ts:231
    #[test]
    fn a_corrupt_layout_row_fails_loudly_on_read_naming_the_room() {
        let c = mem();
        seed(&c, "lobby");
        c.execute(
            "INSERT INTO rooms (id, title, created_at, layout) VALUES ('hacked', '', 2, ?)",
            [r#"{"furniture":[]}"#],
        )
        .unwrap();
        expect_corrupt(&c, "hacked");
    }

    // apps/server/test/store.test.ts:239
    #[test]
    fn a_row_whose_layout_is_not_json_or_whose_embed_is_forged_fails_loudly() {
        let a = mem();
        a.execute(
            "INSERT INTO rooms (id, title, created_at, layout) VALUES ('broken', '', 1, 'not json')",
            [],
        )
        .unwrap();
        expect_corrupt(&a, "broken");

        let b = mem();
        let forged = YOUTUBE.replace("www.youtube.com", "evil.example");
        b.execute(
            "INSERT INTO rooms (id, title, created_at, layout, embed) VALUES ('forged', '', 1, ?, ?)",
            [layout_json(), forged],
        )
        .unwrap();
        expect_corrupt(&b, "forged");
    }

    // apps/server/test/persistence.test.ts:134: boot fails naming the room, the log line does not
    #[test]
    fn the_corrupt_room_message_names_the_room_but_the_error_log_cuts_it() {
        let c = mem();
        c.execute("INSERT INTO rooms (id, title, created_at, layout) VALUES ('lobby', '', 1, 'x')", [])
            .unwrap();
        let err = RoomStore::new(&c).list_rooms().unwrap_err();
        assert!(err.to_string().contains("lobby"));
        let line = crate::log::format_log_line(crate::log::LogEvent::StoreLastActive, Some(("Error", &err.to_string())));
        assert!(!line.contains("lobby"), "{line}");
        // Every other error is free of data.
        for e in [
            StoreError::NoRoom,
            StoreError::NoQueueItem,
            StoreError::Invalid("title"),
            StoreError::Db(19),
        ] {
            assert!(e.corrupt_room_id().is_none());
        }
    }

    // apps/server/test/store.test.ts:260
    #[test]
    fn a_0001_database_migrates_its_rows_become_pinned_public_ownerless_never_active() {
        let d = tempfile::tempdir().unwrap();
        let path = d.path().join("o.db").to_string_lossy().into_owned();
        let old = open_database_with(&path, &MIGRATIONS[..1]).unwrap();
        old.execute(
            "INSERT INTO rooms (id, title, created_at, layout) VALUES ('den', 'Den', 5, ?)",
            [layout_json()],
        )
        .unwrap();
        drop(old);
        let c = open_database(&path).unwrap();
        assert_eq!(
            only_room(&c),
            StoredRoom {
                id: rid("den"),
                title: title("Den"),
                created_at: 5,
                layout: default_layout(),
                embed: None,
                visibility: RoomVisibility::Public,
                pinned: true,
                owner_hash: None,
                invite_hash: None,
                last_active_at: None,
                control_policy: ControlPolicy::Everyone,
                item_id: None,
                queue: vec![],
            }
        );
    }

    // apps/server/test/store.test.ts:278
    #[test]
    fn an_owned_private_room_round_trips_its_hashes_and_delete_says_whether_there_was_one() {
        let c = mem();
        let s = RoomStore::new(&c);
        let id = rid("abcdefghijklmnopqrstuvwxyz");
        s.create_room(&NewRoom {
            id: id.clone(),
            title: title("Hidden"),
            created_at: 7,
            layout: default_layout(),
            visibility: RoomVisibility::Private,
            pinned: false,
            owner_hash: Some([1; 32]),
            invite_hash: Some([2; 32]),
        })
        .unwrap();
        let r = only_room(&c);
        assert_eq!(
            (r.visibility, r.pinned, r.owner_hash, r.invite_hash),
            (RoomVisibility::Private, false, Some([1; 32]), Some([2; 32]))
        );
        assert!(s.delete_room(&id).unwrap());
        assert!(!s.delete_room(&id).unwrap());
        assert!(s.list_rooms().unwrap().is_empty());
    }

    #[test]
    fn creating_a_room_twice_fails() {
        let c = mem();
        seed(&c, "den");
        assert!(matches!(
            RoomStore::new(&c).create_room(&NewRoom::seed(rid("den"), None, 1, default_layout())),
            Err(StoreError::Db(_))
        ));
    }

    #[test]
    fn create_room_refuses_a_created_at_that_is_not_a_safe_non_negative_integer() {
        let c = mem();
        let s = RoomStore::new(&c);
        for bad in [-1, 1 << 53] {
            assert_eq!(
                s.create_room(&NewRoom::seed(rid("den"), None, bad, default_layout())),
                Err(StoreError::Invalid("created_at"))
            );
        }
        assert!(s.list_rooms().unwrap().is_empty());
    }

    // apps/server/test/store.test.ts:337
    #[test]
    fn a_row_with_a_bad_title_fails_loudly_and_the_table_checks_refuse_the_rest() {
        let c = mem();
        let l = layout_json();
        assert!(
            c.execute(
                "INSERT INTO rooms (id, created_at, layout, visibility) VALUES ('a', 1, ?, 'secret')",
                [&l]
            )
            .is_err()
        );
        assert!(
            c.execute("INSERT INTO rooms (id, created_at, layout, pinned) VALUES ('b', 1, ?, 2)", [&l])
                .is_err()
        );
        assert!(
            c.execute(
                "INSERT INTO rooms (id, created_at, layout, owner_hash) VALUES ('c', 1, ?, x'00')",
                [&l]
            )
            .is_err()
        );
        c.execute("INSERT INTO rooms (id, title, created_at, layout) VALUES ('d', '<b>', 1, ?)", [&l])
            .unwrap();
        expect_corrupt(&c, "d");
    }

    #[test]
    fn a_row_with_a_wrong_column_type_or_a_bad_item_id_fails_loudly() {
        // STRICT tables refuse most wrong types; what they allow (an item id that is no id, an id that is no room id) must fail the parse.
        let c = mem();
        c.execute(
            "INSERT INTO rooms (id, title, created_at, layout, embed, item_id) VALUES ('e', '', 1, ?, ?, 'not ok!')",
            [layout_json(), YOUTUBE.to_owned()],
        )
        .unwrap();
        expect_corrupt(&c, "e");
        let c = mem();
        c.execute(
            "INSERT INTO rooms (id, title, created_at, layout) VALUES ('Bad Id', '', 1, ?)",
            [layout_json()],
        )
        .unwrap();
        expect_corrupt(&c, "Bad Id");
    }

    #[test]
    fn an_item_id_without_an_embed_is_dropped_on_read() {
        let c = mem();
        c.execute(
            "INSERT INTO rooms (id, title, created_at, layout, item_id) VALUES ('f', '', 1, ?, 'x')",
            [layout_json()],
        )
        .unwrap();
        assert_eq!(only_room(&c).item_id, None);
    }

    #[test]
    fn rooms_list_oldest_first_then_by_id() {
        let c = mem();
        for (id, at) in [("c", 2), ("b", 2), ("a", 3)] {
            RoomStore::new(&c)
                .create_room(&NewRoom::seed(rid(id), None, at, default_layout()))
                .unwrap();
        }
        let ids: Vec<String> = RoomStore::new(&c)
            .list_rooms()
            .unwrap()
            .iter()
            .map(|r| r.id.as_str().to_owned())
            .collect();
        assert_eq!(ids, ["b", "c", "a"]);
    }

    #[test]
    fn title_last_active_and_pinned_write_through() {
        let c = mem();
        seed(&c, "den");
        let s = RoomStore::new(&c);
        s.set_title(&rid("den"), title("Film club").as_ref()).unwrap();
        s.set_last_active(&rid("den"), 99).unwrap();
        s.set_pinned(&rid("den"), false).unwrap();
        let r = only_room(&c);
        assert_eq!((r.title, r.last_active_at, r.pinned), (title("Film club"), Some(99), false));
        s.set_title(&rid("den"), None).unwrap();
        assert_eq!(only_room(&c).title, None);
        assert_eq!(s.set_last_active(&rid("den"), -1), Err(StoreError::Invalid("at")));
    }

    // apps/server/test/store.test.ts:352
    #[test]
    fn set_control_policy_writes_through_and_survives_a_reopen() {
        let d = tempfile::tempdir().unwrap();
        let path = d.path().join("o.db").to_string_lossy().into_owned();
        let old = open_database_with(&path, &MIGRATIONS[..3]).unwrap();
        old.execute(
            "INSERT INTO rooms (id, title, created_at, layout) VALUES ('den', 'Den', 5, ?)",
            [layout_json()],
        )
        .unwrap();
        drop(old);
        let c = open_database(&path).unwrap();
        assert_eq!(only_room(&c).control_policy, ControlPolicy::Everyone);
        RoomStore::new(&c).set_control_policy(&rid("den"), ControlPolicy::Owner).unwrap();
        drop(c);
        assert_eq!(only_room(&open_database(&path).unwrap()).control_policy, ControlPolicy::Owner);
    }

    // apps/server/test/store.test.ts:371
    #[test]
    fn the_control_policy_check_refuses_a_forged_value() {
        let c = mem();
        seed(&c, "den");
        assert!(
            c.execute("UPDATE rooms SET control_policy = 'nobody' WHERE id = 'den'", [])
                .is_err()
        );
    }

    fn queue_room() -> Connection {
        let c = mem();
        RoomStore::new(&c)
            .create_room(&NewRoom::seed(rid("den"), title("Den"), 5, default_layout()))
            .unwrap();
        c
    }
    fn queue_of(c: &Connection) -> Vec<StoredQueueItem> {
        only_room(c).queue
    }

    // apps/server/test/store.test.ts:393
    #[test]
    fn queue_items_is_strict_with_the_columns_keyed_by_room_and_id() {
        let c = queue_room();
        let strict: i64 = c
            .query_row("SELECT strict FROM pragma_table_list WHERE name = 'queue_items'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(strict, 1);
        let long = "a".repeat(33);
        assert!(
            c.execute(
                "INSERT INTO queue_items (room_id, id, position, embed) VALUES ('den', ?, 1, '{}')",
                [long]
            )
            .is_err()
        );
    }

    // apps/server/test/store.test.ts:408
    #[test]
    fn a_database_at_0004_upgrades_rooms_keep_their_embed_item_id_null_queue_empty() {
        let d = tempfile::tempdir().unwrap();
        let path = d.path().join("o.db").to_string_lossy().into_owned();
        let old = open_database_with(&path, &MIGRATIONS[..4]).unwrap();
        old.execute(
            "INSERT INTO rooms (id, title, created_at, layout, embed) VALUES ('den', 'Den', 5, ?, ?)",
            [layout_json(), YOUTUBE.to_owned()],
        )
        .unwrap();
        drop(old);
        let r = only_room(&open_database(&path).unwrap());
        assert_eq!((r.embed, r.item_id, r.queue), (Some(embed(YOUTUBE)), None, vec![]));
    }

    // apps/server/test/store.test.ts:418
    #[test]
    fn add_remove_and_advance_write_through_in_play_order_and_survive_a_reopen() {
        let d = tempfile::tempdir().unwrap();
        let path = d.path().join("o.db").to_string_lossy().into_owned();
        let c = open_database(&path).unwrap();
        RoomStore::new(&c)
            .create_room(&NewRoom::seed(rid("den"), title("Den"), 5, default_layout()))
            .unwrap();
        let s = RoomStore::new(&c);
        let den = rid("den");
        s.set_embed(&den, Some(&embed(YOUTUBE)), Some(&qid("cur"))).unwrap();
        s.add_queue_item(&den, &item("a", VIMEO)).unwrap();
        s.add_queue_item(&den, &item("b", TWITCH)).unwrap();
        s.add_queue_item(&den, &item("c", YOUTUBE)).unwrap();
        assert!(s.remove_queue_item(&den, &qid("b")).unwrap());
        assert!(!s.remove_queue_item(&den, &qid("b")).unwrap());
        s.add_queue_item(&den, &item("d", TWITCH)).unwrap();
        s.advance_queue(&den, &item("a", VIMEO)).unwrap();
        drop(c);
        let r = only_room(&open_database(&path).unwrap());
        assert_eq!((r.embed, r.item_id), (Some(embed(VIMEO)), Some(qid("a"))));
        assert_eq!(r.queue, [item("c", YOUTUBE), item("d", TWITCH)]);
    }

    // apps/server/test/store.test.ts:437
    #[test]
    fn a_share_writes_the_embed_and_its_item_id_together_and_clearing_clears_the_id() {
        let c = queue_room();
        let s = RoomStore::new(&c);
        s.set_embed(&rid("den"), Some(&embed(YOUTUBE)), Some(&qid("first"))).unwrap();
        let r = only_room(&c);
        assert_eq!((r.embed, r.item_id), (Some(embed(YOUTUBE)), Some(qid("first"))));
        s.set_embed(&rid("den"), None, None).unwrap();
        let r = only_room(&c);
        assert_eq!((r.embed, r.item_id), (None, None));
    }

    // apps/server/test/store.test.ts:445
    #[test]
    fn an_unknown_room_a_taken_id_or_a_missing_item_fail_and_write_nothing() {
        let c = queue_room();
        let s = RoomStore::new(&c);
        assert!(s.add_queue_item(&rid("ghost"), &item("a", YOUTUBE)).is_err());
        assert_eq!(s.advance_queue(&rid("den"), &item("nope", YOUTUBE)), Err(StoreError::NoQueueItem));
        s.add_queue_item(&rid("den"), &item("a", YOUTUBE)).unwrap();
        assert!(s.add_queue_item(&rid("den"), &item("a", VIMEO)).is_err());
        assert_eq!(count(&c, "queue_items"), 1);
        let r = only_room(&c);
        assert_eq!((r.embed, r.item_id), (None, None));
    }

    #[test]
    fn add_queue_item_and_start_is_one_transaction() {
        let c = queue_room();
        let s = RoomStore::new(&c);
        let den = rid("den");
        s.add_queue_item_and_start(&den, &item("a", YOUTUBE), &item("a", YOUTUBE)).unwrap();
        let r = only_room(&c);
        assert_eq!((r.embed, r.item_id, r.queue), (Some(embed(YOUTUBE)), Some(qid("a")), vec![]));
        // The head must be in the queue after the add; otherwise nothing is kept, not even the added item.
        let before = count(&c, "queue_items");
        assert_eq!(
            s.add_queue_item_and_start(&den, &item("b", VIMEO), &item("zzz", VIMEO)),
            Err(StoreError::NoQueueItem)
        );
        assert_eq!(count(&c, "queue_items"), before);
        let r = only_room(&c);
        assert_eq!(r.item_id, Some(qid("a")));
        // An unknown room fails at the add (foreign key) and writes nothing.
        assert!(
            s.add_queue_item_and_start(&rid("ghost"), &item("b", VIMEO), &item("b", VIMEO))
                .is_err()
        );
        assert_eq!(count(&c, "queue_items"), before);
    }

    // apps/server/test/store.test.ts:466
    #[test]
    fn deleting_a_room_deletes_its_queue_rows() {
        let c = queue_room();
        let s = RoomStore::new(&c);
        s.create_room(&NewRoom::seed(rid("attic"), None, 6, default_layout())).unwrap();
        s.add_queue_item(&rid("den"), &item("a", YOUTUBE)).unwrap();
        s.add_queue_item(&rid("den"), &item("b", VIMEO)).unwrap();
        s.add_queue_item(&rid("attic"), &item("a", VIMEO)).unwrap();
        assert!(s.delete_room(&rid("den")).unwrap());
        assert_eq!(count(&c, "queue_items"), 1);
        let rooms = s.list_rooms().unwrap();
        assert_eq!(rooms.len(), 1);
        assert_eq!(rooms.first().map(|r| r.queue.clone()), Some(vec![item("a", VIMEO)]));
    }

    // apps/server/test/store.test.ts:479
    #[test]
    fn a_queue_row_that_fails_to_parse_is_dropped_and_the_rest_of_the_room_loads() {
        let c = queue_room();
        let s = RoomStore::new(&c);
        s.add_queue_item(&rid("den"), &item("a", YOUTUBE)).unwrap();
        let forged = YOUTUBE.replace("www.youtube.com", "evil.example");
        c.execute(
            "INSERT INTO queue_items (room_id, id, position, embed) VALUES ('den', 'x', 2, ?)",
            [forged],
        )
        .unwrap();
        c.execute(
            "INSERT INTO queue_items (room_id, id, position, embed) VALUES ('den', 'y', 3, 'not json')",
            [],
        )
        .unwrap();
        c.execute(
            "INSERT INTO queue_items (room_id, id, position, embed) VALUES ('den', 'bad id', 4, ?)",
            [VIMEO],
        )
        .unwrap();
        s.add_queue_item(&rid("den"), &item("b", VIMEO)).unwrap();
        assert_eq!(queue_of(&c), [item("a", YOUTUBE), item("b", VIMEO)]);
    }

    fn hold(room: &str, n: u8, seat: u64) -> SeatHold {
        SeatHold {
            room_id: rid(room),
            name_hash: [n; 32],
            seat: SeatIndex::new(seat).unwrap(),
        }
    }

    // apps/server/test/graceful-restart.test.ts:121
    #[test]
    fn saved_holds_are_taken_once_and_a_deleted_rooms_holds_go_with_it() {
        let c = mem();
        seed(&c, "lobby");
        seed(&c, "gone");
        let s = RoomStore::new(&c);
        s.save_seat_holds(&[hold("lobby", 1, 0), hold("gone", 2, 4)]).unwrap();
        s.delete_room(&rid("gone")).unwrap();
        assert_eq!(s.take_seat_holds().unwrap(), [hold("lobby", 1, 0)]);
        assert_eq!(s.take_seat_holds().unwrap(), []);
    }

    #[test]
    fn saving_replaces_the_stored_holds_and_a_hold_for_an_unknown_room_fails_the_write() {
        let c = mem();
        seed(&c, "lobby");
        let s = RoomStore::new(&c);
        s.save_seat_holds(&[hold("lobby", 1, 0)]).unwrap();
        s.save_seat_holds(&[hold("lobby", 2, 3), hold("lobby", 3, 1)]).unwrap();
        // Same room and name hash: the later seat wins (INSERT OR REPLACE).
        s.save_seat_holds(&[hold("lobby", 2, 3), hold("lobby", 2, 5)]).unwrap();
        assert_eq!(count(&c, "seat_holds"), 1);
        assert!(s.save_seat_holds(&[hold("lobby", 9, 1), hold("ghost", 1, 0)]).is_err());
        // The failed write rolled back whole: the old holds are still there.
        assert_eq!(s.take_seat_holds().unwrap(), [hold("lobby", 2, 5)]);
    }

    #[test]
    fn holds_come_back_ordered_by_room_then_seat_and_bad_rows_are_dropped() {
        let c = mem();
        seed(&c, "b");
        seed(&c, "a");
        c.execute(
            "INSERT INTO seat_holds (room_id, name_hash, seat) VALUES ('b', ?, 2), ('a', ?, 6), ('a', ?, 1), ('a', ?, 9), ('a', ?, 4)",
            params![[1u8; 32], [2u8; 32], [3u8; 32], [4u8; 32], [5u8; 32]],
        )
        .unwrap();
        let got = RoomStore::new(&c).take_seat_holds().unwrap();
        // Seat 9 is not a seat index: dropped, and the table is emptied anyway.
        assert_eq!(got, [hold("a", 3, 1), hold("a", 5, 4), hold("a", 2, 6), hold("b", 1, 2)]);
        assert_eq!(count(&c, "seat_holds"), 0);
    }

    // A read error on a column is corruption, never "absent": the next write would overwrite the bytes.
    #[test]
    fn a_nullable_column_that_cannot_be_read_fails_the_room_naming_it() {
        let c = mem();
        c.execute(
            "INSERT INTO rooms (id, title, created_at, layout, embed) VALUES ('e', '', 1, ?, CAST(x'ff' AS TEXT))",
            [layout_json()],
        )
        .unwrap();
        expect_corrupt(&c, "e");
        let c = mem();
        c.execute(
            "INSERT INTO rooms (id, title, created_at, layout, item_id) VALUES ('i', '', 1, ?, CAST(x'ff' AS TEXT))",
            [layout_json()],
        )
        .unwrap();
        expect_corrupt(&c, "i");
    }

    #[test]
    fn an_unreadable_queue_row_drops_only_that_row() {
        let c = queue_room();
        let s = RoomStore::new(&c);
        s.add_queue_item(&rid("den"), &item("a", YOUTUBE)).unwrap();
        c.execute(
            "INSERT INTO queue_items (room_id, id, position, embed) VALUES ('den', 'x', 2, CAST(x'ff' AS TEXT))",
            [],
        )
        .unwrap();
        c.execute(
            "INSERT INTO queue_items (room_id, id, position, embed) VALUES ('den', CAST(x'fe' AS TEXT), 3, ?)",
            [VIMEO],
        )
        .unwrap();
        s.add_queue_item(&rid("den"), &item("b", VIMEO)).unwrap();
        assert_eq!(queue_of(&c), [item("a", YOUTUBE), item("b", VIMEO)]);
    }

    #[test]
    fn an_unreadable_seat_hold_row_drops_only_that_row() {
        let c = mem();
        seed(&c, "lobby");
        let s = RoomStore::new(&c);
        s.save_seat_holds(&[hold("lobby", 1, 0)]).unwrap();
        c.execute_batch("PRAGMA foreign_keys = OFF").unwrap();
        c.execute(
            "INSERT INTO seat_holds (room_id, name_hash, seat) VALUES (CAST(x'ff' AS TEXT), ?, 1)",
            [[7u8; 32]],
        )
        .unwrap();
        c.execute_batch("PRAGMA foreign_keys = ON").unwrap();
        assert_eq!(s.take_seat_holds().unwrap(), [hold("lobby", 1, 0)]);
        assert_eq!(count(&c, "seat_holds"), 0);
    }
}
