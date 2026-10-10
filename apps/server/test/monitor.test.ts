import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The off-box monitor (OME-765, docs/ops/hosting.md § Monitoring). It runs on the operator's machine from a user
// timer every 5 min. These drive the real script with fake curl, openssl and ssh on PATH and pin its state machine:
// down/up debounce, one push per state change, the TLS expiry alarm, and the hourly report count.
const DEPLOY = join(import.meta.dir, "../../../deploy/monitor");
const MONITOR = join(DEPLOY, "monitor.sh");
const TOPIC = "omega-test-topic-Zq81x";
const ORIGIN = "https://box.example.test";
const T0 = 1_791_000_000; // a fixed "now" (epoch seconds); each run passes its own
const DAY = 86_400;

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const script = (path: string, body: string) => {
  writeFileSync(path, `#!/usr/bin/env bash\n${body}\n`);
  chmodSync(path, 0o755);
};

/** A sandbox: HOME with the topic file, an XDG state dir, and fakes that read their answers from `fx/`. */
const sandbox = () => {
  const root = mkdtempSync(join(tmpdir(), "omega-monitor-"));
  dirs.push(root);
  const bin = join(root, "bin");
  const fx = join(root, "fx");
  for (const d of [bin, fx, join(root, "home/.config/omega-share"), join(root, "state")]) mkdirSync(d, { recursive: true });
  writeFileSync(join(root, "home/.config/omega-share/ntfy-topic"), `${TOPIC}\n`);
  writeFileSync(join(fx, "health"), "ok");
  writeFileSync(join(fx, "reports.txt"), "no open reports\n");
  // curl: a push reads its URL from a `-K -` config on stdin and logs Title + body; anything else is the health fetch.
  script(
    join(bin, "curl"),
    `fx=${fx}; data=""; cfg=0; url=""
while (( $# )); do case $1 in
  --data-raw|-d) data=$2; shift ;;
  -K) [[ $2 == - ]] && cfg=1; shift ;;
  -H|-o|--max-time|-m|-w) shift ;;
  -*) ;;
  *) url=$1 ;;
esac; shift; done
if (( cfg )); then
  conf=$(cat); printf '%s\\n' "$conf" >> "$fx/push-config.log"
  [[ -e $fx/push-fails ]] && exit 7
  printf '%s\\n' "$data" >> "$fx/pushes.log"; exit 0
fi
printf '%s\\n' "$url" >> "$fx/health-urls.log"
[[ $(cat "$fx/health") == ok ]] && { printf ok; exit 0; }
exit 22`,
  );
  script(
    join(bin, "openssl"),
    `fx=${fx}
case $1 in
  s_client) printf '%s\\n' "$*" >> "$fx/openssl.log"; cat >/dev/null; [[ -e $fx/notafter ]] && echo CERT; exit 0 ;;
  x509) cat >/dev/null; [[ -e $fx/notafter ]] || exit 1; echo "notAfter=$(cat "$fx/notafter")" ;;
esac`,
  );
  // ssh: logs its argv and runs the remote command locally, so the remote count pipeline is the real one.
  script(join(bin, "ssh"), `fx=${fx}; printf '%s\\n' "$*" >> "$fx/ssh.log"; [[ -e $fx/ssh-fails ]] && exit 255; exec sh -c "\${@: -1}"`);

  const run = (now: number, env: Record<string, string> = {}) => {
    const p = Bun.spawnSync(["bash", MONITOR], {
      env: {
        PATH: `${bin}:/usr/bin:/bin`,
        HOME: join(root, "home"),
        XDG_STATE_HOME: join(root, "state"),
        PUBLIC_ORIGIN: ORIGIN,
        SERVER_IP: "192.0.2.10",
        OMEGA_MONITOR_NOW: String(now),
        OMEGA_MONITOR_REPORTS_CMD: `cat ${join(fx, "reports.txt")}`,
        ...env,
      },
    });
    const out = p.stdout.toString() + p.stderr.toString();
    return { code: p.exitCode, out };
  };
  const lines = (name: string) => (existsSync(join(fx, name)) ? readFileSync(join(fx, name), "utf8").split("\n").filter(Boolean) : []);
  const set = (name: string, value: string) => writeFileSync(join(fx, name), value);
  const unset = (name: string) => rmSync(join(fx, name), { force: true });
  const reports = (perRoom: number[]) =>
    set(
      "reports.txt",
      perRoom.length === 0
        ? "no open reports\n"
        : perRoom
            .map(
              (n, i) =>
                `room-${String(i)}\tTitle\tpublic\tmembers 0\t${String(n)} open\tspam ${String(n)}\n` +
                Array.from({ length: n }, (_, j) => `  2026-10-10T00:00:0${String(j)}Z\tspam\tid${String(j)}\tnote: -\ttitle then: -\tplaying: -\n`).join(""),
            )
            .join(""),
    );
  const certIn = (now: number, days: number) => set("notafter", new Date((now + days * DAY + 3600) * 1000).toUTCString().replace(/^\w+, (\d+) (\w+) (\d+) (.*) GMT$/, "$2 $1 $4 $3 GMT"));
  return { root, run, lines, set, unset, reports, certIn };
};

