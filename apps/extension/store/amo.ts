import * as v from "valibot";

/** The Firefox add-on's id (`browser_specific_settings.gecko.id` in wxt.config.ts). */
export const AMO_GUID = "omega-share@omega-share.duckdns.org";
const AMO_API = "https://addons.mozilla.org/api/v5";
/** AMO rejects a token whose exp is more than 5 minutes after its iat. */
const JWT_LIFETIME_S = 300;
/** AMO's validator usually finishes in seconds; 60 polls 2 s apart is a generous bound. */
const UPLOAD_POLLS = 60;
const UPLOAD_POLL_MS = 2000;

export interface AmoCredentials {
  readonly issuer: string;
  readonly secret: string;
}

/** `ext:amo` takes the key from the environment only: never argv, never a file (OME-757, ADR 0038). */
export function amoCredentialsFromEnv(env: Readonly<Record<string, string | undefined>>): AmoCredentials {
  const issuer = env.AMO_JWT_ISSUER ?? "";
  const secret = env.AMO_JWT_SECRET ?? "";
  const missing = [issuer === "" ? "AMO_JWT_ISSUER" : "", secret === "" ? "AMO_JWT_SECRET" : ""].filter((name) => name !== "");
  if (missing.length > 0) throw new Error(`set ${missing.join(" and ")} in the environment (the AMO API key, never on the command line)`);
  return { issuer, secret };
}

const b64url = (bytes: Uint8Array | string): string => Buffer.from(bytes).toString("base64url");

/** The AMO API token (https://mozilla.github.io/addons-server/topics/api/auth.html): HS256 over iss, jti, iat and exp ≤ iat + 5 min. */
export async function amoJwt(creds: AmoCredentials, { now = Date.now(), jti = crypto.randomUUID() }: { readonly now?: number; readonly jti?: string } = {}): Promise<string> {
  const iat = Math.floor(now / 1000);
  const signed = `${b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }))}.${b64url(JSON.stringify({ iss: creds.issuer, jti, iat, exp: iat + JWT_LIFETIME_S }))}`;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(creds.secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(signed));
  return `${signed}.${b64url(new Uint8Array(signature))}`;
}

const AmoFile = v.looseObject({ status: v.string(), hash: v.optional(v.string()) });
const AmoVersion = v.looseObject({
  id: v.number(),
  version: v.string(),
  channel: v.string(),
  is_disabled: v.optional(v.boolean()),
  edit_url: v.optional(v.string()),
  file: v.nullable(AmoFile),
});
const AmoAddon = v.looseObject({ slug: v.string(), status: v.string(), edit_url: v.optional(v.string()) });
const AmoVersionPage = v.looseObject({ next: v.nullable(v.string()), results: v.array(AmoVersion) });
const AmoMessage = v.looseObject({ type: v.string(), message: v.string() });
const AmoUpload = v.looseObject({
  uuid: v.string(),
  processed: v.boolean(),
  valid: v.boolean(),
  validation: v.nullable(v.looseObject({ messages: v.optional(v.array(AmoMessage)) })),
});

export type AmoAddon = v.InferOutput<typeof AmoAddon>;
export type AmoVersion = v.InferOutput<typeof AmoVersion>;

export interface AmoClient {
  /** The add-on's listing (slug, status). */
  addon(): Promise<AmoAddon>;
  /** Every version, listed and unlisted, as AMO orders them. */
  versions(): Promise<AmoVersion[]>;
  /** Uploads `zip` for the listed channel and waits for AMO's validator. Resolves to the upload uuid. */
  upload(zip: Uint8Array, filename: string): Promise<string>;
  /** Creates a version from an upload, then attaches the sources zip to it. */
  createVersion(uploadUuid: string, sources: Uint8Array, filename: string): Promise<AmoVersion>;
}

export interface AmoClientOptions {
  readonly credentials: AmoCredentials;
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
}

