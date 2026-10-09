/**
 * Error lines (OME-504). One JSON object per line on stderr, which systemd hands to journald on the box
 * (rotation: `deploy/journald/omega-share.conf`). A line carries a fixed event name and the error's class
 * and message, never a room id, title, nickname or address: callers have no free-form field, and the
 * message is cut at its first quote (store and Valibot errors quote ids and input) and scrubbed of IPs and emails.
 */
export type LogEvent =
  | "store.new_room"
  | "store.delete_room"
  | "store.last_active"
  | "store.layout"
  | "store.title"
  | "store.control_policy"
  | "store.seat_holds"
  | "store.queue_item"
  | "store.queue"
  | "gc.remove"
  | "gc.sweep"
  | "shutdown";

const MAX_MESSAGE = 240;
/**
 * The redactions see at most this much of the message: EMAIL backtracks quadratically on a long run without
 * whitespace, so an uncapped message could stall the loop. A fragment cut here can only reach the 240-char
 * output if redaction first shrank the prefix by ~1800 chars, and the quote cut drops the tail outright.
 */
const MAX_SCRUBBED = 2048;
/**
 * From the first quote to the end of the message. A quoted value can itself hold a quote, escaped
 * (`JSON.stringify`) or not (Valibot), so no closing quote can be trusted: over-redact instead (OME-536).
 */
const QUOTED = /["'][^]*/;
const EMAIL = /[^\s@"'<>()[\]]+@[^\s@"'<>()[\]]+\.[a-z]{2,}/gi;
const IPV4 = /\b\d{1,3}(?:\.\d{1,3}){3}\b/g;
/** Two or more colon-joined hex groups with a `::` or at least 3 colons: IPv6, not `a: b` prose. */
const IPV6 = /(?<![\w:])(?:[0-9a-f]{0,4}:){2,7}[0-9a-f]{0,4}(?![\w:])/gi;

/** Every redaction runs before the cap, so the cap never cuts an address to a fragment the patterns miss (OME-548). */
function scrub(message: string): string {
  const redacted = message
    .slice(0, MAX_SCRUBBED)
    .replace(QUOTED, (q) => `${q.charAt(0)}…${q.charAt(0)}`)
    .replace(EMAIL, "<email>")
    .replace(IPV4, "<ip>")
    .replace(IPV6, (m) => (m.includes("::") || m.split(":").length > 3 ? "<ip>" : m));
  return redacted.length > MAX_MESSAGE ? `${redacted.slice(0, MAX_MESSAGE)}…` : redacted;
}

export function formatLogLine(level: "error", event: LogEvent, err?: unknown): string {
  const line: { level: string; event: LogEvent; error?: string } = { level, event };
  if (err instanceof Error) line.error = `${err.name}: ${scrub(err.message)}`;
  else if (err !== undefined) line.error = `non-Error ${typeof err}`;
  return JSON.stringify(line);
}

export function logError(event: LogEvent, err?: unknown): void {
  console.error(formatLogLine("error", event, err));
}
