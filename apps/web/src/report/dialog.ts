// "Report this room" (OME-601, ADR 0033, set k `ui-m7-report`). A quiet foot key opens a modal <dialog> with the six
// reasons and an optional note; it POSTs `{ reason, note? }` to the server's `/rooms/:id/report` and nothing else (no
// token, no credentials, no referrer) and shows sent / already reported / rate limited / failed. Idle DOM: no frame work.
// Text only: every string goes in via textContent.
import * as v from "valibot";
import { REPORT_NOTE_MAX_LENGTH, REPORT_REASONS, ReportNoteSchema, ReportReasonSchema, ReportResponseSchema, type ReportReason, type ReportRequest, type RoomId } from "@omega/shared";
import { el, sprite } from "../controls/dom";

export interface ReportOptions {
  readonly roomId: RoomId;
  /** The server's HTTP origin. */
  readonly serverUrl: string;
  readonly fetch: (url: string, init: RequestInit) => Promise<Response>;
  /** "Leave room" on the sent panel. */
  readonly leave: () => void;
}

export interface ReportControl {
  /** The foot key: "Report room", then a sunk "Reported" for the rest of the visit. */
  readonly key: HTMLButtonElement;
  readonly dialog: HTMLDialogElement;
  isOpen(): boolean;
  /** Close without sending; focus goes back to the key. */
  close(): void;
  /** This visit already sent a report (received or already reported). */
  reported(): boolean;
}

/** The set (k) rows, in the contract's order. */
const REASON_LABELS: Readonly<Record<ReportReason, string>> = {
  sexual: "Sexual content",
  violence: "Violence or gore",
  hate: "Hate or harassment",
  spam: "Spam or scams",
  danger: "Someone may be in danger",
  other: "Something else",
};

const KEPT = "Your words are still here.";
const OFFLINE = `Check your connection and try again. ${KEPT}`;
const GONE = "This room doesn't exist any more, so there's nothing left to report.";

type Outcome = { readonly sent: true; readonly already: boolean } | { readonly sent: false; readonly text: string; readonly retry: boolean };

function waitText(ms: number | undefined): string {
  if (ms === undefined) return "later";
  const minutes = Math.ceil(ms / 60_000);
  return minutes <= 1 ? "in a minute" : `in ${String(minutes)} minutes`;
}

/** One POST; every way it can go wrong is an Outcome, never a throw. */
async function post(o: ReportOptions, body: ReportRequest): Promise<Outcome> {
  let parsed: ReturnType<typeof v.safeParse<typeof ReportResponseSchema>>;
  try {
    const res = await o.fetch(`${o.serverUrl}/rooms/${encodeURIComponent(o.roomId)}/report`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      credentials: "omit",
      referrerPolicy: "no-referrer",
      cache: "no-store",
    });
    parsed = v.safeParse(ReportResponseSchema, await res.json());
  } catch {
    return { sent: false, text: OFFLINE, retry: true };
  }
  if (!parsed.success) return { sent: false, text: OFFLINE, retry: true };
  const answer = parsed.output;
  if (answer.ok) return { sent: true, already: answer.status === "already_reported" };
  if (answer.error.code === "rate_limited") return { sent: false, text: `Too many reports from here just now. Try again ${waitText(answer.error.retryAfterMs)}. ${KEPT}`, retry: true };
  if (answer.error.code === "room_not_found") return { sent: false, text: GONE, retry: false };
  return { sent: false, text: OFFLINE, retry: true };
}

let instances = 0;

