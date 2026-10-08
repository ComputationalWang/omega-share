import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import * as fs from "node:fs";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, truncateSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_LAYOUT, RoomListResponseSchema, type RoomLayout } from "@omega/shared";
import * as v from "valibot";
import { KEEP, prune, restore, snapshot, verifySnapshot } from "../scripts/backup";
import { openDatabase } from "../src/store/db";
import { RoomStore } from "../src/store/rooms";
import { Client } from "./helpers";

const REPO = join(import.meta.dir, "../../..");
const CLI = join(import.meta.dir, "../scripts/backup.ts");
const WRITER = join(import.meta.dir, "fixtures/backup-writer.ts");
const CRASH_WRITER = join(import.meta.dir, "fixtures/backup-crash-writer.ts");
const PULL = join(REPO, "deploy/backup/pull.sh");
const RESTORE = join(REPO, "deploy/backup/restore.sh");
const UNIT = join(REPO, "deploy/backup/omega-share-backup.service");
const TIMER = join(REPO, "deploy/backup/omega-share-backup.timer");

/** The plant moved to the far corner: a layout that is not DEFAULT_LAYOUT. */
const MOVED: RoomLayout = {
  furniture: DEFAULT_LAYOUT.furniture.map((f) => (f.kind === "plant" ? { ...f, col: 9, row: 9 } : f)),
};
const NIGHT = new Date("2026-10-08T03:30:00Z");
const day = (n: number): Date => new Date(Date.UTC(2026, 8, n, 3, 30));
const names = (n: number[]): string[] => n.map((d) => `omega-2026-09-${String(d).padStart(2, "0")}.db`);
const mode = (path: string): number => statSync(path).mode & 0o777;

let dir: string | null = null;
const cleanups: (() => void)[] = [];

afterEach(() => {
  for (const c of cleanups.splice(0).reverse()) c();
  if (dir !== null) rmSync(dir, { recursive: true, force: true });
  dir = null;
});

function tmp(): string {
  dir ??= mkdtempSync(join(tmpdir(), "omega-backup-"));
  return dir;
}

/** A live DB with `lobby` (default layout) and `den` (MOVED), closed again. */
function seed(path = join(tmp(), "live/omega.db"), extra = 0): string {
  const db = openDatabase(path);
  const store = new RoomStore(db);
  store.createRoom({ id: "lobby", title: "", createdAt: 1, layout: DEFAULT_LAYOUT });
  store.createRoom({ id: "den", title: "Den", createdAt: 2, layout: MOVED });
  db.transaction(() => {
    for (let i = 0; i < extra; i++) store.createRoom({ id: `seed-${String(i)}`, title: "x".repeat(200), createdAt: 3 + i, layout: DEFAULT_LAYOUT });
  })();
  // Out of WAL, so no checkpoint can rewrite the file later (a deferred close) and the byte
  // comparisons below see only what restore does.
  db.run("PRAGMA journal_mode = DELETE");
  db.close();
  return path;
}

/** Reads rooms without migrating or switching the file's journal mode. */
function rooms(path: string): { id: string; layout: RoomLayout }[] {
  const db = new Database(path, { strict: true });
  try {
    return new RoomStore(db).listRooms();
  } finally {
    db.close();
  }
}

const sha = (path: string): string => new Bun.CryptoHasher("sha256").update(readFileSync(path)).digest("hex");

