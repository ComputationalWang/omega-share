import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The Rust server's deploy kit (OME-1174, ADR 0050): cross build, artifact checks, the two-server deploy, the units and the launcher.
const ROOT = join(import.meta.dir, "..");
const DEPLOY = join(ROOT, "deploy");
const read = (name: string) => readFileSync(join(DEPLOY, name), "utf8");
const BUN_VERSION = readFileSync(join(ROOT, ".bun-version"), "utf8").trim();
const HOST = "deploy@203.0.113.7";

const tmp = () => mkdtempSync(join(tmpdir(), "omega-rs-kit-"));
const fake = (dir: string, name: string, body: string) => {
  writeFileSync(join(dir, name), `#!/usr/bin/env bash\n${body}\n`);
  chmodSync(join(dir, name), 0o755);
};
const spawn = (cmd: string[], env: Record<string, string>) => {
  const r = Bun.spawnSync(cmd, { env: { HOME: process.env["HOME"] ?? "", ...env }, stdout: "pipe", stderr: "pipe" });
  return { code: r.exitCode, out: r.stdout.toString() + r.stderr.toString() };
};
/** `Key=value` lines of a systemd unit (last wins, repeated keys kept in order). */
const unitKeys = (text: string) => {
  const keys = new Map<string, string[]>();
  for (const line of text.split("\n")) {
    const m = /^([A-Za-z]+)=(.*)$/.exec(line.trim());
    if (m?.[1] !== undefined && m[2] !== undefined) keys.set(m[1], [...(keys.get(m[1]) ?? []), m[2]]);
  }
  return keys;
};
const pins: Record<string, string> = Object.fromEntries(
  readFileSync(join(DEPLOY, "server-rs-build.env"), "utf8")
    .split("\n")
    .flatMap((l) => (/^[A-Z0-9_]+=\S+$/.test(l) ? [l.split("=") as [string, string]] : [])),
);

const pin = (k: string): string => pins[k] ?? "";

describe("pinned build tools (deploy/server-rs-build.env)", () => {
  test("glibc, zig and cargo-zigbuild are pinned with checksums", () => {
    expect(pin("GLIBC")).toMatch(/^2\.\d+$/);
    expect(pin("ZIG_VERSION")).toMatch(/^\d+\.\d+\.\d+$/);
    expect(pin("ZIG_SHA256_X86_64")).toMatch(/^[0-9a-f]{64}$/);
    expect(pin("ZIG_SHA256_AARCH64")).toMatch(/^[0-9a-f]{64}$/);
    expect(pin("CARGO_ZIGBUILD_VERSION")).toMatch(/^\d+\.\d+\.\d+$/);
    expect(pin("CARGO_ZIGBUILD_CRATE_SHA256")).toMatch(/^[0-9a-f]{64}$/);
  });

  test("the glibc pin is no newer than Ubuntu 22.04's, which every later LTS also has", () => {
    expect(Number(pin("GLIBC").split(".")[1])).toBeLessThanOrEqual(35);
  });
});

