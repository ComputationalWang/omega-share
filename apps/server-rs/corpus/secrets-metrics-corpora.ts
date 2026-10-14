// OME-1162: `hashSecret` and `Metrics.render` as corpora (byte-identical output is the contract).
import { CLOSE_CODES } from "@omega/shared";
import { Metrics, REPORT_OUTCOMES, SERVICE_RESTART } from "../../server/src/metrics";
import { hashSecret } from "../../server/src/secrets";
import { decided, type Corpus } from "./corpora";

const SECRETS = [
  "",
  "a",
  "AbCdEfGhIjKlMnOpQr_-09",
  "x".repeat(43),
  "é",
  "é",
  "日本語🙂",
  "﻿",
  "\u0085",
  "\0",
  "a\0b",
  "ﬁ",
  "A".repeat(10_000),
];

type Op = ["relay", number] | ["close", number] | ["report", string, string?] | ["takedown"];
interface Input {
  gauges: [number, number, number, number];
  ops: Op[];
}

const CLOSES = [
  CLOSE_CODES.JOIN_TIMEOUT,
  CLOSE_CODES.ROOM_FULL,
  CLOSE_CODES.ROOM_CLOSED,
  CLOSE_CODES.RATE_LIMITED,
  CLOSE_CODES.BAD_MESSAGES,
  CLOSE_CODES.KICKED,
  CLOSE_CODES.TAKEN_DOWN,
  CLOSE_CODES.SESSION_REPLACED,
  SERVICE_RESTART,
];
const REASONS = ["sexual", "violence", "hate", "spam", "danger", "other"];
// Every bucket edge in ms (the TS buckets are in seconds) and a value either side of it.
const EDGES = [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 25, 50];

const relays = (values: number[]): Op[] => values.map((v) => ["relay", v]);
const INPUTS: Input[] = [
  { gauges: [0, 0, 0, 0], ops: [] },
  { gauges: [3, 5, 7, 2], ops: [] },
  { gauges: [1, 1, 1, 1], ops: relays([0]) },
  { gauges: [1, 1, 1, 1], ops: relays(EDGES) },
  { gauges: [1, 1, 1, 1], ops: relays(EDGES.flatMap((e) => [e - 0.001, e + 0.001])) },
  { gauges: [1, 1, 1, 1], ops: relays([51, 1000, 123.456, 0.0001]) },
  { gauges: [1, 1, 1, 1], ops: relays([100, 200]) }, // 0.1 + 0.2: float noise in the sum
  { gauges: [1, 1, 1, 1], ops: relays([0.0001, 0.0001, 0.0002]) }, // tiny sum: exponent form
  { gauges: [1, 1, 1, 1], ops: relays([1e25]) }, // huge sum: exponent form
  { gauges: [1, 1, 1, 1], ops: relays([-1, 0.5]) },
  { gauges: [1, 1, 1, 1], ops: relays(Array.from({ length: 500 }, (_, i) => ((i * 7919) % 97) / 3)) },
  { gauges: [1, 1, 1, 1], ops: CLOSES.map((c): Op => ["close", c]) },
  { gauges: [1, 1, 1, 1], ops: [...CLOSES, ...CLOSES, 4029].map((c): Op => ["close", c]) },
  { gauges: [1, 1, 1, 1], ops: REPORT_OUTCOMES.map((o): Op => ["report", o]) },
  { gauges: [1, 1, 1, 1], ops: REASONS.map((r): Op => ["report", "received", r]) },
  { gauges: [1, 1, 1, 1], ops: [["report", "received", "spam"], ["report", "already_reported"], ["report", "received", "spam"], ["report", "rate_limited"]] },
  { gauges: [1, 1, 1, 1], ops: [["takedown"], ["takedown"], ["takedown"]] },
  {
    gauges: [12, 345, 6789, 1_000_000],
    ops: [["relay", 0.3], ["close", 4029], ["report", "received", "hate"], ["takedown"], ["relay", 12], ["close", 1012], ["relay", 0.07]],
  },
  { gauges: [Number.MAX_SAFE_INTEGER, 0, 0, 0], ops: [] },
];

/** Everything before the two process gauges, which depend on the live process. */
const UNTIL_PROCESS = "# HELP process_resident_memory_bytes";

const run = ({ gauges: [rooms, sockets, members, openReports], ops }: Input): string => {
  const m = new Metrics();
  for (const op of ops) {
    if (op[0] === "relay") m.observeRelay(op[1]);
    else if (op[0] === "close") m.countClose(op[1] as never);
    else if (op[0] === "report") m.countReport(op[1] as never, op[2] as never);
    else m.countTakedown();
  }
  const text = m.render({ rooms, sockets, members, openReports });
  return text.slice(0, text.indexOf(UNTIL_PROCESS));
};

export const secretsMetricsCorpora: Corpus[] = [
  { name: "hash-secret", cases: () => decided(SECRETS, (s) => Buffer.from(hashSecret(s)).toString("hex")) },
  { name: "metrics-render", cases: () => decided(INPUTS, run) },
];
