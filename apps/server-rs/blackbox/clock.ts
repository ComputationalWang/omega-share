/** The suite's fake time, usable in both modes (see PORTING.md "The black-box suite"). */

export class TestClock {
  mono = 0;
  wall = 0;
  readonly now = (): number => this.mono;
  readonly wallNow = (): number => this.wall;
  readonly schedule = (_run: () => void, _ms: number): (() => void) => () => undefined;

  constructor(_mono = 1_000_000, _wall = 1_800_000_000_000) {}

  attach(_url: string): void {}

  set(_to: { mono?: number; wall?: number }): Promise<void> {
    return Promise.resolve();
  }

  pending(): Promise<number> {
    return Promise.resolve(-1);
  }
}

export const clockOf = (_fn: unknown): TestClock | undefined => undefined;
