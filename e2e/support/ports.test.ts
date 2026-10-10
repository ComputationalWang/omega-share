import { describe, expect, test } from "bun:test";
import { AGENTS, LEGACY_BLOCK, MAX_SLOT, agentIdentity, blockPorts, cdpPorts, portBlock, resolvePorts, slotFor } from "./ports";

// OME-821: every agent gets its own port block from its identity, so parallel `bun run e2e` runs never collide
// and nobody hand-picks alternate ports any more.
const QA = "0e8d6a7c-edbf-478b-b6f5-c90fb4e25023";
const QA2 = "d72569af-a258-4057-8723-7b94b7d96755";
/** The first port of Linux's default ephemeral range: outgoing sockets could grab anything from here up. */
const EPHEMERAL = 32_768;

describe("slotFor", () => {
  test("no agent (CI, a human) is slot 0", () => {
    expect(slotFor({})).toBe(0);
  });

  test("every known agent has its own slot, and none is 0", () => {
    const slots = AGENTS.map((a) => slotFor({ PAPERCLIP_AGENT_ID: a.id }));
    expect(new Set(slots).size).toBe(AGENTS.length);
    expect(slots).not.toContain(0);
    expect(slotFor({ PAPERCLIP_AGENT_ID: QA })).not.toBe(slotFor({ PAPERCLIP_AGENT_ID: QA2 }));
  });

  test("an unknown agent id lands on a stable hashed slot past the table", () => {
    const id = "11111111-2222-3333-4444-555555555555";
    const slot = slotFor({ PAPERCLIP_AGENT_ID: id });
    expect(slot).toBe(slotFor({ PAPERCLIP_AGENT_ID: id }));
    expect(slot).toBeGreaterThan(Math.max(...AGENTS.map((a) => a.slot)));
    expect(slot).toBeLessThanOrEqual(MAX_SLOT);
  });

  test("OMEGA_PORT_SLOT picks the slot outright and is range-checked", () => {
    expect(slotFor({ PAPERCLIP_AGENT_ID: QA, OMEGA_PORT_SLOT: "0" })).toBe(0);
    expect(slotFor({ OMEGA_PORT_SLOT: "12" })).toBe(12);
    for (const bad of ["-1", "1.5", "x", String(MAX_SLOT + 1)]) expect(() => slotFor({ OMEGA_PORT_SLOT: bad })).toThrow(/OMEGA_PORT_SLOT/);
  });
});

describe("portBlock", () => {
  test("slot 0 keeps today's ports, so CI and humans see no change", () => {
    expect(portBlock(0)).toEqual(LEGACY_BLOCK);
    expect(LEGACY_BLOCK).toMatchObject({ fixtures: 4400, web: 5173, server: 8787, persistWeb: 5193, persistServer: 8807, genericOn: 8837, genericOff: 8847 });
  });

  test("every port a run binds, derived ones included, is unique within a block", () => {
    for (let slot = 0; slot <= MAX_SLOT; slot++) {
      const ports = blockPorts(portBlock(slot));
      expect(new Set(ports).size).toBe(ports.length);
    }
  });

  test("no two slots share a port, and agent slots stay out of the ephemeral range and away from slot 0", () => {
    const seen = new Map<number, number>();
    for (let slot = 0; slot <= MAX_SLOT; slot++) {
      for (const port of blockPorts(portBlock(slot))) {
        expect(seen.get(port)).toBeUndefined();
        seen.set(port, slot);
        if (slot > 0) {
          expect(port).toBeGreaterThan(10_000);
          expect(port).toBeLessThan(EPHEMERAL);
        }
      }
    }
  });

  test("the perf runner's fixed ports (4470/5243/8857) are in no block", () => {
    for (let slot = 0; slot <= MAX_SLOT; slot++) {
      const ports = blockPorts(portBlock(slot));
      for (const runner of [4470, 5243, 8857]) expect(ports).not.toContain(runner);
    }
  });
});

describe("cdpPorts", () => {
  test("the real lane's raw-CDP Chromiums debug on ports of the block, not fixed ones", () => {
    for (const slot of [0, 5, 6]) {
      const b = portBlock(slot);
      const cdp = cdpPorts(b);
      expect(cdp).toHaveLength(3);
      for (const p of cdp) expect(blockPorts(b)).toContain(p);
    }
    expect(cdpPorts(portBlock(5))).not.toContain(9339);
  });
});

describe("resolvePorts", () => {
  test("two agents on defaults get disjoint ports", () => {
    const a = blockPorts(resolvePorts({ PAPERCLIP_AGENT_ID: QA }));
    const b = new Set(blockPorts(resolvePorts({ PAPERCLIP_AGENT_ID: QA2 })));
    expect(a.filter((p) => b.has(p))).toEqual([]);
  });

  test("an explicit OMEGA_*_PORT still wins (the perf runner sets its own)", () => {
    const p = resolvePorts({ PAPERCLIP_AGENT_ID: QA, OMEGA_FIXTURE_PORT: "4470", OMEGA_WEB_PORT: "5243", OMEGA_SERVER_PORT: "8857" });
    expect(p).toMatchObject({ fixtures: 4470, web: 5243, server: 8857 });
    expect(p.persistServer).toBe(portBlock(slotFor({ PAPERCLIP_AGENT_ID: QA })).persistServer);
  });

  test("a malformed override is an error, not NaN", () => {
    expect(() => resolvePorts({ OMEGA_WEB_PORT: "abc" })).toThrow(/OMEGA_WEB_PORT/);
    expect(() => resolvePorts({ OMEGA_SERVER_PORT: "70000" })).toThrow(/OMEGA_SERVER_PORT/);
  });
});

describe("agentIdentity", () => {
  test("is the Paperclip agent id, else the local user", () => {
    expect(agentIdentity({ PAPERCLIP_AGENT_ID: QA })).toBe(QA);
    expect(agentIdentity({ USER: "wang" })).toBe("user:wang");
  });
});
