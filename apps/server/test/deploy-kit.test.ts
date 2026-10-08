import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
    // No access log: the site block has no `log` directive.
    const site = caddy.slice(caddy.indexOf("omega-share.duckdns.org {"));
    expect(site).not.toMatch(/^\s*log\b/m);
  });

  test("the default logger drops request IPs and headers, so a 502 error entry carries neither (OME-386)", () => {
    // Global options: the first top-level block. `http.log.error` and every other logger go through `log default`.
    const global = /^\{\n([\s\S]*?)^\}$/m.exec(caddy)?.[1] ?? "";
    const logBlock = /^\tlog default \{\n([\s\S]*?)^\t\}$/m.exec(global)?.[1] ?? "";
    const filter = /format filter \{\n([\s\S]*?)^\t\t\}$/m.exec(logBlock)?.[1] ?? "";
    const deleted = new Set([...filter.matchAll(/^\s*(\S+) delete$/gm)].map((m) => m[1]));
    for (const field of ["request>remote_ip", "request>remote_port", "request>client_ip", "request>headers", "remote"]) {
      expect(deleted).toContain(field);
    }
    expect(filter).toMatch(/^\s*wrap json$/m);
    expect(logBlock).toMatch(/^\s*output stderr$/m);
  });
});

describe("deploy/journald", () => {
  test("provision bounds the persistent journal to 14 days with a drop-in: sshd logs peer IPs (OME-386)", () => {
    const conf = unitKeys(read("journald/omega-share.conf"));
    expect(conf.get("MaxRetentionSec")).toEqual(["14day"]);
    const p = read("provision.sh");
    expect(p).toContain("install -d -m 0755 /etc/systemd/journald.conf.d");
    expect(p).toContain('install -m 0644 "$here/journald/omega-share.conf" /etc/systemd/journald.conf.d/');
    expect(p).toMatch(/systemctl restart systemd-journald/);
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

describe("nightly backup wiring (OME-358 engine, OME-363)", () => {
  const provision = () => read("provision.sh");

  test("the kit ships one backup: deploy/backup/**, no second snapshot script or pull", () => {
    for (const gone of ["backup.sh", "omega-share-backup.service", "omega-share-backup.timer", "pull-backups.sh"]) {
      expect(existsSync(join(DEPLOY, gone)), gone).toBe(false);
      expect(provision()).not.toContain(`"$here/${gone}"`);
    }
  });

  test("provision makes a 0700 service-user backup dir and enables the timer from deploy/backup", () => {
    expect(provision()).toContain("install -d -m 0700 -o omega-share -g omega-share /var/backups/omega-share");
    expect(provision()).toContain('install -m 0644 "$here/backup/omega-share-backup.service" "$here/backup/omega-share-backup.timer" /etc/systemd/system/');
    expect(provision()).toMatch(/systemctl enable --now omega-share-backup\.timer/);
  });

  test("provision checks the pull sudoers rule with visudo -cf before installing it 0440", () => {
    const p = provision();
    const check = p.indexOf('visudo -cf "$here/backup/sudoers.omega-backup"');
    const put = p.indexOf('install -m 0440 "$here/backup/sudoers.omega-backup" /etc/sudoers.d/omega-backup');
    expect(check).toBeGreaterThan(-1);
    expect(put).toBeGreaterThan(check);
    const rules = read("backup/sudoers.omega-backup").split("\n").filter((l) => l.trim() !== "" && !l.startsWith("#"));
    expect(rules).toEqual(["deploy ALL=(omega-share) NOPASSWD: /usr/bin/rsync --server --sender *"]);
  });

  test("the snapshot unit uses the server unit's user, DB, env file, Bun and checkout, and waits for the DB", () => {
    const server = unitKeys(read("omega-share.service"));
    const backup = unitKeys(read("backup/omega-share-backup.service"));
    expect(backup.get("User")?.at(-1)).toBe(server.get("User")?.at(-1));
    const dbPath = (keys: Map<string, string[]>) => keys.get("Environment")?.find((e) => e.startsWith("DB_PATH="));
    expect(dbPath(backup)).toBe(dbPath(server));
    expect(server.get("EnvironmentFile")?.at(-1)).toBe("-/etc/omega-share/env");
    expect(backup.get("EnvironmentFile")?.at(-1)).toBe("-/etc/omega-share/env");
    const [bun, entry] = (server.get("ExecStart")?.at(-1) ?? "").split(" ");
    const app = entry?.replace(/\/apps\/server\/src\/index\.ts$/, "");
    expect(backup.get("ExecStart")?.at(-1)).toBe(`${bun ?? ""} ${app ?? ""}/apps/server/scripts/backup.ts snapshot`);
    expect(backup.get("ConditionPathExists")?.at(-1)).toBe("/var/lib/omega-share/omega.db");
  });

  test("a re-run clears a migrated dir's setgid bit and restarts the timer onto the new schedule (OME-382)", () => {
    const p = provision();
    expect(p).toContain("chmod g-s /var/backups/omega-share");
    expect(p.indexOf("systemctl restart omega-share-backup.timer")).toBeGreaterThan(p.indexOf("systemctl enable --now omega-share-backup.timer"));
  });

  test("the unit's hard-coded DB paths match its default and an env-file override is documented as needing a drop-in (OME-382)", () => {
    const text = read("backup/omega-share-backup.service");
    const backup = unitKeys(text);
    const db = backup.get("Environment")?.find((e) => e.startsWith("DB_PATH="))?.slice("DB_PATH=".length) ?? "";
    expect(backup.get("ConditionPathExists")?.at(-1)).toBe(db);
    expect(backup.get("ReadWritePaths")).toContain(db.replace(/\/[^/]+$/, ""));
    expect(text).not.toMatch(/\bwins\b/);
    expect(text).toMatch(/drop-in/);
    // The release ships apps/server only, so a docs/ path under current/ would dangle.
    expect(backup.get("Documentation")?.at(-1)).toMatch(/^https:\/\//);
  });

  test("docs claim no more for the sudoers rule than deploy already has, and restore runs from the box's kit copy (OME-382)", () => {
    const docs = (name: string) => readFileSync(join(DEPLOY, "../docs", name), "utf8");
    const sudoers = read("backup/sudoers.omega-backup");
    for (const [name, text] of [["sudoers", sudoers], ["hosting.md", docs("ops/hosting.md")], ["backup.md", docs("ops/backup.md")]] as const) {
      expect(text, name).not.toMatch(/read-only rsync|sender only reads|sender side cannot write/);
    }
    expect(sudoers).toMatch(/no more than deploy already has/);
    expect(docs("ops/hosting.md")).toContain("bash omega-deploy/backup/restore.sh");
    expect(docs("ops/hosting.md")).not.toContain("bash deploy/backup/restore.sh");
  });

  test("a release carries apps/server, so the snapshot script ships with every deploy", () => {
    expect(read("deploy.sh")).toMatch(/archive "\$rel" [^\n]*apps\/server /);
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
      expect(r.out).toMatch(/flip \/opt\/omega-share\/releases\/[0-9a-f]{40}\n/);
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

describe("review hardening (OME-356)", () => {
  test("Caddy's admin API is off: the app sandbox can reach loopback TCP", () => {
    expect(read("Caddyfile")).toMatch(/^\s*admin off\s*$/m);
  });

  test("every dynamic nftables set expires and is bounded; IPv6 SSH is metered per /64", () => {
    const nft = read("nftables.conf");
    const sets = [...nft.matchAll(/set (\w+) \{([^}]*)\}/g)];
    expect(sets.length).toBeGreaterThanOrEqual(4);
    for (const [, name, body] of sets) {
      expect(body).toMatch(/size \d+;/);
      // A ct count set frees an entry when its last connection closes (and the kernel refuses a timeout on it).
      const connCount = new RegExp(`@${name ?? ""} \\{[^}]*ct count`).test(nft);
      if (!connCount) expect(body).toMatch(/timeout \d+m;/);
    }
    expect(nft).toMatch(/add @ssh_meter6 \{ ip6 saddr and ffff:ffff:ffff:ffff:: limit rate/);
  });

  test("the server unit tolerates a burst of restarts", () => {
    const unit = unitKeys(read("omega-share.service"));
    expect(unit.get("StartLimitIntervalSec")?.at(-1)).toBe("60");
    expect(unit.get("StartLimitBurst")?.at(-1)).toBe("10");
  });

  test("Bun is checked against a hash committed in the repo, not one fetched beside the binary", () => {
    expect(readFileSync(join(DEPLOY, "bun-linux-aarch64.sha256"), "utf8")).toMatch(/^[0-9a-f]{64} {2}bun\.zip\n$/);
    expect(read("provision.sh")).not.toContain("SHASUMS256.txt");
  });

  test("a failed health check puts the previous release back", () => {
    const script = read("deploy.sh");
    expect(script).toMatch(/prev=\\"\\\$\(readlink -f/);
    expect(script).toContain("rolled back to");
  });

  test("the site is built from the archived commit, not the working tree", () => {
    expect(read("deploy.sh")).not.toContain("cd $root && bun run --filter @omega/web build");
  });
});
