// Cinema dim (OME-1406). Stub: the red commit.
export interface CinemaStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}
export interface CinemaDim {
  readonly el: HTMLDivElement;
  on(): boolean;
  set(on: boolean): void;
  update(playing: boolean, editing: boolean): void;
}
export function createCinemaDim(_store: CinemaStore): CinemaDim {
  return { el: document.createElement("div"), on: () => false, set: () => undefined, update: () => undefined };
}
