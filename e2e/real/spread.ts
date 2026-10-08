// Spread statistics for the real-provider sync checks (OME-377). Implemented in the next commit.

export function heldMaxAbsMs(_samplesMs: readonly number[]): number {
  throw new Error("not implemented");
}

export function needsConfirmSample(_samplesMs: readonly number[], _budgetMs: number): boolean {
  throw new Error("not implemented");
}