const healthOnly = { OMEGA_MONITOR_CHECKS: "health" };

describe("deploy/monitor/monitor.sh: health debounce", () => {
  test("one failure does not push; the second in a row pushes 'down' once; more failures stay quiet", () => {
    const s = sandbox();
    s.set("health", "fail");
    expect(s.run(T0, healthOnly).code).toBe(0);
    expect(s.lines("pushes.log")).toEqual([]);
    expect(s.run(T0 + 300, healthOnly).code).toBe(0);
    expect(s.lines("pushes.log")).toEqual(["omega-share is down"]);
    s.run(T0 + 600, healthOnly);
    s.run(T0 + 900, healthOnly);
    expect(s.lines("pushes.log")).toEqual(["omega-share is down"]);
    expect(s.lines("health-urls.log").at(-1)).toBe(`${ORIGIN}/healthz`);
  });

  test("recovery pushes 'recovered' once, and a lone failure in between resets the count", () => {
    const s = sandbox();
    s.set("health", "fail");
    s.run(T0, healthOnly);
    s.set("health", "ok");
    s.run(T0 + 300, healthOnly);
    s.set("health", "fail");
    s.run(T0 + 600, healthOnly);
    expect(s.lines("pushes.log")).toEqual([]); // fail, ok, fail: never two in a row
    s.run(T0 + 900, healthOnly);
    s.set("health", "ok");
    s.run(T0 + 1200, healthOnly);
    s.run(T0 + 1500, healthOnly);
    expect(s.lines("pushes.log")).toEqual(["omega-share is down", "omega-share recovered"]);
  });

  test("a failed push is retried on the next run, and the run exits non-zero", () => {
    const s = sandbox();
    s.set("health", "fail");
    s.run(T0, healthOnly);
    s.set("push-fails", "");
    expect(s.run(T0 + 300, healthOnly).code).not.toBe(0);
    s.unset("push-fails");
    s.run(T0 + 600, healthOnly);
    s.run(T0 + 900, healthOnly);
    expect(s.lines("pushes.log")).toEqual(["omega-share is down"]);
  });

  test("the state file sits under $XDG_STATE_HOME/omega-share", () => {
    const s = sandbox();
    s.run(T0, healthOnly);
    expect(existsSync(join(s.root, "state/omega-share/monitor.state"))).toBe(true);
  });

  test("OMEGA_MONITOR_URL and OMEGA_MONITOR_PREFIX drive a drill against a bad URL", () => {
    const s = sandbox();
    s.set("health", "fail");
    const drill = { ...healthOnly, OMEGA_MONITOR_URL: "https://bad.invalid/healthz", OMEGA_MONITOR_PREFIX: "[drill]" };
    s.run(T0, drill);
    s.run(T0 + 300, drill);
    expect(s.lines("pushes.log")).toEqual(["[drill] omega-share is down"]);
    expect(s.lines("health-urls.log")).toEqual(["https://bad.invalid/healthz", "https://bad.invalid/healthz"]);
  });
});

describe("deploy/monitor/monitor.sh: the ntfy topic", () => {
  test("is read from ~/.config/omega-share/ntfy-topic, sent only on stdin, and never printed", () => {
    const s = sandbox();
    s.set("health", "fail");
    const a = s.run(T0, healthOnly);
    const b = s.run(T0 + 300, healthOnly);
    expect(s.lines("push-config.log").join("\n")).toContain(`https://ntfy.sh/${TOPIC}`);
    expect(a.out + b.out).not.toContain(TOPIC);
  });

  test("a missing topic file exits 2 without pushing", () => {
    const s = sandbox();
    rmSync(join(s.root, "home/.config/omega-share/ntfy-topic"));
    expect(s.run(T0, healthOnly).code).toBe(2);
    expect(s.lines("pushes.log")).toEqual([]);
  });

  test("a malformed topic is refused and not echoed", () => {
    const s = sandbox();
    writeFileSync(join(s.root, "home/.config/omega-share/ntfy-topic"), "bad topic/../x\n");
    const r = s.run(T0, healthOnly);
    expect(r.code).toBe(2);
    expect(r.out).not.toContain("bad topic");
  });
});

