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
  | "store.report"
  | "store.health"
  | "gc.remove"
  | "gc.sweep"
  | "gc.purge"
  | "shutdown";

const MAX_MESSAGE = 240;
/**
 * The redactions see at most this much of the message: EMAIL backtracks quadratically on a long run without
 * whitespace, so an uncapped message could stall the loop. The cut backs up to whitespace: a token cut in half
 * (`alice.secret@`) misses its pattern, and earlier redactions can shrink the line enough for it to show (OME-579).
 */
const MAX_SCRUBBED = 2048;

/** At most `MAX_SCRUBBED` chars of the message, never ending in part of a token. */
function head(message: string): string {
  if (message.length <= MAX_SCRUBBED) return message;
  let end = MAX_SCRUBBED;
  while (end > 0 && !/\s/.test(message.charAt(end))) end--;
  return message.slice(0, end);
}
/**
 * From the first quote to the end of the message. A quoted value can itself hold a quote, escaped
 * (`JSON.stringify`) or not (Valibot), so no closing quote can be trusted: over-redact instead (OME-536).
 */
const QUOTED = /["'][^]*/;
const EMAIL = /[^\s@"'<>()[\]]+@[^\s@"'<>()[\]]+\.[a-z]{2,}/gi;
const IPV4 = /\b\d{1,3}(?:\.\d{1,3}){3}\b/g;
/** Two or more colon-joined hex groups with a `::` or at least 3 colons: IPv6, not `a: b` prose. */
const IPV6 = /(?<![\w:])(?:[0-9a-f]{0,4}:){2,7}[0-9a-f]{0,4}(?![\w:])/gi;

/**
 * Emails become `<email>`, IPv4 and IPv6 addresses `<ip>`. Also what an abuse report's note goes through before
 * it is stored (ADR 0033 §3). The caller bounds `text` first: EMAIL is quadratic on a long run without whitespace.
 */
export function redactAddresses(text: string): string {
  return text
    .replace(EMAIL, "<email>")
    .replace(IPV4, "<ip>")
    .replace(IPV6, (m) => (m.includes("::") || m.split(":").length > 3 ? "<ip>" : m));
}

/** Every redaction runs before the cap, so the cap never cuts an address to a fragment the patterns miss (OME-548). */
function scrub(message: string): string {
  const redacted = redactAddresses(head(message).replace(QUOTED, (q) => `${q.charAt(0)}…${q.charAt(0)}`));
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
