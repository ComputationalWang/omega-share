import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { REPORT_KEY_REFILL_MS, REPORT_NOTE_MAX_LENGTH } from "@omega/shared";

// OME-601 (ADR 0033, set k `ui-m7-report`): "Report this room". A quiet foot key opens a modal dialog with six reasons and an
// optional note; it sends `{ reason, note? }` to `POST /rooms/:id/report` and nothing else, and shows sent / already reported /
// rate limited / failed. Text only.

beforeAll(() => {
  GlobalRegistrator.register();
});
afterAll(async () => {
  await GlobalRegistrator.unregister();
});

const SERVER = "http://srv.test";
const ROOM = "movie-night";

interface Call {
  readonly url: string;
  readonly init: RequestInit;
}

type Answer = Response | Error | Promise<Response>;

const json = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const RECEIVED = (): Response => json(202, { ok: true, status: "received" });

async function setup(answers: Answer[] = [RECEIVED()]) {
  const { createReport } = await import("../src/report/dialog");
  const calls: Call[] = [];
  let left = 0;
  const pending: Answer[] = [...answers];
  const report = createReport({
    roomId: ROOM,
    serverUrl: SERVER,
    fetch: (url, init) => {
      calls.push({ url, init });
      const a = pending.shift() ?? RECEIVED();
      return a instanceof Error ? Promise.reject(a) : a instanceof Promise ? a : Promise.resolve(a);
    },
    leave: () => {
      left++;
    },
  });
  document.body.replaceChildren(report.key, report.dialog);
  const q = <T extends Element>(sel: string): T => {
    const e = report.dialog.querySelector<T>(sel);
    if (e === null) throw new Error(`no ${sel}`);
    return e;
  };
  const reasons = (): HTMLInputElement[] => [...report.dialog.querySelectorAll<HTMLInputElement>("[data-testid=report-reason]")];
  const pick = (value: string): void => {
    const r = reasons().find((x) => x.value === value);
    if (r === undefined) throw new Error(`no reason ${value}`);
    r.click();
  };
  const note = (): HTMLTextAreaElement => q<HTMLTextAreaElement>("[data-testid=report-note]");
  const type = (text: string): void => {
    note().value = text;
    note().dispatchEvent(new Event("input", { bubbles: true }));
  };
  const send = q<HTMLButtonElement>("[data-testid=report-send]");
  const settle = async (): Promise<void> => {
    for (let i = 0; i < 10; i++) await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
  };
  const bodyOf = (i: number): unknown => JSON.parse(String(calls[i]?.init.body));
  const visible = (id: string): boolean => {
    const e = report.dialog.querySelector<HTMLElement>(`[data-testid=${id}]`);
    if (e === null) return false;
    for (let n: HTMLElement | null = e; n !== null && n !== report.dialog; n = n.parentElement) if (n.hidden) return false;
    return true;
  };
  return { report, calls, left: () => left, reasons, pick, note, type, send, settle, bodyOf, q, visible };
}

