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

  /** True when the bucket has refilled completely, so forgetting it changes nothing. */
  isFull(): boolean {
    return this.tokens + ((performance.now() - this.last) / 1000) * this.perSecond >= this.burst;
  }
}

/** One bucket per key (e.g. client address). Full buckets are pruned so the map stays small. */
export class KeyedLimiter {
  private readonly buckets = new Map<string, TokenBucket>();

  constructor(
    private readonly burst: number,
    private readonly perSecond: number,
    private readonly maxKeys = 1024,
  ) {}

  take(key: string): boolean {
    let bucket = this.buckets.get(key);
    if (bucket === undefined) {
      if (this.buckets.size >= this.maxKeys) {
        for (const [k, b] of this.buckets) if (b.isFull()) this.buckets.delete(k);
      }
      bucket = new TokenBucket(this.burst, this.perSecond);
      this.buckets.set(key, bucket);
    }
    return bucket.take();
  }
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
