// Run with bun (bun:sqlite): `bun e2e/fixtures/seed-rooms.ts <db path>` (OME-341). Recreates the e2e server's DB
// with the lobby and every test room of e2e/support/test-rooms.ts, all on DEFAULT_LAYOUT. Playwright's webServer
// runs it right before `dev`, so each run starts from empty rooms. `--lobby-only` seeds the lobby alone, for a spec that
// creates rooms on its own server and needs the headroom under MAX_ROOMS (OME-2144).
import { readFileSync, rmSync } from "node:fs";
import * as v from "valibot";
import { DEFAULT_LAYOUT, DEFAULT_ROOM_ID, RoomLayoutSchema } from "@omega/shared";
import { openDatabase } from "../../apps/server/src/store/db";
import { RoomStore } from "../../apps/server/src/store/rooms";
import { hashSecret } from "../../apps/server/src/secrets";
import { GC_IDLE_ROOM_ID, GC_PINNED_IDLE_ROOM_ID, OWNED_ROOMS } from "../support/owned-rooms";
import { SPEC_ROOMS, TEST_ROOM_IDS, testRoomId } from "../support/test-rooms";
import { PADS, SET_G, doorTo } from "./layouts";

const [path, flag] = process.argv.slice(2);
const lobbyOnly = flag === "--lobby-only";
if (path === undefined || path === ":memory:" || (flag !== undefined && !lobbyOnly)) throw new Error("usage: seed-rooms.ts <db file path> [--lobby-only]");

for (const suffix of ["", "-wal", "-shm"]) rmSync(`${path}${suffix}`, { force: true });
const db = openDatabase(path);
const store = new RoomStore(db);
// Rooms whose layout the test needs on the server itself, not only in the snapshot: teleport pads, two doors to each other.
const DUNGEON = v.parse(RoomLayoutSchema, JSON.parse(readFileSync(new URL("../../assets/presets/dank-dungeon.json", import.meta.url), "utf8")));
const preset = (file: string) => v.parse(RoomLayoutSchema, JSON.parse(readFileSync(new URL(`../../assets/presets/${file}`, import.meta.url), "utf8")));
const SEEDED_LAYOUTS = new Map([
  // Every shipped preset as created from the form, for the room-art bytes row (OME-2152).
  ...SPEC_ROOMS["art-perf"].map((p) => [testRoomId("art-perf", p), preset(`${p}.json`)] as const),
  [testRoomId("teleport", "pads"), PADS],
  // Sofas and a couch (the sofa at layout index 2 is seats 0-1), for lying down (OME-1691).
  [testRoomId("lie", "sofa"), SET_G],
  // The Dank Dungeon without its partitions, so a sleeper's view doesn't turn (OME-1961): its first queen bed is layout index
  // 1 (seats 0-1) and sleeps two (OME-2009), moved to row 4 so its lie key clears the TV shelf at 1280×720; the second bed
  // faces sw, so only the first one's frames match the spec's nw filter.
  [testRoomId("lie", "bed"), { ...DUNGEON, furniture: DUNGEON.furniture.filter((f) => f.kind !== "partition").map((f, i) => (f.kind !== "bed" ? f : i === 1 ? { ...f, row: 4 } : { ...f, facing: "sw" as const })) }],
  // The whole preset for the 180° view swap (OME-1961).
  [testRoomId("view-swap", "main"), DUNGEON],
  [testRoomId("view-swap-perf", "frames"), DUNGEON],
  // The preset with a wall screen (span 2, segments 3-4 of the left wall, not the fixtures 5, 6, 8) in place of its TV: the swapped view's ghost (OME-2069).
  [testRoomId("wall-screen", "north"), { ...DUNGEON, furniture: DUNGEON.furniture.map((f) => (f.kind === "tv" ? { kind: "wallscreen" as const, col: 0, row: 3, facing: "se" as const } : f)) }],
  [testRoomId("doors", "a"), doorTo(testRoomId("doors", "b"))],
  [testRoomId("doors", "b"), doorTo(testRoomId("doors", "a"))],
]);
for (const [i, id] of [DEFAULT_ROOM_ID, ...(lobbyOnly ? [] : TEST_ROOM_IDS)].entries()) {
  store.createRoom({ id, title: id === DEFAULT_ROOM_ID ? "Lobby" : "", createdAt: i + 1, layout: SEEDED_LAYOUTS.get(id) ?? DEFAULT_LAYOUT });
}
if (lobbyOnly) {
  db.close();
  process.exit(0);
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
