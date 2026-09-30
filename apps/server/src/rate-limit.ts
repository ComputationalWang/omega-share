import { isIP } from "node:net";
import { RETRY_AFTER_MAX_MS } from "@omega/shared";

/** Milliseconds on a monotonic clock. Injected by tests so a refill needs no sleep. */
export type Clock = () => number;
export const monotonic: Clock = () => performance.now();

/** Classic token bucket: `burst` tokens, refilled at `perSecond`. Allocation-free per call. */
export class TokenBucket {
  private tokens: number;
  private last: number;

  constructor(
    private readonly burst: number,
    private readonly perSecond: number,
    private readonly now: Clock = monotonic,
  ) {
    this.tokens = burst;
    this.last = now();
  }

  /** Takes a token if one is available. */
  take(): boolean {
    this.refill();
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }

  /** Milliseconds until a token is available (0 if one is), capped at the contract's RETRY_AFTER_MAX_MS. */
  retryAfterMs(): number {
    this.refill();
    if (this.tokens >= 1) return 0;
    return Math.min(RETRY_AFTER_MAX_MS, Math.ceil(((1 - this.tokens) / this.perSecond) * 1000));
  }

  private refill(): void {
    const now = this.now();
    this.tokens = Math.min(this.burst, this.tokens + ((now - this.last) / 1000) * this.perSecond);
    this.last = now;
  }
}

/**
 * One bucket per key (e.g. client address), at most `maxKeys` of them. The least recently
 * used key is evicted first (Map keeps insertion order), so the map can't grow without bound.
 */
export class KeyedLimiter {
  private readonly buckets = new Map<string, TokenBucket>();

  constructor(
    private readonly burst: number,
    private readonly perSecond: number,
    private readonly maxKeys = 1024,
    private readonly now: Clock = monotonic,
  ) {}

  get size(): number {
    return this.buckets.size;
  }

  take(key: string): boolean {
    let bucket = this.buckets.get(key);
    if (bucket === undefined) {
      if (this.buckets.size >= this.maxKeys) {
        const oldest = this.buckets.keys().next();
        if (oldest.done !== true) this.buckets.delete(oldest.value);
      }
      bucket = new TokenBucket(this.burst, this.perSecond, this.now);
    } else {
      this.buckets.delete(key);
    }
    this.buckets.set(key, bucket);
    return bucket.take();
  }

  /** Milliseconds until `key` may take again; 0 for a key with a token or no bucket. */
  retryAfterMs(key: string): number {
    return this.buckets.get(key)?.retryAfterMs() ?? 0;
  }
}

/**
 * Rate-limit key for a peer address. IPv4 (including IPv4-mapped IPv6) is kept as is; IPv6
 * is keyed by its /64, because one host usually controls a whole /64.
 */
export function addressKey(ip: string): string {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (mapped?.[1] !== undefined) return mapped[1];
  if (!ip.includes(":")) return ip;
  // Its own key, so `isLoopbackKey` can't match other addresses of ::/64 (::2, hex-form IPv4-mapped).
  if (ip === "::1") return ip;
  const [head = "", tail = ""] = ip.split("::", 2);
  const h = head === "" ? [] : head.split(":");
  const t = ip.includes("::") && tail !== "" ? tail.split(":") : [];
  const groups = [...h, ...Array.from({ length: Math.max(0, 8 - h.length - t.length) }, () => "0"), ...t];
  return groups
    .slice(0, 4)
    .map((g) => parseInt(g, 16).toString(16))
    .join(":") + "::/64";
}

const LOOPBACK_V4 = /^(?:::ffff:)?127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/i;
const isLoopback = (ip: string): boolean => ip === "::1" || LOOPBACK_V4.test(ip);

/**
 * Whether a client key (from `clientKey`) is a loopback peer: local dev, tests and the load probe. The
 * per-key WS limits skip these. Behind the tunnel the key is the forwarded client address, never loopback.
 */
export const isLoopbackKey = (key: string): boolean => key === "::1" || LOOPBACK_V4.test(key);

/**
 * Rate-limit key for a request (ADR 0015 §5). `X-Forwarded-For` counts only with `trustProxy` and a
 * loopback peer (the tunnel agent), and then only its rightmost entry: the tunnel appends it, so a
 * client can't choose it. Anything else there shares one `proxy:unknown` bucket.
 */
export function clientKey(peer: string, forwardedFor: string | null, trustProxy: boolean): string {
  if (!trustProxy || !isLoopback(peer)) return addressKey(peer);
  // Headers.get joins repeated headers with ", ", so this is also the last header's last entry.
  const last = forwardedFor?.slice(forwardedFor.lastIndexOf(",") + 1).trim() ?? "";
  return isIP(last) === 0 ? "proxy:unknown" : addressKey(last);
}

/** Reads a request body as UTF-8, or returns null once it exceeds `maxBytes` (without buffering the rest). */
export async function readBodyCapped(req: Request, maxBytes: number): Promise<string | null> {
  if (req.body === null) return "";
  // Bun types Request.body chunks as `any`; they are bytes.
  const reader = (req.body as ReadableStream<Uint8Array>).getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > maxBytes) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}
