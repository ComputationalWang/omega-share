/** Spawns the binary for one test and reaps it. */

export interface Spawned {
  port: number;
  /** The first stdout line. */
  banner: string;
  stop: () => Promise<void>;
}

export function spawnServer(_bin: string, _env: Record<string, string>): Spawned {
  throw new Error("stub");
}

/** Kills every child still running and removes its temp dir (also runs on exit and on signals). */
export function killAll(): void {}
