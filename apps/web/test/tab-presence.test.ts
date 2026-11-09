import { describe, expect, test } from "bun:test";
import type { ResumeRecord } from "@omega/shared";
import { createTabPresence, type TabChannel } from "../src/tab-presence";

// OME-2429: a second tab of this browser, refused for a name that is ours in the first one, hears it from that tab over
// a same-origin BroadcastChannel (no wire change) and can take the session over.

const record: ResumeRecord = { roomId: "abcdefghijklmnopqrstuvwxyz", token: "A".repeat(43), nickname: "zoe", avatar: 1 };

/** Channels that deliver to every other channel on the same bus, synchronously. */
function bus() {
  const all: TabChannel[] = [];
  const make = (): TabChannel => {
    const ch: TabChannel = {
      onmessage: null,
      postMessage: (data: unknown) => {
        for (const o of all) if (o !== ch) o.onmessage?.(new MessageEvent("message", { data }));
      },
      close: () => {
        all.splice(all.indexOf(ch), 1);
      },
    };
    all.push(ch);
    return ch;
  };
  return { make, all };
}

function timers() {
  const fns: (() => void)[] = [];
  return { setTimer: (fn: () => void) => { fns.push(fn); }, fire: () => { for (const f of fns.splice(0)) f(); } };
}

describe("tab presence (OME-2429)", () => {
  test("a tab in the room as zoe answers a new tab asking for zoe; the new one hears it's open elsewhere", () => {
    const b = bus();
    const t = timers();
    createTabPresence({ channel: b.make(), nickname: "zoe", here: () => record, onElsewhere: () => undefined, setTimer: t.setTimer });
    let told = 0;
    const second = createTabPresence({ channel: b.make(), nickname: "zoe", here: () => null, onElsewhere: () => { told++; }, setTimer: t.setTimer });
    second.ask();
    expect(told).toBe(1);
    expect(second.elsewhere()).toBe(true);
  });

  test("another name, or a tab not in the room, says nothing", () => {
    const b = bus();
    const t = timers();
    createTabPresence({ channel: b.make(), nickname: "ann", here: () => ({ ...record, nickname: "ann" }), onElsewhere: () => undefined, setTimer: t.setTimer });
    createTabPresence({ channel: b.make(), nickname: "zoe", here: () => null, onElsewhere: () => undefined, setTimer: t.setTimer });
    const second = createTabPresence({ channel: b.make(), nickname: "zoe", here: () => null, onElsewhere: () => undefined, setTimer: t.setTimer });
    second.ask();
    expect(second.elsewhere()).toBe(false);
  });

  test("take hands the other tab's session over", async () => {
    const b = bus();
    const t = timers();
    createTabPresence({ channel: b.make(), nickname: "zoe", here: () => record, onElsewhere: () => undefined, setTimer: t.setTimer });
    const second = createTabPresence({ channel: b.make(), nickname: "zoe", here: () => null, onElsewhere: () => undefined, setTimer: t.setTimer });
    expect(await second.take()).toEqual(record);
  });

  test("take with nobody answering gives up with null", async () => {
    const b = bus();
    const t = timers();
    const second = createTabPresence({ channel: b.make(), nickname: "zoe", here: () => null, onElsewhere: () => undefined, setTimer: t.setTimer });
    const took = second.take();
    t.fire();
    expect(await took).toBeNull();
  });

  test("anything else on the channel is dropped: a bad record is never taken", async () => {
    const b = bus();
    const t = timers();
    const rogue = b.make();
    const second = createTabPresence({ channel: b.make(), nickname: "zoe", here: () => null, onElsewhere: () => undefined, setTimer: t.setTimer });
    rogue.onmessage = () => {
      rogue.postMessage({ t: "record", record: { ...record, token: "short" } });
      rogue.postMessage({ t: "here", nickname: 5 });
      rogue.postMessage("junk");
    };
    const took = second.take();
    t.fire();
    expect(await took).toBeNull();
    second.ask();
    expect(second.elsewhere()).toBe(false);
  });
});
