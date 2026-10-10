import { describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { AMO_GUID, amoClient, amoCredentialsFromEnv, amoJwt, compareVersions, statusReport, submitProblems, type AmoCredentials } from "../store/amo";

// `bun run ext:amo` (OME-757): the AMO v5 API with the board's JWT key. Credentials here are made up.
const CREDS: AmoCredentials = { issuer: "user:12345:67", secret: "s3cr3t-0123456789abcdef0123456789abcdef0123456789abcdef" };
const NOW = Date.UTC(2026, 9, 10, 12, 0, 0);

const b64url = (s: string): string => Buffer.from(s, "base64url").toString("utf8");
const decode = (jwt: string): { header: unknown; payload: Record<string, unknown>; signature: string; signed: string } => {
  const [h = "", p = "", s = ""] = jwt.split(".");
  return { header: JSON.parse(b64url(h)), payload: JSON.parse(b64url(p)) as Record<string, unknown>, signature: s, signed: `${h}.${p}` };
};

describe("amoJwt", () => {
  test("is an HS256 JWT with iss, jti, iat and an exp at most 5 minutes out, signed with the secret", async () => {
    const jwt = await amoJwt(CREDS, { now: NOW, jti: "jti-1" });
    const { header, payload, signature, signed } = decode(jwt);
    expect(header).toEqual({ alg: "HS256", typ: "JWT" });
    expect(payload.iss).toBe("user:12345:67");
    expect(payload.jti).toBe("jti-1");
    expect(payload.iat).toBe(NOW / 1000);
    expect(typeof payload.exp).toBe("number");
    const lifetime = Number(payload.exp) - Number(payload.iat);
    expect(lifetime).toBeGreaterThan(0);
    expect(lifetime).toBeLessThanOrEqual(300);
    // node:crypto's HMAC is an implementation independent of the WebCrypto one under test.
    expect(signature).toBe(createHmac("sha256", CREDS.secret).update(signed).digest("base64url"));
  });

  test("a fresh jti every call by default, so AMO never sees a replayed token", async () => {
    const a = decode(await amoJwt(CREDS, { now: NOW })).payload.jti;
    const b = decode(await amoJwt(CREDS, { now: NOW })).payload.jti;
    expect(typeof a).toBe("string");
    expect(a).not.toBe(b);
  });
});

describe("amoCredentialsFromEnv", () => {
  test("reads AMO_JWT_ISSUER and AMO_JWT_SECRET", () => {
    expect(amoCredentialsFromEnv({ AMO_JWT_ISSUER: CREDS.issuer, AMO_JWT_SECRET: CREDS.secret })).toEqual(CREDS);
  });

  test("names the missing variable, never echoes the other one's value", () => {
    expect(() => amoCredentialsFromEnv({ AMO_JWT_ISSUER: CREDS.issuer })).toThrow("AMO_JWT_SECRET");
    expect(() => amoCredentialsFromEnv({ AMO_JWT_SECRET: CREDS.secret })).toThrow("AMO_JWT_ISSUER");
    let message = "";
    try {
      amoCredentialsFromEnv({ AMO_JWT_SECRET: CREDS.secret, AMO_JWT_ISSUER: "" });
    } catch (e) {
      message = String(e);
    }
    expect(message).toContain("AMO_JWT_ISSUER");
    expect(message).not.toContain(CREDS.secret);
  });
});

describe("compareVersions", () => {
  test.each([
    ["0.1.0", "0.1.0", 0],
    ["0.1.1", "0.1.0", 1],
    ["0.2.0", "0.10.0", -1],
    ["1.0", "1.0.0", 0],
    ["1.0.1", "1.0", 1],
    ["0.9.9", "1.0.0", -1],
  ])("%s vs %s → %d", (a, b, want) => {
    expect(Math.sign(compareVersions(a, b))).toBe(want);
  });

  test("refuses a version that isn't dotted numbers", () => {
    expect(() => compareVersions("1.0beta", "1.0")).toThrow("1.0beta");
  });
});

const API = "https://addons.mozilla.org/api/v5";
const ADDON_URL = `${API}/addons/addon/omega-share%40omega-share.duckdns.org/`;

interface Seen {
  readonly method: string;
  readonly url: string;
  readonly auth: string | null;
  readonly contentType: string | null;
  readonly body: FormData | unknown;
}

/** A fake AMO at the HTTP boundary: answers by `METHOD url`, in order when a route has several answers, and records each request. */
function fakeAmo(routes: Record<string, readonly (() => Response)[]>): { fetch: typeof fetch; seen: Seen[] } {
  const seen: Seen[] = [];
  const left = new Map(Object.entries(routes).map(([k, v]) => [k, [...v]]));
  const fake = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const req = new Request(input, init);
    const type = req.headers.get("content-type");
    const body = req.method === "GET" ? undefined : type?.startsWith("multipart/") ? await req.formData() : JSON.parse(await req.text());
    seen.push({ method: req.method, url: req.url, auth: req.headers.get("authorization"), contentType: type, body });
    const answers = left.get(`${req.method} ${req.url}`);
    const answer = answers && answers.length > 1 ? answers.shift() : answers?.[0];
    if (!answer) throw new Error(`unexpected ${req.method} ${req.url}`);
    return answer();
  };
  return { fetch: fake as typeof fetch, seen };
}

