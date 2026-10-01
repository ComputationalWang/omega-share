// Run with bun (bun:sqlite): `bun e2e/fixtures/seed-room.ts <db path>` (OME-281). Creates the lobby in a fresh DB with
// the set (g) test layout, which is not DEFAULT_LAYOUT, so a restart that fell back to the default would show.
import { DEFAULT_ROOM_ID } from "@omega/shared";
import { openDatabase } from "../../apps/server/src/store/db";
import { RoomStore } from "../../apps/server/src/store/rooms";
import { SET_G } from "./layouts";

const path = process.argv[2];
if (path === undefined) throw new Error("usage: seed-room.ts <db path>");

const db = openDatabase(path);
new RoomStore(db).createRoom({ id: DEFAULT_ROOM_ID, title: "Lobby", createdAt: 1, layout: SET_G });
db.close();
