import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decideReuse, describeOwner, ownerDir, listOwners, readOwner, reapTargets, removeOwner, writeOwner, type Owner } from "./owner";

// OME-821: a server the harness starts carries an owner file; it is reused only by the same agent at the same HEAD,
// and anything else is refused with the owner's name instead of being silently reused.
const QA = "0e8d6a7c-edbf-478b-b6f5-c90fb4e25023";
const QA2 = "d72569af-a258-4057-8723-7b94b7d96755";
const SHA = "a".repeat(40);
const OTHER_SHA = "b".repeat(40);

const owner = (over: Partial<Owner> = {}): Owner => ({ port: 10_300, pid: 4242, pgid: 4243, agent: QA, sha: SHA, cmd: "bun e2e/fixtures/server.ts", startedAt: "2026-10-10T20:00:00.000Z", ...over });
const alive = (): boolean => true;
const dead = (): boolean => false;

describe("decideReuse", () => {
  test("a free port with no owner file: start our own", () => {
    expect(decideReuse({ inUse: false, owner: null, alive, agent: QA, sha: SHA })).toEqual({ kind: "start", stale: false });
  });

  test("our own live server at HEAD: reuse it", () => {
    expect(decideReuse({ inUse: true, owner: owner(), alive, agent: QA, sha: SHA })).toEqual({ kind: "reuse" });
  });

  test("another agent's server: refused, naming that agent", () => {
    const d = decideReuse({ inUse: true, owner: owner({ agent: QA2 }), alive, agent: QA, sha: SHA });
    expect(d.kind).toBe("refuse");
    if (d.kind === "refuse") expect(d.reason).toMatch(/QA Engineer 2/);
  });

  test("our own server from another commit: refused, pointing at e2e:reap", () => {
    const d = decideReuse({ inUse: true, owner: owner({ sha: OTHER_SHA }), alive, agent: QA, sha: SHA });
    expect(d.kind).toBe("refuse");
    if (d.kind === "refuse") {
      expect(d.reason).toContain(OTHER_SHA.slice(0, 10));
      expect(d.reason).toContain("bun run e2e:reap");
    }
  });

  test("a port in use with no owner file: refused, never reused", () => {
    const d = decideReuse({ inUse: true, owner: null, alive, agent: QA, sha: SHA });
    expect(d.kind).toBe("refuse");
    if (d.kind === "refuse") expect(d.reason).toMatch(/no owner file/);
  });

  test("a dead owner on a free port is stale: start, and drop the file", () => {
    expect(decideReuse({ inUse: false, owner: owner({ agent: QA2 }), alive: dead, agent: QA, sha: SHA })).toEqual({ kind: "start", stale: true });
  });

  test("a dead owner but the port still answers: refused as unowned", () => {
    const d = decideReuse({ inUse: true, owner: owner(), alive: dead, agent: QA, sha: SHA });
    expect(d.kind).toBe("refuse");
  });

  test("a live owner whose port is not up yet: refused, not raced", () => {
    const d = decideReuse({ inUse: false, owner: owner({ agent: QA2 }), alive, agent: QA, sha: SHA });
    expect(d.kind).toBe("refuse");
  });
});

describe("describeOwner", () => {
  test("names known agents, falls back to the id", () => {
    expect(describeOwner(owner())).toContain("QA Engineer");
    expect(describeOwner(owner({ agent: "user:wang" }))).toContain("user:wang");
  });
});

describe("owner files", () => {
  let dir = "";
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "omega-owner-test-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("round-trip one file per port", () => {
    writeOwner(owner(), dir);
    writeOwner(owner({ port: 10_350, agent: QA2 }), dir);
    expect(readOwner(10_300, dir)).toEqual(owner());
    expect(listOwners(dir).map((o) => o.port).sort()).toEqual([10_300, 10_350]);
    expect(readOwner(10_301, dir)).toBeNull();
  });

  test("a malformed file reads as no owner and is never trusted", () => {
    writeFileSync(join(dir, "10300.json"), JSON.stringify({ port: 10_300, agent: QA }));
    expect(readOwner(10_300, dir)).toBeNull();
    writeFileSync(join(dir, "10301.json"), "{not json");
    expect(readOwner(10_301, dir)).toBeNull();
    expect(listOwners(dir)).toEqual([]);
  });

  test("remove only drops the file when it is still the given launcher's", () => {
    writeOwner(owner(), dir);
    removeOwner(10_300, dir, 9999);
    expect(readOwner(10_300, dir)).not.toBeNull();
    removeOwner(10_300, dir, 4242);
    expect(readOwner(10_300, dir)).toBeNull();
  });
});

describe("ownerDir", () => {
  test("is machine-wide, never the per-run TMPDIR (Paperclip gives each run its own)", () => {
    expect(ownerDir({ TMPDIR: "/tmp/paperclip-run-x", XDG_RUNTIME_DIR: "/run/user/1000" })).toBe("/run/user/1000/omega-e2e-owners");
    expect(ownerDir({ TMPDIR: "/tmp/paperclip-run-x" }, 1000)).toBe("/tmp/omega-e2e-owners-1000");
    expect(ownerDir({ OMEGA_OWNER_DIR: "/x", XDG_RUNTIME_DIR: "/run/user/1000" })).toBe("/x");
  });
});

describe("reapTargets", () => {
  test("only this agent's entries, never another's", () => {
    const mine = [owner(), owner({ port: 10_400 })];
    const theirs = [owner({ port: 10_600, agent: QA2 }), owner({ port: 4400, agent: "user:wang" })];
    expect(reapTargets([...mine, ...theirs], QA)).toEqual(mine);
  });
});
