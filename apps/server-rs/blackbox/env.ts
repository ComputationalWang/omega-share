/** Maps `start()` options onto the Rust binary's environment (`CONFIG_KEYS` in config.rs). */
import { clockOf, type TestClock } from "./clock";

/** The test needs the in-process server (a spy, a registry object, a function): the runner skips it. */
export class NotBlackBox extends Error {
  override readonly name = "NotBlackBox";
}

export interface Mapped {
  env: Record<string, string>;
  clock: TestClock | undefined;
}

const text = (v: unknown): string => String(v);
const list = (v: unknown): string => (Array.isArray(v) ? v.join(",") : text(v));

/** option → [variable, formatter]; a null or undefined option sets nothing. */
const MAPPED: Record<string, readonly [string, (v: unknown) => string]> = {
  port: ["PORT", text],
  hostname: ["HOST", text],
  siteOrigin: ["SITE_ORIGIN", text],
  publicOrigin: ["PUBLIC_ORIGIN", text],
  staticDir: ["STATIC_DIR", text],
  extensionIds: ["EXTENSION_IDS", list],
  maxConnections: ["MAX_CONNECTIONS", text],
  resumeGraceMs: ["RESUME_GRACE_MS", text],
  maxHttpInFlight: ["MAX_HTTP_IN_FLIGHT", text],
  genericEmbedDenylist: ["GENERIC_EMBED_DENYLIST", list],
  roomTitleBlocklist: ["ROOM_TITLE_BLOCKLIST", list],
  dbPath: ["DB_PATH", text],
  genericEmbeds: ["GENERIC_EMBEDS", (v) => (v === false ? "off" : "on")],
  trustProxy: ["TRUST_PROXY", text],
};

const CLOCK_OPTIONS = ["now", "wallNow", "schedule"] as const;

export function envFor(opts: Record<string, unknown>): Mapped {
  const env: Record<string, string> = {
    PORT: "0",
    HOST: "127.0.0.1",
    SITE_ORIGIN: "http://localhost:5173",
    DB_PATH: ":memory:",
  };
  let clock: TestClock | undefined;
  for (const [key, value] of Object.entries(opts)) {
    if (value === undefined || value === null) continue;
    if ((CLOCK_OPTIONS as readonly string[]).includes(key)) {
      const owner = clockOf(value);
      if (owner === undefined || (clock !== undefined && clock !== owner)) {
        throw new NotBlackBox(`${key}: only one TestClock's functions can cross into the binary`);
      }
      clock = owner;
      continue;
    }
    const mapped = MAPPED[key];
    if (mapped === undefined) throw new NotBlackBox(`${key}: not expressible as an environment variable`);
    if (key === "trustProxy") {
      if (value === true) env[mapped[0]] = "loopback";
    } else {
      env[mapped[0]] = mapped[1](value);
    }
  }
  if (clock !== undefined) {
    env["OMEGA_TEST_MONO"] = String(clock.mono);
    env["OMEGA_TEST_WALL"] = String(clock.wall);
  }
  return { env, clock };
}
