import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The hosted deploy kit (ADR 0020). These pin the safety properties a later edit must not lose.
const DEPLOY = join(import.meta.dir, "../../../deploy");
const read = (name: string) => readFileSync(join(DEPLOY, name), "utf8");
const BUN_VERSION = readFileSync(join(import.meta.dir, "../../../.bun-version"), "utf8").trim();

/** `Key=value` lines of a systemd unit, last one wins (as systemd reads them). */
const unitKeys = (text: string) => {
  const keys = new Map<string, string[]>();
  for (const line of text.split("\n")) {
    const m = /^([A-Za-z]+)=(.*)$/.exec(line.trim());
    if (m?.[1] !== undefined && m[2] !== undefined) keys.set(m[1], [...(keys.get(m[1]) ?? []), m[2]]);
  }
  return keys;
};

describe("deploy/omega-share.service (D7 hardening)", () => {
  const unit = unitKeys(read("omega-share.service"));
  const env = (unit.get("Environment") ?? []).join(" ");

  test.each([
    ["User", "omega-share"],
    ["NoNewPrivileges", "yes"],
    ["ProtectSystem", "strict"],
    ["ProtectHome", "yes"],
    ["PrivateTmp", "yes"],
    ["PrivateDevices", "yes"],
    ["ReadWritePaths", "/var/lib/omega-share"],
    ["MemoryMax", "512M"],
    ["RestrictAddressFamilies", "AF_INET AF_INET6 AF_UNIX"],
    ["CapabilityBoundingSet", ""],
    ["UMask", "0077"],
  ])("%s=%s", (key, value) => {
    expect(unit.get(key)?.at(-1)).toBe(value);
  });

  test("binds loopback, trusts only the loopback proxy, and keeps the DB outside the release", () => {
    expect(env).toContain("HOST=127.0.0.1");
    expect(env).toContain("PORT=8787");
    expect(env).toContain("TRUST_PROXY=loopback");
    expect(env).toContain("PUBLIC_ORIGIN=https://omega-share.duckdns.org");
    expect(env).toContain("SITE_ORIGIN=https://omega-share.duckdns.org");
    expect(env).toContain("DB_PATH=/var/lib/omega-share/omega.db");
    expect(env).toContain("STATIC_DIR=/opt/omega-share/current/apps/web/dist");
    expect(unit.get("ExecStart")?.at(-1)).toBe("/usr/local/bin/bun /opt/omega-share/current/apps/server/src/index.ts");
  });

  test("carries no secret", () => {
    expect(read("omega-share.service")).not.toMatch(/TOKEN|SECRET|PASSWORD|KEY=/i);
  });
});

describe("deploy/Caddyfile", () => {
  const caddy = read("Caddyfile");

  test("proxies the DuckDNS name to the loopback server", () => {
    expect(caddy).toContain("omega-share.duckdns.org {");
    expect(caddy).toContain("reverse_proxy 127.0.0.1:8787");
    expect(caddy).toContain("encode zstd gzip");
  });

  test("leaves CSP and client IP to the server, and logs no IPs (D3, D6)", () => {
    expect(caddy).not.toMatch(/Content-Security-Policy/i);
    expect(caddy).not.toContain("trusted_proxies");
    expect(caddy).not.toMatch(/^\s*log\b/m);
  });
});

describe("deploy/nftables.conf", () => {
  const nft = read("nftables.conf");

  test("drops by default and opens only 22, 80 and 443", () => {
    expect(nft).toMatch(/type filter hook input priority 0; policy drop;/);
    const ports = [...nft.matchAll(/dport (\{[^}]*\}|\d+)/g)].flatMap((m) => (m[1] ?? "").match(/\d+/g) ?? []);
    expect(new Set(ports)).toEqual(new Set(["22", "80", "443"]));
  });

  test("caps connections per source address", () => {
    expect(nft).toMatch(/ct count over \d+/);
  });
});

describe("deploy/omega-share-backup.*", () => {
  test("snapshots with VACUUM INTO as the service user, nightly", () => {
    const svc = read("omega-share-backup.service");
    expect(read("backup.sh")).toMatch(/sqlite3 "\$db" "VACUUM INTO/);
    expect(unitKeys(svc).get("ExecStart")?.at(-1)).toBe("/usr/local/lib/omega-share/backup.sh");
    expect(unitKeys(svc).get("User")?.at(-1)).toBe("omega-share");
    expect(read("omega-share-backup.timer")).toMatch(/OnCalendar=.*\d\d:\d\d/);
  });
});

describe("deploy/deploy.sh", () => {
  const SCRIPT = join(DEPLOY, "deploy.sh");
  const withFakeBun = (version: string, fn: (path: string) => void) => {
    const dir = mkdtempSync(join(tmpdir(), "omega-deploy-"));
    writeFileSync(join(dir, "bun"), `#!/usr/bin/env bash\n[[ "$1" == --version ]] && { echo ${version}; exit 0; }\nexit 0\n`);
    chmodSync(join(dir, "bun"), 0o755);
    try {
      fn(`${dir}:${process.env["PATH"] ?? ""}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
  const run = (path: string, env: Record<string, string>, ...args: string[]) => {
    const r = Bun.spawnSync(["bash", SCRIPT, ...args], { env: { PATH: path, HOME: process.env["HOME"] ?? "", ...env }, stdout: "pipe", stderr: "pipe" });
    return { code: r.exitCode, out: r.stdout.toString() + r.stderr.toString() };
  };

  test("refuses to run without DEPLOY_HOST", () => {
    withFakeBun(BUN_VERSION, (path) => {
      expect(run(path, {}, "--dry-run").code).toBe(2);
    });
  });

  test("refuses a local Bun that differs from .bun-version", () => {
    withFakeBun("0.0.1", (path) => {
      const r = run(path, { DEPLOY_HOST: "deploy@203.0.113.7" }, "--dry-run");
      expect(r.code).toBe(1);
      expect(r.out).toContain(".bun-version");
    });
  });

  test("a dry run builds locally, ships a release by commit and flips current", () => {
    withFakeBun(BUN_VERSION, (path) => {
      const r = run(path, { DEPLOY_HOST: "deploy@203.0.113.7" }, "--dry-run");
      expect(r.code).toBe(0);
      expect(r.out).toContain("bun run --filter @omega/web build");
      expect(r.out).toMatch(/rsync .* deploy@203\.0\.113\.7:\/opt\/omega-share\/releases\/[0-9a-f]{40}\//);
      expect(r.out).toContain("ln -sfn /opt/omega-share/releases/");
      expect(r.out).toContain("systemctl restart omega-share");
      expect(r.out).not.toMatch(/ssh [^\n]*\b(bun install|vite|build)\b/);
    });
  });

  test("an unknown flag exits 2", () => {
    withFakeBun(BUN_VERSION, (path) => {
      expect(run(path, { DEPLOY_HOST: "deploy@203.0.113.7" }, "--dryrun").code).toBe(2);
    });
  });
});