/**
 * The AMO v5 API for omega-share's add-on (OME-757). Every response is parsed with Valibot, a `next` page link off
 * the AMO API is refused, and every error has the issuer, the secret and each token it signed replaced by `[redacted]`.
 */
export function amoClient({ credentials, fetch: fetchImpl = fetch, now = Date.now, sleep = (ms) => Bun.sleep(ms) }: AmoClientOptions): AmoClient {
  const addonUrl = `${AMO_API}/addons/addon/${encodeURIComponent(AMO_GUID)}/`;
  const tokens: string[] = [];

  const redact = (text: string): string =>
    [credentials.secret, credentials.issuer, ...tokens].reduce((out, leak) => out.split(leak).join("[redacted]"), text).replace(/JWT [\w.-]+/g, "JWT [redacted]");

  async function call<S extends v.GenericSchema>(schema: S, method: string, url: string, body?: FormData | object): Promise<v.InferOutput<S>> {
    const token = await amoJwt(credentials, { now: now() });
    tokens.push(token);
    const headers: Record<string, string> = { Authorization: `JWT ${token}`, Accept: "application/json" };
    let payload: BodyInit | undefined;
    if (body instanceof FormData) payload = body;
    else if (body !== undefined) {
      headers["Content-Type"] = "application/json";
      payload = JSON.stringify(body);
    }
    const res = await fetchImpl(url, { method, headers, body: payload, redirect: "error" });
    const text = await res.text();
    const where = `AMO ${method} ${new URL(url).pathname}`;
    if (!res.ok) throw new Error(`${where} → ${String(res.status)}: ${text.slice(0, 500)}`);
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      throw new Error(`${where} → ${String(res.status)}: not JSON: ${text.slice(0, 200)}`);
    }
    const parsed = v.safeParse(schema, json);
    if (!parsed.success) throw new Error(`${where}: unexpected response: ${parsed.issues.map((i) => `${v.getDotPath(i) ?? "(root)"}: ${i.message}`).join("; ")}`);
    return parsed.output;
  }

  /** Runs `op`, rethrowing any failure as a fresh Error with the credentials and tokens redacted (no `cause`, which could carry them). */
  const guarded =
    <A extends unknown[], R>(op: (...args: A) => Promise<R>) =>
    async (...args: A): Promise<R> => {
      try {
        return await op(...args);
      } catch (e) {
        throw new Error(redact(e instanceof Error ? e.message : String(e)));
      }
    };

  return {
    addon: guarded(() => call(AmoAddon, "GET", addonUrl)),
    versions: guarded(async () => {
      const all: AmoVersion[] = [];
      let url: string | null = `${addonUrl}versions/?filter=all_with_unlisted&page_size=50`;
      while (url !== null) {
        const page: v.InferOutput<typeof AmoVersionPage> = await call(AmoVersionPage, "GET", url);
        all.push(...page.results);
        if (page.next !== null && !page.next.startsWith(`${AMO_API}/`)) throw new Error(`AMO sent a next page off its API: ${page.next}`);
        url = page.next;
      }
      return all;
    }),
    upload: guarded(async (zip: Uint8Array, filename: string) => {
      const form = new FormData();
      form.append("upload", new File([zip], filename, { type: "application/zip" }));
      form.append("channel", "listed");
      const { uuid } = await call(AmoUpload, "POST", `${AMO_API}/addons/upload/`, form);
      for (let poll = 0; poll < UPLOAD_POLLS; poll++) {
        const upload = await call(AmoUpload, "GET", `${AMO_API}/addons/upload/${encodeURIComponent(uuid)}/`);
        if (upload.processed) {
          if (upload.valid) return uuid;
          const errors = (upload.validation?.messages ?? []).filter((m) => m.type === "error").map((m) => m.message);
          throw new Error(`AMO rejected upload ${uuid}:\n- ${errors.length > 0 ? errors.join("\n- ") : "invalid, no message"}`);
        }
        await sleep(UPLOAD_POLL_MS);
      }
      throw new Error(`AMO had not validated upload ${uuid} after ${String((UPLOAD_POLLS * UPLOAD_POLL_MS) / 1000)} s`);
    }),
    createVersion: guarded(async (uploadUuid: string, sources: Uint8Array, filename: string) => {
      const created = await call(AmoVersion, "POST", `${addonUrl}versions/`, { upload: uploadUuid });
      const form = new FormData();
      form.append("source", new File([sources], filename, { type: "application/zip" }));
      return call(AmoVersion, "PATCH", `${addonUrl}versions/${String(created.id)}/`, form);
    }),
  };
}

