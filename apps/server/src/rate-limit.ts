import { isIP } from "node:net";

/** Classic token bucket: `burst` tokens, refilled at `perSecond`. Allocation-free per call. */
export class TokenBucket {
  private tokens: number;
  private last = performance.now();

  constructor(
    private readonly burst: number,
    private readonly perSecond: number,
  ) {
    this.tokens = burst;
  }

  /** Takes a token if one is available. */
  take(): boolean {
    const now = performance.now();
    this.tokens = Math.min(this.burst, this.tokens + ((now - this.last) / 1000) * this.perSecond);
    this.last = now;
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
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
      bucket = new TokenBucket(this.burst, this.perSecond);
    } else {
      this.buckets.delete(key);
    }
    this.buckets.set(key, bucket);
    return bucket.take();
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