describe("snapshot (VACUUM INTO, research §2.5)", () => {
  test("writes omega-<UTC date>.db, mode 0600, into a 0700 dir it creates, and it verifies", () => {
    const live = seed();
    const out = join(tmp(), "backups");
    const path = snapshot(live, out, NIGHT);
    expect(path).toBe(join(out, "omega-2026-10-08.db"));
    expect(mode(path)).toBe(0o600);
    expect(mode(out)).toBe(0o700);
    expect(verifySnapshot(path).rooms).toBe(2);
    expect(rooms(path).find((r) => r.id === "den")?.layout).toEqual(MOVED);
    expect(readdirSync(out)).toEqual(["omega-2026-10-08.db"]);
  });

  test("a second run the same day replaces that day's snapshot", () => {
    const live = seed();
    const out = join(tmp(), "backups");
    snapshot(live, out, NIGHT);
    const db = openDatabase(live);
    new RoomStore(db).createRoom({ id: "late", title: "", createdAt: 9, layout: DEFAULT_LAYOUT });
    db.close();
    const path = snapshot(live, out, new Date("2026-10-08T23:59:00Z"));
    expect(verifySnapshot(path).rooms).toBe(3);
    expect(readdirSync(out)).toEqual(["omega-2026-10-08.db"]);
  });

  test("is consistent while another process keeps writing", async () => {
    const live = seed(undefined, 3000);
    const writer = Bun.spawn([process.execPath, WRITER, live], { stdout: "pipe", stderr: "inherit" });
    cleanups.push(() => {
      writer.kill();
    });
    const reader = writer.stdout.getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toContain("ready");

    const out = join(tmp(), "backups");
    const counts: number[] = [];
    for (let d = 1; d <= 5; d++) {
      const path = snapshot(live, out, day(d));
      expect(verifySnapshot(path).rooms).toBeGreaterThan(3000);
      const w = rooms(path).filter((r) => r.id.startsWith("w-")).length;
      expect(w % 2).toBe(0); // never half of a committed pair
      counts.push(w);
      await Bun.sleep(20);
    }
    writer.kill();
    await writer.exited;
    expect(counts[0]).toBeGreaterThan(0);
    for (let i = 1; i < counts.length; i++) expect(counts[i]).toBeGreaterThan(counts[i - 1] ?? Infinity);
    expect(readdirSync(out).sort()).toEqual(names([1, 2, 3, 4, 5]));
  }, 30_000);

  test("leaves no temp file behind when the final rename fails", () => {
    const live = seed();
    const out = join(tmp(), "backups");
    mkdirSync(join(out, "omega-2026-10-08.db", "in-the-way"), { recursive: true }); // rename onto a full dir throws
    expect(() => snapshot(live, out, NIGHT)).toThrow();
    expect(readdirSync(out)).toEqual(["omega-2026-10-08.db"]);
  });

  test("sweeps temp files a killed run left behind on an earlier night", () => {
    const live = seed();
    const out = join(tmp(), "backups");
    mkdirSync(out, { mode: 0o700 });
    const stale = join(out, ".omega-2026-10-06.db.tmp");
    writeFileSync(stale, "x".repeat(4096));
    const old = new Date("2026-10-06T03:31:00Z");
    utimesSync(stale, old, old);
    snapshot(live, out, NIGHT);
    expect(readdirSync(out)).toEqual(["omega-2026-10-08.db"]);
  });

  test("keeps the newest 14 days: the 15th night prunes the oldest", () => {
    const live = seed();
    const out = join(tmp(), "backups");
    for (let d = 1; d <= 15; d++) snapshot(live, out, day(d));
    expect(KEEP).toBe(14);
    expect(readdirSync(out).sort()).toEqual(names([2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]));
  });
});

describe("prune", () => {
  test("removes all but the newest 14 snapshots and leaves other files alone", () => {
    const out = join(tmp(), "backups");
    mkdirSync(out);
    for (const n of names([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20])) writeFileSync(join(out, n), "x");
    writeFileSync(join(out, "notes.txt"), "keep me");
    writeFileSync(join(out, "omega-latest.db"), "not a dated snapshot");
    expect(prune(out).sort()).toEqual(names([1, 2, 3, 4, 5, 6]).map((n) => join(out, n)));
    expect(readdirSync(out).sort()).toEqual([...names([7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20]), "notes.txt", "omega-latest.db"].sort());
  });

  test("removes stale temp files a killed snapshot left, but not one still being written", () => {
    const out = join(tmp(), "backups");
    mkdirSync(out);
    const stale = join(out, ".omega-2026-09-01.db.tmp");
    const fresh = join(out, ".omega-2026-09-02.db.tmp");
    writeFileSync(stale, "x");
    writeFileSync(fresh, "x");
    const old = new Date(Date.now() - 2 * 24 * 3600 * 1000);
    utimesSync(stale, old, old);
    writeFileSync(join(out, ".other.tmp"), "not ours");
    expect(prune(out)).toEqual([stale]);
    expect(readdirSync(out).sort()).toEqual([".omega-2026-09-02.db.tmp", ".other.tmp"]);
  });

  test("with 14 or fewer, removes nothing", () => {
    const out = join(tmp(), "backups");
    mkdirSync(out);
    for (const n of names([3, 1, 2])) writeFileSync(join(out, n), "x");
    expect(prune(out)).toEqual([]);
    expect(readdirSync(out)).toHaveLength(3);
  });
});

