import * as v from "valibot";
import { RoomIdSchema, type RoomId } from "@omega/shared";
import { AdminErrorSchema, AdminRoomListSchema, type AdminRoom } from "./admin";
import { adminSocketFor } from "./config";

/**
 * Operator CLI for room takedowns (docs/ops/rooms.md). It talks to the running server over its
 * admin socket (`admin.ts`), so a delete ends the live room the way an owner delete or GC does.
 *
 *   bun apps/server/src/cli.ts rooms list
 *   bun apps/server/src/cli.ts rooms delete <id>
 *   bun apps/server/src/cli.ts rooms pin <id>
 *   bun apps/server/src/cli.ts rooms unpin <id>
 *
 * Exit codes: 0 done, 1 failed (no such room, no server, server error), 2 usage.
 */

export interface CliIo {
  /** `ADMIN_SOCKET` or `DB_PATH` locate the socket (`adminSocketFor`). */
  env: Readonly<Record<string, string | undefined>>;
  out: (line: string) => void;
  err: (line: string) => void;
}

const USAGE = "usage: cli.ts rooms list | rooms delete <id> | rooms pin <id> | rooms unpin <id>";

type Command = { verb: "list" } | { verb: "delete" | "pin" | "unpin"; id: RoomId };

function parseArgs(argv: readonly string[]): Command | null {
  const [noun, verb, id, ...rest] = argv;
  if (noun !== "rooms" || rest.length > 0) return null;
  if (verb === "list") return id === undefined ? { verb } : null;
  if (verb !== "delete" && verb !== "pin" && verb !== "unpin") return null;
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

function request(cmd: Command): { path: string; method: string } {
  switch (cmd.verb) {
    case "list":
      return { path: "/rooms", method: "GET" };
    case "delete":
      return { path: `/rooms/${cmd.id}`, method: "DELETE" };
    case "pin":
    case "unpin":
      return { path: `/rooms/${cmd.id}/${cmd.verb}`, method: "POST" };
  }
}

const DONE: Record<Exclude<Command["verb"], "list">, string> = { delete: "deleted", pin: "pinned", unpin: "unpinned" };

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
    res = await fetch(`http://localhost${path}`, { method, unix: socket });
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
  if (cmd.verb === "list") {
    const parsed = v.safeParse(AdminRoomListSchema, body);
    if (!parsed.success) {
      io.err(`unexpected answer from the server: ${v.summarize(parsed.issues)}`);
      return 1;
    }
    for (const line of table(parsed.output.rooms)) io.out(line);
    return 0;
  }
  io.out(`${DONE[cmd.verb]} ${cmd.id}`);
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
