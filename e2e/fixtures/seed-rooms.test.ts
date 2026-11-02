import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { E2E_MAX_ROOMS, SEED_HEADROOM } from "../support/test-rooms";

const ROOT = resolve(import.meta.dirname, "../..");

test(`the seed leaves at least ${String(SEED_HEADROOM)} rooms under the e2e room cap (OME-2164)`, () => {
  const db = join(mkdtempSync(join(tmpdir(), "omega-seed-headroom-")), "omega.db");
  const seeded = spawnSync("bun", ["e2e/fixtures/seed-rooms.ts", db], { cwd: ROOT, encoding: "utf8" });
  expect(seeded.status, seeded.stderr).toBe(0);
  const conn = new Database(db, { readonly: true });
  const row = conn.query("SELECT count(*) AS n FROM rooms").get();
  conn.close();
  const rooms = row !== null && typeof row === "object" && "n" in row && typeof row.n === "number" ? row.n : NaN;
  expect(rooms).toBeGreaterThan(0);
  expect(E2E_MAX_ROOMS - rooms, `${String(rooms)} seeded rooms of E2E_MAX_ROOMS ${String(E2E_MAX_ROOMS)}: share rooms between specs or raise E2E_MAX_ROOMS`).toBeGreaterThanOrEqual(SEED_HEADROOM);
}, 30_000);

test("every server booted from the full seed takes the e2e room cap", () => {
  const files = ["playwright.config.ts", ...readdirSync(join(ROOT, "e2e")).filter((f) => f.endsWith(".ts")).map((f) => `e2e/${f}`)];
  // A spawn of the full seed (not `--lobby-only`): `seed-rooms.ts", db]` in a spec, `seed-rooms.ts ${db}` in the config.
  const seeding = files.filter((f) => /seed-rooms\.ts", db\]|seed-rooms\.ts \$\{db\}/.test(readFileSync(join(ROOT, f), "utf8")));
  expect(seeding.length).toBeGreaterThan(1);
  expect(seeding.filter((f) => !readFileSync(join(ROOT, f), "utf8").includes("MAX_ROOMS: String(E2E_MAX_ROOMS)"))).toEqual([]);
});
