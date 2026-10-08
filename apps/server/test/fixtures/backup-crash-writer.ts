/**
 * Leaves a DB the way `systemctl stop` does (OME-383): in WAL mode, with committed frames that were
 * never checkpointed into the main file. Writes rooms `crash-a` and `crash-b`, then SIGKILLs itself.
 */
import { DEFAULT_LAYOUT } from "@omega/shared";
import { openDatabase } from "../../src/store/db";
import { RoomStore } from "../../src/store/rooms";

const path = process.argv[2];
if (path === undefined) throw new Error("usage: backup-crash-writer.ts <db>");
const db = openDatabase(path);
db.run("PRAGMA wal_autocheckpoint = 0");
const store = new RoomStore(db);
store.createRoom({ id: "crash-a", title: "", createdAt: 10, layout: DEFAULT_LAYOUT });
store.createRoom({ id: "crash-b", title: "", createdAt: 11, layout: DEFAULT_LAYOUT });
process.kill(process.pid, "SIGKILL");
