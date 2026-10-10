# ADR 0039: Chat bubble motion on a shared step clock, not CSS animations

**Status:** accepted (2026-10-10) · Lead · [OME-802](/OME/issues/OME-802) · found by M8 Q1 QA [OME-733](/OME/issues/OME-733) · amends the motion of [OME-730](/OME/issues/OME-730) (set (l) `.ui-float`, `meta.omega.bubbles`)

**Context:** W1's floating bubbles (OME-730) roughly doubled main-thread work per frame in the chat-burst perf rows. Under ordinary box load, the `wide` and `chat` budgets failed. Traces of `perf/chat.perf.ts` and an isolated repro showed two costs:
1. **Forced layouts.** `say()` read `offsetWidth`/`offsetHeight`, forcing a whole-page style and layout pass on every message. `stack()` re-measured, forcing another one.
2. **CSS animations.** Each bubble ran two 5 s `@keyframes` (the rise and the fade) plus a 160 ms transform transition for the push.
   - Blink restyles every element with a running CSS animation on every main frame, even when the animation is composited. In a 2 s trace of 8 composited bubbles there was no style recalc while nothing requested a frame, and one recalc per frame (16 elements: 8 bubbles plus their `::after` tails) as soon as a `requestAnimationFrame` loop ran.
   - The room always has main frames: Pixi, the perf harness's frame counter, and anything else using rAF.
   - Every message also started two animations and cancelled two, and every push started a transition.

Removing only the forced layouts (ResizeObserver plus twin, below) cut the work but left the rows red. With the CSS animations also gone, the rows came back to within noise of the pre-W1 build.

**Decision:**
- **No CSS animation or transition on a bubble.** `apps/web/src/style.css` sets `animation: none; transition: none` on `.float-slot > .ui-float`. This overrides the keyframes `reference.css` declares for the standalone component.
- **One step clock.** `floats.ts` runs a single timer for the whole layer. Step `i` falls at `i × 5000 / 24` ms on `now`'s clock, the same instants for every bubble. On each step it frees the bubbles that are due and writes the rest as inline styles, only when a value changes:
  - the rise: `translate: 0 -Npx`, where N is the number of whole steps between the bubble's birth and the last step, capped at 24;
  - the fade: `opacity`, in hundredths.

  The timer stops when the layer is empty. A bubble expires at the first step at or after the end of its 5 s life, so up to one step (208 ms) late.
- **Motion, against set (l):**

  | Motion | Set (l) | Now |
  |---|---|---|
  | Rise | 24 px in `steps(24)` | Unchanged: the same 24 whole-pixel steps, aligned to the shared clock |
  | Fade-out | From 72 % of the life on `cubic-bezier(0.55, 0, 1, 0.45)` | Unchanged, but sampled on the steps (about 7 levels over 1.4 s) |
  | Reduced motion | No rise; linear fade from 80 % | Unchanged, sampled on the steps; an early exit is still instant |
  | Fade-in | 3 steps over 120 ms | **Changed:** shown whole at once |
  | Leave (2 per speaker) | 160 ms `steps(4)` fade | **Changed:** drops to half opacity, then goes at the first step at least 160 ms later |
  | Push (stacking) | 160 ms slide in 4 steps | **Changed:** instant |

- **No layout reads.** A `ResizeObserver` (border-box) delivers each new bubble's size from the frame's own layout, before paint. Each pool node has a stacked twin (`.float-twin`): the same box with the speaker's name, `visibility: hidden`, with its words as `attr()` generated content. The twin is sized in the same delivery, so a bubble that stacks takes its width from the twin and is never measured again. A bubble is not placed or shown until both sizes arrive. A bubble said while the stage is hidden reports once it shows.
- **The overlap maths counts only what shows now.** An older bubble's head start is the lower of two numbers: its whole-step lead, and its current rise minus the newer bubble's. Pushes still only grow, and two live bubbles on the same steps keep their gap for as long as both are up.

**Consequences:**
- **Steady state:** no per-frame style work from bubbles. A step costs one small style pass on 4.8 frames a second, and a message costs its own writes plus one ResizeObserver pass.
- **Visual:** the three changed motions above (fade-in, leave and push).
- **Design follow-up:** the set (l) spec (`meta.omega.bubbles`, `assets/src/chatfloat.ts`) still describes the CSS keyframes for the standalone component. If design wants the fade-in or the push slide back, it has to be stepped on the same clock, never a CSS animation.
- **`reflow()` is removed:** there is no animation to restart after the layer was hidden. `stage.ts` no longer observes the layer.
- **Twin drift:** the twin copies `.ui-float`'s box metrics. `e2e/bubbles.e2e.ts` checks that a stacked bubble and its twin measure the same, for short, clamped and unbroken text.
- **Rule for future work:** any long-running decorative CSS animation in the room page has the same per-frame cost while the room renders. Prefer stepped writes on a shared clock.
