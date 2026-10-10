// Port blocks (OME-821): each agent's e2e/perf runs bind ports from a block of their own, picked from the agent's
// identity, so two agents can run `bun run e2e` at once on defaults. Slot 0 is today's ports (CI, humans).
// Every port a run binds is listed in blockPorts(); the tests keep blocks disjoint and below the ephemeral range.

type Env = Readonly<Record<string, string | undefined>>;

export interface PortBlock {
  /** Fixture pages; the tunnel lanes' proxies sit at +30…+35, the real lane's raw-CDP Chromiums at +36…+38. */
  readonly fixtures: number;
  readonly web: number;
  /** The lobby server; spec-owned servers sit at +1…+8 and the tunnel-proxy upstream at +101. */
  readonly server: number;
  /** persistence.e2e.ts's own site and server (restarted mid-test). */
  readonly persistWeb: number;
  readonly persistServer: number;
  /** generic-policy.e2e.ts's two servers. */
  readonly genericOn: number;
  readonly genericOff: number;
}

/** Paperclip agents and their slots. A new agent works without an entry (hashed slot); add one to pin it. */
export const AGENTS: readonly { readonly id: string; readonly name: string; readonly slot: number }[] = [
  { id: "fe40d344-b9ef-40f1-aeef-e76cbae8c787", name: "CEO", slot: 1 },
  { id: "7cfa1415-67fc-4650-b72d-db860eb7e599", name: "Lead Engineer", slot: 2 },
  { id: "fc06a562-1f73-422f-afa7-de30baf59c1c", name: "Server Engineer", slot: 3 },
  { id: "2bd40b31-37bc-463a-97c4-f48cb05a8c09", name: "Extension Engineer", slot: 4 },
  { id: "0e8d6a7c-edbf-478b-b6f5-c90fb4e25023", name: "QA Engineer", slot: 5 },
  { id: "d72569af-a258-4057-8723-7b94b7d96755", name: "QA Engineer 2", slot: 6 },
  { id: "d1caac00-d9da-43ba-aa57-f8668438a995", name: "Creative Designer", slot: 7 },
];

export const LEGACY_BLOCK: PortBlock = { fixtures: 4400, web: 5173, server: 8787, persistWeb: 5193, persistServer: 8807, genericOn: 8837, genericOff: 8847 };

/** Agent slot n uses BASE + n·STRIDE … + 201; slot 70 tops out at 31 201, under the ephemeral range (32 768). */
const BASE = 10_000;
const STRIDE = 300;
export const MAX_SLOT = 70;
/** Unknown agent ids hash into HASH_FIRST…MAX_SLOT, clear of the table. */
const HASH_FIRST = 16;

export function agentIdentity(env: Env = process.env): string {
  const id = env["PAPERCLIP_AGENT_ID"];
  if (id !== undefined && id !== "") return id;
  return `user:${env["USER"] ?? "unknown"}`;
}

export function agentName(identity: string): string {
  return AGENTS.find((a) => a.id === identity)?.name ?? identity;
}

/** FNV-1a: stable across runs and machines. */
function hash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

export function slotFor(env: Env = process.env): number {
  const forced = env["OMEGA_PORT_SLOT"];
  if (forced !== undefined) {
    const n = Number(forced);
    if (forced === "" || !Number.isInteger(n) || n < 0 || n > MAX_SLOT) throw new Error(`OMEGA_PORT_SLOT must be an integer 0…${String(MAX_SLOT)}, got ${JSON.stringify(forced)}`);
    return n;
  }
  const id = env["PAPERCLIP_AGENT_ID"];
  if (id === undefined || id === "") return 0;
  return AGENTS.find((a) => a.id === id)?.slot ?? HASH_FIRST + (hash(id) % (MAX_SLOT - HASH_FIRST + 1));
}

export function portBlock(slot: number): PortBlock {
  if (slot === 0) return LEGACY_BLOCK;
  const b = BASE + slot * STRIDE;
  return { fixtures: b, web: b + 50, persistWeb: b + 60, server: b + 100, persistServer: b + 120, genericOn: b + 150, genericOff: b + 160 };
}

/** Remote-debugging ports for the real lane's raw-CDP Chromiums (real-youtube, real-ads). */
export function cdpPorts(p: PortBlock): [number, number, number] {
  return [p.fixtures + 36, p.fixtures + 37, p.fixtures + 38];
}

/** Every port a run on this block binds, the derived lanes included. */
export function blockPorts(p: PortBlock): number[] {
  const range = (from: number, to: number): number[] => Array.from({ length: to - from + 1 }, (_, i) => from + i);
  return [p.fixtures, ...range(p.fixtures + 30, p.fixtures + 38), p.web, p.persistWeb, ...range(p.server, p.server + 8), p.server + 101, p.persistServer, p.genericOn, p.genericOff];
}

function override(env: Env, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined) return fallback;
  const port = Number(raw);
  if (raw === "" || !Number.isInteger(port) || port <= 0 || port > 65535) throw new Error(`${name} must be a port number, got ${JSON.stringify(raw)}`);
  return port;
}

/** This run's ports: the agent's block, with any explicit OMEGA_*_PORT on top (the perf runner pins its own). */
export function resolvePorts(env: Env = process.env): PortBlock {
  const b = portBlock(slotFor(env));
  return {
    fixtures: override(env, "OMEGA_FIXTURE_PORT", b.fixtures),
    web: override(env, "OMEGA_WEB_PORT", b.web),
    server: override(env, "OMEGA_SERVER_PORT", b.server),
    persistWeb: override(env, "OMEGA_PERSIST_WEB_PORT", b.persistWeb),
    persistServer: override(env, "OMEGA_PERSIST_SERVER_PORT", b.persistServer),
    genericOn: override(env, "OMEGA_GENERIC_ON_PORT", b.genericOn),
    genericOff: override(env, "OMEGA_GENERIC_OFF_PORT", b.genericOff),
  };
}
