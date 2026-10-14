/** Maps `start()` options onto the Rust binary's environment (`CONFIG_KEYS` in config.rs). */
import type { TestClock } from "./clock";

/** The test needs the in-process server (a spy, a registry object, a function): the runner skips it. */
export class NotBlackBox extends Error {}

export interface Mapped {
  env: Record<string, string>;
  clock: TestClock | undefined;
}

export function envFor(_opts: Record<string, unknown>): Mapped {
  return { env: {}, clock: undefined };
}
