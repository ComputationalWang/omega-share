// Stub for the failing-test commit (OME-358); the implementation lands next.
export const KEEP = 14;
const todo = (): never => {
  throw new Error("not implemented");
};
export const snapshot: (dbPath: string, dir: string, now?: Date) => string = todo;
export const prune: (dir: string, keep?: number) => string[] = todo;
export const verifySnapshot: (path: string) => { rooms: number } = todo;
export const restore: (snapshot: string, dbPath: string, now?: Date) => { rooms: number; previous: string | null } = todo;
