// OME-1587: the first-visit tour. Red stub.
export const HINTS_KEY = "omega.hints";

export function parseHints(_raw: string | null): { readonly seen: boolean } {
  return { seen: false };
}

export interface HintsOptions {
  readonly storage: Pick<Storage, "getItem" | "setItem">;
  readonly anchor: (step: number) => HTMLElement | null;
  readonly next: () => HTMLElement | null;
}

export interface Hints {
  readonly root: HTMLElement;
  isOpen(): boolean;
  show(): void;
  dismiss(): void;
  restart(): void;
}

export function createHints(_o: HintsOptions): Hints {
  const root = document.createElement("div");
  root.hidden = true;
  return { root, isOpen: () => false, show() {}, dismiss() {}, restart() {} };
}
