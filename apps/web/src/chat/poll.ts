// The poll card (OME-1454, ADR 0055): DOM only, pinned above the chat log in the page and in the pop-out. Options are real
// buttons (aria-pressed marks mine); counts and bars follow the poll as it changes, in place, so focus stays on the
// button just pressed. One 1 s interval ticks the countdown, and it runs only while the card is up.
import { el } from "../controls/dom";

/** What the card shows, and what the room tab relays to a pop-out (popout/channel.ts parses it). `endsAt` is client wall time. */
export interface PollView {
  readonly pollId: string;
  readonly question: string;
  readonly options: readonly string[];
  readonly counts: readonly number[];
  /** The option I voted for. */
  readonly vote: number | null;
  /** I opened it, or I own the room. */
  readonly canClose: boolean;
  readonly endsAt: number;
}

export interface PollCardOptions<H> {
  /** Client wall time, ms (Date.now). */
  readonly now: () => number;
  readonly setInterval: (fn: () => void, ms: number) => H;
  readonly clearTimer: (h: H) => void;
  readonly vote: (option: number) => void;
  readonly close: () => void;
}

export interface PollCard {
  readonly root: HTMLElement;
  show(v: PollView): void;
  hide(): void;
}

interface Row {
  readonly button: HTMLButtonElement;
  readonly label: HTMLElement;
  readonly count: HTMLElement;
  readonly bar: HTMLElement;
}

const setText = (e: HTMLElement, text: string): void => {
  if (e.textContent !== text) e.textContent = text;
};

export function createPollCard<H>(o: PollCardOptions<H>): PollCard {
  const root = el("div", { className: "ui-panel poll-card", hidden: true, role: "group", ariaLabel: "Poll" }, "poll-card");
  const question = el("p", { className: "poll-question" });
  const left = el("span", { className: "poll-left" });
  const head = el("div", { className: "poll-head" });
  head.append(question, left);
  const list = el("div", { className: "poll-options" });
  const close = el("button", { type: "button", className: "ui-button secondary poll-close", textContent: "Close poll", hidden: true }, "poll-close");
  root.append(head, list, close);
  close.addEventListener("click", o.close);

  let rows: Row[] = [];
  let pollId: string | null = null;
  let endsAt = 0;
  let timer: H | null = null;
  const tick = (): void => {
    setText(left, `${String(Math.max(0, Math.ceil((endsAt - o.now()) / 1000)))}s`);
  };

  return {
    root,
    show(v) {
      if (v.pollId !== pollId || rows.length !== v.options.length) {
        pollId = v.pollId;
        rows = v.options.map((label, i) => {
          const button = el("button", { type: "button", className: "ui-button poll-option" }, "poll-option");
          const bar = el("span", { className: "poll-bar", ariaHidden: "true" });
          const text = el("span", { className: "poll-label", textContent: label });
          const count = el("span", { className: "poll-n" }, "poll-count");
          button.append(bar, text, count);
          button.addEventListener("click", () => {
            o.vote(i);
          });
          return { button, label: text, count, bar };
        });
        list.replaceChildren(...rows.map((r) => r.button));
      }
      const total = v.counts.reduce((a, b) => a + b, 0);
      rows.forEach((r, i) => {
        const n = v.counts[i] ?? 0;
        setText(r.count, String(n));
        r.bar.style.width = `${String(total === 0 ? 0 : Math.round((n / total) * 100))}%`;
        r.button.setAttribute("aria-pressed", String(v.vote === i));
      });
      setText(question, v.question);
      close.hidden = !v.canClose;
      endsAt = v.endsAt;
      tick();
      root.hidden = false;
      timer ??= o.setInterval(tick, 1000);
    },
    hide() {
      if (timer !== null) o.clearTimer(timer);
      timer = null;
      pollId = null;
      root.hidden = true;
    },
  };
}