describe("restore", () => {
  function corrupt(kind: string, snap: string): void {
    if (kind === "not a database") writeFileSync(snap, "this is not an SQLite file at all, just text\n".repeat(200));
    if (kind === "truncated") truncateSync(snap, Math.floor(statSync(snap).size / 2));
    if (kind === "a damaged page") {
      const bytes = readFileSync(snap);
      bytes.fill(0xa5, 4096 * 3, 4096 * 3 + 2048); // the middle of a b-tree page
      writeFileSync(snap, bytes);
    }
    if (kind === "a forged layout") {
      const db = new Database(snap);
      db.run("UPDATE rooms SET layout = ? WHERE id = 'den'", [JSON.stringify({ furniture: [] })]);
      db.close();
    }
    if (kind === "an empty database") {
      rmSync(snap);
      new Database(snap).close();
    }
  }

  test.each(["not a database", "truncated", "a damaged page", "a forged layout", "an empty database"])(
    "refuses %s and leaves DB_PATH untouched",
    (kind) => {
      const snap = snapshot(seed(join(tmp(), "src/omega.db"), 400), join(tmp(), "backups"), NIGHT);
      corrupt(kind, snap);
      const live = seed();
      const before = sha(live);
      const files = readdirSync(join(tmp(), "live")).sort();

      expect(() => verifySnapshot(snap)).toThrow();
      expect(() => restore(snap, live)).toThrow(/refus/);
      expect(sha(live)).toBe(before);
      expect(readdirSync(join(tmp(), "live")).sort()).toEqual(files);
    },
  );

  test("replaces DB_PATH (0600), ignores a stale WAL and keeps the old DB aside", () => {
    const snap = snapshot(seed(), join(tmp(), "backups"), NIGHT);

    // A crashed server: "beta" exists only in the live DB's WAL.
    const scratch = join(tmp(), "scratch/omega.db");
    seed(scratch);
    const open = openDatabase(scratch);
    new RoomStore(open).createRoom({ id: "beta", title: "", createdAt: 9, layout: DEFAULT_LAYOUT });
    const live = join(tmp(), "crashed/omega.db");
    mkdirSync(join(tmp(), "crashed"), { mode: 0o700 });
    copyFileSync(scratch, live);
    copyFileSync(`${scratch}-wal`, `${live}-wal`);
    open.close();

    const result = restore(snap, live, NIGHT);
    expect(result.rooms).toBe(2);
    expect(mode(live)).toBe(0o600);
    expect(existsSync(`${live}-wal`)).toBe(false);
    expect(rooms(live).map((r) => r.id)).toEqual(["lobby", "den"]);

    expect(result.previous).not.toBeNull();
    const previous = result.previous ?? "";
    expect(rooms(previous).map((r) => r.id)).toEqual(["lobby", "den", "beta"]);
  });

  test("a death mid-swap never leaves DB_PATH missing or stale: the old DB, WAL frames folded in, stays until the new one lands atomically", () => {
    const snap = snapshot(seed(join(tmp(), "src/omega.db")), join(tmp(), "backups"), NIGHT);
    const live = seed();
    const db = openDatabase(live);
    new RoomStore(db).createRoom({ id: "beta", title: "", createdAt: 9, layout: DEFAULT_LAYOUT });
    db.run("PRAGMA journal_mode = DELETE");
    db.close();
    // Then the server is stopped the usual way: WAL mode, rows only in frames never checkpointed.
    const crash = Bun.spawnSync([process.execPath, CRASH_WRITER, live], { stdout: "pipe", stderr: "pipe" });
    expect(crash.signalCode).toBe("SIGKILL");
    expect(statSync(`${live}-wal`).size).toBeGreaterThan(0);

    // The process dies the moment it tries to move the restored copy into place.
    const real = fs.renameSync;
    const rename = spyOn(fs, "renameSync").mockImplementation((from, to) => {
      if (to === live) throw new Error("killed");
      real(from, to);
    });
    cleanups.push(() => {
      rename.mockRestore();
    });
    expect(() => restore(snap, live, NIGHT)).toThrow("killed");
    rename.mockRestore();

    expect(existsSync(live)).toBe(true);
    expect(rooms(live).map((r) => r.id)).toEqual(["lobby", "den", "beta", "crash-a", "crash-b"]);
  });

  test("restores into a wiped DB_PATH", () => {
    const snap = snapshot(seed(), join(tmp(), "backups"), NIGHT);
    const live = join(tmp(), "wiped/omega.db");
    const result = restore(snap, live, NIGHT);
    expect(result).toEqual({ rooms: 2, previous: null });
    expect(mode(live)).toBe(0o600);
    expect(rooms(live).find((r) => r.id === "den")?.layout).toEqual(MOVED);
  });
});

