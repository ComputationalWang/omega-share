// The chat log (OME-594, M7 W1, set k): one capped list for the room page, the full-screen strip (W2) and the pop-out
// (W3). DOM, text only. A message is one append and, at the cap, one removal of the oldest: nothing is redrawn.
// Lines age by tone, never by alpha (assets/ui/reference.css .ui-fs-line): fresh → settled at 6 s → faded at 20 s, the
// last only where the log fades (the strip). One timer for the whole log, and nothing ages while the pointer or focus is
// in it (WCAG 2.2.2): the hold is added to every line's age when it ends. The one-frame scrim on a turn is CSS, and
// prefers-reduced-motion drops it (style.css).
import type { SystemLine } from "../controls/sysline";
import { el, syslineEl } from "../controls/dom";

/** Lines kept; older ones are dropped from the DOM. */
export const CHAT_LOG_CAP = 50;
export const SETTLE_MS = 6000;
export const FADE_MS = 20_000;

export type ChatLogEntry =
  | { readonly kind: "chat"; readonly nickname: string; readonly text: string; readonly self: boolean }
  | { readonly kind: "system"; readonly line: SystemLine };

/** "settle": lines stop at settled (room page, pop-out, phone). "fade": they go on to faded (full-screen strip). */
export type ChatLogAgeing = "settle" | "fade";

export interface ChatLogOptions<H> {
  readonly ageing: ChatLogAgeing;
  readonly cap?: number;
  readonly label?: string;
  readonly now: () => number;
  readonly setTimer: (fn: () => void, ms: number) => H;
  readonly clearTimer: (h: H) => void;
}

export interface ChatLog {
  readonly root: HTMLOListElement;
  append(entry: ChatLogEntry): void;
  setAgeing(ageing: ChatLogAgeing): void;
}

interface Line {
  readonly el: HTMLLIElement;
  /** When it arrived, pushed later by every hold since. */
  born: number;
  /** 0 fresh, 1 settled, 2 faded. */
  stage: 0 | 1 | 2;
}

function lineEl(entry: ChatLogEntry): HTMLLIElement {
  if (entry.kind === "system") {
    const li = el("li", { className: "chat-log-sys" }, "chat-log-line");
    li.append(syslineEl(entry.line));
    return li;
  }
  const li = el("li", { className: entry.self ? "ui-fs-line chat-log-line self" : "ui-fs-line chat-log-line" }, "chat-log-line");
  li.append(el("b", { textContent: entry.nickname }), ` ${entry.text}`);
  return li;
}

export function createChatLog<H>(opts: ChatLogOptions<H>): ChatLog {
  const cap = opts.cap ?? CHAT_LOG_CAP;
  let ageing = opts.ageing;
  const root = el("ol", { className: "ui-fs-lines chat-log", tabIndex: 0 }, "chat-log");
  root.setAttribute("role", "log");
  root.setAttribute("aria-live", "polite");
  root.setAttribute("aria-label", opts.label ?? "Chat messages");
  root.dataset["ageing"] = ageing;
  // Oldest first; lines arrive in order, so they come due in order too.
  const lines: Line[] = [];
  let timer: H | null = null;
  /** When the armed timer is due. */
  let armedAt = 0;
  let hovered = false;
  let focused = false;
  let heldSince: number | null = null;

  const last = (): 1 | 2 => (ageing === "fade" ? 2 : 1);
  const dueAt = (l: Line): number => l.born + (l.stage === 0 ? SETTLE_MS : FADE_MS);

  const setStage = (l: Line, stage: 0 | 1 | 2): void => {
    l.stage = stage;
    l.el.classList.toggle("is-settled", stage === 1);
    l.el.classList.toggle("is-faded", stage === 2);
  };

  const schedule = (): void => {
    if (timer !== null) opts.clearTimer(timer);
    timer = null;
    if (heldSince !== null) return;
    let next: number | null = null;
    for (const l of lines) {
      if (l.stage >= last()) continue;
      const at = dueAt(l);
      if (next === null || at < next) next = at;
      // A fresh line is due before any later one: no need to look further.
      if (l.stage === 0) break;
    }
    if (next === null) return;
    armedAt = next;
    timer = opts.setTimer(tick, Math.max(0, next - opts.now()));
  };

  function tick(): void {
    timer = null;
    const now = opts.now();
    for (const l of lines) {
      while (l.stage < last() && dueAt(l) <= now) setStage(l, l.stage === 0 ? 1 : 2);
    }
    schedule();
  }

  const hold = (): void => {
    const held = hovered || focused;
    if (held && heldSince === null) {
      heldSince = opts.now();
      schedule();
    } else if (!held && heldSince !== null) {
      const d = opts.now() - heldSince;
      heldSince = null;
      for (const l of lines) l.born += d;
      schedule();
    }
  };
  root.addEventListener("pointerenter", () => {
    hovered = true;
    hold();
  });
  root.addEventListener("pointerleave", () => {
    hovered = false;
    hold();
  });
  root.addEventListener("focusin", () => {
    focused = true;
    hold();
  });
  root.addEventListener("focusout", () => {
    focused = false;
    hold();
  });

  return {
    root,
    append(entry) {
      // Stick to the foot if the reader is there; someone scrolled up to read stays put.
      const atFoot = root.scrollHeight - root.scrollTop - root.clientHeight <= 2;
      const line: Line = { el: lineEl(entry), born: heldSince ?? opts.now(), stage: 0 };
      lines.push(line);
      root.append(line.el);
      if (lines.length > cap) lines.shift()?.el.remove();
      if (atFoot) root.scrollTop = root.scrollHeight;
      // In fade mode the armed timer may be an older line's fade, due after this line settles.
      if (heldSince === null && (timer === null || dueAt(line) < armedAt)) schedule();
    },
    setAgeing(next) {
      if (next === ageing) return;
      ageing = next;
      root.dataset["ageing"] = next;
      if (next === "settle") for (const l of lines) if (l.stage === 2) setStage(l, 1);
      schedule();
    },
  };
}