const json = (body: unknown, status = 200): (() => Response) => () => Response.json(body, { status });
const client = (fetchImpl: typeof fetch) => amoClient({ credentials: CREDS, fetch: fetchImpl, now: () => NOW, sleep: () => Promise.resolve() });

const ADDON = { id: 3001, guid: AMO_GUID, slug: "omega-share", status: "nominated", edit_url: "https://addons.mozilla.org/en-US/developers/addon/omega-share/edit", current_version: null };
const V010 = { id: 5001, version: "0.1.0", channel: "listed", is_disabled: false, edit_url: "https://addons.mozilla.org/en-US/developers/addon/omega-share/versions/5001", file: { id: 9001, status: "unreviewed", hash: "sha256:aa" } };
const V001 = { id: 4001, version: "0.0.1", channel: "unlisted", is_disabled: false, edit_url: "https://addons.mozilla.org/en-US/developers/addon/omega-share/versions/4001", file: { id: 8001, status: "public", hash: "sha256:bb" } };

describe("amoClient requests", () => {
  test("addon() GETs the add-on by guid with a JWT the secret verifies", async () => {
    const amo = fakeAmo({ [`GET ${ADDON_URL}`]: [json(ADDON)] });
    const addon = await client(amo.fetch).addon();
    expect(addon.slug).toBe("omega-share");
    expect(addon.status).toBe("nominated");
    const [req] = amo.seen;
    expect(req?.auth).toStartWith("JWT ");
    const { payload, signature, signed } = decode(req?.auth?.slice(4) ?? "");
    expect(payload.iss).toBe(CREDS.issuer);
    expect(signature).toBe(createHmac("sha256", CREDS.secret).update(signed).digest("base64url"));
  });

  test("versions() lists listed and unlisted versions, following next pages on AMO only", async () => {
    const first = `${ADDON_URL}versions/?filter=all_with_unlisted&page_size=50`;
    const second = `${ADDON_URL}versions/?filter=all_with_unlisted&page_size=50&page=2`;
    const amo = fakeAmo({
      [`GET ${first}`]: [json({ count: 2, next: second, previous: null, results: [V010] })],
      [`GET ${second}`]: [json({ count: 2, next: null, previous: first, results: [V001] })],
    });
    const versions = await client(amo.fetch).versions();
    expect(versions.map((v) => v.version)).toEqual(["0.1.0", "0.0.1"]);
    expect(amo.seen.map((s) => s.url)).toEqual([first, second]);
    expect(amo.seen.every((s) => s.auth?.startsWith("JWT ") === true)).toBe(true);
  });

  test("versions() refuses a next link off the AMO API, so the token never leaves for another host", async () => {
    const first = `${ADDON_URL}versions/?filter=all_with_unlisted&page_size=50`;
    const amo = fakeAmo({ [`GET ${first}`]: [json({ count: 2, next: "https://evil.example/api/v5/next", previous: null, results: [V010] })] });
    await expect(client(amo.fetch).versions()).rejects.toThrow("evil.example");
    expect(amo.seen.map((s) => s.url)).toEqual([first]);
  });

  test("upload() posts the zip as a listed upload and polls until AMO has validated it", async () => {
    const pending = { uuid: "u-1", channel: "listed", processed: false, valid: false, submitted: false, validation: null, url: `${API}/addons/upload/u-1/` };
    const amo = fakeAmo({
      [`POST ${API}/addons/upload/`]: [json(pending, 201)],
      [`GET ${API}/addons/upload/u-1/`]: [json(pending), json({ ...pending, processed: true, valid: true, validation: { errors: 0, warnings: 0, messages: [] } })],
    });
    const zip = new Uint8Array([80, 75, 5, 6]);
    expect(await client(amo.fetch).upload(zip, "omega-share-0.1.1-firefox.zip")).toBe("u-1");

    const post = amo.seen[0];
    expect(post?.method).toBe("POST");
    expect(post?.contentType).toStartWith("multipart/form-data");
    const form = post?.body as FormData;
    expect(form.get("channel")).toBe("listed");
    const file = form.get("upload") as File;
    expect(file.name).toBe("omega-share-0.1.1-firefox.zip");
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(zip);
    expect(amo.seen.map((s) => `${s.method} ${s.url}`)).toEqual([`POST ${API}/addons/upload/`, `GET ${API}/addons/upload/u-1/`, `GET ${API}/addons/upload/u-1/`]);
  });

  test("upload() fails with AMO's validation errors when the upload is invalid", async () => {
    const done = {
      uuid: "u-2",
      channel: "listed",
      processed: true,
      valid: false,
      submitted: false,
      validation: { errors: 1, warnings: 0, messages: [{ type: "error", message: "Version 0.1.0 already exists." }] },
      url: `${API}/addons/upload/u-2/`,
    };
    const amo = fakeAmo({ [`POST ${API}/addons/upload/`]: [json(done, 201)], [`GET ${API}/addons/upload/u-2/`]: [json(done)] });
    await expect(client(amo.fetch).upload(new Uint8Array([1]), "x.zip")).rejects.toThrow("Version 0.1.0 already exists.");
  });

  test("upload() gives up after a bounded wait for AMO's validator", async () => {
    const pending = { uuid: "u-3", channel: "listed", processed: false, valid: false, submitted: false, validation: null, url: `${API}/addons/upload/u-3/` };
    const amo = fakeAmo({ [`POST ${API}/addons/upload/`]: [json(pending, 201)], [`GET ${API}/addons/upload/u-3/`]: [json(pending)] });
    await expect(client(amo.fetch).upload(new Uint8Array([1]), "x.zip")).rejects.toThrow("u-3");
  });

  test("createVersion() creates the version from the upload, then attaches the sources zip", async () => {
    const created = { ...V010, id: 5002, version: "0.1.1", edit_url: "https://addons.mozilla.org/en-US/developers/addon/omega-share/versions/5002" };
    const amo = fakeAmo({
      [`POST ${ADDON_URL}versions/`]: [json(created, 201)],
      [`PATCH ${ADDON_URL}versions/5002/`]: [json(created)],
    });
    const sources = new Uint8Array([80, 75, 5, 6, 0]);
    const version = await client(amo.fetch).createVersion("u-1", sources, "omega-share-0.1.1-sources.zip");
    expect(version.version).toBe("0.1.1");
    expect(version.edit_url).toBe("https://addons.mozilla.org/en-US/developers/addon/omega-share/versions/5002");

    const [post, patch] = amo.seen;
    expect(post?.body).toEqual({ upload: "u-1" });
    expect(patch?.method).toBe("PATCH");
    const file = (patch?.body as FormData).get("source") as File;
    expect(file.name).toBe("omega-share-0.1.1-sources.zip");
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(sources);
  });
});

