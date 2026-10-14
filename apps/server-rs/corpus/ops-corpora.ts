// Operator-tool corpora (OME-1168): the pure formatters of the CLI and the backup file name, driven by the
// real TS code. No lone surrogates (PORTING.md).
//  - cli-parse-args: `parseArgs` (rooms/reports verbs, id validation, arity).
//  - cli-printable: `printable` (control and format characters escaped).
//  - cli-time: `time` (ISO text, extended years, refusal outside the Date range).
//  - cli-success: what a successful answer prints (`success`, so `table` and `reportLines` too).
//  - backup-snapshot-name: `snapshotName`.
import { parseArgs, printable, success } from "../../server/src/cli";
import { snapshotName } from "../../server/scripts/backup";
import { decided, type Case, type Corpus } from "./corpora";

const ROOM = "aaaaaaaaaaaaaaaaaaaaaaaaaa";
const REPORT = "AAAAAAAAAAAAAAAAAAAAAA";

// ---- cli-parse-args

function argvCases(): string[][] {
  const out: string[][] = [[], [""], ["rooms"], ["reports"], ["Rooms", "list"], ["room", "list"]];
  const ids = [ROOM, "lobby", "LOBBY", "a", "a-b", "a_b", "", " ", "../lobby", "a/b", "é", "\u{1F600}", "a".repeat(64), "a".repeat(65), "a\n", "-", "--room", "list"];
  for (const verb of ["list", "delete", "pin", "unpin", "takedown", "nuke", "", "LIST"]) {
    out.push(["rooms", verb]);
    for (const id of ids) out.push(["rooms", verb, id]);
    out.push(["rooms", verb, ROOM, "extra"], ["rooms", verb, ROOM, ROOM]);
  }
  for (const verb of ["list", "dismiss", "delete", "", "Dismiss"]) {
    out.push(["reports", verb]);
    for (const id of [REPORT, "A".repeat(21), "A".repeat(23), "a-b_".repeat(5) + "AB", "A".repeat(21) + "!", "A".repeat(21) + "\n", "", "--room", ROOM]) {
      out.push(["reports", verb, id]);
    }
    out.push(["reports", verb, REPORT, "extra"], ["reports", verb, "--room"], ["reports", verb, "--room", ROOM], ["reports", verb, "--room", ROOM, "x"]);
    for (const id of ["LOBBY", "", "../x", "a".repeat(65)]) out.push(["reports", verb, "--room", id]);
  }
  out.push(["rooms", "list", ""], ["admin", "rooms", "list"], ["--room", "x"]);
  return out;
}
const parsed = (argv: string[]): unknown => parseArgs(argv);

// ---- cli-printable

function printableInputs(): string[] {
  const out = [
    "", "plain", "Film club", "tab\there", "line\nbreak", "esc\u001b[2J", "nul\u0000x", "del\u007f", "c1\u0085\u009f\u0080", "bidi‮‭‪⁦⁩",
    "zw​‌‍⁠﻿", "ls ps ", "tag\u{e0041}\u{e007f}", "soft­", "arabic؀؜", "nbsp ideo　", "emoji \u{1F600} ok",
    "a\u001b[2Jb\tc‮d\ne\u0085f g\u{e0041}h​i", "\u{10ffff}", "\u{e0001}", "\u{1d173}", "é", "é", "李雷", "￿", "�", "⁥", "᠎", " ", "    ",
  ];
  for (let cp = 0; cp < 0x200; cp++) out.push(`x${String.fromCodePoint(cp)}y`);
  for (let cp = 0x2000; cp < 0x2070; cp++) out.push(`x${String.fromCodePoint(cp)}y`);
  for (let cp = 0xfff0; cp < 0x10000; cp++) out.push(`x${String.fromCodePoint(cp)}y`);
  for (const cp of [0xe0000, 0xe0020, 0xe0100, 0xf0000, 0x1bca0, 0x1bca3, 0x13430, 0x1d173, 0x1d17a, 0x110bd, 0x110cd, 0x8e2, 0x0890, 0x0891, 0x180f, 0x2065]) {
    out.push(`x${String.fromCodePoint(cp)}y`);
  }
  return [...new Set(out)];
}

// ---- cli-time

