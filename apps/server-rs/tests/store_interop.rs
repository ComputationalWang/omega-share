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
//! the TS side reads in `interop/interop.test.ts`; regenerate them with `UPDATE_INTEROP=1 cargo test --test store_interop`.

use omega_server::contract::Obj;
use omega_server::contract::generic_embed::AnyEmbed;
use omega_server::contract::ids::{QueueItemId, RoomId};
use omega_server::contract::layout::RoomLayout;
use omega_server::contract::room::{ControlPolicy, RoomVisibility, SeatIndex};
use omega_server::contract::text::RoomTitle;
use omega_server::store::{NewReport, NewRoom, ReportId, ReportStore, RoomStore, SeatHold, Store, StoredQueueItem};
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

fn list(v: &Value, key: &str) -> Vec<Value> {
    v[key].as_array().cloned().unwrap_or_default()
}

fn qid(s: &str) -> QueueItemId {
    QueueItemId::parse(s).unwrap()
}

fn title_of(v: &Value) -> Option<RoomTitle> {
    match v.as_str().unwrap() {
        "" => None,
        t => Some(RoomTitle::parse(t).unwrap()),
    }
}

/// One store call on a room, as `interop/dump.ts` `applyOp`.
fn apply_op(rooms: &RoomStore, room: &RoomId, o: &Value) {
    match o["op"].as_str().unwrap() {
        "removeItem" => {
            rooms.remove_queue_item(room, &qid(o["id"].as_str().unwrap())).unwrap();
        }
        "addItem" => rooms.add_queue_item(room, &item(&o["item"])).unwrap(),
        "advance" => rooms.advance_queue(room, &item(&o["item"])).unwrap(),
        "setTitle" => rooms.set_title(room, title_of(&o["title"]).as_ref()).unwrap(),
        "setLayout" => rooms
            .set_layout(room, &RoomLayout::parse(&serde_json::to_vec(&o["layout"]).unwrap()).unwrap())
            .unwrap(),
        "setEmbed" => {
            let item_id = o["itemId"].as_str().map(qid);
            let e = (!o["embed"].is_null()).then(|| embed(&o["embed"]));
            rooms.set_embed(room, e.as_ref(), item_id.as_ref()).unwrap();
        }
        "setControlPolicy" => {
            let policy = if o["policy"] == "owner" {
                ControlPolicy::Owner
            } else {
                ControlPolicy::Everyone
            };
            rooms.set_control_policy(room, policy).unwrap();
        }
        "setLastActive" => rooms.set_last_active(room, o["at"].as_i64().unwrap()).unwrap(),
        "setPinned" => rooms.set_pinned(room, o["pinned"].as_bool().unwrap()).unwrap(),
        other => panic!("unknown op {other}"),
    }
}