describe("amoClient responses (Valibot at the boundary)", () => {
  test("a response missing a field it relies on fails, naming the field", async () => {
    const amo = fakeAmo({ [`GET ${ADDON_URL}`]: [json({ ...ADDON, status: undefined })] });
    await expect(client(amo.fetch).addon()).rejects.toThrow("status");
  });

  test("a non-2xx answer fails with the status and AMO's message", async () => {
    const amo = fakeAmo({ [`GET ${ADDON_URL}`]: [json({ detail: "Not found." }, 404)] });
    await expect(client(amo.fetch).addon()).rejects.toThrow(/404.*Not found\./);
  });
});

describe("secret redaction", () => {
  test("an error body echoing the secret, the issuer or the token never reaches the message", async () => {
    let token = "";
    const fake = (async (input: RequestInfo | URL, init?: RequestInit) => {
      token = new Request(input, init).headers.get("authorization")?.slice(4) ?? "";
      return Response.json({ detail: `bad key ${CREDS.issuer} / ${CREDS.secret} / ${token}` }, { status: 401 });
    }) as typeof fetch;
    const err = await client(fake)
      .addon()
      .then(() => undefined, (e: unknown) => e);
    const message = String(err instanceof Error ? `${err.message}\n${err.stack ?? ""}` : err);
    expect(message).toContain("401");
    expect(message).toContain("[redacted]");
    for (const leak of [CREDS.secret, CREDS.issuer, token]) expect(message).not.toContain(leak);
  });

  test("a network error carrying the Authorization header is redacted too", async () => {
    const fake = ((input: RequestInfo | URL, init?: RequestInit) =>
      Promise.reject(new Error(`connect failed, headers: ${new Request(input, init).headers.get("authorization") ?? ""}`))) as typeof fetch;
    const err = await client(fake)
      .addon()
      .then(() => undefined, (e: unknown) => e);
    const message = String(err instanceof Error ? err.message : err);
    expect(message).toContain("connect failed");
    expect(message).not.toContain("JWT ey");
    expect(message).not.toContain(CREDS.issuer);
  });
});

