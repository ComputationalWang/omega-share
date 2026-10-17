import { describe, expect, test } from "bun:test";
import { chatSticker, createStickerGate, isShout, slashCommand, STICKER_GAP_MS } from "../src/chat/effects";

// OME-1349: chat effects at zero wire cost. Slash commands send the existing `emote`; chat stickers and the shout
// bubble are read locally from the relayed text.

describe("slashCommand", () => {
  test("each emote's name after a slash is that emote, any case, spaces around ignored", () => {
    for (const kind of ["wave", "clap", "cheer", "yawn", "heart", "laugh", "question", "exclaim"] as const) {
      expect(slashCommand(`/${kind}`)).toEqual({ type: "emote", kind });
    }
    expect(slashCommand("  /WAVE ")).toEqual({ type: "emote", kind: "wave" });
  });

  test("/help is help", () => {
    expect(slashCommand("/help")).toEqual({ type: "help" });
  });

  test("anything else is chat: unknown commands, words after a command, no slash, a slash mid-line", () => {
    for (const text of ["/x", "/dance", "/wave hi", "wave", "hi /wave", "/", "//wave", "/ wave"]) expect(slashCommand(text)).toBeNull();
  });
});

describe("chatSticker", () => {
  test("<3 is a heart, lol and haha a laugh, !! a surprise, ?? a question", () => {
    expect(chatSticker("love this <3")).toBe("heart");
    expect(chatSticker("lol")).toBe("laugh");
    expect(chatSticker("LOL that cat")).toBe("laugh");
    expect(chatSticker("hahaha")).toBe("laugh");
    expect(chatSticker("no way!!")).toBe("exclaim");
    expect(chatSticker("what??")).toBe("question");
  });

  test("plain lines, a single ! or ?, and lol or haha inside a word pop nothing", () => {
    for (const text of ["hello", "really?", "wow!", "lollipop", "aloha", "ha", "shahaha", "3 < 4"]) expect(chatSticker(text)).toBeNull();
  });
});

describe("isShout", () => {
  test("all caps with at least 4 letters is a shout", () => {
    expect(isShout("GOAL")).toBe(true);
    expect(isShout("NO WAY!!")).toBe(true);
    expect(isShout("ÇA VA")).toBe(true);
  });

  test("fewer than 4 letters, any lowercase, or no cased letters is not", () => {
    for (const text of ["LOL", "OK!", "Goal", "GOAL is here", "1234!!", "", "日本語です"]) expect(isShout(text)).toBe(false);
  });
});

describe("sticker gate", () => {
  test("one sticker per member per 3 s; members are counted apart", () => {
    const gate = createStickerGate();
    expect(STICKER_GAP_MS).toBe(3000);
    expect(gate.allow("a", 1000)).toBe(true);
    expect(gate.allow("a", 3999)).toBe(false);
    expect(gate.allow("b", 3999)).toBe(true);
    expect(gate.allow("a", 4000)).toBe(true);
  });

  test("a line that was gated doesn't restart the 3 s", () => {
    const gate = createStickerGate();
    gate.allow("a", 0);
    gate.allow("a", 2000);
    expect(gate.allow("a", 3000)).toBe(true);
  });
});
