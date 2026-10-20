// Run with bun (bun:sqlite): `bun e2e/fixtures/seed-rooms.ts <db path>` (OME-341). Recreates the e2e server's DB
// with the lobby and every test room of e2e/support/test-rooms.ts, all on DEFAULT_LAYOUT. Playwright's webServer
// runs it right before `dev`, so each run starts from empty rooms.
import { rmSync } from "node:fs";
import { DEFAULT_LAYOUT, DEFAULT_ROOM_ID } from "@omega/shared";
import { openDatabase } from "../../apps/server/src/store/db";
import { RoomStore } from "../../apps/server/src/store/rooms";
import { hashSecret } from "../../apps/server/src/secrets";
import { GC_IDLE_ROOM_ID, GC_PINNED_IDLE_ROOM_ID, OWNED_ROOMS } from "../support/owned-rooms";
import { TEST_ROOM_IDS, testRoomId } from "../support/test-rooms";
import { PADS, doorTo } from "./layouts";

const path = process.argv[2];
if (path === undefined || path === ":memory:") throw new Error("usage: seed-rooms.ts <db file path>");

for (const suffix of ["", "-wal", "-shm"]) rmSync(`${path}${suffix}`, { force: true });
const db = openDatabase(path);
const store = new RoomStore(db);
// Rooms whose layout the test needs on the server itself, not only in the snapshot: teleport pads, two doors to each other.
const SEEDED_LAYOUTS = new Map([
  [testRoomId("teleport", "pads"), PADS],
  [testRoomId("doors", "a"), doorTo(testRoomId("doors", "b"))],
  [testRoomId("doors", "b"), doorTo(testRoomId("doors", "a"))],
]);
for (const [i, id] of [DEFAULT_ROOM_ID, ...TEST_ROOM_IDS].entries()) {
  store.createRoom({ id, title: id === DEFAULT_ROOM_ID ? "Lobby" : "", createdAt: i + 1, layout: SEEDED_LAYOUTS.get(id) ?? DEFAULT_LAYOUT });
}
const MIN = 60_000;
// The QA rooms specs' rooms (OME-417): private, unpinned (so the owner can delete them), with known secrets. The GC
// deletes a room 20 min after it last emptied (OME-904), and a run is longer than that, so each one's last_active_at
// starts a day ahead: no sweep in the run sees it idle until a test has been in it and left.
for (const r of OWNED_ROOMS) {
  store.createRoom({
    id: r.id,
    title: r.title,
    createdAt: Date.now(),
    layout: DEFAULT_LAYOUT,
    visibility: r.visibility,
    pinned: false,
    ownerHash: hashSecret(r.ownerToken),
    inviteHash: hashSecret(r.inviteKey),
  });
  store.setLastActive(r.id, Date.now() + 24 * 60 * MIN);
}
// Nobody has been in it for 21 min: the server's boot sweep deletes it (e2e/room-gc.e2e.ts).
store.createRoom({ id: GC_IDLE_ROOM_ID, title: "Idle room", createdAt: Date.now() - 21 * MIN, layout: DEFAULT_LAYOUT, visibility: "public", pinned: false, ownerHash: hashSecret("gc-idle-owner") });
// Pinned and idle for 21 min on both clocks: pinned rooms are never collected (e2e/room-gc.e2e.ts).
store.createRoom({ id: GC_PINNED_IDLE_ROOM_ID, title: "Pinned idle room", createdAt: Date.now() - 21 * MIN, layout: DEFAULT_LAYOUT, visibility: "public", pinned: true });
store.setLastActive(GC_PINNED_IDLE_ROOM_ID, Date.now() - 21 * MIN);
db.close();
