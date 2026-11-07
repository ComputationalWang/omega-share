// Chrome motion (OME-2308, docs/design/site-redesign-2/HANDOFF.md "Motion"): opacity and transform only, at most 200 ms,
// a newer move on an element cancels its older one. Under reduced motion nothing plays, and turning it on cancels what runs.
const reduced = globalThis.matchMedia("(prefers-reduced-motion: reduce)");
const live = new Set<Animation>();
reduced.addEventListener("change", () => {
  if (!reduced.matches) return;
  for (const a of live) a.cancel();
  live.clear();
});
const last = new WeakMap<Element, Animation>();

/** Plays `frames` on `e` with ease-out, replacing the move it was already making. */
export function play(e: Element, frames: Keyframe[], duration: number): void {
  last.get(e)?.cancel();
  if (reduced.matches) return;
  const a = e.animate(frames, { duration, easing: "ease-out" });
  last.set(e, a);
  live.add(a);
  // `finished` rejects on cancel: that is the expected end, not an error.
  const done = (): void => {
    live.delete(a);
  };
  void a.finished.then(done, done);
}

/** Content entering (a tab's panel, a disclosure's body): fades in from `dy` px below. */
export function enter(e: Element, dy = 8): void {
  play(e, [{ opacity: 0, transform: `translateY(${String(dy)}px)` }, { opacity: 1, transform: "none" }], 140);
}

// Every disclosure on the page: its body enters as a tab's does (toggle doesn't bubble, so this listens in the capture phase).
document.addEventListener("toggle", (ev) => {
  const d = ev.target;
  if (!(d instanceof HTMLDetailsElement) || !d.open) return;
  for (const c of d.children) if (!(c instanceof HTMLElement && c.tagName === "SUMMARY")) enter(c, 6);
}, true);
