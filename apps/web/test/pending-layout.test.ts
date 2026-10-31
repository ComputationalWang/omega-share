import { describe, expect, test } from "bun:test";
import { classic } from "./support/preset-layouts";
import type { ClientMessage } from "@omega/shared";
import { createPendingApplier, pendingLayoutKey, pendingViaKey, stashVia, takeVia, pendingShareKey, shareableLink, stashPendingLayout, stashPendingShare, takePendingLayout, takePendingShare } from "../src/pending-layout";
import { stashPendingEnter, takePendingEnter } from "../src/session-record";

const ROOM = "abcdefghijklmnopqrstuvwxyz";
const OWN = ["omega.example"];
const YT = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";

class MemoryStore {
  readonly data = new Map<string, string>();
  getItem(k: string): string | null {
    return this.data.get(k) ?? null;
  }
  setItem(k: string, value: string): void {
    this.data.set(k, value);
  }
  removeItem(k: string): void {
    this.data.delete(k);
  }
}

describe("pending layout (saved layout chosen at room creation)", () => {
  test("keyed per room in sessionStorage", () => {
    expect(pendingLayoutKey(ROOM)).toBe(`omega.pendingLayout.${ROOM}`);
  });

  test("a stashed layout is taken once, then it is gone", () => {
    const s = new MemoryStore();
    expect(stashPendingLayout(s, ROOM, classic)).toBe(true);
    expect(takePendingLayout(s, ROOM)).toEqual(classic);
    expect(s.data.size).toBe(0);
    expect(takePendingLayout(s, ROOM)).toBeNull();
  });

  test("nothing stashed, garbage and an invalid layout all read as null, and the key is cleared", () => {
    const s = new MemoryStore();
    expect(takePendingLayout(s, ROOM)).toBeNull();
    for (const raw of ["not json{", "{}", '{"furniture":[{"kind":"tv"}]}', "null"]) {
      s.data.set(pendingLayoutKey(ROOM), raw);
      expect(takePendingLayout(s, ROOM)).toBeNull();
      expect(s.data.size).toBe(0);
    }
  });

  describe("applyPendingLayout (on the room page)", () => {
    const setup = (): { s: MemoryStore; sent: ClientMessage[]; apply: ReturnType<typeof createPendingApplier> } => {
      const s = new MemoryStore();
      const sent: ClientMessage[] = [];
      const apply = createPendingApplier(
        s,
        ROOM,
        (m) => {
          sent.push(m);
          return true;
        },
        OWN,
      );
      return { s, sent, apply };
    };

    test("sends one layout-set once the joiner is the owner and the first snapshot is in, then clears the key", () => {
      const { s, sent, apply } = setup();
      stashPendingLayout(s, ROOM, classic);
      apply({ owner: false, hasRoom: false });
      apply({ owner: true, hasRoom: false });
      expect(sent).toEqual([]);
      apply({ owner: true, hasRoom: true });
      apply({ owner: true, hasRoom: true });
      expect(sent).toEqual([{ type: "layout-set", layout: classic }]);
      expect(s.data.size).toBe(0);
    });

    test("a guest (not the owner) leaves the key alone and sends nothing", () => {
      const { s, sent, apply } = setup();
      stashPendingLayout(s, ROOM, classic);
      apply({ owner: false, hasRoom: true });
      expect(sent).toEqual([]);
      expect(s.data.size).toBe(1);
    });

    test("a shared link (OME-1085) goes in as one queue-add, after the layout, then the key is gone", () => {
      const { s, sent, apply } = setup();
      stashPendingLayout(s, ROOM, classic);
      stashPendingShare(s, ROOM, YT);
      apply({ owner: false, hasRoom: true });
      expect(sent).toEqual([]);
      apply({ owner: true, hasRoom: true });
      apply({ owner: true, hasRoom: true });
      expect(sent).toEqual([{ type: "layout-set", layout: classic }, { type: "queue-add", url: YT }]);
      expect(s.data.size).toBe(0);
    });

    test("a shared link alone is sent; one edited in storage into something unplayable is not", () => {
      const { s, sent, apply } = setup();
      stashPendingShare(s, ROOM, YT);
      apply({ owner: true, hasRoom: true });
      expect(sent).toEqual([{ type: "queue-add", url: YT }]);
      const second = setup();
      second.s.data.set(pendingShareKey(ROOM), "javascript:alert(1)");
      second.apply({ owner: true, hasRoom: true });
      expect(second.sent).toEqual([]);
      expect(second.s.data.size).toBe(0);
    });

    test("nothing stashed or an invalid layout sends nothing", () => {
      const { s, sent, apply } = setup();
      apply({ owner: true, hasRoom: true });
      expect(sent).toEqual([]);
      const second = setup();
      second.s.data.set(pendingLayoutKey(ROOM), '{"furniture":[{"kind":"tv"}]}');
      second.apply({ owner: true, hasRoom: true });
      expect(second.sent).toEqual([]);
      expect(second.s.data.size).toBe(0);
      expect(s.data.size).toBe(0);
    });
  });

  test("a storage that throws never throws out of either call", () => {
    const boom = {
      getItem: (): string | null => {
        throw new Error("x");
      },
      setItem: (): void => {
        throw new Error("x");
      },
      removeItem: (): void => {
        throw new Error("x");
      },
    };
    expect(stashPendingLayout(boom, ROOM, classic)).toBe(false);
    expect(takePendingLayout(boom, ROOM)).toBeNull();
  });
});