/** Compares dotted-number versions (AMO's and package.json's form): negative, 0 or positive. Missing parts count as 0. */
export function compareVersions(a: string, b: string): number {
  const parts = (s: string): number[] => {
    if (!/^\d+(\.\d+)*$/.test(s)) throw new Error(`not a dotted-number version: ${s}`);
    return s.split(".").map(Number);
  };
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

const LISTING: Readonly<Record<string, string>> = {
  public: "approved, live on AMO",
  nominated: "awaiting review",
  incomplete: "incomplete, no version submitted for review",
  rejected: "rejected",
  disabled: "disabled by Mozilla",
  deleted: "deleted",
};
const REVIEW: Readonly<Record<string, string>> = { public: "approved", unreviewed: "awaiting review", disabled: "disabled" };

/** `ext:amo status`: the listing status and every version's channel, review and file status, newest first. */
export function statusReport(addon: AmoAddon, versions: readonly AmoVersion[]): string {
  const listing = LISTING[addon.status];
  const lines = [`${addon.slug} (${AMO_GUID})`, `listing: ${addon.status}${listing === undefined ? "" : ` (${listing})`}`];
  if (addon.edit_url !== undefined) lines.push(`edit: ${addon.edit_url}`);
  if (versions.length === 0) return [...lines, "versions: none"].join("\n");
  const width = Math.max(...versions.map((ver) => ver.version.length));
  const sorted = [...versions].sort((a, b) => compareVersions(b.version, a.version));
  lines.push("versions:");
  for (const ver of sorted) {
    const file = ver.file?.status ?? "none";
    const review = REVIEW[file] ?? file;
    const row = `  ${ver.version.padEnd(width)}  ${ver.channel.padEnd(8)}  review: ${review.padEnd(17)}  file: ${file.padEnd(10)}  ${ver.is_disabled === true ? "(disabled by the developer)" : ""}`;
    lines.push(row.trimEnd());
  }
  return lines.join("\n");
}

export interface SubmitCheck {
  /** apps/extension/package.json's version. */
  readonly local: string;
  /** Every version on AMO, listed or unlisted. */
  readonly amoVersions: readonly string[];
  /** `git status --porcelain` lines. */
  readonly dirty: readonly string[];
  /** sha256 of the `ext:store` zips and of a fresh build of each. */
  readonly hashes: Readonly<Record<"firefox" | "sources", { readonly built: string; readonly fresh: string }>>;
}

/** Why `ext:amo submit` refuses to upload; empty when it may (OME-757, ADR 0038). */
export function submitProblems({ local, amoVersions, dirty, hashes }: SubmitCheck): string[] {
  const problems: string[] = [];
  const newest = amoVersions.reduce<string | undefined>((max, ver) => (max === undefined || compareVersions(ver, max) > 0 ? ver : max), undefined);
  if (newest !== undefined && compareVersions(local, newest) <= 0) problems.push(`version ${local} is not greater than ${newest}, the newest on AMO: bump apps/extension/package.json`);
  if (dirty.length > 0) problems.push(`the tree is dirty; submit from a clean checkout of the release commit:\n  ${dirty.join("\n  ")}`);
  for (const zip of ["firefox", "sources"] as const) {
    const { built, fresh } = hashes[zip];
    if (built !== fresh) problems.push(`the ${zip} zip (sha256 ${built}) differs from a fresh build (sha256 ${fresh}): rerun bun run ext:store`);
  }
  return problems;
}
