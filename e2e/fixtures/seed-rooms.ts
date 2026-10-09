// Run with bun (bun:sqlite): `bun e2e/fixtures/seed-rooms.ts <db path>` (OME-341). Recreates the e2e server's DB
// with the lobby and every test room of e2e/support/test-rooms.ts, all on DEFAULT_LAYOUT. Playwright's webServer
// runs it right before `dev`, so each run starts from empty rooms.
import { rmSync } from "node:fs";
import { DEFAULT_LAYOUT, DEFAULT_ROOM_ID } from "@omega/shared";
import { openDatabase } from "../../apps/server/src/store/db";
import { RoomStore } from "../../apps/server/src/store/rooms";
import { hashSecret } from "../../apps/server/src/secrets";
import { OWNED_ROOMS } from "../support/owned-rooms";
import { TEST_ROOM_IDS } from "../support/test-rooms";

const path = process.argv[2];
if (path === undefined || path === ":memory:") throw new Error("usage: seed-rooms.ts <db file path>");

for (const suffix of ["", "-wal", "-shm"]) rmSync(`${path}${suffix}`, { force: true });
const db = openDatabase(path);
const store = new RoomStore(db);
for (const [i, id] of [DEFAULT_ROOM_ID, ...TEST_ROOM_IDS].entries()) {
  store.createRoom({ id, title: id === DEFAULT_ROOM_ID ? "Lobby" : "", createdAt: i + 1, layout: DEFAULT_LAYOUT });
}
// The QA rooms specs' rooms (OME-417): private, unpinned (so the owner can delete them), with known secrets. createdAt is
// now, so the GC (an unjoined room goes an hour after createdAt) leaves them alone for the run.
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
}
db.close();