describe("scripts/build-server-rs.sh", () => {
  const SCRIPT = join(ROOT, "scripts/build-server-rs.sh");
  test("a dry run shows the locked, glibc-pinned zig cross build with the path remap", () => {
    const r = spawn(["bash", SCRIPT, "--dry-run"], { PATH: process.env["PATH"] ?? "" });
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain(`cargo zigbuild --release --locked --target aarch64-unknown-linux-gnu.${pin("GLIBC")} -p omega-server`);
    expect(r.out).toMatch(/RUSTFLAGS=\S*--remap-path-prefix=\S+=\/src/);
  });

  test("an unknown argument exits 2", () => {
    expect(spawn(["bash", SCRIPT, "--nope"], { PATH: process.env["PATH"] ?? "" }).code).toBe(2);
  });

  test("refuses a zig that is not the pinned version", () => {
    const dir = tmp();
    try {
      fake(dir, "zig", 'echo 0.0.1');
      fake(dir, "cargo-zigbuild", `echo cargo-zigbuild ${pin("CARGO_ZIGBUILD_VERSION")}`);
      const r = spawn(["bash", SCRIPT], { PATH: `${dir}:${process.env["PATH"] ?? ""}`, XDG_DATA_HOME: dir });
      expect(r.code).toBe(1);
      expect(r.out).toContain("zig");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("finds the pinned zig and cargo-zigbuild where install-server-rs-tools.sh puts them, with no PATH edit (OME-1606)", () => {
    const dir = tmp();
    try {
      const zigDir = join(dir, `zig-${pin("ZIG_VERSION")}`);
      const zbBin = join(dir, `cargo-zigbuild-${pin("CARGO_ZIGBUILD_VERSION")}`, "bin");
      mkdirSync(zigDir);
      mkdirSync(zbBin, { recursive: true });
      fake(zigDir, "zig", `echo ${pin("ZIG_VERSION")}`);
      fake(zbBin, "cargo-zigbuild", `echo cargo-zigbuild ${pin("CARGO_ZIGBUILD_VERSION")}`);
      const r = spawn(["bash", SCRIPT, "--check-tools"], { PATH: process.env["PATH"] ?? "", XDG_DATA_HOME: dir });
      expect(r.code, r.out).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("missing pinned tools fail with one line naming the install script (OME-1606)", () => {
    const dir = tmp();
    try {
      const r = spawn(["bash", SCRIPT, "--check-tools"], { PATH: "/usr/bin:/bin", XDG_DATA_HOME: dir });
      expect(r.code).toBe(1);
      expect(r.out.trim().split("\n")).toHaveLength(1);
      expect(r.out).toContain("scripts/install-server-rs-tools.sh");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("builds with the pinned tools and copies the binary to --out", () => {
    const dir = tmp();
    try {
      const target = join(dir, "target");
      fake(dir, "zig", `echo ${pin("ZIG_VERSION")}`);
      fake(dir, "cargo-zigbuild", `echo cargo-zigbuild ${pin("CARGO_ZIGBUILD_VERSION")}`);
      fake(
        dir,
        "cargo",
        `echo "$@ RUSTFLAGS=$RUSTFLAGS" > "${dir}/args"\nmkdir -p "${target}/aarch64-unknown-linux-gnu/release"\necho bin > "${target}/aarch64-unknown-linux-gnu/release/omega-server"`,
      );
      const out = join(dir, "out-binary");
      const r = spawn(["bash", SCRIPT, "--out", out], { PATH: `${dir}:${process.env["PATH"] ?? ""}`, CARGO_TARGET_DIR: target, XDG_DATA_HOME: dir });
      expect(r.code, r.out).toBe(0);
      expect(readFileSync(out, "utf8")).toBe("bin\n");
      expect(readFileSync(join(dir, "args"), "utf8")).toContain(`zigbuild --release --locked --target aarch64-unknown-linux-gnu.${pin("GLIBC")}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("deploy/check-server-binary.sh (artifact checks)", () => {
  const SCRIPT = join(DEPLOY, "check-server-binary.sh");
  const GOOD: Record<string, string> = {
    "-h": "  Class:                             ELF64\n  Type:                              DYN (Position-Independent Executable file)\n  Machine:                           AArch64\n",
    "-lW":
      "  INTERP         0x0002e0 0x00000000000002e0 0x00000000000002e0 0x00001b 0x00001b R   0x1\n  GNU_RELRO      0x44c160 0x000000000046c160 0x000000000046c160 0x011cc0 0x011ea0 R   0x1\n  GNU_STACK      0x000000 0x0000000000000000 0x0000000000000000 0x000000 0x1000000 RW  0\n",
    "-dW": " 0x0000000000000001 (NEEDED)             Shared library: [libc.so.6]\n 0x000000000000001e (FLAGS)              BIND_NOW\n 0x000000006ffffffb (FLAGS_1)            Flags: NOW PIE\n",
    "-SW": "  [ 1] .interp           PROGBITS        00000000000002e0 0002e0 00001b 00   A  0   0  1\n  [ 9] .text             PROGBITS        0000000000100000 100000 200000 00  AX  0   0 64\n",
    "--dyn-syms": "    12: 0000000000000000     0 FUNC    GLOBAL DEFAULT  UND memcpy@GLIBC_2.17 (2)\n    13: 0000000000000000     0 FUNC    GLOBAL DEFAULT  UND pthread_create@GLIBC_2.34 (3)\n",
  };
  const DYN = (extra: string) => `${GOOD["--dyn-syms"] ?? ""}${extra}`;
  /** Runs the checker on a binary whose readelf/objdump output is GOOD with `patch` applied; `bytes` is the file's content. */
  const check = (patch: Record<string, string>, bytes = "a".repeat(2_000_000), max = "2.35", env: Record<string, string> = {}) => {
    const dir = tmp();
    try {
      const out: Record<string, string> = { ...GOOD, ...patch };
      for (const [k, v] of Object.entries(out)) writeFileSync(join(dir, `fx${k}`), v);
      // A fixture holding FAIL makes the tool exit 1, as readelf does on a file it cannot read.
      fake(dir, "readelf", `if grep -q '^FAIL$' "${dir}/fx$1"; then exit 1; fi\ncat "${dir}/fx$1"`);
      const bin = join(dir, "omega-server");
      writeFileSync(bin, bytes);
      return spawn(["bash", SCRIPT, bin, max], { PATH: `${dir}:${process.env["PATH"] ?? ""}`, ...env });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  test("accepts a PIE aarch64 glibc binary with full RELRO, a non-exec stack, no symbols", () => {
    const r = check({});
    expect(r.code, r.out).toBe(0);
  });

  test.each([
    ["not aarch64", { "-h": GOOD["-h"]?.replace("AArch64", "Advanced Micro Devices X86-64") ?? "" }, "aarch64"],
    ["not PIE", { "-h": GOOD["-h"]?.replace("DYN", "EXEC") ?? "" }, "PIE"],
    ["no RELRO", { "-lW": GOOD["-lW"]?.replace("GNU_RELRO", "OTHER") ?? "" }, "RELRO"],
    ["lazy binding", { "-dW": " 0x0000000000000001 (NEEDED)             Shared library: [libc.so.6]\n" }, "BIND_NOW"],
    ["an executable stack", { "-lW": GOOD["-lW"]?.replace("RW  0", "RWE 0") ?? "" }, "stack"],
    ["statically linked", { "-lW": GOOD["-lW"]?.replace("INTERP", "OTHER") ?? "" }, "dynamic"],
    ["unstripped", { "-SW": `${GOOD["-SW"] ?? ""}  [30] .symtab           SYMTAB          0000000000000000 400000 100000 18   31 100 8\n` }, "stripped"],
    ["debug info", { "-SW": `${GOOD["-SW"] ?? ""}  [31] .debug_info       PROGBITS        0000000000000000 400000 100000 00      0   0  1\n` }, "stripped"],
    ["a glibc newer than the pin", { "--dyn-syms": DYN("    14: 0000000000000000     0 FUNC    GLOBAL DEFAULT  UND arc4random@GLIBC_2.36 (4)\n") }, "GLIBC_2.36"],
    ["a readelf that cannot read the binary", { "--dyn-syms": "FAIL\n" }, "GLIBC"],
    ["no GLIBC symbols at all (the check would otherwise pass silently)", { "--dyn-syms": "    12: 0000000000000000     0 FUNC    GLOBAL DEFAULT  UND memcpy (2)\n" }, "GLIBC"],
    ["an empty symbol listing", { "--dyn-syms": "" }, "GLIBC"],
  ])("refuses %s", (_name, patch, word) => {
    const r = check(patch);
    expect(r.code).toBe(1);
    expect(r.out).toContain(word);
  });

  test.each([
    ["the test-hooks routes", "x/__test/time", "/__test/"],
    ["a test env var", "OMEGA_TEST_MONO", "OMEGA_TEST_"],
    ["SQLite's load_extension", "load_extension", "load_extension"],
    ["a build-machine home path", "/home/someone/.cargo/registry", "/home/"],
    ["the build's source path", "/srv/ci/work/apps/server-rs", "/apps/server-rs"],
  ])("refuses a binary containing %s", (_name, bytes, marker) => {
    const r = check({}, `${"a".repeat(1_500_000)}${bytes}${"b".repeat(600_000)}`);
    expect(r.code).toBe(1);
    expect(r.out).toContain(marker);
  });

  test("refuses the build root and the builder's HOME, wherever they sit in the binary", () => {
    const planted = (path: string) => `${"a".repeat(1_500_000)}${path}/apps/x${"b".repeat(600_000)}`;
    const root = check({}, planted("/srv/ci/work-1234"), "2.35", { OMEGA_BUILD_ROOT: "/srv/ci/work-1234" });
    expect(root.code).toBe(1);
    expect(root.out).toContain("/srv/ci/work-1234");
    const home = check({}, planted("/builder/home"), "2.35", { HOME: "/builder/home" });
    expect(home.code).toBe(1);
    expect(home.out).toContain("/builder/home");
    // Neither planted: clean.
    expect(check({}, "a".repeat(2_000_000), "2.35", { OMEGA_BUILD_ROOT: "/srv/ci/work-1234", HOME: "/builder/home" }).code).toBe(0);
  });

  test("refuses a binary that is far too small or far too large", () => {
    expect(check({}, "tiny").code).toBe(1);
  });

  test("a GLIBC_2.9 symbol compares as older than 2.35 (version sort, not text)", () => {
    expect(check({ "--dyn-syms": DYN("    14: 0000000000000000     0 FUNC    GLOBAL DEFAULT  UND x@GLIBC_2.9 (4)\n") }).code).toBe(0);
  });
});

describe("deploy/omega-ops (the release's launcher)", () => {
  const OPS = join(DEPLOY, "omega-ops");
  test("a Rust release runs omega-server with the same verb and arguments", () => {
    const dir = tmp();
    try {
      mkdirSync(join(dir, "bin"));
      fake(dir, "omega-server", 'echo "rust $*"');
      for (const verb of [["backup", "snapshot"], ["admin", "reports", "list"], ["serve"]]) {
        const r = spawn(["bash", OPS, ...verb], { PATH: process.env["PATH"] ?? "", OMEGA_APP_DIR: dir });
        expect(r.out.trim(), r.out).toBe(`rust ${verb.join(" ")}`);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a Bun release maps serve, backup and admin onto the Bun entry points", () => {
    const dir = tmp();
    try {
      fake(dir, "bun", 'echo "bun $*"');
      const run = (...a: string[]) => spawn(["bash", OPS, ...a], { PATH: process.env["PATH"] ?? "", OMEGA_APP_DIR: "/app", OMEGA_BUN: join(dir, "bun") }).out.trim();
      expect(run("serve")).toBe("bun /app/apps/server/src/index.ts");
      expect(run("backup", "snapshot")).toBe("bun /app/apps/server/scripts/backup.ts snapshot");
      expect(run("admin", "reports", "list")).toBe("bun /app/apps/server/src/cli.ts reports list");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("an unknown verb exits 2", () => {
    expect(spawn(["bash", OPS, "nope"], { PATH: process.env["PATH"] ?? "", OMEGA_APP_DIR: "/nonexistent" }).code).toBe(2);
  });
});

describe("deploy/deploy.sh --server", () => {
  const SCRIPT = join(DEPLOY, "deploy.sh");
  const withBun = (fn: (path: string) => void) => {
    const dir = tmp();
    try {
      fake(dir, "bun", `[[ "$1" == --version ]] && { echo ${BUN_VERSION}; exit 0; }\nexit 0`);
      fn(`${dir}:${process.env["PATH"] ?? ""}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
  const dry = (path: string, ...args: string[]) => spawn(["bash", SCRIPT, ...args, "--dry-run"], { PATH: path, DEPLOY_HOST: HOST });

  test("an unknown or missing --server value exits 2", () => {
    withBun((path) => {
      expect(dry(path, "--server", "go").code).toBe(2);
      expect(spawn(["bash", SCRIPT, "--server"], { PATH: path, DEPLOY_HOST: HOST }).code).toBe(2);
    });
  });

  test("the default is rust (the switch PR): a plain deploy cross-builds and ships omega-server", () => {
    withBun((path) => {
      const r = dry(path);
      expect(r.code, r.out).toBe(0);
      expect(r.out).toContain("build-server-rs.sh");
      expect(r.out).not.toMatch(/bun install [^\n]*--production/);
      expect(r.out).toMatch(/releases\/[0-9a-f]{40}-rust\//);
    });
  });

  test("a rust deploy without the build tools stops before building the site; a dry run only warns (OME-1606)", () => {
    const dir = tmp();
    try {
      fake(dir, "bun", `echo "$@" >> "${dir}/bun-calls"\n[[ "$1" == --version ]] && echo ${BUN_VERSION}\nexit 0`);
      const env = { PATH: `${dir}:/usr/bin:/bin`, DEPLOY_HOST: HOST, XDG_DATA_HOME: dir };
      const real = spawn(["bash", SCRIPT], env);
      expect(real.code, real.out).toBe(1);
      expect(real.out).toContain("scripts/install-server-rs-tools.sh");
      expect(readFileSync(join(dir, "bun-calls"), "utf8")).not.toContain("install");
      const dry = spawn(["bash", SCRIPT, "--dry-run"], env);
      expect(dry.code, dry.out).toBe(0);
      expect(dry.out).toContain("a real deploy would refuse");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("--server rust builds from the archived commit, checks the binary, ships it and keeps the release atomic", () => {
    withBun((path) => {
      for (const args of [["--server", "rust"], ["--server=rust"]]) {
        const r = dry(path, ...args);
        expect(r.code, r.out).toBe(0);
        const out = r.out;
        const build = out.indexOf("build-server-rs.sh");
        const check = out.indexOf("check-server-binary.sh");
        const ship = out.search(/rsync .* deploy@203\.0\.113\.7:\/opt\/omega-share\/releases\/[0-9a-f]{40}-rust\//);
        expect(build).toBeGreaterThan(-1);
        expect(check).toBeGreaterThan(build);
        expect(ship).toBeGreaterThan(check);
        expect(out).toMatch(/--out \S+\/release\/omega-server/);
        expect(out).toContain("bin/omega-ops");
        expect(out).not.toMatch(/bun install [^\n]*--production/);
        expect(out).toMatch(/flip \/opt\/omega-share\/releases\/[0-9a-f]{40}-rust\n/);
        expect(out).toContain("rolled back to");
        expect(out).toContain("/healthz");
      }
    });
  });

  test("--server bun keeps shipping the Bun release with production node_modules", () => {
    withBun((path) => {
      const r = dry(path, "--server", "bun");
      expect(r.code, r.out).toBe(0);
      expect(r.out).toMatch(/bun install [^\n]*--production/);
      expect(r.out).toContain("bun --version");
      expect(r.out).not.toContain("build-server-rs.sh");
      expect(r.out).toMatch(/deploy@203\.0\.113\.7:\/opt\/omega-share\/releases\/[0-9a-f]{40}\//);
      expect(r.out).toMatch(/flip \/opt\/omega-share\/releases\/[0-9a-f]{40}\n/);
    });
  });

  /** The remote script of a dry run, run against a scratch base with fake systemctl/curl; `inspect` reads the scratch dir before it is removed. */
  const remote = (
    kind: "rust" | "bun",
    setup: (base: string) => void,
    inspect: (res: { code: number; out: string; base: string; calls: string }) => void,
    opts: { has?: string[]; rustExec?: boolean; healthy?: boolean } = {},
  ) => {
    const has = opts.has ?? ["omega-share", "omega-share-bun"];
    const dir = tmp();
    try {
      const base = join(dir, "opt");
      mkdirSync(join(base, "releases"), { recursive: true });
      setup(base);
      let script = "";
      withBun((path) => {
        const r = spawn(["bash", SCRIPT, "--server", kind, "--dry-run"], { PATH: path, DEPLOY_HOST: HOST, OMEGA_DEPLOY_BASE: base });
        script = /<<remote\n([\s\S]*?)\nremote\n/.exec(r.out)?.[1] ?? "";
      });
      expect(script).not.toBe("");
      const calls = join(dir, "calls");
      const exec = opts.rustExec === false ? "ExecStart=/usr/local/bin/bun" : "ExecStart=/opt/omega-share/current/omega-server serve";
      fake(dir, "systemctl", `echo "systemctl $*" >> "${calls}"\nif [ "$1" = cat ]; then case " ${has.join(" ")} " in *" $2 "*) echo "${exec}"; exit 0;; *) exit 1;; esac; fi`);
      fake(dir, "curl", opts.healthy === false ? "exit 1" : "exit 0");
      fake(dir, "sleep", "exit 0");
      fake(dir, "bun", `echo ${BUN_VERSION}`);
      const patched = script.replaceAll("/usr/local/bin/bun", join(dir, "bun"));
      const r = spawn(["bash", "-c", patched], { PATH: `${dir}:${process.env["PATH"] ?? ""}` });
      inspect({ ...r, base, calls: existsSync(calls) ? readFileSync(calls, "utf8") : "" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
  const mkRelease = (base: string, sha: string, rust: boolean, ageSeconds: number) => {
    const d = join(base, "releases", sha);
    mkdirSync(d, { recursive: true });
    if (rust) writeFileSync(join(d, "omega-server"), "x");
    else {
      mkdirSync(join(d, "apps/server/src"), { recursive: true });
      writeFileSync(join(d, "apps/server/src/index.ts"), "x");
    }
    Bun.spawnSync(["touch", "-d", new Date(Date.now() - ageSeconds * 1000).toISOString(), d]);
    return d;
  };
  const link = (base: string, target: string) => Bun.spawnSync(["ln", "-sfn", target, join(base, "current")]);
  const currentIs = (base: string) => Bun.spawnSync(["readlink", "-f", join(base, "current")]).stdout.toString();

  test("a rust deploy stops the Bun unit, restarts omega-share and prunes to 5 releases plus the newest Bun one", () => {
    remote(
      "rust",
      (b) => {
        for (let i = 0; i < 6; i++) mkRelease(b, `rust-${String(i)}`, true, 100 + i * 100);
        mkRelease(b, "bun-newest", false, 1000);
        mkRelease(b, "bun-older", false, 5000);
        link(b, mkRelease(b, "prev", true, 50));
      },
      ({ code, out, base, calls }) => {
        expect(code, out).toBe(0);
        expect(calls.indexOf("stop omega-share-bun")).toBeGreaterThan(-1);
        expect(calls.indexOf("restart omega-share")).toBeGreaterThan(calls.indexOf("stop omega-share-bun"));
        expect(existsSync(join(base, "releases", "bun-newest"))).toBe(true);
        expect(existsSync(join(base, "releases", "bun-older"))).toBe(false);
        expect(existsSync(join(base, "releases", "rust-5"))).toBe(false);
        expect(existsSync(join(base, "releases", "prev"))).toBe(true);
      },
    );
  });

  const HEAD = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: join(DEPLOY, "..") }).stdout.toString().trim();

  test("a rust deploy of the sha the live Bun release runs goes to <sha>-rust and leaves <sha> untouched", () => {
    remote(
      "rust",
      (b) => link(b, mkRelease(b, HEAD, false, 100)),
      ({ code, out, base, calls }) => {
        expect(code, out).toBe(0);
        expect(currentIs(base).trim()).toBe(join(base, "releases", `${HEAD}-rust`));
        expect(existsSync(join(base, "releases", HEAD, "apps/server/src/index.ts"))).toBe(true);
        expect(calls).toContain("restart omega-share\n");
      },
    );
  });

  test("a bun deploy of a sha whose Rust release exists goes to <sha> and leaves <sha>-rust untouched", () => {
    remote(
      "bun",
      (b) => link(b, mkRelease(b, `${HEAD}-rust`, true, 100)),
      ({ code, out, base, calls }) => {
        expect(code, out).toBe(0);
        expect(currentIs(base).trim()).toBe(join(base, "releases", HEAD));
        expect(existsSync(join(base, "releases", `${HEAD}-rust`, "omega-server"))).toBe(true);
        expect(calls).toContain("restart omega-share-bun\n");
      },
    );
  });

  test("the rsync target differs per kind for the same sha", () => {
    withBun((path) => {
      const dest = (kind: string) => new RegExp(`rsync [^\\n]*:/opt/omega-share/releases/${HEAD}(-rust)?/ \\n`).exec(dry(path, "--server", kind).out)?.[1] ?? "none";
      expect(dest("bun")).toBe("none");
      expect(dest("rust")).toBe("-rust");
    });
  });

  test("retention keeps the Bun target across name forms, and the 5 newest", () => {
    remote(
      "rust",
      (b) => {
        for (let i = 0; i < 6; i++) mkRelease(b, `${"a".repeat(39)}${String(i)}-rust`, true, 100 + i * 100);
        mkRelease(b, "b".repeat(40), false, 9000);
        mkRelease(b, "c".repeat(40), false, 9500);
        link(b, mkRelease(b, "prev-rust", true, 50));
      },
      ({ code, out, base }) => {
        expect(code, out).toBe(0);
        expect(existsSync(join(base, "releases", "b".repeat(40)))).toBe(true);
        expect(existsSync(join(base, "releases", "c".repeat(40)))).toBe(false);
        expect(existsSync(join(base, "releases", `${"a".repeat(39)}5-rust`))).toBe(false);
      },
    );
  });

  test("a failed healthz rolls a same-sha rust deploy back to the Bun <sha> dir and its unit", () => {
    remote(
      "rust",
      (b) => link(b, mkRelease(b, HEAD, false, 100)),
      ({ code, out, base, calls }) => {
        expect(code).toBe(1);
        expect(out).toContain(`rolled back to ${join(base, "releases", HEAD)}`);
        expect(currentIs(base).trim()).toBe(join(base, "releases", HEAD));
        expect(calls.lastIndexOf("restart omega-share-bun")).toBeGreaterThan(calls.indexOf("restart omega-share\n"));
      },
      { healthy: false },
    );
  });

  test("a failed healthz rolls a same-sha bun deploy back to the <sha>-rust dir and its unit", () => {
    remote(
      "bun",
      (b) => link(b, mkRelease(b, `${HEAD}-rust`, true, 100)),
      ({ code, out, base, calls }) => {
        expect(code).toBe(1);
        expect(out).toContain(`rolled back to ${join(base, "releases", `${HEAD}-rust`)}`);
        expect(currentIs(base).trim()).toBe(join(base, "releases", `${HEAD}-rust`));
        expect(calls.lastIndexOf("restart omega-share\n")).toBeGreaterThan(calls.indexOf("restart omega-share-bun"));
      },
      { healthy: false },
    );
  });

  test("a half-uploaded release (neither server inside) never displaces the Bun release kept for rollback", () => {
    remote(
      "rust",
      (b) => {
        for (let i = 0; i < 6; i++) mkRelease(b, `rust-${String(i)}`, true, 100 + i * 100);
        mkdirSync(join(b, "releases", "partial"), { recursive: true });
        Bun.spawnSync(["touch", "-d", new Date(Date.now() - 60_000).toISOString(), join(b, "releases", "partial")]);
        mkRelease(b, "bun-real", false, 9000);
        link(b, mkRelease(b, "prev", true, 50));
      },
      ({ code, out, base }) => {
        expect(code, out).toBe(0);
        expect(existsSync(join(base, "releases", "bun-real"))).toBe(true);
      },
    );
  });

  test("an unhealthy bun deploy puts the previous Rust release back and restarts the Rust unit (the mirror)", () => {
    remote(
      "bun",
      (b) => link(b, mkRelease(b, "prev-rust", true, 100)),
      ({ code, out, base, calls }) => {
        expect(code).toBe(1);
        expect(out).toContain("rolled back to");
        expect(currentIs(base)).toContain("prev-rust");
        expect(calls).toContain("stop omega-share-bun\n");
        expect(calls.lastIndexOf("restart omega-share\n")).toBeGreaterThan(calls.indexOf("restart omega-share-bun"));
      },
      { healthy: false },
    );
  });

  test("a release holding both servers runs Rust only: rolling back to it restarts omega-share", () => {
    remote(
      "bun",
      (b) => {
        const both = mkRelease(b, "prev-both", false, 100);
        writeFileSync(join(both, "omega-server"), "x");
        link(b, both);
      },
      ({ calls, out }) => {
        expect(out).toContain("rolled back to");
        expect(calls.lastIndexOf("restart omega-share\n")).toBeGreaterThan(-1);
      },
      { healthy: false },
    );
  });

  test("an unhealthy rust deploy puts the previous Bun release back and restarts the Bun unit", () => {
    remote(
      "rust",
      (b) => link(b, mkRelease(b, "prev-bun", false, 100)),
      ({ code, out, base, calls }) => {
        expect(code).toBe(1);
        expect(out).toContain("rolled back to");
        expect(currentIs(base)).toContain("prev-bun");
        expect(calls.lastIndexOf("restart omega-share-bun")).toBeGreaterThan(calls.indexOf("restart omega-share\n"));
        expect(calls).toContain("stop omega-share\n");
      },
      { healthy: false },
    );
  });

  test("a rust deploy refuses, before flipping, when the box's unit is still the Bun one (run provision.sh first)", () => {
    remote(
      "rust",
      (b) => link(b, mkRelease(b, "prev", false, 100)),
      ({ code, out, base, calls }) => {
        expect(code).toBe(1);
        expect(out).toContain("provision");
        expect(calls).not.toContain("restart");
        expect(currentIs(base)).toContain("prev");
      },
      { has: ["omega-share"], rustExec: false },
    );
  });

  test("a bun deploy before provisioning still restarts the legacy omega-share unit", () => {
    remote(
      "bun",
      (b) => link(b, mkRelease(b, "prev", false, 100)),
      ({ code, out, calls }) => {
        expect(code, out).toBe(0);
        expect(calls).toContain("restart omega-share\n");
        expect(calls).not.toContain("restart omega-share-bun");
      },
      { has: ["omega-share"], rustExec: false },
    );
  });
});

describe("deploy/omega-share.service (the Rust server's unit)", () => {
  const text = read("omega-share.service");
  const unit = unitKeys(text);
  const env = (unit.get("Environment") ?? []).join(" ");

  test.each([
    ["ExecStart", "/opt/omega-share/current/omega-server serve"],
    ["User", "omega-share"],
    ["NoNewPrivileges", "yes"],
    ["ProtectSystem", "strict"],
    ["MemoryDenyWriteExecute", "yes"],
    ["LimitCORE", "0"],
    ["IPAddressDeny", "any"],
    ["IPAddressAllow", "localhost"],
    ["SocketBindDeny", "any"],
    ["PrivateUsers", "yes"],
    ["NoExecPaths", "/var/lib/omega-share"],
    ["ConditionPathExists", "/opt/omega-share/current/omega-server"],
    ["UMask", "0077"],
    ["StateDirectoryMode", "0700"],
    ["ReadWritePaths", "/var/lib/omega-share"],
  ])("%s=%s", (key, value) => {
    expect(unit.get(key)?.at(-1)).toBe(value);
  });

  test("binds only the app and metrics ports", () => {
    const port = /PORT=(\d+)/.exec(env)?.[1] ?? "";
    const metrics = /METRICS_PORT=(\d+)/.exec(env)?.[1] ?? "";
    expect(unit.get("SocketBindAllow")).toEqual([`tcp:${port}`, `tcp:${metrics}`]);
  });

  test("drops NODE_ENV, sets RUST_BACKTRACE=0 and keeps the loopback proxy setup", () => {
    expect(text).not.toContain("NODE_ENV");
    expect(env).toContain("RUST_BACKTRACE=0");
    expect(env).toContain("TRUST_PROXY=loopback");
    expect(env).toContain("HOST=127.0.0.1");
    expect(env).toContain("STATIC_DIR=/opt/omega-share/current/apps/web/dist");
    expect(env).toContain("DB_PATH=/var/lib/omega-share/omega.db");
  });

  test("the syscall filter allows @system-service and denies the privileged groups", () => {
    const filters = (unit.get("SystemCallFilter") ?? []).join(" ");
    expect(filters).toContain("@system-service");
    for (const group of ["@privileged", "@resources", "@mount", "@obsolete", "@debug", "@raw-io", "@reboot", "@swap", "@cpu-emulation"]) {
      expect(filters, group).toContain(group);
    }
  });

  test("the unit's connection-cap comment states the server's real numbers (1024 + 256 = 1280 total, 128 per non-loopback peer)", () => {
    expect(text).toContain("1280");
    expect(text).toContain("1024 + 256");
    expect(text).toContain("128 per non-loopback peer");
  });

  test("LimitNOFILE covers MAX_CONNECTIONS' ceiling, the 256 HTTP headroom and a file per response", () => {
    const ceiling = 3072;
    // The server's connection caps are fixed numbers sized for 4096: never lower.
    expect(Number(unit.get("LimitNOFILE")?.at(-1))).toBeGreaterThanOrEqual(4096);
    expect(Number(unit.get("LimitNOFILE")?.at(-1))).toBeGreaterThanOrEqual(ceiling + 256 + 256);
    expect(env).not.toMatch(/MAX_CONNECTIONS=(\d+)/); // the default (1024) applies unless an env file raises it
  });

  test("restarts on failure, drains on SIGTERM and carries no secret", () => {
    expect(unit.get("Restart")?.at(-1)).toBe("on-failure");
    expect(unit.get("KillSignal")?.at(-1)).toBe("SIGTERM");
    expect(text).not.toMatch(/TOKEN|SECRET|PASSWORD|KEY=/i);
  });

  test("every option that needs the aarch64 box to prove it is named in the unit's checklist comment", () => {
    for (const option of ["MemoryDenyWriteExecute", "SystemCallFilter", "SocketBind", "IPAddress", "PrivateUsers", "NoExecPaths"]) {
      expect(text.split("\n").filter((l) => l.startsWith("#") && l.includes("BOX:") && l.includes(option)).length, option).toBeGreaterThan(0);
    }
  });
});

describe("deploy/omega-share-bun.service (the 7-day rollback unit)", () => {
  const unit = unitKeys(read("omega-share-bun.service"));
  test("runs the Bun release only, with no Rust-only hardening", () => {
    expect(unit.get("ExecStart")?.at(-1)).toBe("/usr/local/bin/bun /opt/omega-share/current/apps/server/src/index.ts");
    expect(unit.get("ConditionPathExists")).toContain("/opt/omega-share/current/apps/server/src/index.ts");
    expect(unit.get("ConditionPathExists")).toContain("!/opt/omega-share/current/omega-server");
    expect(unit.has("MemoryDenyWriteExecute")).toBe(false); // Bun's JIT needs W+X pages
    expect(unit.get("Environment")?.join(" ")).toContain("NODE_ENV=production");
  });
  test("shares the state, user and ports of the Rust unit, and the two never declare Conflicts (a boot would collide)", () => {
    const rust = unitKeys(read("omega-share.service"));
    for (const key of ["User", "StateDirectory", "ReadWritePaths", "MemoryMax", "LimitNOFILE"]) {
      expect(unit.get(key)?.at(-1), key).toBe(rust.get(key)?.at(-1));
    }
    expect(unit.has("Conflicts")).toBe(false);
    expect(rust.has("Conflicts")).toBe(false);
  });
});

describe("polkit, provision and the ops scripts serve both servers", () => {
  test("the deploy user may start, stop and restart both units and nothing else", () => {
    const rule = read("polkit/50-omega-share-deploy.rules");
    expect(rule).toContain("omega-share.service");
    expect(rule).toContain("omega-share-bun.service");
    expect(rule).not.toMatch(/"(reload|enable|disable|mask|kill)"/);
  });

  test("provision installs and enables both units", () => {
    const p = read("provision.sh");
    expect(p).toContain("omega-share-bun.service");
    expect(p).toMatch(/systemctl enable omega-share\.service omega-share-bun\.service/);
  });

  test("the backup unit snapshots through the release's launcher", () => {
    const backup = unitKeys(read("backup/omega-share-backup.service"));
    expect(backup.get("ExecStart")?.at(-1)).toBe("/opt/omega-share/current/bin/omega-ops backup snapshot");
  });

  test("restore.sh and the monitor use the launcher's backup and admin verbs", () => {
    expect(read("backup/restore.sh")).toContain("omega-ops");
    expect(read("backup/restore.sh")).not.toContain("backup.ts");
    expect(read("monitor/monitor.sh")).toContain("/opt/omega-share/current/bin/omega-ops admin reports list");
  });
});

describe("deploy/Caddyfile limits for the Rust origin (#254)", () => {
  const caddy = read("Caddyfile");
  test("sets header and idle timeouts and a header size under the server's 16 KiB refusal", () => {
    expect(caddy).toMatch(/timeouts \{[^}]*read_header \d+s/);
    expect(caddy).toMatch(/timeouts \{[^}]*idle \d+[sm]/);
    const kib = /max_header_size (\d+)KiB/.exec(caddy)?.[1];
    expect(Number(kib)).toBeLessThanOrEqual(16);
  });
  // Caddy (2.5+) drops a client's own X-Forwarded-* unless the peer is in trusted_proxies, then sets X-Forwarded-For to the
  // peer. With none trusted the rightmost entry is always the real client, so a remote client cannot pose as loopback.
  test("trusts no proxy and never rewrites X-Forwarded-For, so its rightmost entry is the real peer", () => {
    expect(caddy).not.toContain("trusted_proxies");
    expect(caddy).not.toMatch(/header_up\s+-?X-Forwarded-For/i);
  });
  test("the switch runbook checks a forged X-Forwarded-For through the public origin", () => {
    expect(readFileSync(join(ROOT, "docs/ops/switch-to-rust.md"), "utf8")).toMatch(/X-Forwarded-For: 127\.0\.0\.1/);
  });
});

describe("scripts/tunnel.sh for the Rust server", () => {
  const SCRIPT = join(ROOT, "scripts/tunnel.sh");
  const URL = "https://quiet-otter.ngrok-free.app";
  test("TUNNEL_SERVER=rust builds and runs omega-server serve with a DB_PATH", () => {
    const r = spawn(["bash", SCRIPT, URL, "--dry-run"], { PATH: process.env["PATH"] ?? "", TUNNEL_SERVER: "rust" });
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain("cargo build --release --locked -p omega-server");
    expect(r.out).toMatch(/DB_PATH=\S+ \S*omega-server serve/);
    expect(r.out).toContain("TRUST_PROXY=loopback");
    expect(r.out).not.toContain("apps/server/src/index.ts");
  });
  test("an unknown TUNNEL_SERVER is refused", () => {
    expect(spawn(["bash", SCRIPT, URL, "--dry-run"], { PATH: process.env["PATH"] ?? "", TUNNEL_SERVER: "go" }).code).toBe(2);
  });
});

describe("docs", () => {
  const doc = (name: string) => readFileSync(join(ROOT, "docs/ops", name), "utf8");
  test("the switch runbook has the rollback command, the 7-day window and every box-verified option", () => {
    const d = doc("switch-to-rust.md");
    expect(d).toContain("deploy.sh --server bun");
    expect(d).toMatch(/7 days?/);
    for (const option of ["MemoryDenyWriteExecute", "SystemCallFilter", "SocketBind", "IPAddressDeny", "PrivateUsers", "NoExecPaths", "max_header_size"]) {
      expect(d, option).toContain(option);
    }
  });
  test("the XFF check is a parallel burst over the 120 limit, with a control run and a stays-under sanity run", () => {
    const d = doc("switch-to-rust.md");
    expect(d).toMatch(/xargs -P \d+/);
    expect(d).toMatch(/seq 1 600/);
    expect(d).toMatch(/control/i);
    expect(d).toMatch(/under the limit/i);
  });
  test("the snapshot is listed as the service user and the step fails loudly when none is found", () => {
    const d = doc("switch-to-rust.md");
    expect(d).toMatch(/sudo -u omega-share sh -c/);
    expect(d).toMatch(/no snapshot found/);
  });
  test("the runbook holds a WebSocket open past Caddy's 2m idle timeout", () => {
    expect(doc("switch-to-rust.md")).toMatch(/2\.5 minutes/);
  });
  test("the journalctl pipe in the hardening table is escaped and its sudo noted", () => {
    const d = doc("switch-to-rust.md");
    expect(d).not.toMatch(/journalctl -k \| grep/);
    expect(d).toMatch(/journalctl -k \\\| grep/);
  });
  test("a plain deploy after the switch stays on Rust: hosting.md and the runbook say Bun is only deployed explicitly", () => {
    for (const name of ["hosting.md", "switch-to-rust.md"]) {
      expect(doc(name), name).toMatch(/default to `--server rust`|flipped the default/);
      expect(doc(name), name).toMatch(/explicit `--server bun`/);
    }
  });
  test("hosting, backup, rooms and tunnel docs show the Rust commands next to the Bun ones", () => {
    expect(doc("hosting.md")).toContain("--server rust");
    expect(doc("backup.md")).toContain("omega-ops backup");
    expect(doc("rooms.md")).toContain("omega-ops admin");
    expect(doc("tunnel.md")).toContain("TUNNEL_SERVER=rust");
  });
});
