import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { ExtensionBridge } from "../src/extension-bridge";

// A real DOM for this file only; the other web tests stay DOM-free.
beforeAll(() => {
  GlobalRegistrator.register({ url: "https://omega.example/r/main" });
});
afterAll(async () => {
  await GlobalRegistrator.unregister();
});

const PRESENT = { source: "omega-share", kind: "present", version: "1.4.0" };
const result = (host: string, outcome: string) => ({ source: "omega-share", kind: "unlock-result", host, outcome });

/** Each test gets its own page window, so bridges from earlier tests can't answer (one bridge per page in the app). */
function newPage(posted: { msg: unknown; target: string }[]) {
  return Object.assign(new EventTarget(), {
    location: { origin: "https://omega.example" },
    postMessage: (msg: unknown, target: string) => {
      posted.push({ msg, target });
    },
  });
}
let page = newPage([]);

/** A message as the extension's content script would post it, unless overridden. */
function deliver(data: unknown, init: { origin?: string; source?: unknown } = {}): void {
  const e = new MessageEvent("message", { data, origin: init.origin ?? page.location.origin });
  Object.defineProperty(e, "source", { value: "source" in init ? init.source : page });
  page.dispatchEvent(e);
}

async function make(): Promise<{ bridge: ExtensionBridge; posted: { msg: unknown; target: string }[] }> {
  const posted: { msg: unknown; target: string }[] = [];
  page = newPage(posted);
  const { createExtensionBridge } = await import("../src/extension-bridge");
  return { bridge: createExtensionBridge(page), posted };
}

function presentCalls(bridge: ExtensionBridge): () => number {
  let n = 0;
  bridge.whenPresent(() => {
    n += 1;
  });
  return () => n;
}

describe("extension bridge (ADR 0047 §5)", () => {
  test("present from our own window and origin is heard; a later subscriber hears it at once", async () => {
    const { bridge } = await make();
    const calls = presentCalls(bridge);
    expect(calls()).toBe(0);
    deliver(PRESENT);
    expect(calls()).toBe(1);
    const late = presentCalls(bridge);
    expect(late()).toBe(1);
  });

  test("ignores another origin, another source and anything that doesn't parse", async () => {
    const { bridge } = await make();
    const calls = presentCalls(bridge);
    deliver(PRESENT, { origin: "https://evil.example" });
    deliver(PRESENT, { source: null });
    deliver(PRESENT, { source: window });
    deliver({ ...PRESENT, source: "someone-else" });
    deliver({ ...PRESENT, extra: 1 });
    deliver("present");
    expect(calls()).toBe(0);
  });

  test("unlock posts the host to our origin only and resolves with the matching result", async () => {
    const { bridge, posted } = await make();
    deliver(PRESENT);
    const outcome = bridge.unlock("media.example.org");
    expect(posted).toEqual([{ msg: { source: "omega-share", kind: "unlock", host: "media.example.org" }, target: "https://omega.example" }]);
    deliver(result("other.example.org", "unlocked"));
    deliver(result("media.example.org", "unlocked"), { origin: "https://evil.example" });
    deliver(result("media.example.org", "denied"));
    expect(await outcome).toBe("denied");
  });

  test("relock posts only when something is or may be unlocked", async () => {
    const { bridge, posted } = await make();
    deliver(PRESENT);
    bridge.relock();
    expect(posted).toHaveLength(0);
    const outcome = bridge.unlock("media.example.org");
    deliver(result("media.example.org", "unlocked"));
    expect(await outcome).toBe("unlocked");
    bridge.relock();
    expect(posted.at(-1)?.msg).toEqual({ source: "omega-share", kind: "relock" });
    bridge.relock();
    expect(posted).toHaveLength(2);
  });

  test("an unlock that lands after the embed changed is dropped again", async () => {
    const { bridge, posted } = await make();
    deliver(PRESENT);
    void bridge.unlock("media.example.org");
    bridge.relock();
    expect(posted).toHaveLength(2);
    deliver(result("media.example.org", "unlocked"));
    expect(posted).toHaveLength(3);
    expect(posted.at(-1)?.msg).toEqual({ source: "omega-share", kind: "relock" });
  });
});