export function createReport(o: ReportOptions): ReportControl {
  const n = String(++instances);
  const key = el("button", { type: "button", className: "ui-button secondary report-key" }, "report-key");
  key.setAttribute("aria-haspopup", "dialog");
  key.append(sprite("ui-icon-report"), "Report room");

  const dialog = el("dialog", { className: "ui-panel report-dialog" }, "report-dialog");
  dialog.setAttribute("aria-modal", "true");

  // The form.
  const formTitle = el("h2", { id: `report-title-${n}` });
  formTitle.append(sprite("ui-icon-report"), "Report this room");
  const form = el("form", { className: "ui-report", noValidate: true }, "report-form");
  const legend = el("legend", { textContent: "What's wrong?" });
  const fieldset = el("fieldset");
  fieldset.append(legend);
  const radios = REPORT_REASONS.map((reason) => {
    const input = el("input", { type: "radio", name: `report-reason-${n}`, value: reason }, "report-reason");
    const label = el("label", { className: "ui-reason" });
    label.append(input, sprite("ui-glyph-radio-off"), REASON_LABELS[reason]);
    fieldset.append(label);
    return input;
  });
  const note = el("textarea", { className: "ui-input", rows: 3, maxLength: REPORT_NOTE_MAX_LENGTH }, "report-note");
  const noteLabel = el("label", { className: "report-note" });
  noteLabel.append("Anything else we should know? ", el("span", { className: "optional", textContent: "(optional)" }), note);
  const noteError = el("p", { id: `report-note-error-${n}`, className: "report-note-error", hidden: true }, "report-note-error");
  const count = el("span", { id: `report-count-${n}`, className: "count", textContent: `0 / ${String(REPORT_NOTE_MAX_LENGTH)}` }, "report-count");
  note.setAttribute("aria-describedby", count.id);
  const cancel = el("button", { type: "button", className: "ui-button secondary", textContent: "Cancel" }, "report-cancel");
  const send = el("button", { type: "submit", className: "ui-button", textContent: "Send report", disabled: true }, "report-send");
  const formActs = el("div", { className: "acts" });
  formActs.append(cancel, send);
  form.append(formTitle, el("p", { textContent: "Tell the people who run omega-share what's wrong. It goes to them only, not to the host or anyone in the room." }), fieldset, noteLabel, noteError, count, formActs);

  // Sent.
  const sentTitle = el("h2", { id: `report-sent-title-${n}` });
  sentTitle.append(sprite("ui-glyph-check"), "Thanks, we got it");
  const already = el("p", { textContent: "You already reported this room. One report is enough.", hidden: true }, "report-already");
  const leave = el("button", { type: "button", className: "ui-button secondary" }, "report-leave");
  leave.append(sprite("ui-icon-leave"), "Leave room");
  const closeKey = el("button", { type: "button", className: "ui-button", textContent: "Close" }, "report-close");
  const sentActs = el("div", { className: "acts" });
  sentActs.append(leave, closeKey);
  const sent = el("section", { className: "ui-report", hidden: true }, "report-sent");
  sent.append(sentTitle, el("p", { textContent: "Someone will look at this room. We can't reply here. If you'd rather not stay, you can leave at any time." }), already, sentActs);

  // Couldn't send.
  const failedTitle = el("h2", { id: `report-failed-title-${n}` });
  failedTitle.append(sprite("ui-icon-warn"), "That didn't send");
  const failedText = el("p", { role: "alert" }, "report-failed-text");
  const failedCancel = el("button", { type: "button", className: "ui-button secondary", textContent: "Cancel" }, "report-failed-cancel");
  const retry = el("button", { type: "button", className: "ui-button" }, "report-retry");
  retry.append(sprite("ui-icon-retry"), "Try again");
  const failedActs = el("div", { className: "acts" });
  failedActs.append(failedCancel, retry);
  const failed = el("section", { className: "ui-report", hidden: true }, "report-failed");
  failed.append(failedTitle, failedText, failedActs);

  dialog.append(form, sent, failed);

  let done = false;
  let sending = false;
  let lastBody: ReportRequest | null = null;

  const picked = (): ReportReason | null => {
    const r = radios.find((x) => x.checked);
    return r === undefined ? null : v.parse(ReportReasonSchema, r.value);
  };
  const show = (panel: HTMLElement, title: HTMLElement): void => {
    for (const p of [form, sent, failed]) p.hidden = p !== panel;
    dialog.setAttribute("aria-labelledby", title.id);
  };
  const syncForm = (): void => {
    send.disabled = sending || picked() === null;
    for (const r of radios) {
      const glyph = r.nextElementSibling;
      if (glyph !== null) glyph.className = `ui-sprite ${r.checked ? "ui-glyph-radio-on" : "ui-glyph-radio-off"}`;
    }
  };
  const setInvalid = (on: boolean): void => {
    noteError.hidden = !on;
    noteError.textContent = on ? "Plain text only, please, or leave it empty." : "";
    if (on) {
      note.setAttribute("aria-invalid", "true");
      note.setAttribute("aria-describedby", `${noteError.id} ${count.id}`);
    } else {
      note.removeAttribute("aria-invalid");
      note.setAttribute("aria-describedby", count.id);
    }
  };
  const sink = (): void => {
    key.replaceChildren(sprite("ui-glyph-check"), "Reported");
    key.setAttribute("aria-disabled", "true");
    key.classList.add("is-disabled");
    key.removeAttribute("aria-haspopup");
  };

  const close = (): void => {
    if (dialog.open) dialog.close();
    if (done) sink();
    key.focus();
  };

  const deliver = async (body: ReportRequest): Promise<void> => {
    sending = true;
    lastBody = body;
    send.disabled = true;
    retry.disabled = true;
    const out = await post(o, body);
    sending = false;
    retry.disabled = false;
    syncForm();
    if (out.sent) {
      done = true;
      // Closed while the answer was out: nothing will close it again, so the key sinks now.
      if (!dialog.open) sink();
      already.hidden = !out.already;
      show(sent, sentTitle);
      closeKey.focus();
      return;
    }
    failedText.textContent = out.text;
    retry.hidden = !out.retry;
    show(failed, failedTitle);
    (out.retry ? retry : failedCancel).focus();
  };

  key.addEventListener("click", () => {
    if (done || dialog.open) return;
    show(form, formTitle);
    dialog.showModal();
    (radios.find((r) => r.checked) ?? radios[0])?.focus();
  });
  fieldset.addEventListener("change", syncForm);
  note.addEventListener("input", () => {
    count.textContent = `${String(note.value.length)} / ${String(REPORT_NOTE_MAX_LENGTH)}`;
    if (note.hasAttribute("aria-invalid")) setInvalid(false);
  });
  form.addEventListener("submit", (ev) => {
    ev.preventDefault();
    const reason = picked();
    if (sending || reason === null) return;
    let body: ReportRequest = { reason };
    if (note.value.trim() !== "") {
      const parsed = v.safeParse(ReportNoteSchema, note.value);
      if (!parsed.success) {
        setInvalid(true);
        note.focus();
        return;
      }
      body = { reason, note: parsed.output };
    }
    void deliver(body);
  });
  cancel.addEventListener("click", close);
  failedCancel.addEventListener("click", close);
  closeKey.addEventListener("click", close);
  retry.addEventListener("click", () => {
    if (!sending && lastBody !== null) void deliver(lastBody);
  });
  leave.addEventListener("click", () => {
    close();
    o.leave();
  });
  // Esc: our own close, so focus lands on the key.
  dialog.addEventListener("cancel", (ev) => {
    ev.preventDefault();
    if (!sending) close();
  });
  // The browser may close it anyway (a second Esc): the key still gets focus back.
  dialog.addEventListener("close", () => {
    if (done) sink();
    if (document.activeElement === document.body || document.activeElement === null) key.focus();
  });
  // Focus is trapped inside: Tab past the last control wraps to the first, and back.
  dialog.addEventListener("keydown", (ev) => {
    if (ev.key !== "Tab") return;
    const panel = [form, sent, failed].find((p) => !p.hidden);
    if (panel === undefined) return;
    const stops = [...panel.querySelectorAll<HTMLElement>("input, textarea, button")].filter((e) => !(e instanceof HTMLButtonElement && e.disabled) && !e.hidden && !(e instanceof HTMLInputElement && e.type === "radio" && !e.checked && radios.some((r) => r.checked)));
    const first = stops[0];
    const last = stops.at(-1);
    if (first === undefined || last === undefined) return;
    if (!ev.shiftKey && document.activeElement === last) {
      ev.preventDefault();
      first.focus();
    } else if (ev.shiftKey && (document.activeElement === first || (document.activeElement instanceof HTMLInputElement && radios.includes(document.activeElement)))) {
      ev.preventDefault();
      last.focus();
    }
  });

  return { key, dialog, isOpen: () => dialog.open, close, reported: () => done };
}
