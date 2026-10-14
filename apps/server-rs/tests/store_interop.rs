#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::string_slice,
    clippy::indexing_slicing,
    reason = "test helpers"
)]
//! Rollback safety (ADR 0050, OME-1144): for 7 days after the switch the TS server may be put back on the
//! database file the Rust server wrote, and the reverse. `interop/spec.json` is replayed through both
//! servers' stores; `interop/dump.json` is what the TS stores read back from a database they built
//! (`bun apps/server-rs/interop/gen.ts`). Here the Rust stores must read exactly that from the TS-written
//! file, and must write a file whose dump is the same. The committed `interop/rust-written.db` is the file
//! the TS side reads in `interop/interop.test.ts`; regenerate it with `UPDATE_INTEROP=1 cargo test --test store_interop`.

use omega_server::contract::Obj;
use omega_server::contract::generic_embed::AnyEmbed;
use omega_server::contract::ids::{QueueItemId, RoomId};
use omega_server::contract::layout::RoomLayout;
use omega_server::contract::room::{ControlPolicy, RoomVisibility, SeatIndex};
use omega_server::contract::text::RoomTitle;
use omega_server::store::{NewReport, NewRoom, ReportId, SeatHold, Store, StoredQueueItem};
use rusqlite::types::Value as Sql;
use serde_json::{Value, json};
use std::path::{Path, PathBuf};

fn interop(file: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("interop").join(file)
}
fn read_json(file: &str) -> Value {
    serde_json::from_str(&std::fs::read_to_string(interop(file)).unwrap()).unwrap()
}

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}
fn unhex(h: &str) -> [u8; 32] {
    let bytes: Vec<u8> = (0..h.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&h[i..i + 2], 16).unwrap())
        .collect();
    bytes.try_into().unwrap()
}
fn opt_hex(h: Option<[u8; 32]>) -> Value {
    h.map_or(Value::Null, |h| json!(hex(&h)))
}

fn rid(v: &Value) -> RoomId {
    RoomId::parse(v.as_str().unwrap()).unwrap()
}
fn embed(v: &Value) -> AnyEmbed {
    serde_json::from_str::<Obj<AnyEmbed>>(&v.to_string()).unwrap().0
}
fn item(v: &Value) -> StoredQueueItem {
    StoredQueueItem {
        id: QueueItemId::parse(v["id"].as_str().unwrap()).unwrap(),
        embed: embed(&v["embed"]),
    }
}

/// Replays the spec through the Rust stores, in the order `interop/dump.ts` `build` does.
fn build(spec: &Value, path: &Path) {
    let _ = std::fs::remove_file(path);
    let store = Store::open(&path.to_string_lossy()).unwrap();
    let (rooms, reports) = (store.rooms(), store.reports());
    let list = |v: &Value, key: &str| v[key].as_array().cloned().unwrap_or_default();
    for r in list(spec, "rooms") {
        let id = rid(&r["id"]);
        let title = match r["title"].as_str().unwrap() {
            "" => None,
            t => Some(RoomTitle::parse(t).unwrap()),
        };
        let layout = RoomLayout::parse(&serde_json::to_vec(&r["layout"]).unwrap()).unwrap();
        rooms
            .create_room(&NewRoom {
                id: id.clone(),
                title,
                created_at: r["createdAt"].as_i64().unwrap(),
                layout,
                visibility: if r["visibility"] == "private" {
                    RoomVisibility::Private
                } else {
                    RoomVisibility::Public
                },
                pinned: r["pinned"].as_bool().unwrap_or(true),
                owner_hash: r["ownerHash"].as_str().map(unhex),
                invite_hash: r["inviteHash"].as_str().map(unhex),
            })
            .unwrap();
        if let Some(at) = r["lastActiveAt"].as_i64() {
            rooms.set_last_active(&id, at).unwrap();
        }
        if r["controlPolicy"] == "owner" {
            rooms.set_control_policy(&id, ControlPolicy::Owner).unwrap();
        }
        if !r["embed"].is_null() {
            let item_id = r["itemId"].as_str().map(|s| QueueItemId::parse(s).unwrap());
            rooms.set_embed(&id, Some(&embed(&r["embed"])), item_id.as_ref()).unwrap();
        }
        if r["then"] == "addAndStart" {
            let start = item(&r["startItem"]);
            rooms.add_queue_item_and_start(&id, &start, &start).unwrap();
        }
        let queue: Vec<StoredQueueItem> = list(&r, "queue").iter().map(item).collect();
        for q in &queue {
            rooms.add_queue_item(&id, q).unwrap();
        }
        if r["then"] == "advance" {
            rooms.advance_queue(&id, queue.first().unwrap()).unwrap();
        }
        if r["unpin"] == true {
            rooms.set_pinned(&id, false).unwrap();
        }
    }
    let holds: Vec<SeatHold> = list(spec, "seatHolds")
        .iter()
        .map(|h| SeatHold {
            room_id: rid(&h["roomId"]),
            name_hash: unhex(h["nameHash"].as_str().unwrap()),
            seat: SeatIndex::new(h["seat"].as_u64().unwrap()).unwrap(),
        })
        .collect();
    rooms.save_seat_holds(&holds).unwrap();
    for r in list(spec, "rooms") {
        if r["deleted"] == true {
            rooms.delete_room(&rid(&r["id"])).unwrap();
        }
    }
    for r in list(spec, "reports") {
        let text = |k: &str| r[k].as_str().map(str::to_owned);
        reports
            .add(&NewReport {
                id: ReportId::parse(r["id"].as_str().unwrap()).unwrap(),
                room_id: rid(&r["roomId"]),
                reason: text("reason").unwrap(),
                note: text("note"),
                room_title: text("roomTitle"),
                embed_url: text("embedUrl"),
                created_at: r["createdAt"].as_i64().unwrap(),
            })
            .unwrap();
    }
    for id in list(spec, "dismiss") {
        reports.dismiss(&ReportId::parse(id.as_str().unwrap()).unwrap()).unwrap();
    }
    for id in list(spec, "actionRooms") {
        reports.action_room(&rid(&id)).unwrap();
    }
    for t in list(spec, "takedowns") {
        reports.add_takedown(&rid(&t["roomId"]), t["at"].as_i64().unwrap()).unwrap();
    }
    store.checkpoint().unwrap();
}