describe("CLI and restore.sh", () => {
  const cli = (args: string[], env: Record<string, string>) => {
    const r = Bun.spawnSync([process.execPath, CLI, ...args], { env: { PATH: process.env["PATH"] ?? "", ...env }, stdout: "pipe", stderr: "pipe" });
    return { code: r.exitCode, out: r.stdout.toString() + r.stderr.toString() };
  };

  test("the CLI needs DB_PATH and a known command", () => {
    expect(cli(["snapshot"], {}).code).toBe(2);
    expect(cli(["nope"], { DB_PATH: join(tmp(), "x.db") }).code).toBe(2);
    expect(cli(["restore"], { DB_PATH: join(tmp(), "x.db") }).code).toBe(2);
  });

  test("the CLI refuses a corrupt snapshot with exit 1", () => {
    const bad = join(tmp(), "omega-2026-10-08.db");
    writeFileSync(bad, "garbage");
    const live = seed();
    const r = cli(["restore", bad], { DB_PATH: live });
    expect(r.code).toBe(1);
    expect(r.out).toContain("refus");
  });

  /** Stub `systemctl` and `runuser`: start spawns the real server on the restored DB_PATH. */
  function stubs(): { bin: string; log: string } {
    const bin = join(tmp(), "bin");
    const log = join(tmp(), "calls.log");
    mkdirSync(bin);
    writeFileSync(
      join(bin, "systemctl"),
      `#!/usr/bin/env bash
echo "systemctl $*" >> "${log}"
if [[ "$1" == start && -n "\${STUB_SERVER_PORT:-}" ]]; then
  PORT="$STUB_SERVER_PORT" setsid "${process.execPath}" "${join(REPO, "apps/server/src/index.ts")}" >> "${join(tmp(), "server.log")}" 2>&1 &
  echo $! > "${join(tmp(), "server.pid")}"
fi
`,
    );
    writeFileSync(join(bin, "runuser"), `#!/usr/bin/env bash\necho "runuser $1 $2" >> "${log}"\nshift 3\nexec "$@"\n`);
    chmodSync(join(bin, "systemctl"), 0o755);
    chmodSync(join(bin, "runuser"), 0o755);
    cleanups.push(() => {
      const pid = join(tmp(), "server.pid");
      if (existsSync(pid)) {
        try {
          process.kill(Number(readFileSync(pid, "utf8").trim()));
        } catch {
          // already gone
        }
      }
    });
    return { bin, log };
  }

  async function freePort(): Promise<number> {
    const s = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response() });
    const port = s.port ?? 0;
    await s.stop(true);
    return port;
  }

  test("restore.sh refuses a corrupt snapshot before stopping the service", () => {
    const { bin, log } = stubs();
    const bad = join(tmp(), "omega-2026-10-08.db");
    writeFileSync(bad, "garbage");
    const live = seed();
    const before = sha(live);
    const r = Bun.spawnSync(["bash", RESTORE, bad], {
      env: { PATH: `${bin}:${process.env["PATH"] ?? ""}`, DB_PATH: live, OMEGA_BUN: process.execPath, OMEGA_APP_DIR: REPO },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(r.exitCode).not.toBe(0);
    expect(r.stdout.toString() + r.stderr.toString()).toContain("refus");
    expect(existsSync(log) ? readFileSync(log, "utf8") : "").not.toContain("systemctl stop");
    expect(sha(live)).toBe(before);
  });

  test("restore.sh will not start the service on a missing DB_PATH after a failed restore", () => {
    const { bin, log } = stubs();
    // runuser that dies in the middle of the swap, after DB_PATH is gone.
    writeFileSync(
      join(bin, "runuser"),
      `#!/usr/bin/env bash\necho "runuser $1 $2" >> "${log}"\nshift 3\nif [[ " $* " == *" restore "* ]]; then rm -f "$DB_PATH"; exit 137; fi\nexec "$@"\n`,
    );
    const live = seed();
    const snap = snapshot(seed(join(tmp(), "src/omega.db")), join(tmp(), "backups"), NIGHT);
    const r = Bun.spawnSync(["bash", RESTORE, snap], {
      env: { PATH: `${bin}:${process.env["PATH"] ?? ""}`, DB_PATH: live, OMEGA_BUN: process.execPath, OMEGA_APP_DIR: REPO },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr.toString()).toContain(live);
    expect(readFileSync(log, "utf8")).toContain("systemctl stop");
    expect(readFileSync(log, "utf8")).not.toContain("systemctl start");
  });

  test("restore drill: seed rooms and layout, snapshot, wipe, restore, start the server, rooms and layout are back", async () => {
    // Seed and snapshot through the CLI, like the nightly timer.
    const live = seed();
    const backups = join(tmp(), "backups");
    const snap = cli(["snapshot"], { DB_PATH: live, BACKUP_DIR: backups });
    expect(snap.code).toBe(0);
    const path = join(backups, readdirSync(backups)[0] ?? "");
    expect(snap.out).toContain(path);

    // Wipe.
    for (const f of [live, `${live}-wal`, `${live}-shm`]) rmSync(f, { force: true });

    // Restore through the runbook script; its start brings up the real server.
    const { bin, log } = stubs();
    const port = await freePort();
    const proc = Bun.spawn(["bash", RESTORE, path], {
      env: {
        PATH: `${bin}:${process.env["PATH"] ?? ""}`,
        DB_PATH: live,
        OMEGA_BUN: process.execPath,
        OMEGA_APP_DIR: REPO,
        OMEGA_CHECK_URL: `http://127.0.0.1:${String(port)}/rooms`,
        STUB_SERVER_PORT: String(port),
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const code = await proc.exited;
    const out = (await new Response(proc.stdout).text()) + (await new Response(proc.stderr).text());
    expect(code, out).toBe(0);
    expect(out).toContain("den");
    // Verify first (a bad snapshot costs no downtime), then stop, restore, start.
    expect(readFileSync(log, "utf8").split("\n").filter((l) => l !== "")).toEqual([
      "runuser -u omega-share",
      "systemctl stop omega-share",
      "runuser -u omega-share",
      "systemctl start omega-share",
    ]);
    expect(mode(live)).toBe(0o600);

    const list = v.parse(RoomListResponseSchema, await (await fetch(`http://127.0.0.1:${String(port)}/rooms`)).json());
    expect(list.rooms.map((r) => r.id)).toEqual(["lobby", "den"]);
    const { client, snapshot: snap2 } = await Client.join(`ws://127.0.0.1:${String(port)}/rooms/den/ws`, "alice");
    cleanups.push(() => {
      client.close();
    });
    expect(snap2.room.layout).toEqual(MOVED);
  }, 30_000);
});

describe("pull.sh (off-box copy, run on the operator's machine)", () => {
  const pull = (env: Record<string, string>) => {
    const r = Bun.spawnSync(["bash", PULL], { env: { PATH: process.env["PATH"] ?? "", HOME: tmp(), ...env }, stdout: "pipe", stderr: "pipe" });
    return { code: r.exitCode, out: r.stdout.toString() + r.stderr.toString() };
  };

  function box(): string {
    const src = join(tmp(), "box");
    mkdirSync(src, { mode: 0o700 });
    for (const n of names([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20])) writeFileSync(join(src, n), n, { mode: 0o600 });
    writeFileSync(join(src, ".omega-2026-09-21.db.tmp"), "half written");
    writeFileSync(join(src, "notes.txt"), "not a snapshot");
    return src;
  }

  test("refuses with usage when OMEGA_BACKUP_SOURCE or OMEGA_BACKUP_DEST is missing", () => {
    expect(pull({}).code).toBe(2);
    expect(pull({ OMEGA_BACKUP_SOURCE: "deploy@example.org:/var/backups/omega-share/" }).code).toBe(2);
  });

  test("copies only finished snapshots, 0600 in a 0700 dir, and keeps the newest 14", () => {
    const src = box();
    const dest = join(tmp(), "offbox");
    const r = pull({ OMEGA_BACKUP_SOURCE: `${src}/`, OMEGA_BACKUP_DEST: dest, OMEGA_BACKUP_RSYNC_PATH: "rsync" });
    expect(r.code, r.out).toBe(0);
    expect(readdirSync(dest).sort()).toEqual(names([7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20]));
    expect(mode(dest)).toBe(0o700);
    for (const f of readdirSync(dest)) expect(mode(join(dest, f))).toBe(0o600);
  });

  test("fails loudly when the newest snapshot on the box is older than 36 h (the backup alarm)", () => {
    const src = box();
    const old = new Date(Date.now() - 37 * 3600_000);
    for (const f of readdirSync(src)) utimesSync(join(src, f), old, old);
    const dest = join(tmp(), "offbox");
    const r = pull({ OMEGA_BACKUP_SOURCE: `${src}/`, OMEGA_BACKUP_DEST: dest, OMEGA_BACKUP_RSYNC_PATH: "rsync" });
    expect(r.code).toBe(1);
    expect(r.out).toContain("older than 36 h");
    expect(readdirSync(dest)).toHaveLength(14);
  });

  test("a failed pull prunes nothing", () => {
    const dest = join(tmp(), "offbox");
    mkdirSync(dest, { mode: 0o700 });
    for (const n of names([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16])) writeFileSync(join(dest, n), n);
    const r = pull({ OMEGA_BACKUP_SOURCE: `${join(tmp(), "missing")}/`, OMEGA_BACKUP_DEST: dest, OMEGA_BACKUP_RSYNC_PATH: "rsync" });
    expect(r.code).not.toBe(0);
    expect(readdirSync(dest)).toHaveLength(16);
  });
});

describe("systemd units", () => {
  test("the snapshot service runs as the service user, umask 0077, no network", () => {
    const unit = readFileSync(UNIT, "utf8");
    for (const line of ["Type=oneshot", "User=omega-share", "UMask=0077", "PrivateNetwork=yes", "NoNewPrivileges=yes", "ProtectSystem=strict", "ReadWritePaths=/var/backups/omega-share"]) {
      expect(unit.split("\n")).toContain(line);
    }
    expect(unit).toMatch(/^ExecStart=\S*bun \S*apps\/server\/scripts\/backup\.ts snapshot$/m);
  });

  test("the timer runs nightly and catches up after downtime", () => {
    const timer = readFileSync(TIMER, "utf8").split("\n");
    expect(timer.some((l) => l.startsWith("OnCalendar=*-*-* "))).toBe(true);
    expect(timer).toContain("Persistent=true");
  });

  const hasShellcheck = Bun.spawnSync(["shellcheck", "--version"], { stdout: "ignore", stderr: "ignore" }).exitCode === 0;
  test.skipIf(!hasShellcheck)("the shell scripts are shellcheck clean", () => {
    const r = Bun.spawnSync(["shellcheck", PULL, RESTORE], { stdout: "pipe", stderr: "pipe" });
    expect(r.exitCode, r.stdout.toString()).toBe(0);
  });
});