describe("pending share (a #share= link from the extension, OME-1085)", () => {
  test("keyed per room in sessionStorage", () => {
    expect(pendingShareKey(ROOM)).toBe(`omega.pendingShare.${ROOM}`);
  });

  test("shareableLink takes what the queue takes: synced providers and the generic tier, trimmed", () => {
    expect(shareableLink(` ${YT} `, OWN)).toBe(YT);
    expect(shareableLink("https://vimeo.com/76979871", OWN)).toBe("https://vimeo.com/76979871");
    expect(shareableLink("https://videos.example.org/watch/1", OWN)).toBe("https://videos.example.org/watch/1");
  });

  test("shareableLink drops anything the queue would refuse", () => {
    for (const raw of ["", "not a link", "javascript:alert(1)", "http://videos.example.org/1", "https://127.0.0.1/x", "https://omega.example/r/abc", `https://example.com/${"a".repeat(3000)}`]) {
      expect(shareableLink(raw, OWN)).toBeNull();
    }
  });

  test("stashed once, taken once; a throwing storage never throws", () => {
    const s = new MemoryStore();
    expect(stashPendingShare(s, ROOM, YT)).toBe(true);
    expect(takePendingShare(s, ROOM, OWN)).toBe(YT);
    expect(takePendingShare(s, ROOM, OWN)).toBeNull();
    const boom = {
      getItem: (): string | null => {
        throw new Error("x");
      },
      setItem: (): void => {
        throw new Error("x");
      },
      removeItem: (): void => {
        throw new Error("x");
      },
    };
    expect(stashPendingShare(boom, ROOM, YT)).toBe(false);
    expect(takePendingShare(boom, ROOM, OWN)).toBeNull();
  });
});

// OME-1558: Go on a door chip leaves the room I came from for the next room's join (`join.via`). It hops in
// sessionStorage (this tab only), keyed by the room it is for, never in the URL, and is parsed again when taken.
describe("via (the room I came through a door from)", () => {
  const FROM = "e2e-doors-from";
  test("stashed for the door's room, taken once by that room only", () => {
    const s = new MemoryStore();
    expect(stashVia(s, ROOM, FROM)).toBe(true);
    expect(s.data.get(pendingViaKey(ROOM))).toBe(FROM);
    expect(takeVia(s, "some-other-room")).toBeNull();
    expect(takeVia(s, ROOM)).toBe(FROM);
    expect(s.data.size).toBe(0);
    expect(takeVia(s, ROOM)).toBeNull();
  });
  test("anything that is not a room id reads as null and is cleared", () => {
    const s = new MemoryStore();
    for (const raw of ["", "a b", "x".repeat(200), "../r/evil"]) {
      s.data.set(pendingViaKey(ROOM), raw);
      expect(takeVia(s, ROOM)).toBeNull();
      expect(s.data.size).toBe(0);
    }
  });
  test("blocked storage never throws", () => {
    const blocked = {
      getItem: (): string | null => {
        throw new Error("blocked");
      },
      setItem: (): void => {
        throw new Error("blocked");
      },
      removeItem: (): void => {
        throw new Error("blocked");
      },
    };
    expect(stashVia(blocked, ROOM, FROM)).toBe(false);
    expect(takeVia(blocked, ROOM)).toBeNull();
  });
});

describe("pending enter (the creator goes straight in, OME-2075)", () => {
  test("stashed once per room, taken once", () => {
    const s = new MemoryStore();
    expect(takePendingEnter(s, ROOM)).toBe(false);
    stashPendingEnter(s, ROOM);
    expect(takePendingEnter(s, "other")).toBe(false);
    expect(takePendingEnter(s, ROOM)).toBe(true);
    expect(s.data.size).toBe(0);
    expect(takePendingEnter(s, ROOM)).toBe(false);
  });

  test("a storage that throws reads as no intent", () => {
    const boom = {
      getItem: (): string | null => {
        throw new Error("x");
      },
      setItem: (): void => {
        throw new Error("x");
      },
      removeItem: (): void => {
        throw new Error("x");
      },
    };
    expect(() => {
      stashPendingEnter(boom, ROOM);
    }).not.toThrow();
    expect(takePendingEnter(boom, ROOM)).toBe(false);
  });
});