/// Every row of `sql`, columns by name, blobs as lowercase hex.
fn raw(conn: &rusqlite::Connection, sql: &str) -> Value {
    let mut stmt = conn.prepare(sql).unwrap();
    let names: Vec<String> = stmt.column_names().iter().map(|n| (*n).to_owned()).collect();
    let rows = stmt
        .query_map([], |row| {
            let mut obj = serde_json::Map::new();
            for (i, name) in names.iter().enumerate() {
                let v = match row.get::<_, Sql>(i)? {
                    Sql::Null => Value::Null,
                    Sql::Integer(n) => json!(n),
                    Sql::Real(f) => json!(f),
                    Sql::Text(s) => json!(s),
                    Sql::Blob(b) => json!(hex(&b)),
                };
                obj.insert(name.clone(), v);
            }
            Ok(Value::Object(obj))
        })
        .unwrap();
    Value::Array(rows.map(Result::unwrap).collect())
}

/// What the Rust stores read from a copy of `path`: the same document `interop/dump.ts` `dump` makes.
fn dump(path: &Path) -> Value {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("copy.db");
    std::fs::copy(path, &file).unwrap();
    let file = file.to_string_lossy().into_owned();
    let store = Store::open(&file).unwrap();
    let conn = rusqlite::Connection::open(&file).unwrap();
    let user_version: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0)).unwrap();
    let (rooms, reports) = (store.rooms(), store.reports());
    let stored = rooms.list_rooms().unwrap();
    let mut takedowns: Vec<String> = reports.takedowns().unwrap().iter().map(|r| r.as_str().to_owned()).collect();
    takedowns.sort();
    let out = json!({
        "userVersion": user_version,
        "schema": raw(&conn, "SELECT type, name, sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY name"),
        "rawRooms": raw(&conn, "SELECT * FROM rooms ORDER BY id"),
        "rawQueue": raw(&conn, "SELECT * FROM queue_items ORDER BY room_id, position"),
        "rawHolds": raw(&conn, "SELECT * FROM seat_holds ORDER BY room_id, seat"),
        "rawReports": raw(&conn, "SELECT * FROM reports ORDER BY id"),
        "rawTakedowns": raw(&conn, "SELECT * FROM takedowns ORDER BY room_id"),
        "rooms": stored.iter().map(|r| json!({
            "id": r.id.as_str(),
            "title": r.title.as_ref().map_or("", RoomTitle::as_str),
            "createdAt": r.created_at,
            "layout": serde_json::to_value(&r.layout).unwrap(),
            "embed": serde_json::to_value(&r.embed).unwrap(),
            "visibility": serde_json::to_value(r.visibility).unwrap(),
            "pinned": r.pinned,
            "ownerHash": opt_hex(r.owner_hash),
            "inviteHash": opt_hex(r.invite_hash),
            "lastActiveAt": r.last_active_at,
            "controlPolicy": serde_json::to_value(r.control_policy).unwrap(),
            "itemId": r.item_id.as_ref().map(QueueItemId::as_str),
            "queue": r.queue.iter().map(|q| json!({"id": q.id.as_str(), "embed": serde_json::to_value(&q.embed).unwrap()})).collect::<Vec<_>>(),
        })).collect::<Vec<_>>(),
        "openReports": reports.list_open().unwrap().iter().map(|r| json!({
            "id": r.id.as_str(), "roomId": r.room_id.as_str(), "reason": r.reason, "note": r.note,
            "roomTitle": r.room_title, "embedUrl": r.embed_url, "createdAt": r.created_at,
        })).collect::<Vec<_>>(),
        "openCount": reports.open_count().unwrap(),
        "takedowns": takedowns,
        "seatHolds": rooms.take_seat_holds().unwrap().iter().map(|h| json!({"roomId": h.room_id.as_str(), "nameHash": hex(&h.name_hash), "seat": h.seat.get()})).collect::<Vec<_>>(),
    });
    drop(conn);
    out
}

// A database the TS stores built reads, through the Rust stores, exactly as the TS stores list it.
#[test]
fn rust_reads_what_ts_wrote() {
    assert_eq!(dump(&interop("ts-written.db")), read_json("dump.json"));
}

// The Rust stores replaying the same spec write a database that dumps the same (and has the same schema SQL).
#[test]
fn rust_writes_what_ts_writes() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("built.db");
    build(&read_json("spec.json"), &path);
    assert_eq!(dump(&path), read_json("dump.json"));
    if std::env::var_os("UPDATE_INTEROP").is_some() {
        std::fs::copy(&path, interop("rust-written.db")).unwrap();
    }
}

// The committed Rust-written file (what `interop.test.ts` hands to the TS stores) is current.
#[test]
fn the_committed_rust_written_database_is_current() {
    assert_eq!(dump(&interop("rust-written.db")), read_json("dump.json"));
}