function timeInputs(): (number | null)[] {
  const day = 86_400_000;
  return [
    null, 0, 1, -1, 999, 1000, 1_790_000_000_000, 1_790_000_000_123, Date.UTC(2026, 9, 1), Date.UTC(2000, 1, 29), Date.UTC(1900, 0, 1), Date.UTC(9999, 11, 31, 23, 59, 59, 999),
    253_402_300_800_000, 253_402_300_800_001, 8.64e15, 8.64e15 + 1, -8.64e15, -8.64e15 - 1, -62_167_219_200_000, -62_167_219_200_001, -62_198_755_200_000, -62_135_596_800_000,
    Number.MAX_SAFE_INTEGER, Number.MIN_SAFE_INTEGER, 1e15, -1e15, 3e14, 4e14, 951_782_400_000, 951_868_800_000, 4_107_542_400_000, 5 * day, -5 * day, -day - 1,
  ];
}
const timeText = (ms: number | null): unknown => (ms === null ? "never" : Number.isNaN(new Date(ms).getTime()) ? null : new Date(ms).toISOString());

// ---- cli-success

const room = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: ROOM, title: "Film club", visibility: "public", createdAt: 1_790_000_000_000, lastActiveAt: 1_790_000_003_000, pinned: false, members: 3, ...over,
});
const report = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: REPORT, createdAt: 1_790_000_000_000, reason: "spam", note: "buy now", title: "Film club", embedUrl: "https://example.org/v", ...over,
});
const rep = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: ROOM, state: "live", title: "Film club", visibility: "public", members: 2, reports: [report()], ...over,
});
const HOSTILE = ["", "a\u001b[2Jb\tc‮d\ne\u0085f", "tag\u{e0041}x", "\u{1F600} emoji", "é", "x".repeat(300)];