describe("the foot key", () => {
  test("is a secondary key with words (never an icon alone) that says it opens a dialog", async () => {
    const { report } = await setup();
    expect(report.key.textContent).toBe("Report room");
    expect(report.key.classList.contains("secondary")).toBe(true);
    expect(report.key.getAttribute("aria-haspopup")).toBe("dialog");
    expect(report.key.dataset["testid"]).toBe("report-key");
  });

  test("opens a labelled modal dialog: title, the 'goes to them only' line, six reasons in the contract's order", async () => {
    const { report, reasons } = await setup();
    expect(report.isOpen()).toBe(false);
    report.key.click();
    expect(report.isOpen()).toBe(true);
    expect(report.dialog.open).toBe(true);
    const labelledBy = report.dialog.getAttribute("aria-labelledby") ?? "";
    expect(document.getElementById(labelledBy)?.textContent).toBe("Report this room");
    expect(report.dialog.textContent).toContain("It goes to them only, not to the host or anyone in the room.");
    expect(reasons().map((r) => r.value)).toEqual(["sexual", "violence", "hate", "spam", "danger", "other"]);
    expect(reasons().map((r) => r.closest("label")?.textContent)).toEqual(["Sexual content", "Violence or gore", "Hate or harassment", "Spam or scams", "Someone may be in danger", "Something else"]);
    expect(report.dialog.querySelector("fieldset legend")?.textContent).toBe("What's wrong?");
  });

  test("focus opens on the first reason; Send stays off until a reason is picked", async () => {
    const { report, reasons, pick, send } = await setup();
    report.key.click();
    expect(document.activeElement).toBe(reasons()[0] ?? null);
    expect(send.disabled).toBe(true);
    pick("hate");
    expect(send.disabled).toBe(false);
    // The picked row shows the "on" glyph, the rest "off".
    const glyphs = reasons().map((r) => r.closest("label")?.querySelector(".ui-glyph-radio-on") !== null);
    expect(glyphs).toEqual([false, false, true, false, false, false]);
  });

  test("Cancel and Esc (the dialog's cancel) close it and give focus back to the key; a pick and the words stay", async () => {
    const { report, pick, type, q, note, reasons } = await setup();
    report.key.click();
    pick("spam");
    type("buy coins");
    q<HTMLButtonElement>("[data-testid=report-cancel]").click();
    expect(report.isOpen()).toBe(false);
    expect(document.activeElement).toBe(report.key);
    report.key.click();
    expect(note().value).toBe("buy coins");
    // Focus opens on the picked reason.
    expect(document.activeElement).toBe(reasons()[3] ?? null);
    report.dialog.dispatchEvent(new Event("cancel", { cancelable: true }));
    expect(report.isOpen()).toBe(false);
    expect(document.activeElement).toBe(report.key);
  });
});

describe("what it sends (ADR 0033: only reason and note)", () => {
  test("POSTs JSON { reason } to the server's /rooms/:id/report when the note is blank (\"\" would fail the parse)", async () => {
    const { report, pick, type, send, calls, bodyOf, settle } = await setup();
    report.key.click();
    pick("sexual");
    type("   ");
    send.click();
    await settle();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(`${SERVER}/rooms/${ROOM}/report`);
    expect(calls[0]?.init.method).toBe("POST");
    expect(new Headers(calls[0]?.init.headers).get("content-type")).toBe("application/json");
    expect(bodyOf(0)).toEqual({ reason: "sexual" });
    // No credentials, no referrer: nothing about the reporter rides along.
    expect(calls[0]?.init.credentials).toBe("omit");
    expect(calls[0]?.init.referrerPolicy).toBe("no-referrer");
  });

  test("sends the note as the contract parses it: line breaks become one space, trimmed", async () => {
    const { report, pick, type, send, bodyOf, settle } = await setup();
    report.key.click();
    pick("hate");
    type("  The chat keeps posting\n\nslurs at people who join.  ");
    send.click();
    await settle();
    expect(bodyOf(0)).toEqual({ reason: "hate", note: "The chat keeps posting slurs at people who join." });
  });

  test("the note is bounded to the contract's 300 and counts what's typed", async () => {
    const { report, note, type, q } = await setup();
    report.key.click();
    expect(note().maxLength).toBe(REPORT_NOTE_MAX_LENGTH);
    type("The chat keeps posting slurs at people who join.");
    expect(q("[data-testid=report-count]").textContent).toBe("47 / 300");
    expect(note().getAttribute("aria-describedby")).toBe(q("[data-testid=report-count]").id);
  });

  test("a note the contract refuses (only invisible characters) is flagged on the field and nothing is sent", async () => {
    const { report, pick, type, send, calls, note, settle, q } = await setup();
    report.key.click();
    pick("other");
    type("​​");
    send.click();
    await settle();
    expect(calls).toHaveLength(0);
    expect(note().getAttribute("aria-invalid")).toBe("true");
    expect(q("[data-testid=report-note-error]").textContent).toBe("Plain text only, please, or leave it empty.");
    expect(document.activeElement).toBe(note());
    type("ok now");
    expect(note().hasAttribute("aria-invalid")).toBe(false);
  });

  test("one send at a time: a second click while the first is out sends nothing", async () => {
    let release: (r: Response) => void = () => undefined;
    const slow = new Promise<Response>((r) => {
      release = r;
    });
    const { report, pick, send, calls, settle, visible } = await setup([slow]);
    report.key.click();
    pick("spam");
    send.click();
    send.click();
    expect(calls).toHaveLength(1);
    expect(send.disabled).toBe(true);
    release(RECEIVED());
    await settle();
    expect(visible("report-sent")).toBe(true);
  });
});

