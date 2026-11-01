import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_ROOM_ID } from "@omega/shared";

// room-presets.e2e.ts creates 10 rooms on its own server: seeded with every spec's rooms, that sits at MAX_ROOMS (OME-2144).
test("--lobby-only seeds the lobby and nothing else, whatever the specs' room count", () => {
  const dir = mkdtempSync(join(tmpdir(), "omega-seed-"));
  try {
    const path = join(dir, "omega.db");
    const seed = spawnSync("bun", [join(import.meta.dir, "seed-rooms.ts"), path, "--lobby-only"], { encoding: "utf8" });
    expect(seed.status, seed.stderr).toBe(0);
    const db = new Database(path, { readonly: true });
    const ids = db.query<{ id: string }, []>("SELECT id FROM rooms").all().map((r) => r.id);
    db.close();
    expect(ids).toEqual([DEFAULT_ROOM_ID]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
