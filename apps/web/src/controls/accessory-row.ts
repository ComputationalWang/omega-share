export function buildAccessoryRow(): HTMLElement {
  return document.createElement("div");
}
export function bindAccessoryRow(_group: HTMLElement, _onPick: (a: number) => void): { check(a: number): void } {
  return { check: () => undefined };
}