describe("answers", () => {
  test("received: 'Thanks, we got it', focus on Close; Close returns to a sunk 'Reported' key for the rest of the visit", async () => {
    const { report, pick, send, settle, q, visible } = await setup([RECEIVED()]);
    report.key.click();
    pick("violence");
    send.click();
    await settle();
    expect(visible("report-sent")).toBe(true);
    expect(visible("report-form")).toBe(false);
    expect(q("[data-testid=report-sent] h2").textContent).toBe("Thanks, we got it");
    expect(q("[data-testid=report-sent]").textContent).toContain("Someone will look at this room. We can't reply here.");
    expect(visible("report-already")).toBe(false);
    const close = q<HTMLButtonElement>("[data-testid=report-close]");
    expect(document.activeElement).toBe(close);
    close.click();
    expect(report.isOpen()).toBe(false);
    expect(report.key.textContent).toBe("Reported");
    expect(report.key.querySelector(".ui-glyph-check")).not.toBeNull();
    // Sunk with aria-disabled, not disabled: focus comes back to it instead of falling to the page, and it opens nothing.
    expect(report.key.getAttribute("aria-disabled")).toBe("true");
    expect(document.activeElement).toBe(report.key);
    report.key.click();
    expect(report.isOpen()).toBe(false);
    expect(report.reported()).toBe(true);
  });

  test("already reported is a success too, plus a line that says so", async () => {
    const { report, pick, send, settle, q, visible } = await setup([json(200, { ok: true, status: "already_reported" })]);
    report.key.click();
    pick("spam");
    send.click();
    await settle();
    expect(visible("report-sent")).toBe(true);
    expect(visible("report-already")).toBe(true);
    expect(q("[data-testid=report-already]").textContent).toBe("You already reported this room. One report is enough.");
    q<HTMLButtonElement>("[data-testid=report-close]").click();
    expect(report.reported()).toBe(true);
  });

  test("Leave room on the sent panel leaves", async () => {
    const { report, pick, send, settle, q, left } = await setup();
    report.key.click();
    pick("danger");
    send.click();
    await settle();
    q<HTMLButtonElement>("[data-testid=report-leave]").click();
    expect(left()).toBe(1);
  });

  test("offline: 'That didn't send' in an alert, keeps the reason and the words, and Try again sends the same", async () => {
    const { report, pick, type, send, settle, q, visible, calls, bodyOf, note, reasons } = await setup([new TypeError("network"), RECEIVED()]);
    report.key.click();
    pick("hate");
    type("slurs");
    send.click();
    await settle();
    expect(visible("report-failed")).toBe(true);
    expect(q("[data-testid=report-failed] h2").textContent).toBe("That didn't send");
    const why = q("[data-testid=report-failed-text]");
    expect(why.getAttribute("role")).toBe("alert");
    expect(why.textContent).toBe("Check your connection and try again. Your words are still here.");
    const retry = q<HTMLButtonElement>("[data-testid=report-retry]");
    expect(visible("report-retry")).toBe(true);
    expect(document.activeElement).toBe(retry);
    expect(note().value).toBe("slurs");
    expect(reasons()[2]?.checked).toBe(true);
    retry.click();
    await settle();
    expect(calls).toHaveLength(2);
    expect(bodyOf(1)).toEqual(bodyOf(0));
    expect(visible("report-sent")).toBe(true);
  });

  test("rate limited: says how long to wait, from retryAfterMs, and offers Try again", async () => {
    const { report, pick, send, settle, q, visible } = await setup([json(429, { ok: false, error: { code: "rate_limited", message: "too many", retryAfterMs: 9 * 60_000 + 1 } })]);
    report.key.click();
    pick("spam");
    send.click();
    await settle();
    expect(visible("report-failed")).toBe(true);
    expect(q("[data-testid=report-failed-text]").textContent).toBe("Too many reports from here just now. Try again in 10 minutes. Your words are still here.");
    expect(visible("report-retry")).toBe(true);
  });

  test("rate limited without a wait, or under a minute, still reads plainly", async () => {
    const a = await setup([json(429, { ok: false, error: { code: "rate_limited", message: "too many" } })]);
    a.report.key.click();
    a.pick("spam");
    a.send.click();
    await a.settle();
    expect(a.q("[data-testid=report-failed-text]").textContent).toBe("Too many reports from here just now. Try again later. Your words are still here.");
    const b = await setup([json(429, { ok: false, error: { code: "rate_limited", message: "too many", retryAfterMs: 20_000 } })]);
    b.report.key.click();
    b.pick("spam");
    b.send.click();
    await b.settle();
    expect(b.q("[data-testid=report-failed-text]").textContent).toBe("Too many reports from here just now. Try again in a minute. Your words are still here.");
  });

  test("the room is gone (404): says so, no Try again", async () => {
    const { report, pick, send, settle, q, visible } = await setup([json(404, { ok: false, error: { code: "room_not_found", message: "no such room" } })]);
    report.key.click();
    pick("other");
    send.click();
    await settle();
    expect(q("[data-testid=report-failed-text]").textContent).toBe("This room doesn't exist any more, so there's nothing left to report.");
    expect(visible("report-retry")).toBe(false);
    expect(document.activeElement).toBe(q("[data-testid=report-failed-cancel]"));
  });

  test("unavailable, a 500 or an answer that doesn't parse is a plain failure with Try again", async () => {
    for (const answer of [
      json(503, { ok: false, error: { code: "unavailable", message: "later" } }),
      new Response("<html>bad gateway</html>", { status: 502 }),
      json(202, { ok: true, status: "received", reportId: 7 }),
      json(429, { ok: false, error: { code: "rate_limited", message: "x", retryAfterMs: REPORT_KEY_REFILL_MS + 1 } }),
    ]) {
      const { report, pick, send, settle, q, visible } = await setup([answer]);
      report.key.click();
      pick("other");
      send.click();
      await settle();
      expect(visible("report-failed")).toBe(true);
      expect(q("[data-testid=report-failed-text]").textContent).toBe("Check your connection and try again. Your words are still here.");
      expect(visible("report-retry")).toBe(true);
    }
  });

  test("Cancel on the failed panel closes, and the key can reopen the form with the words kept", async () => {
    const { report, pick, type, send, settle, q, visible, note } = await setup([new TypeError("offline")]);
    report.key.click();
    pick("hate");
    type("slurs");
    send.click();
    await settle();
    q<HTMLButtonElement>("[data-testid=report-failed-cancel]").click();
    expect(report.isOpen()).toBe(false);
    expect(document.activeElement).toBe(report.key);
    expect(report.key.hasAttribute("aria-disabled")).toBe(false);
    report.key.click();
    expect(visible("report-form")).toBe(true);
    expect(note().value).toBe("slurs");
  });
});

describe("text only", () => {
  test("nothing in the dialog is built from markup", async () => {
    const { report } = await setup();
    expect(report.dialog.querySelectorAll("a, iframe, img, script")).toHaveLength(0);
  });
});
