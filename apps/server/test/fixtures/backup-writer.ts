/**
 * A second process writing to the DB while a snapshot runs (OME-358). Each transaction inserts two
 * rooms, so any consistent snapshot holds an even number of `w-*` rooms. Prints "ready" after the
 * first commit and runs until killed.
 */
import { DEFAULT_LAYOUT } from "@omega/shared";
import { openDatabase } from "../../src/store/db";
import { RoomStore } from "../../src/store/rooms";

const path = process.argv[2];
if (path === undefined) throw new Error("usage: backup-writer.ts <db>");
const db = openDatabase(path);
const store = new RoomStore(db);
const pair = db.transaction((n: number) => {
  store.createRoom({ id: `w-${String(n)}-a`, title: "", createdAt: n, layout: DEFAULT_LAYOUT });
  store.createRoom({ id: `w-${String(n)}-b`, title: "", createdAt: n, layout: DEFAULT_LAYOUT });
});

let n = 0;
pair(n++);
console.log("ready");
for (;;) {
  pair(n++);
  if (n % 50 === 0) await Bun.sleep(0);
}
