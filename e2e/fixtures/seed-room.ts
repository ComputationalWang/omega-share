// Run with bun (bun:sqlite): `bun e2e/fixtures/seed-room.ts <db path>` (OME-281). Creates the lobby in a fresh DB with a
// layout that is not DEFAULT_LAYOUT, so a restart that fell back to the default would show.
import { DEFAULT_LAYOUT, DEFAULT_ROOM_ID, type RoomLayout } from "@omega/shared";
import { openDatabase } from "../../apps/server/src/store/db";
import { RoomStore } from "../../apps/server/src/store/rooms";

const path = process.argv[2];
if (path === undefined) throw new Error("usage: seed-room.ts <db path>");

/** The default room with the plant moved to the far corner and a second lamp added: valid, but recognisably not the default. */
const CUSTOM_LAYOUT: RoomLayout = {
  furniture: [
    ...DEFAULT_LAYOUT.furniture.map((f) => (f.kind === "plant" ? { ...f, col: 9, row: 9 } : f)),
    { kind: "lamp", col: 9, row: 3, facing: "se" },
  ],
};

const db = openDatabase(path);
new RoomStore(db).createRoom({ id: DEFAULT_ROOM_ID, title: "Lobby", createdAt: 1, layout: CUSTOM_LAYOUT });
db.close();