/// `interop/dump.ts` `createRoom`: the room, then its follow-up calls in the same order.
fn create_room(rooms: &RoomStore, r: &Value) {
    let id = rid(&r["id"]);
    let layout = RoomLayout::parse(&serde_json::to_vec(&r["layout"]).unwrap()).unwrap();
    rooms
        .create_room(&NewRoom {
            id: id.clone(),
            title: title_of(&r["title"]),
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
        let item_id = r["itemId"].as_str().map(qid);
        rooms.set_embed(&id, Some(&embed(&r["embed"])), item_id.as_ref()).unwrap();
    }
    if r["then"] == "addAndStart" {
        let start = item(&r["startItem"]);
        rooms.add_queue_item_and_start(&id, &start, &start).unwrap();
    }
    let queue: Vec<StoredQueueItem> = list(r, "queue").iter().map(item).collect();
    for q in &queue {
        rooms.add_queue_item(&id, q).unwrap();
    }
    if r["then"] == "advance" {
        rooms.advance_queue(&id, queue.first().unwrap()).unwrap();
    }
    if r["unpin"] == true {
        rooms.set_pinned(&id, false).unwrap();
    }
    for o in list(r, "ops") {
        apply_op(rooms, &id, &o);
    }
}

fn holds_of(v: &[Value]) -> Vec<SeatHold> {
    v.iter()
        .map(|h| SeatHold {
            room_id: rid(&h["roomId"]),
            name_hash: unhex(h["nameHash"].as_str().unwrap()),
            seat: SeatIndex::new(h["seat"].as_u64().unwrap()).unwrap(),
        })
        .collect()
}

fn add_report(reports: &ReportStore, r: &Value) {
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

fn bulk_id(i: i64) -> String {
    format!("bulk{i:018}")
}

fn bulk_report(base: i64, i: i64) -> Value {
    json!({"id": bulk_id(i), "roomId": "lobby", "reason": "spam", "note": null, "roomTitle": null, "embedUrl": null, "createdAt": base + i})
}

fn report_id(v: &Value) -> ReportId {
    ReportId::parse(v.as_str().unwrap()).unwrap()
}

/// The history step shared by the base replay and the mixed step: reports, closes, takedowns, purge.
fn finish_reports(reports: &ReportStore, spec: &Value) {
    for id in list(spec, "dismiss") {
        reports.dismiss(&report_id(&id)).unwrap();
    }
    for id in list(spec, "actionRooms") {
        reports.action_room(&rid(&id)).unwrap();
    }
    for t in list(spec, "takedowns") {
        reports.add_takedown(&rid(&t["roomId"]), t["at"].as_i64().unwrap()).unwrap();
    }
}

/// Replays the spec through the Rust stores, in the order `interop/dump.ts` `replay` does.
fn replay(spec: &Value, store: &Store) {
    let (rooms, reports) = (store.rooms(), store.reports());
    for r in list(spec, "rooms") {
        create_room(&rooms, &r);
    }
    rooms.save_seat_holds(&holds_of(&list(spec, "seatHolds"))).unwrap();
    for r in list(spec, "rooms") {
        if r["deleted"] == true {
            rooms.delete_room(&rid(&r["id"])).unwrap();
        }
    }
    for r in list(spec, "reports") {
        add_report(&reports, &r);
    }
    finish_reports(&reports, spec);
    let (first, then, base, close_below) = (
        spec["bulk"]["first"].as_i64().unwrap(),
        spec["bulk"]["then"].as_i64().unwrap(),
        spec["bulk"]["base"].as_i64().unwrap(),
        spec["bulk"]["closeBelow"].as_i64().unwrap(),
    );
    for i in 0..first {
        add_report(&reports, &bulk_report(base, i));
    }
    for i in 0..close_below {
        reports.dismiss(&report_id(&json!(bulk_id(i)))).unwrap();
    }
    for i in first..first + then {
        add_report(&reports, &bulk_report(base, i));
    }
    reports.purge(spec["purgeBefore"].as_i64().unwrap()).unwrap();
}

/// The mixed-history step, as `interop/dump.ts` `applyMixed`.
fn apply_mixed(spec: &Value, store: &Store) {
    let m = &spec["mixed"];
    let (rooms, reports) = (store.rooms(), store.reports());
    for r in list(m, "newRooms") {
        create_room(&rooms, &r);
    }
    for o in list(m, "ops") {
        apply_op(&rooms, &rid(&o["room"]), &o);
    }
    for id in list(m, "deleteRooms") {
        rooms.delete_room(&rid(&id)).unwrap();
    }
    rooms.save_seat_holds(&holds_of(&list(m, "holds"))).unwrap();
    for r in list(m, "reports") {
        add_report(&reports, &r);
    }
    finish_reports(&reports, m);
    reports.purge(m["purgeBefore"].as_i64().unwrap()).unwrap();
}

/// A fresh database from the spec, checkpointed and closed.
fn build(spec: &Value, path: &Path) {
    let _ = std::fs::remove_file(path);
    let store = Store::open(&path.to_string_lossy()).unwrap();
    replay(spec, &store);
    store.checkpoint().unwrap();
}

/// The mixed step applied in place to an existing database file.
fn mutate(spec: &Value, path: &Path) {
    let store = Store::open(&path.to_string_lossy()).unwrap();
    apply_mixed(spec, &store);
    store.checkpoint().unwrap();
}

/// Replaces `dest` with a copy of `src` atomically (a temp file in the same directory, then a rename), so a
/// concurrent reader sees the old file or the new one, never a partial one.
fn install(src: &Path, dest: &Path) {
    let tmp = dest.with_extension("db.tmp");
    std::fs::copy(src, &tmp).unwrap();
    std::fs::rename(&tmp, dest).unwrap();
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
        "rawReports": raw(&conn, "SELECT * FROM reports WHERE id NOT LIKE 'bulk%' ORDER BY id"),
        "bulkReports": raw(&conn, "SELECT state, count(*) AS n, min(created_at) AS oldest, max(created_at) AS newest FROM reports WHERE id LIKE 'bulk%' GROUP BY state ORDER BY state"),
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
        "openReports": reports.list_open().unwrap().iter().filter(|r| !r.id.as_str().starts_with("bulk")).map(|r| json!({
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
}

// Mixed history: the Rust stores mutate a database the TS stores wrote (and one they wrote themselves); the
// dump equals the TS-only history.
#[test]
fn rust_mutates_what_ts_wrote_and_the_dump_is_the_ts_history() {
    let spec = read_json("spec.json");
    let dir = tempfile::tempdir().unwrap();
    let from_ts = dir.path().join("from-ts.db");
    std::fs::copy(interop("ts-written.db"), &from_ts).unwrap();
    mutate(&spec, &from_ts);
    assert_eq!(dump(&from_ts), read_json("mixed-dump.json"));
    let from_rust = dir.path().join("from-rust.db");
    build(&spec, &from_rust);
    mutate(&spec, &from_rust);
    assert_eq!(dump(&from_rust), read_json("mixed-dump.json"));
}

// The committed Rust-written files (what `interop.test.ts` hands to the TS stores) are current. With
// UPDATE_INTEROP set this one test regenerates them first (atomically), so no other test races the write.
#[test]
fn the_committed_rust_written_databases_are_current() {
    let spec = read_json("spec.json");
    if std::env::var_os("UPDATE_INTEROP").is_some() {
        let dir = tempfile::tempdir().unwrap();
        let base = dir.path().join("base.db");
        build(&spec, &base);
        install(&base, &interop("rust-written.db"));
        let mixed = dir.path().join("mixed.db");
        std::fs::copy(interop("ts-written.db"), &mixed).unwrap();
        mutate(&spec, &mixed);
        install(&mixed, &interop("rust-mixed.db"));
    }
    assert_eq!(dump(&interop("rust-written.db")), read_json("dump.json"));
    assert_eq!(dump(&interop("rust-mixed.db")), read_json("mixed-dump.json"));
}