function successBodies(): { argv: string[]; body: unknown }[] {
  const out: { argv: string[]; body: unknown }[] = [];
  const list = ["rooms", "list"];
  out.push({ argv: list, body: { rooms: [] } });
  out.push({ argv: list, body: { rooms: [room()] } });
  out.push({ argv: list, body: { rooms: [room(), room({ id: "lobby", title: "", pinned: true, lastActiveAt: null, members: 0, visibility: "private" })] } });
  for (const title of HOSTILE) out.push({ argv: list, body: { rooms: [room({ title })] } });
  for (const createdAt of [0, -1, 8.64e15, 8.64e15 + 1, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER + 2, 1.5, "1", null]) out.push({ argv: list, body: { rooms: [room({ createdAt })] } });
  for (const lastActiveAt of [null, 0, 1.5, "x", undefined]) out.push({ argv: list, body: { rooms: [room({ lastActiveAt })] } });
  for (const members of [0, -1, 1.5, "1", null, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER + 2]) out.push({ argv: list, body: { rooms: [room({ members })] } });
  for (const visibility of ["public", "private", "unlisted", "", null]) out.push({ argv: list, body: { rooms: [room({ visibility })] } });
  for (const id of ["LOBBY", "", "a/b", ROOM]) out.push({ argv: list, body: { rooms: [room({ id })] } });
  for (const pinned of [true, false, "yes", null, 1]) out.push({ argv: list, body: { rooms: [room({ pinned })] } });
  out.push({ argv: list, body: { rooms: [room({ extra: 1 })] } }, { argv: list, body: { rooms: [room(), { id: ROOM }] } }, { argv: list, body: { rooms: [{ ...room(), title: undefined }] } });
  out.push({ argv: list, body: { rooms: [room()], extra: 1 } }, { argv: list, body: {} }, { argv: list, body: null }, { argv: list, body: [] }, { argv: list, body: "x" }, { argv: list, body: { rooms: null } });

  const reps = ["reports", "list"];
  out.push({ argv: reps, body: { rooms: [] } }, { argv: reps, body: { rooms: [rep()] } });
  out.push({
    argv: reps,
    body: {
      rooms: [
        rep({ state: "taken_down", title: null, visibility: null, members: null }),
        rep({ id: "other", state: "gone", title: null, visibility: null, members: null, reports: [report({ reason: "hate" }), report({ id: "BBBBBBBBBBBBBBBBBBBBBB", reason: "danger", createdAt: 5 })] }),
      ],
    },
  });
  out.push({
    argv: reps,
    body: { rooms: [rep({ reports: ["spam", "hate", "spam", "other", "sexual", "violence", "danger"].map((reason) => report({ reason })) })] },
  });
  out.push({ argv: reps, body: { rooms: [rep({ reports: [] })] } });
  for (const t of HOSTILE) {
    out.push({ argv: reps, body: { rooms: [rep({ title: t, reports: [report({ note: t, title: t, embedUrl: t })] })] } });
    out.push({ argv: reps, body: { rooms: [rep({ title: null, reports: [report({ note: null, title: null, embedUrl: null })] })] } });
  }
  for (const state of ["live", "taken_down", "gone", "other", null]) out.push({ argv: reps, body: { rooms: [rep({ state })] } });
  for (const visibility of ["public", "private", null, "x"]) out.push({ argv: reps, body: { rooms: [rep({ visibility })] } });
  for (const members of [0, 7, null, -1, 1.5, "2"]) out.push({ argv: reps, body: { rooms: [rep({ members })] } });
  for (const reason of ["spam", "nope", "", null]) out.push({ argv: reps, body: { rooms: [rep({ reports: [report({ reason })] })] } });
  for (const id of [REPORT, "short", "A".repeat(23), null]) out.push({ argv: reps, body: { rooms: [rep({ reports: [report({ id })] })] } });
  out.push({ argv: reps, body: { rooms: [rep({ reports: [report({ extra: 1 })] })] } }, { argv: reps, body: { rooms: [rep({ extra: 1 })] } });
  out.push({ argv: reps, body: { rooms: [rep({ reports: [{ ...report(), note: undefined }] })] } });
  out.push({ argv: reps, body: { rooms: [rep({ title: undefined })] } }, { argv: reps, body: { rooms: [{ ...rep(), members: undefined }] } }, { argv: reps, body: {} }, { argv: reps, body: null });
  for (const createdAt of [0, 8.64e15, 8.64e15 + 1, 1.5]) out.push({ argv: reps, body: { rooms: [rep({ reports: [report({ createdAt })] })] } });

  for (const argv of [["reports", "dismiss", REPORT], ["reports", "dismiss", "--room", ROOM]]) {
    const bodies = [{ dismissed: 0 }, { dismissed: 1 }, { dismissed: 12 }, { dismissed: -1 }, { dismissed: 1.5 }, { dismissed: "1" }, { dismissed: Number.MAX_SAFE_INTEGER }, { dismissed: Number.MAX_SAFE_INTEGER + 2 }, { dismissed: null }, {}, null, { dismissed: 1, extra: 2 }, [], "x"];
    for (const body of bodies) out.push({ argv, body });
  }
  const downs = [{ takenDown: ROOM, live: true }, { takenDown: ROOM, live: false }, { takenDown: "LOBBY", live: true }, { takenDown: ROOM }, { live: true }, { takenDown: ROOM, live: "yes" }, { takenDown: ROOM, live: true, extra: 1 }, null, {}];
  for (const body of downs) out.push({ argv: ["rooms", "takedown", ROOM], body });
  for (const verb of ["delete", "pin", "unpin"]) for (const body of [{ deleted: ROOM }, {}, null, [], "x", { pinned: true, id: ROOM }]) out.push({ argv: ["rooms", verb, ROOM], body });
  return out;
}

const successCases = (): Case[] =>
  decided(
    successBodies().map(({ argv, body }) => [argv, JSON.stringify(body) ?? "null"] as [string[], string]),
    ([argv, text]) => {
      const cmd = parseArgs(argv);
      if (cmd === null) return null;
      try {
        return success(cmd, JSON.parse(text));
      } catch {
        // `toISOString` throws RangeError outside the Date range and runCli dies with it; Rust refuses the answer instead.
        return null;
      }
    },
  );

// ---- backup-snapshot-name

const snapshotDates = (): number[] => [
  0, 1, 86_399_999, 86_400_000, 1_790_000_000_000, Date.UTC(2026, 9, 14, 23, 59, 59, 999), Date.UTC(2024, 1, 29), Date.UTC(2000, 0, 1), Date.UTC(1999, 11, 31, 23, 59, 59, 999),
  Date.UTC(1969, 11, 31), -1, Date.UTC(1900, 5, 1), Date.UTC(2100, 2, 1),
];

export const opsCorpora: Corpus[] = [
  { name: "cli-parse-args", cases: () => decided(argvCases(), parsed) },
  { name: "cli-printable", cases: () => decided(printableInputs(), printable) },
  { name: "cli-time", cases: () => decided(timeInputs(), timeText) },
  { name: "cli-success", cases: successCases },
  { name: "backup-snapshot-name", cases: () => decided(snapshotDates(), (ms) => snapshotName(new Date(ms))) },
];
