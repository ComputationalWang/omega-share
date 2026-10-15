/**
 * Long-run soak of a server binary (ADR 0050, slice S11b): realistic churn for N hours, a sample every 10 s,
 * planned SIGTERM restarts with seat-hold verification, and pass criteria that fail the run loudly (perf/soak-stats.ts).
 *
 *   bun perf/server-soak.ts --server "target/release/omega-server serve" [--minutes 1440] [--out soak-out]
 *   bun run soak -- --server "..." --minutes 30        (a 30-minute run; `bun run soak:smoke` is the 1-minute one)
 *
 * The server is any command under the env contract (as for perf/server-compare.ts). The load is below 500 sockets:
 *  - steady rooms: half "probe" rooms (stable embed; a control seek timed until every anchor has the playback) and half
 *    "churn" rooms (shares, queue add/advance/ended, owner layout/title/policy edits, kicks, mutes). In all of them members chat,
 *    emote, sit, change presence and status at the server's sustained limits, and leave, drop, resume (durable sessions) and rejoin;
 *  - ephemeral rooms created over HTTP, joined by an owner and guests, shared into, then deleted;
 *  - abuse that must be cut without touching anyone else: chat floods, oversize frames, malformed frames, a stalled reader and a slow body;
 *  - abuse reports over HTTP;
 *  - every `--restart-every-min`, a quiesce (metrics gauges and counters checked against this client's own counts), SIGTERM,
 *    exit 0 within 10 s with empty stderr, a new process on the same DB, and every seated member rejoining by name to find its seat held.
 * Clients use TRUST_PROXY=loopback and a distinct X-Forwarded-For each, so per-client limits apply as behind Caddy.
 */
import { Database } from "bun:sqlite";
import { appendFileSync, mkdirSync, readdirSync, readlinkSync, statSync, writeFileSync } from "node:fs";
import { createServer, connect } from "node:net";
import { join, resolve } from "node:path";
import { DEFAULT_LAYOUT, EMOTE_KINDS, EMOTE_REFILL_MS, ROOM_PRESET_IDS } from "@omega/shared";
import { presetLayout } from "../apps/server/src/presets";
import { CHAT_PER_SECOND } from "../apps/server/src/ws-limits";
import { cpuPercent, readProc, SITE_ORIGIN, startServer, WsConn, type StartedServer } from "./server-load";
import {
  evaluate,
  EXPECTED_ERROR_EVENTS,
  parseMetrics,
  parseSoakArgs,
  RESTART_EXIT_LIMIT_MS,
  slopePerHour,
  StderrTally,
  windowPercentiles,
  type Check,
  type RestartResult,
  type Sample,
  type SoakArgs,
  type SoakResult,
} from "./soak-stats";

const VIDEO_IDS = ["dQw4w9WgXcQ", "9bZkp7q19f0", "kJQP7kiw5Fk", "JGwWNGJdvx8", "OPf0YbXqDm0", "fRh_vgS2dFE", "RgKAFK5djSk", "CevxZvSJ5v0"];
const watchUrl = (n: number): string => `https://www.youtube.com/watch?v=${VIDEO_IDS[n % VIDEO_IDS.length] ?? "dQw4w9WgXcQ"}`;
const ANCHORS = 3;
/** The close codes the server counts in omega_ws_closes_total that this soak can cause or must see none of. */
const COUNTED = { JOIN_TIMEOUT: 4001, ROOM_FULL: 4002, ROOM_CLOSED: 4004, KICKED: 4005, RATE_LIMITED: 4029, BAD_MESSAGES: 4400, RESTART: 1012 } as const;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const rnd = (n: number): number => Math.floor(Math.random() * n);
const pick = <T>(xs: readonly T[]): T => xs[rnd(xs.length)] as T;
const itemOf = (r: { itemId: string | null }): string | null => r.itemId;
const letters = (n: number): string => Array.from({ length: n }, () => String.fromCharCode(97 + rnd(26))).join("");

async function freePort(): Promise<number> {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const addr = s.address();
  await new Promise<void>((r) => s.close(() => { r(); }));
  if (addr === null || typeof addr === "string") throw new Error("no port");
  return addr.port;
}

interface Seg {
  reports: number;
  reportsStored: number;
  closes: Map<number, number>;
}
const newSeg = (): Seg => ({ reports: 0, reportsStored: 0, closes: new Map() });

interface RoomRef {
  id: string;
  ownerToken: string;
  inviteKey: string | null;
  kind: "probe" | "churn" | "ephemeral";
  embedUrl: string;
  itemId: string | null;
  queueLen: number;
  clients: Client[];
}