describe("statusReport", () => {
  test("shows the listing status and each version's channel, review and file status, newest first", () => {
    const report = statusReport(ADDON, [V001, V010, { ...V010, id: 5003, version: "0.2.0", is_disabled: true, file: { id: 9003, status: "disabled", hash: "sha256:cc" } }]);
    expect(report.split("\n")).toEqual([
      `omega-share (${AMO_GUID})`,
      "listing: nominated (awaiting review)",
      "edit: https://addons.mozilla.org/en-US/developers/addon/omega-share/edit",
      "versions:",
      "  0.2.0  listed    review: disabled           file: disabled    (disabled by the developer)",
      "  0.1.0  listed    review: awaiting review    file: unreviewed",
      "  0.0.1  unlisted  review: approved           file: public",
    ]);
  });

  test("an add-on with no versions says so", () => {
    expect(statusReport({ ...ADDON, status: "incomplete" }, [])).toContain("versions: none");
  });
});

describe("submitProblems", () => {
  const ok = {
    local: "0.1.1",
    amoVersions: ["0.1.0", "0.0.1"],
    dirty: [] as string[],
    hashes: { firefox: { built: "aa", fresh: "aa" }, sources: { built: "bb", fresh: "bb" } },
  };

  test("none for a clean tree, a version bump and zips matching a fresh build", () => {
    expect(submitProblems(ok)).toEqual([]);
  });

  test("refuses a version not greater than the newest on AMO, listed or not", () => {
    expect(submitProblems({ ...ok, local: "0.1.0" }).join("\n")).toContain("0.1.0 is not greater than 0.1.0");
    expect(submitProblems({ ...ok, local: "0.1.1", amoVersions: ["0.1.0", "0.2.0"] }).join("\n")).toContain("0.1.1 is not greater than 0.2.0");
  });

  test("refuses a dirty tree, naming the paths", () => {
    expect(submitProblems({ ...ok, dirty: [" M apps/extension/src/popup.ts", "?? c1.json"] }).join("\n")).toContain("apps/extension/src/popup.ts");
  });

  test("refuses when either zip differs from a fresh build", () => {
    const firefox = submitProblems({ ...ok, hashes: { ...ok.hashes, firefox: { built: "aa", fresh: "cc" } } }).join("\n");
    expect(firefox).toContain("firefox");
    const sources = submitProblems({ ...ok, hashes: { ...ok.hashes, sources: { built: "bb", fresh: "dd" } } }).join("\n");
    expect(sources).toContain("sources");
  });

  test("reports every problem at once", () => {
    expect(submitProblems({ ...ok, local: "0.0.1", dirty: ["?? x"], hashes: { firefox: { built: "a", fresh: "b" }, sources: { built: "c", fresh: "d" } } })).toHaveLength(4);
  });
});
