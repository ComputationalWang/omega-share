import * as v from "valibot";
import { RoomIdSchema, type RoomId } from "@omega/shared";
import { AdminErrorSchema, AdminReportListSchema, AdminRoomListSchema, type AdminReportRoom, type AdminRoom } from "./admin";
import { adminSocketFor } from "./config";
import { ReportIdSchema } from "./store/reports";

/**
 * Operator CLI for rooms, abuse reports and takedowns (docs/ops/rooms.md). It talks to the running server
 * over its admin socket (`admin.ts`), so a delete or takedown ends the live room the way an owner delete or GC does.
 *
 *   bun apps/server/src/cli.ts rooms list
 *   bun apps/server/src/cli.ts rooms delete <id>
 *   bun apps/server/src/cli.ts rooms pin <id>
 *   bun apps/server/src/cli.ts rooms unpin <id>
 *   bun apps/server/src/cli.ts rooms takedown <id>
 *   bun apps/server/src/cli.ts reports list
 *   bun apps/server/src/cli.ts reports dismiss <reportId>
 *   bun apps/server/src/cli.ts reports dismiss --room <id>
 *
 * Exit codes: 0 done, 1 failed (no such room or report, no server, server error), 2 usage.
 */

export interface CliIo {
  /** `ADMIN_SOCKET` or `DB_PATH` locate the socket (`adminSocketFor`). */
  env: Readonly<Record<string, string | undefined>>;
  out: (line: string) => void;
  err: (line: string) => void;
}

/** The server answers from memory at once; a hung one shouldn't hang the operator's ssh session. */
const FETCH_TIMEOUT_MS = 10_000;

const USAGE =
  "usage: cli.ts rooms list | rooms delete <id> | rooms pin <id> | rooms unpin <id> | rooms takedown <id> | reports list | reports dismiss <reportId> | reports dismiss --room <id>";

type Command =
  | { verb: "list" }
  | { verb: "delete" | "pin" | "unpin" | "takedown"; id: RoomId }
  | { verb: "reports" }
  | { verb: "dismiss"; reportId: string }
  | { verb: "dismiss-room"; id: RoomId };

function parseReports(verb: string | undefined, args: readonly string[]): Command | null {
  if (verb === "list") return args.length === 0 ? { verb: "reports" } : null;
  if (verb !== "dismiss") return null;
  if (args[0] === "--room") {
    const id = v.safeParse(RoomIdSchema, args[1]);
    return args.length === 2 && id.success ? { verb: "dismiss-room", id: id.output } : null;
  }
  const reportId = v.safeParse(ReportIdSchema, args[0]);
  return args.length === 1 && reportId.success ? { verb: "dismiss", reportId: reportId.output } : null;
}

function parseArgs(argv: readonly string[]): Command | null {
  const [noun, verb, ...args] = argv;
  if (noun === "reports") return parseReports(verb, args);
  const [id, ...rest] = args;
  if (noun !== "rooms" || rest.length > 0) return null;
  if (verb === "list") return id === undefined ? { verb } : null;
  if (verb !== "delete" && verb !== "pin" && verb !== "unpin" && verb !== "takedown") return null;
  const parsed = v.safeParse(RoomIdSchema, id);
  return parsed.success ? { verb, id: parsed.output } : null;
}

/**
 * Titles are user text: escape C0/C1 controls (ESC, tab, newline) and format characters (bidi
 * overrides), so a title can neither drive the operator's terminal nor break the table.
 */
function printable(text: string): string {
  return text.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, (ch) => {
    const cp = ch.codePointAt(0) ?? 0;
    return cp > 0xffff ? `\\u{${cp.toString(16)}}` : `\\u${cp.toString(16).padStart(4, "0")}`;
  });
}

const time = (ms: number | null): string => (ms === null ? "never" : new Date(ms).toISOString());

function table(rooms: readonly AdminRoom[]): string[] {
  const head = ["id", "title", "visibility", "created", "last active", "pinned", "members"];
  const rows = rooms.map((r) => [
    r.id,
    r.title === "" ? "-" : printable(r.title),
    r.visibility,
    time(r.createdAt),
    time(r.lastActiveAt),
    r.pinned ? "yes" : "no",
    String(r.members),
  ]);
  return [head, ...rows].map((cells) => cells.join("\t"));
}