class Client {
  ws: WsConn | null = null;
  self = "";
  seat: number | null = null;
  shareToken = "";
  resumeToken = "";
  alive = false;
  /** Set before the soak closes it on purpose; any other close is "unexpected". */
  expected = false;
  timers: Timer[] = [];
  onPlayback: ((by: string, position: number) => void) | null = null;
  constructor(
    readonly room: RoomRef,
    readonly nickname: string,
    readonly avatar: number,
    readonly ip: string,
    readonly durable: boolean,
    readonly owner: boolean,
  ) {}
  send(msg: object): boolean {
    return this.ws?.send(JSON.stringify(msg)) ?? false;
  }
  stopTraffic(): void {
    for (const t of this.timers) {
      clearTimeout(t);
      clearInterval(t);
    }
    this.timers = [];
  }
}

type Json = Record<string, unknown>;

export async function runSoak(args: SoakArgs): Promise<{ pass: boolean; checks: Check[]; result: SoakResult }> {
  const out = resolve(args.out);
  const work = join(out, "work");
  mkdirSync(work, { recursive: true });
  const dbPath = join(work, "omega.db");
  const timeline = join(out, "timeline.jsonl");
  writeFileSync(timeline, "");
  const [port, metricsPort] = [await freePort(), await freePort()];
  const env = { HOST: "127.0.0.1", PORT: String(port), DB_PATH: dbPath, ADMIN_SOCKET: "off", METRICS_PORT: String(metricsPort), SITE_ORIGIN, TRUST_PROXY: "loopback" };

  const t0 = performance.now();
  const now = (): number => performance.now() - t0;
  const tally = new StderrTally();
  let segStderr = "";
  const srv: { cur: StartedServer | null } = { cur: null };
  let seg = newSeg();
  let segIndex = 0;
  const segments: Sample[][] = [[]];
  const lat: { tMs: number; ms: number }[] = [];
  const unexpected: string[] = [];
  const unexpectedBy = new Map<string, number>();
  const note = (cls: string, detail: string): void => {
    unexpectedBy.set(cls, (unexpectedBy.get(cls) ?? 0) + 1);
    if (unexpected.length < 20) unexpected.push(`${cls}: ${detail}`);
  };
  let unexpectedCloses = 0;
  let unplannedExits = 0;
  let probeTimeouts = 0;
  let badMessages = 0;
  let stopping = false as boolean;
  let paused = false as boolean;
  const stopped = (): boolean => stopping;
  let baseRooms = 0;
  let inflight = 0;
  let ipSeq = 0;
  const consistency: SoakResult["consistency"] = [];
  const restarts: RestartResult[] = [];
  const abuse = new Map<string, { started: number; cut: number }>();
  const abuseOf = (k: string): { started: number; cut: number } => {
    const a = abuse.get(k) ?? { started: 0, cut: 0 };
    abuse.set(k, a);
    return a;
  };
  const errorsSeen = new Map<string, number>();
  const ops = new Map<string, number>();
  const op = (k: string): void => {
    ops.set(k, (ops.get(k) ?? 0) + 1);
  };
  const nextIp = (): string => {
    const n = (ipSeq++ % 60_000) + 1;
    return `10.${String(1 + (n >> 16))}.${String((n >> 8) & 255)}.${String(n & 255)}`;
  };

  const boot = async (): Promise<void> => {
    segStderr = "";
    const started = await startServer(args.server, env, (chunk) => {
      tally.add(chunk);
      segStderr += chunk;
    });
    srv.cur = started;
    const pid = started.proc.pid;
    void started.proc.exited.then((code) => {
      if (!plannedExit.has(pid)) {
        unplannedExits++;
        stopping = true;
        console.error(`server-soak: the server exited on its own (code ${String(code)}): ${segStderr.slice(-300)}`);
      }
    });
  };
  const plannedExit = new Set<number>();

  // ---- HTTP ----
  const api = async (method: string, path: string, o: { ip: string; body?: string; bearer?: string; contentType?: string }): Promise<{ status: number; json: Json }> => {
    const res = await fetch(`http://127.0.0.1:${String(port)}${path}`, {
      method,
      headers: {
        origin: SITE_ORIGIN,
        "x-forwarded-for": o.ip,
        ...(o.body === undefined ? {} : { "content-type": o.contentType ?? "application/json" }),
        ...(o.bearer === undefined ? {} : { authorization: `Bearer ${o.bearer}` }),
      },
      ...(o.body === undefined ? {} : { body: o.body }),
    });
    const text = await res.text();
    let json: Json = {};
    try {
      const j: unknown = JSON.parse(text);
      if (typeof j === "object" && j !== null) json = j as Json;
    } catch {
      // not JSON (healthz)
    }
    return { status: res.status, json };
  };
  const createRoom = async (visibility: "public" | "private", ip: string): Promise<{ id: string; ownerToken: string; inviteKey: string | null }> => {
    for (let attempt = 0; attempt < 20; attempt++) {
      const r = await api("POST", "/rooms", { ip, body: JSON.stringify({ title: `Soak ${letters(6)}`, visibility, preset: pick(ROOM_PRESET_IDS) }) });
      if (r.status === 201) {
        const room = r.json["room"] as Json;
        return { id: String(room["id"]), ownerToken: String(r.json["ownerToken"]), inviteKey: typeof r.json["inviteKey"] === "string" ? r.json["inviteKey"] : null };
      }
      if (r.status !== 429) throw new Error(`create room: HTTP ${String(r.status)} ${JSON.stringify(r.json)}`);
      const wait = r.json["error"] as Json | undefined;
      await sleep(Math.min(70_000, Number(wait?.["retryAfterMs"] ?? 7000)) + 500); // the global bucket refills one room a minute
    }
    throw new Error("create room: rate limited for 2+ minutes");
  };

  // ---- sockets ----
  const countClose = (code: number | undefined): void => {
    if (code !== undefined) seg.closes.set(code, (seg.closes.get(code) ?? 0) + 1);
  };
  const open = new Set<Client>();
  const onText = (c: Client, d: string, done: { ok: () => void; fail: (why: string) => void }): void => {
    if (d.startsWith('{"type":"playback"')) {
      const p = (JSON.parse(d) as { playback: { by: string; position: number } }).playback;
      c.onPlayback?.(p.by, p.position);
    } else if (d.startsWith('{"type":"snapshot"')) {
      const s = JSON.parse(d) as { self: string; shareToken?: string; resumeToken?: string; resumed?: boolean; room: { seats: (string | null)[]; embed: { url: string } | null; itemId?: string; queue?: unknown[] } };
      c.self = s.self;
      c.shareToken = s.shareToken ?? "";
      c.resumeToken = s.resumeToken ?? "";
      const seat = s.room.seats.indexOf(s.self);
      c.seat = seat < 0 ? null : seat;
      c.room.embedUrl = s.room.embed?.url ?? c.room.embedUrl;
      c.room.itemId = s.room.itemId ?? c.room.itemId;
      done.ok();
    } else if (d.startsWith('{"type":"seat-changed"')) {
      const s = JSON.parse(d) as { memberId: string; seat: number | null };
      if (s.memberId === c.self) c.seat = s.seat;
    } else if (d.startsWith('{"type":"embed-changed"')) {
      const e = JSON.parse(d) as { embed: { url: string } | null; itemId?: string };
      if (c.owner && e.embed !== null) {
        c.room.embedUrl = e.embed.url;
        c.room.itemId = e.itemId ?? null;
      }
    } else if (d.startsWith('{"type":"queue-changed"')) {
      if (c.owner) c.room.queueLen = (JSON.parse(d) as { queue: unknown[] }).queue.length;
    } else if (d.startsWith('{"type":"error"')) {
      const code = String((JSON.parse(d) as Json)["code"]);
      errorsSeen.set(code, (errorsSeen.get(code) ?? 0) + 1);
      if (code === "bad_message") badMessages++;
      if (!c.alive || c.self === "") done.fail(`join refused: ${code}`);
    } else if (d.startsWith('{"type":"room-full"')) done.fail("room full");
  };
  const connectClient = (c: Client, resume?: string): Promise<void> =>
    new Promise((resolveJoin, rejectJoin) => {
      let settled = false;
      const done = {
        ok: (): void => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          c.alive = true;
          open.add(c);
          resolveJoin();
        },
        fail: (why: string): void => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          c.expected = true;
          c.ws?.close();
          rejectJoin(new Error(why));
        },
      };
      const timer = setTimeout(() => { done.fail("join timeout"); }, 15_000);
      const ws = new WsConn(
        port,
        "127.0.0.1",
        `/rooms/${c.room.id}/ws`,
        {
          open: () => {
            c.send({
              type: "join",
              nickname: c.nickname,
              avatar: c.avatar,
              ...(c.owner ? { ownerToken: c.room.ownerToken } : {}),
              ...(c.room.inviteKey !== null && !c.owner ? { inviteKey: c.room.inviteKey } : {}),
              ...(resume === undefined ? (c.durable ? { durableSession: true } : {}) : { resumeToken: resume }),
            });
          },
          text: (d) => { onText(c, d, done); },
          close: (why, code) => {
            const wasAlive = c.alive;
            c.alive = false;
            open.delete(c);
            c.stopTraffic();
            countClose(code);
            if (!c.expected && !stopping) {
              unexpectedCloses++;
              note(`${c.room.kind} socket closed${wasAlive ? "" : " before join"}${code === undefined ? "" : ` (${String(code)})`}`, `${c.nickname}: ${why}`);
            }
            done.fail(`closed before join: ${why}`);
          },
        },
        { "x-forwarded-for": c.ip },
      );
      c.ws = ws;
    });
  const retire = (c: Client): void => {
    c.expected = true;
    c.stopTraffic();
    c.ws?.close();
  };

  /** Background traffic at the server's sustained limits, staggered; stopped with the client. */
  const startTraffic = (c: Client): void => {
    const every = (ms: number, tick: () => void): void => {
      c.timers.push(setTimeout(() => c.timers.push(setInterval(tick, ms)), rnd(ms)));
    };
    let n = 0;
    every(1000 / CHAT_PER_SECOND, () => { c.send({ type: "chat", text: `soak chat ${String(n++)}` }); });
    every(EMOTE_REFILL_MS, () => { c.send({ type: "emote", kind: EMOTE_KINDS[n++ % EMOTE_KINDS.length] }); });
    every(10_000, () => { c.send({ type: "presence", away: n++ % 2 === 0 }); });
    every(7000, () => { c.send({ type: "status", catching: n++ % 2 === 0 }); });
    every(6000, () => { c.send({ type: "sit", seat: rnd(5) === 0 ? null : rnd(8) }); });
  };

  /** One discrete action, skipped while paused and waited for at a quiesce. */
  const step = async (fn: () => Promise<void>): Promise<void> => {
    if (paused || stopping) return;
    inflight++;
    try {
      await fn();
    } catch (err) {
      if (!stopped()) {
        op("step-error");
        note("step failed", err instanceof Error ? err.message : String(err));
      }
    } finally {
      inflight--;
    }
  };
  const loop = (everyMs: number, fn: () => Promise<void>): void => {
    void (async () => {
      await sleep(rnd(everyMs));
      while (!stopping) {
        await step(fn);
        await sleep(everyMs * (0.7 + Math.random() * 0.6));
      }
    })();
  };

  // ---- steady rooms ----
  const rooms: RoomRef[] = [];
  const addMember = async (room: RoomRef, name: string, owner = false): Promise<Client> => {
    const c = new Client(room, name, rnd(4), nextIp(), !owner && rnd(2) === 0, owner);
    await connectClient(c);
    startTraffic(c);
    return c;
  };
  const populate = async (): Promise<void> => {
    for (let i = 0; i < args.rooms; i++) {
      const made = await createRoom("public", nextIp());
      const room: RoomRef = { ...made, kind: i < Math.ceil(args.rooms / 2) ? "probe" : "churn", embedUrl: watchUrl(0), itemId: null, queueLen: 0, clients: [] };
      rooms.push(room);
      room.clients.push(await addMember(room, `r${String(i)}owner`, true));
      for (let j = 1; j < args.members; j++) room.clients.push(await addMember(room, `r${String(i)}m${String(j)}`));
      const owner = room.clients[0];
      if (owner !== undefined) {
        const r = await api("POST", `/rooms/${room.id}/share`, { ip: nextIp(), bearer: owner.shareToken, body: JSON.stringify({ url: watchUrl(0) }) });
        if (r.status !== 200) throw new Error(`initial share: HTTP ${String(r.status)}`);
        await sleep(200);
      }
    }
  };

  const liveClients = (room: RoomRef): Client[] => room.clients.filter((c) => c.alive);
  const ownerOf = (room: RoomRef): Client | undefined => room.clients.find((c) => c.owner && c.alive);

  /** Leave, abrupt drop, or a durable drop and resume: the member comes back in the same slot. */
  const reconnectOne = async (room: RoomRef): Promise<void> => {
    const idx = ANCHORS + rnd(Math.max(1, room.clients.length - ANCHORS));
    const c = room.clients[idx];
    if (c === undefined || !c.alive || c.owner || idx < ANCHORS) return;
    const way = c.durable ? pick(["resume", "resume", "leave"] as const) : pick(["leave", "drop"] as const);
    op(`reconnect-${way}`);
    c.expected = true;
    c.stopTraffic();
    if (way === "leave") {
      c.send({ type: "leave" });
      await sleep(150);
      c.ws?.close();
    } else c.ws?.drop();
    await sleep(500 + rnd(1500));
    const fresh = new Client(room, c.nickname, c.avatar, c.ip, c.durable, false);
    if (way === "resume") {
      try {
        await connectClient(fresh, c.resumeToken);
      } catch {
        op("resume-failed");
        await connectClient(new Client(room, c.nickname, c.avatar, c.ip, c.durable, false)).then(() => undefined);
        return;
      }
    } else await connectClient(fresh);
    room.clients[idx] = fresh;
    startTraffic(fresh);
  };

  const probeRoom = (room: RoomRef): void => {
    let s = 0;
    loop(1500, async () => {
      const owner = ownerOf(room);
      const anchors = room.clients.slice(0, ANCHORS).filter((c) => c.alive);
      if (owner === undefined || anchors.length < ANCHORS) return;
      const actor = pick(anchors);
      const position = 2 * (++s % 20_000) + 1;
      let pending = anchors.length;
      const t = now();
      const arrived = new Promise<boolean>((resolveProbe) => {
        const timeout = setTimeout(() => { resolveProbe(false); }, 5000);
        for (const a of anchors)
          a.onPlayback = (by, pos) => {
            if (by !== actor.self || pos !== position) return;
            a.onPlayback = null;
            if (--pending === 0) {
              clearTimeout(timeout);
              resolveProbe(true);
            }
          };
      });
      actor.send({ type: "control", url: room.embedUrl, playing: s % 2 === 1, position });
      if (await arrived) lat.push({ tMs: t, ms: now() - t });
      else {
        probeTimeouts++;
        for (const a of anchors) a.onPlayback = null;
      }
    });
    loop(5000, () => reconnectOne(room));
  };

  let layoutN = 0;
  const churnRoom = (room: RoomRef): void => {
    loop(5000, () => reconnectOne(room));
    // owner edits: layout, title, control policy (a quick toggle that restores "everyone")
    loop(9000, async () => {
      const owner = ownerOf(room);
      if (owner === undefined) return;
      op("owner-edit");
      owner.send({ type: "layout-set", layout: layoutN++ % 2 === 0 ? presetLayout(pick(ROOM_PRESET_IDS)) : DEFAULT_LAYOUT });
      await sleep(2500);
      owner.send({ type: "title-set", title: `Soak ${letters(6)}` });
      await sleep(2500);
      owner.send({ type: "control-policy", policy: "owner" });
      await sleep(1500);
      owner.send({ type: "control-policy", policy: "everyone" });
    });
    // queue add (ws and HTTP), advance, ended, and a share from a member
    loop(8000, async () => {
      const members = liveClients(room);
      const m = pick(members);
      if (m.shareToken === "") return;
      op("queue-add");
      if (rnd(2) === 0) m.send({ type: "queue-add", url: watchUrl(rnd(8)) });
      else await api("POST", `/rooms/${room.id}/queue`, { ip: m.ip, bearer: m.shareToken, body: JSON.stringify({ url: watchUrl(rnd(8)) }) });
    });
    loop(11_000, async () => {
      const owner = ownerOf(room);
      if (owner === undefined || room.itemId === null) return;
      op("queue-advance");
      owner.send({ type: "queue-advance", fromItemId: room.itemId });
      await sleep(3500);
      const item = itemOf(room);
      if (item !== null) owner.send({ type: "ended", itemId: item, position: 0 });
    });
    loop(37_000, async () => {
      const m = pick(liveClients(room));
      if (m.shareToken === "") return;
      op("share");
      await api("POST", `/rooms/${room.id}/share`, { ip: m.ip, bearer: m.shareToken, body: JSON.stringify({ url: watchUrl(rnd(8)) }) });
    });
    // moderation: mute then unmute; kick one member and replace them
    loop(23_000, async () => {
      const owner = ownerOf(room);
      const target = room.clients.slice(ANCHORS).find((c) => c.alive && !c.owner);
      if (owner === undefined || target === undefined || target.self === "") return;
      op("mute");
      owner.send({ type: "mute", memberId: target.self, muted: true });
      await sleep(2000);
      owner.send({ type: "mute", memberId: target.self, muted: false });
    });
    loop(70_000, async () => {
      const owner = ownerOf(room);
      const idx = room.clients.findIndex((c, i) => i >= ANCHORS && c.alive && !c.owner);
      const target = room.clients[idx];
      if (owner === undefined || target === undefined) return;
      op("kick");
      target.expected = true;
      target.stopTraffic();
      owner.send({ type: "kick", memberId: target.self });
      await sleep(1500);
      const fresh = new Client(room, `r${letters(8)}`, rnd(4), nextIp(), false, false);
      await connectClient(fresh);
      room.clients[idx] = fresh;
      startTraffic(fresh);
    });
  };

  // ---- ephemeral rooms ----
  const ephemeral = async (): Promise<void> => {
    const visibility = rnd(2) === 0 ? "public" : "private";
    const made = await createRoom(visibility, nextIp());
    const room: RoomRef = { ...made, kind: "ephemeral", embedUrl: watchUrl(1), itemId: null, queueLen: 0, clients: [] };
    op("room-created");
    try {
      const owner = new Client(room, "eph-owner", 0, nextIp(), false, true);
      await connectClient(owner);
      room.clients.push(owner);
      for (let i = 0; i < 2; i++) {
        const g = new Client(room, `eph-g${String(i)}`, i + 1, nextIp(), i === 0, false);
        await connectClient(g);
        room.clients.push(g);
      }
      for (const c of room.clients) {
        c.send({ type: "chat", text: "hello from the soak" });
        c.send({ type: "sit", seat: rnd(8) });
      }
      owner.send({ type: "title-set", title: `Soak ${letters(6)}` });
      await api("POST", `/rooms/${room.id}/share`, { ip: owner.ip, bearer: owner.shareToken, body: JSON.stringify({ url: watchUrl(rnd(8)) }) });
      await sleep(4000 + rnd(4000));
      const wrong = await api("DELETE", `/rooms/${room.id}`, { ip: nextIp(), bearer: "A".repeat(22) });
      if (wrong.status !== 401) throw new Error(`delete with a wrong token answered ${String(wrong.status)}`);
    } finally {
      for (const c of room.clients) c.expected = true;
      const del = await api("DELETE", `/rooms/${room.id}`, { ip: nextIp(), bearer: room.ownerToken });
      op("room-deleted");
      if (del.status !== 200) throw new Error(`delete room: HTTP ${String(del.status)}`);
      await sleep(300);
      for (const c of room.clients) retire(c);
    }
  };

  // ---- reports ----
  const report = async (): Promise<void> => {
    const room = pick(rooms);
    const body = JSON.stringify({ reason: pick(["sexual", "violence", "hate", "spam", "danger", "other"] as const), ...(rnd(2) === 0 ? { note: "soak report" } : {}) });
    const r = await api("POST", `/rooms/${room.id}/report`, { ip: nextIp(), body });
    seg.reports++;
    if (r.status === 202) seg.reportsStored++;
    op("report");
  };

  // ---- abusive clients ----
  const joined = (room: RoomRef, nickname: string, onClose: (code: number | undefined) => void): Promise<WsConn> =>
    new Promise((res, rej) => {
      const timer = setTimeout(() => { rej(new Error("abuser join timeout")); }, 10_000);
      const ws = new WsConn(
        port,
        "127.0.0.1",
        `/rooms/${room.id}/ws`,
        {
          open: () => { ws.send(JSON.stringify({ type: "join", nickname, avatar: 0 })); },
          text: (d) => {
            if (d.startsWith('{"type":"snapshot"')) {
              clearTimeout(timer);
              res(ws);
            } else if (d.startsWith('{"type":"room-full"') || d.startsWith('{"type":"error"')) {
              clearTimeout(timer);
              rej(new Error("abuser refused"));
            }
          },
          close: (_why, code) => {
            countClose(code);
            onClose(code);
            clearTimeout(timer);
            rej(new Error("abuser closed before join"));
          },
        },
        { "x-forwarded-for": nextIp() },
      );
    });
  /** Runs one abusive WebSocket client; `act` misbehaves, and the server must close it within `deadlineMs`. */
  const abuser = async (kind: string, deadlineMs: number, act: (ws: WsConn) => void): Promise<void> => {
    const spare = rooms.filter((r) => r.clients.length < 24);
    if (spare.length === 0) return;
    const room = pick(spare);
    let closed: () => void = () => undefined;
    const gone = new Promise<void>((r) => { closed = r; });
    let ws: WsConn;
    try {
      ws = await joined(room, `ab${letters(8)}`, () => { closed(); });
    } catch {
      return; // refused (room full): not an abuser that ran
    }
    const a = abuseOf(kind);
    a.started++;
    act(ws);
    const cut = await Promise.race([gone.then(() => true), sleep(deadlineMs).then(() => false)]);
    if (cut) a.cut++;
    else {
      note(`abuser ${kind} not cut`, `within ${String(deadlineMs)} ms`);
      ws.close();
    }
  };
  const slowBody = (): Promise<void> =>
    new Promise((res) => {
      const a = abuseOf("slow-body");
      a.started++;
      let timedOut = false;
      const sock = connect(port, "127.0.0.1");
      const timer = setTimeout(() => {
        timedOut = true;
        note("abuser slow-body not cut", "within 90000 ms");
        sock.destroy();
        res();
      }, 90_000);
      sock.on("connect", () => {
        sock.write(`POST /rooms HTTP/1.1\r\nHost: 127.0.0.1\r\nx-forwarded-for: ${nextIp()}\r\norigin: ${SITE_ORIGIN}\r\ncontent-type: application/json\r\ncontent-length: 200\r\n\r\n{"title":"slow`);
      });
      const end = (): void => {
        clearTimeout(timer);
        if (!timedOut) a.cut++;
        sock.destroy();
        res();
      };
      sock.on("close", end);
      sock.on("error", end);
      sock.on("data", () => undefined);
    });
  const abuseKinds = ["flood", "oversize", "malformed", "stalled-reader", "slow-body"] as const;
  let abuseN = 0;
  const abuse1 = async (): Promise<void> => {
    const kind = abuseKinds[abuseN++ % abuseKinds.length] ?? "flood";
    op(`abuse-${kind}`);
    switch (kind) {
      case "flood":
        return abuser(kind, 15_000, (ws) => {
          for (let i = 0; i < 400; i++) ws.send(JSON.stringify({ type: "chat", text: `flood ${String(i)}` }));
        });
      case "oversize":
        return abuser(kind, 15_000, (ws) => { ws.send(JSON.stringify({ type: "chat", text: "x".repeat(8000) })); });
      case "malformed":
        return abuser(kind, 15_000, (ws) => {
          let n = 0;
          const t = setInterval(() => {
            ws.send("{not json");
            if (++n >= 40) clearInterval(t);
          }, 80);
        });
      case "stalled-reader":
        return abuser(kind, 150_000, (ws) => { ws.pause(); });
      case "slow-body":
        return slowBody();
    }
  };

  // ---- sampling ----
  const gauges = async (): Promise<Map<string, number>> => {
    try {
      const res = await fetch(`http://127.0.0.1:${String(metricsPort)}/metrics`);
      return parseMetrics(await res.text());
    } catch {
      return new Map();
    }
  };
  const fdStats = (pid: number): { fds: number; sockets: number } => {
    try {
      const names = readdirSync(`/proc/${String(pid)}/fd`);
      let sockets = 0;
      for (const n of names) {
        try {
          if (readlinkSync(`/proc/${String(pid)}/fd/${n}`).startsWith("socket:")) sockets++;
        } catch {
          // closed between the listing and the read
        }
      }
      return { fds: names.length, sockets };
    } catch {
      return { fds: 0, sockets: 0 };
    }
  };
  const threadsOf = (pid: number): number => {
    try {
      return statSync(`/proc/${String(pid)}/task`).nlink - 2;
    } catch {
      return 0;
    }
  };
  const size = (p: string): number => {
    try {
      return statSync(p).size;
    } catch {
      return 0;
    }
  };
  let last: { ticks: number; at: number } | null = null;
  let latSeen = 0;
  const sample = async (): Promise<void> => {
    const pid = srv.cur?.proc.pid;
    if (pid === undefined) return;
    const p = readProc(pid);
    if (p === null) return;
    const at = performance.now();
    const cpu = last === null ? 0 : cpuPercent(last.ticks, p.ticks, at - last.at);
    last = { ticks: p.ticks, at };
    const f = fdStats(pid);
    const threads = threadsOf(pid);
    const wal = size(`${dbPath}-wal`);
    const g = await gauges();
    const fresh = lat.slice(latSeen).map((x) => x.ms).sort((a, b) => a - b);
    latSeen = lat.length;
    const s: Sample = { tMs: now(), rss: p.rss, fds: f.fds, threads, wal };
    segments[segIndex]?.push(s);
    const q = (x: number): number => fresh[Math.min(fresh.length - 1, Math.ceil(x * fresh.length) - 1)] ?? 0;
    appendFileSync(
      timeline,
      `${JSON.stringify({
        t: Math.round(s.tMs / 100) / 10,
        seg: segIndex,
        pid,
        rss: p.rss,
        cpuPct: Math.round(cpu * 10) / 10,
        fds: f.fds,
        sockets: f.sockets,
        threads,
        dbBytes: size(dbPath),
        walBytes: wal,
        gauges: { rooms: g.get("omega_rooms"), sockets: g.get("omega_sockets"), members: g.get("omega_members"), uptime: g.get("process_uptime_seconds") },
        clientSockets: open.size,
        probes: fresh.length,
        p50: q(0.5),
        p99: q(0.99),
        probeTimeouts,
        unexpectedCloses,
        stderr: tally.counts,
      })}\n`,
    );
  };

  // ---- quiesce, restart, finish ----
  const quiesce = async (label: string): Promise<void> => {
    paused = true;
    for (const room of rooms) for (const c of room.clients) c.stopTraffic();
    const until = Date.now() + 200_000;
    while (inflight > 0 && Date.now() < until) await sleep(250);
    await sleep(2000);
    const g = await gauges();
    const mine = [...open];
    const eq = (name: string, client: number, serverVal: number | undefined): void => {
      consistency.push({ name: `${label} ${name}`, client, server: serverVal ?? -1 });
    };
    eq("sockets", mine.length, g.get("omega_sockets"));
    eq("members", mine.length, g.get("omega_members"));
    eq("rooms", rooms.length + baseRooms, g.get("omega_rooms"));
    eq("reports answered", seg.reports, [...g].filter(([k]) => k.startsWith("omega_reports_total{")).reduce((a, [, v]) => a + v, 0));
    eq("reports stored", seg.reportsStored, [...g].filter(([k]) => k.startsWith("omega_reports_received_total{")).reduce((a, [, v]) => a + v, 0));
    for (const [name, code] of Object.entries(COUNTED)) {
      if (code === COUNTED.RESTART) continue;
      eq(`closes ${name}`, seg.closes.get(code) ?? 0, g.get(`omega_ws_closes_total{code="${String(code)}"}`));
    }
  };

  /** SIGTERM the server, check how it went; with `rejoin`, bring up a new process and every member back. */
  const stopServer = async (track: boolean): Promise<{ r: RestartResult; seated: Map<string, number> }> => {
    const server = srv.cur;
    if (server === null) throw new Error("no server");
    const seated = new Map<string, number>();
    for (const room of rooms) for (const c of room.clients) if (track && c.alive && c.seat !== null) seated.set(`${room.id}|${c.nickname}`, c.seat);
    for (const c of open) c.expected = true;
    plannedExit.add(server.proc.pid);
    const t = performance.now();
    server.proc.kill("SIGTERM");
    const code = await Promise.race([server.proc.exited, sleep(RESTART_EXIT_LIMIT_MS + 10_000).then(() => null)]);
    const exitMs = Math.round(performance.now() - t);
    if (code === null) server.proc.kill("SIGKILL");
    await sleep(500);
    const r: RestartResult = { exitCode: code, exitMs, stderr: segStderr, seatsExpected: seated.size, seatsRestored: 0 };
    restarts.push(r);
    return { r, seated };
  };
  const restart = async (): Promise<void> => {
    await quiesce(`seg${String(segIndex)}`);
    const { r, seated } = await stopServer(true);
    segments.push([]);
    segIndex++;
    seg = newSeg();
    last = null;
    await boot();
    // Members rejoin by name within the 30 s hold window, all at once as clients do after a restart.
    const all = rooms.flatMap((room) => room.clients.map((c, i) => ({ room, i, c })));
    let restored = 0;
    await Promise.all(
      all.map(async ({ room, i, c }) => {
        const fresh = new Client(room, c.nickname, c.avatar, c.ip, c.durable, c.owner);
        try {
          await connectClient(fresh);
        } catch (err) {
          note("rejoin after restart failed", `${c.nickname}: ${err instanceof Error ? err.message : String(err)}`);
          unexpectedCloses++;
          return;
        }
        room.clients[i] = fresh;
        const want = seated.get(`${room.id}|${c.nickname}`);
        if (want !== undefined && fresh.seat === want) restored++;
        startTraffic(fresh);
      }),
    );
    r.seatsRestored = restored;
    paused = false;
  };

  // ---- run ----
  const abort = (): void => {
    stopping = true;
    for (const room of rooms) for (const c of room.clients) retire(c);
    if (srv.cur !== null && srv.cur.proc.exitCode === null) srv.cur.proc.kill("SIGKILL");
  };
  let integrity = "not run";
  const sampler = setInterval(() => { void sample(); }, args.sampleS * 1000);
  try {
    await boot();
    baseRooms = (await gauges()).get("omega_rooms") ?? 0;
    await populate();
    for (const room of rooms) {
      if (room.kind === "probe") probeRoom(room);
      else churnRoom(room);
    }
    loop(70_000, ephemeral);
    loop(100_000, report);
    loop(25_000, abuse1);
    const end = args.minutes * 60_000;
    const every = args.restartEveryMin * 60_000;
    let nextRestart = every > 0 ? every : Infinity;
    // The last interval is not a restart: it is the final stop.
    while (now() < end && !stopping) {
      await sleep(500);
      if (now() >= nextRestart && end - now() > 20_000) {
        await restart();
        nextRestart = now() + every;
      }
    }
    if (!stopping) {
      await quiesce(`seg${String(segIndex)} final`);
      await stopServer(false);
    }
  } finally {
    clearInterval(sampler);
    abort();
  }
  try {
    const db = new Database(dbPath, { readonly: true });
    const row = db.query("PRAGMA integrity_check").all() as { integrity_check: string }[];
    integrity = row.map((r) => r.integrity_check).join("; ");
    db.close();
  } catch (err) {
    integrity = `could not open the database: ${err instanceof Error ? err.message : String(err)}`;
  }

  const planned = (args.restartEveryMin > 0 ? segIndex : 0) + 1;
  const result: SoakResult = {
    durationMs: now(),
    segments,
    windows: windowPercentiles(lat, args.windowS * 1000),
    restarts,
    plannedRestarts: planned,
    unplannedExits,
    unexpectedCloses,
    badMessages,
    errors: tally.unexpectedErrors([...EXPECTED_ERROR_EVENTS, ...args.allowErrors]),
    integrity,
    consistency,
    abuse: [...abuse].map(([kind, a]) => ({ kind, ...a })),
  };
  const checks = evaluate(result);
  const pass = checks.every((c) => !c.enforced || c.ok);
  const settledSlopes = Object.fromEntries(
    (["rss", "fds", "threads", "wal"] as const).map((k) => [k, slopePerHour(segments.map((s) => s.slice(Math.ceil(s.length * 0.2)).map((x) => ({ tMs: x.tMs, v: x[k] }))))]),
  );
  const summary = {
    pass,
    server: args.label,
    args,
    durationS: Math.round(result.durationMs / 1000),
    checks,
    slopesPerHour: settledSlopes,
    windows: result.windows,
    probes: lat.length,
    probeTimeouts,
    restarts: restarts.map((r) => ({ ...r, stderr: r.stderr.slice(-300) })),
    stderrCounts: tally.counts,
    errorsSeen: Object.fromEntries(errorsSeen),
    ops: Object.fromEntries(ops),
    abuse: result.abuse,
    unexpected,
    unexpectedBy: Object.fromEntries(unexpectedBy),
    consistency,
    integrity,
  };
  writeFileSync(join(out, "summary.json"), JSON.stringify(summary, null, 2));
  return { pass, checks, result };
}

if (import.meta.main) {
  try {
    const args = parseSoakArgs(process.argv.slice(2));
    const { pass, checks } = await runSoak(args);
    for (const c of checks) console.log(`${c.ok ? "PASS" : c.enforced ? "FAIL" : "info"}  ${c.name}: ${c.detail}`);
    console.log(`\nsoak ${pass ? "PASSED" : "FAILED"} (summary: ${join(resolve(args.out), "summary.json")})`);
    process.exit(pass ? 0 : 1);
  } catch (err) {
    console.error(`server-soak: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}
