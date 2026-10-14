/**
 * The suite's fake time, usable in both modes (PORTING.md "The black-box suite"). In process it is
 * the server's `now`/`wallNow`/`schedule` options; against the Rust binary the same object writes
 * to `POST /__test/time` once `attach`ed, and the binary's timers are the virtual ones.
 */

interface Task {
  at: number;
  run: () => void;
  live: boolean;
}

const owners = new WeakMap<object, TestClock>();

/** The `TestClock` a `now`/`wallNow`/`schedule` function belongs to, if any. */
export const clockOf = (fn: unknown): TestClock | undefined => (typeof fn === "function" ? owners.get(fn) : undefined);

export class TestClock {
  readonly now = (): number => this.mono;
  readonly wallNow = (): number => this.wall;
  readonly schedule = (run: () => void, ms: number): (() => void) => {
    const task: Task = { at: this.mono + ms, run, live: true };
    this.tasks.push(task);
    return () => {
      task.live = false;
    };
  };
  private readonly tasks: Task[] = [];
  private url: string | undefined;

  constructor(
    public mono = 1_000_000,
    public wall = 1_800_000_000_000,
  ) {
    for (const fn of [this.now, this.wallNow, this.schedule]) owners.set(fn, this);
  }

  /** Black-box mode: from now on `set` drives the binary at `url`. */
  attach(url: string): void {
    this.url = url;
  }

  /** Moves the clocks, then runs (in process) or has the server run (black box) every timer now due. */
  async set(to: { mono?: number; wall?: number }): Promise<void> {
    this.mono = to.mono ?? this.mono;
    this.wall = to.wall ?? this.wall;
    if (this.url !== undefined) {
      const res = await fetch(`${this.url}/__test/time`, {
        method: "POST",
        body: JSON.stringify({ mono: this.mono, wall: this.wall }),
      });
      if (!res.ok) throw new Error(`POST /__test/time answered ${String(res.status)}`);
      await res.text();
      return;
    }
    const due = this.tasks.filter((t) => t.live && t.at <= this.mono).sort((a, b) => a.at - b.at);
    for (const task of due) {
      task.live = false;
      task.run();
    }
  }

  /** Timers armed and neither fired nor cancelled. */
  async pending(): Promise<number> {
    if (this.url === undefined) return this.tasks.filter((t) => t.live).length;
    const body: unknown = await (await fetch(`${this.url}/__test/time`)).json();
    const pending = typeof body === "object" && body !== null && "pending" in body ? body.pending : undefined;
    if (typeof pending !== "number") throw new Error("GET /__test/time: no pending count");
    return pending;
  }
}