/** Open reports, one header line per room (most reported first), then its reports, newest first. All user text escaped. */
function reportLines(rooms: readonly AdminReportRoom[]): string[] {
  if (rooms.length === 0) return ["no open reports"];
  const text = (t: string | null): string => (t === null || t === "" ? "-" : printable(t));
  const lines: string[] = [];
  for (const room of rooms) {
    const reasons = new Map<string, number>();
    for (const r of room.reports) reasons.set(r.reason, (reasons.get(r.reason) ?? 0) + 1);
    const counts = [...reasons].sort(([a], [b]) => (a < b ? -1 : 1)).map(([reason, n]) => `${reason} ${String(n)}`);
    const title = room.state === "live" ? text(room.title) : room.state === "taken_down" ? "(taken down)" : "(gone)";
    lines.push(
      [room.id, title, room.visibility ?? "-", `members ${room.members === null ? "-" : String(room.members)}`, `${String(room.reports.length)} open`, counts.join(", ")].join("\t"),
    );
    for (const r of room.reports) {
      lines.push(`  ${[time(r.createdAt), r.reason, r.id, `note: ${text(r.note)}`, `title then: ${text(r.title)}`, `playing: ${text(r.embedUrl)}`].join("\t")}`);
    }
  }
  return lines;
}

function request(cmd: Command): { path: string; method: string } {
  switch (cmd.verb) {
    case "list":
      return { path: "/rooms", method: "GET" };
    case "delete":
      return { path: `/rooms/${cmd.id}`, method: "DELETE" };
    case "pin":
    case "unpin":
    case "takedown":
      return { path: `/rooms/${cmd.id}/${cmd.verb}`, method: "POST" };
    case "reports":
      return { path: "/reports", method: "GET" };
    case "dismiss":
      return { path: `/reports/${cmd.reportId}/dismiss`, method: "POST" };
    case "dismiss-room":
      return { path: `/rooms/${cmd.id}/reports/dismiss`, method: "POST" };
  }
}

const DONE: Record<"delete" | "pin" | "unpin", string> = { delete: "deleted", pin: "pinned", unpin: "unpinned" };
const DismissedSchema = v.object({ dismissed: v.pipe(v.number(), v.safeInteger(), v.minValue(0)) });
const TakenDownSchema = v.object({ takenDown: RoomIdSchema, live: v.boolean() });

/** What a successful answer prints, or null if the answer doesn't parse. */
function success(cmd: Command, body: unknown): string[] | null {
  switch (cmd.verb) {
    case "list": {
      const parsed = v.safeParse(AdminRoomListSchema, body);
      return parsed.success ? table(parsed.output.rooms) : null;
    }
    case "reports": {
      const parsed = v.safeParse(AdminReportListSchema, body);
      return parsed.success ? reportLines(parsed.output.rooms) : null;
    }
    case "dismiss":
    case "dismiss-room": {
      const parsed = v.safeParse(DismissedSchema, body);
      return parsed.success ? [`dismissed ${String(parsed.output.dismissed)}`] : null;
    }
    case "takedown": {
      const parsed = v.safeParse(TakenDownSchema, body);
      if (!parsed.success) return null;
      return [`taken down ${parsed.output.takenDown}${parsed.output.live ? "" : " (it was not live)"}`];
    }
    case "delete":
    case "pin":
    case "unpin":
      return [`${DONE[cmd.verb]} ${cmd.id}`];
  }
}

export async function runCli(argv: readonly string[], io: CliIo): Promise<number> {
  const cmd = parseArgs(argv);
  if (cmd === null) {
    io.err(USAGE);
    return 2;
  }
  let socket: string | null;
  try {
    socket = adminSocketFor(io.env);
  } catch (err) {
    io.err(err instanceof Error ? err.message : String(err));
    return 2;
  }
  if (socket === null) {
    io.err("the admin socket is off (ADMIN_SOCKET=off or DB_PATH=:memory:)");
    return 1;
  }
  const { path, method } = request(cmd);
  let res: Response;
  try {
    // The host is ignored on a Unix socket; the server listens nowhere else.
    res = await fetch(`http://localhost${path}`, { method, unix: socket, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  } catch (err) {
    io.err(`no server on ${socket}: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  if (!res.ok) {
    const parsed = v.safeParse(AdminErrorSchema, body);
    io.err(parsed.success ? printable(parsed.output.error) : `server answered ${String(res.status)}`);
    return 1;
  }
  const lines = success(cmd, body);
  if (lines === null) {
    io.err("unexpected answer from the server");
    return 1;
  }
  for (const line of lines) io.out(line);
  return 0;
}

if (import.meta.main) {
  const code = await runCli(process.argv.slice(2), {
    env: process.env,
    out: (line) => {
      console.log(line);
    },
    err: (line) => {
      console.error(line);
    },
  });
  process.exit(code);
}
