// The walk-tiers guard (OME-911, ADR 0043): how many bots walked in the measured window. Standing slots are stable, so a
// bot that sits and stands up again inside the window ends where it started; its seat change still says it walked.

/** Bots whose tag ended elsewhere, or whose seat changed in the window (each once; only names in `start` count). */
export function walkedInWindow(start: Readonly<Record<string, string>>, end: Readonly<Record<string, string>>, seatChanged: readonly string[]): number {
  const walked = new Set<string>();
  for (const n of Object.keys(start)) if (start[n] !== end[n]) walked.add(n);
  for (const n of seatChanged) if (n in start) walked.add(n);
  return walked.size;
}