describe("deploy/monitor/monitor.sh: TLS expiry", () => {
  const tlsOnly = { OMEGA_MONITOR_CHECKS: "tls" };

  test("quiet with 14 days or more left; checks the origin's host", () => {
    const s = sandbox();
    s.certIn(T0, 30);
    s.run(T0, tlsOnly);
    s.certIn(T0, 14);
    s.run(T0, tlsOnly);
    expect(s.lines("pushes.log")).toEqual([]);
    expect(s.lines("openssl.log")[0]).toContain("box.example.test:443");
  });

  test("pushes once under 14 days, again only after 3 more days without renewal", () => {
    const s = sandbox();
    s.certIn(T0, 13);
    s.run(T0, tlsOnly);
    s.run(T0 + 300, tlsOnly);
    s.run(T0 + 2 * DAY, tlsOnly);
    expect(s.lines("pushes.log")).toEqual(["TLS certificate expires in 13 days"]);
    s.run(T0 + 3 * DAY, tlsOnly);
    s.run(T0 + 4 * DAY, tlsOnly);
    expect(s.lines("pushes.log")).toEqual(["TLS certificate expires in 13 days", "TLS certificate expires in 10 days"]);
  });

  test("a renewal re-arms the alarm", () => {
    const s = sandbox();
    s.certIn(T0, 10);
    s.run(T0, tlsOnly);
    s.certIn(T0, 90);
    s.run(T0 + 300, tlsOnly);
    s.certIn(T0, 12);
    s.run(T0 + 600, tlsOnly);
    expect(s.lines("pushes.log")).toEqual(["TLS certificate expires in 10 days", "TLS certificate expires in 12 days"]);
  });

  test("an unreadable certificate pushes nothing (the health check owns 'down')", () => {
    const s = sandbox();
    s.run(T0, tlsOnly);
    expect(s.lines("pushes.log")).toEqual([]);
  });
});

describe("deploy/monitor/monitor.sh: new abuse reports", () => {
  const reportsOnly = { OMEGA_MONITOR_CHECKS: "reports" };

  test("pushes 'N new abuse reports' only when the count rose; flat or falling stays quiet", () => {
    const s = sandbox();
    s.reports([]);
    s.run(T0, reportsOnly);
    expect(s.lines("pushes.log")).toEqual([]);
    s.reports([2, 1]);
    s.run(T0 + 3600, reportsOnly);
    expect(s.lines("pushes.log")).toEqual(["3 new abuse reports"]);
    s.run(T0 + 7200, reportsOnly); // flat
    s.reports([1]);
    s.run(T0 + 10_800, reportsOnly); // fell: dismissed
    s.reports([1, 1]);
    s.run(T0 + 14_400, reportsOnly);
    expect(s.lines("pushes.log")).toEqual(["3 new abuse reports", "1 new abuse report"]);
  });

  test("asks the box at most hourly", () => {
    const s = sandbox();
    s.run(T0, reportsOnly);
    s.reports([4]);
    s.run(T0 + 300, reportsOnly);
    s.run(T0 + 3599, reportsOnly);
    expect(s.lines("ssh.log").length).toBe(1);
    expect(s.lines("pushes.log")).toEqual([]);
    s.run(T0 + 3600, reportsOnly);
    expect(s.lines("ssh.log").length).toBe(2);
    expect(s.lines("pushes.log")).toEqual(["4 new abuse reports"]);
  });

  test("goes to admin@SERVER_IP with only the admin key, in batch mode", () => {
    const s = sandbox();
    s.run(T0, reportsOnly);
    const argv = s.lines("ssh.log")[0] ?? "";
    expect(argv).toContain("BatchMode=yes");
    expect(argv).toContain("IdentitiesOnly=yes");
    expect(argv).toContain(".config/omega-share/admin-key");
    expect(argv).toContain("admin@192.0.2.10");
  });

  test("the default remote command counts on the box with the admin CLI's reports list", () => {
    const s = sandbox();
    s.set("ssh-fails", "");
    s.run(T0, { OMEGA_MONITOR_CHECKS: "reports", OMEGA_MONITOR_REPORTS_CMD: "" });
    const argv = s.lines("ssh.log")[0] ?? "";
    expect(argv).toContain("apps/server/src/cli.ts reports list");
    expect(argv).toMatch(/sudo -n -u omega-share /); // -n: never wait for a password in batch mode
  });

  test("an ssh failure keeps the last count and pushes nothing", () => {
    const s = sandbox();
    s.reports([1]);
    s.run(T0, reportsOnly);
    s.set("ssh-fails", "");
    s.run(T0 + 3600, reportsOnly);
    s.unset("ssh-fails");
    s.reports([1]);
    s.run(T0 + 7200, reportsOnly);
    expect(s.lines("pushes.log")).toEqual(["1 new abuse report"]);
  });

  test("no report content, title, id or address reaches a push", () => {
    const s = sandbox();
    s.reports([2]);
    s.run(T0, reportsOnly);
    const pushed = s.lines("pushes.log").join("\n") + s.lines("push-config.log").join("\n");
    for (const leak of ["room-0", "Title", "spam", "id0", "192.0.2.10"]) expect(pushed).not.toContain(leak);
  });
});

describe("deploy/monitor user units", () => {
  const read = (name: string) => readFileSync(join(DEPLOY, name), "utf8");

  test("the timer fires every 5 minutes", () => {
    expect(read("omega-share-monitor.timer")).toMatch(/^OnCalendar=\*:0\/5$/m);
  });

  test("the service is a user oneshot that needs no root and carries no topic", () => {
    const unit = read("omega-share-monitor.service");
    expect(unit).toMatch(/^Type=oneshot$/m);
    expect(unit).not.toMatch(/^User=/m);
    expect(unit).not.toMatch(/sudo/);
    expect(unit).not.toContain("ntfy.sh/");
    expect(unit).toMatch(/^ExecStart=.*monitor\.sh$/m);
  });
});
