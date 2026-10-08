// Spread statistics for the real-provider sync checks (OME-377).
//
// Why not the plain max: each client's sync loop corrects against the room clock on its own. After a resume, a real
// Vimeo or Twitch player can start more than a second behind the room. Both clients then hard-seek, but on different
// loop ticks, so for one ~250 ms sample the pair is up to ~1.5 s apart even though each one lands on the room clock.
// Measured on main@27df5fe: the spike is always a single sample, with the samples either side within ±60 ms. A real
// drift (a player that stays off, or a correction that never lands) holds across consecutive samples, so we count an
// offset only once two samples in a row both reach it.

/** The worst |offset| held by two consecutive samples: a one-sample spike counts only as far as its neighbours reach. */
export function heldMaxAbsMs(samplesMs: readonly number[]): number {
  if (samplesMs.length === 0) return Number.NaN;
  const abs = samplesMs.map(Math.abs);
  if (abs.length === 1) return abs[0] ?? Number.NaN;
  let held = 0;
  for (let i = 1; i < abs.length; i++) held = Math.max(held, Math.min(abs[i - 1] ?? 0, abs[i] ?? 0));
  return held;
}

/** A window whose last sample is over budget can't yet tell a spike from the start of a drift: take one more. */
export function needsConfirmSample(samplesMs: readonly number[], budgetMs: number): boolean {
  const last = samplesMs.at(-1);
  return last !== undefined && Math.abs(last) > budgetMs;
}
