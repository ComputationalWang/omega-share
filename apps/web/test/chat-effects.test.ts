import { describe, expect, test } from "bun:test";
import { chatSticker, createStickerGate, HELP_LINE, isShout, meAction, POLL_USAGE_LINE, ROLL_USAGE_LINE, rollSticker, slashCommand, STICKER_GAP_MS, thinkText } from "../src/chat/effects";

// OME-1349: chat effects at zero wire cost. Slash commands send the existing `emote`; chat stickers and the shout
// bubble are read locally from the relayed text.

describe("slashCommand", () => {
  test("each emote's name after a slash is that emote, any case, spaces around ignored", () => {
    for (const kind of ["wave", "clap", "cheer", "yawn", "heart", "laugh", "question", "exclaim", "dance"] as const) {
      expect(slashCommand(`/${kind}`)).toEqual({ type: "emote", kind });
    }
    expect(slashCommand("  /WAVE ")).toEqual({ type: "emote", kind: "wave" });
  });

  test("/help is help", () => {
    expect(slashCommand("/help")).toEqual({ type: "help" });
  });

  // OME-1426: /roll dice, 2..100 sides; a d6 by default.
  test("/roll is a d6; /roll 20 and /roll d20 roll that many sides, any case, spaces around ignored", () => {
    expect(slashCommand("/roll")).toEqual({ type: "roll", sides: 6 });
    expect(slashCommand("/roll 20")).toEqual({ type: "roll", sides: 20 });
    expect(slashCommand(" /ROLL D20 ")).toEqual({ type: "roll", sides: 20 });
    expect(slashCommand("/roll 2")).toEqual({ type: "roll", sides: 2 });
    expect(slashCommand("/roll d100")).toEqual({ type: "roll", sides: 100 });
  });

  test("any other /roll is the usage hint: out of range, not a whole number, extra words", () => {
    for (const text of ["/roll 1", "/roll 101", "/roll 0", "/roll -5", "/roll 2.5", "/roll d", "/roll two", "/roll 2d6", "/roll 20 now", "/roll 1e1", "/roll 020x"]) {
      expect(slashCommand(text)).toEqual({ type: "roll-usage" });
    }
    expect(ROLL_USAGE_LINE.verb).toContain("/roll");
    expect(ROLL_USAGE_LINE.self).toBe(true);
  });

  test("/rolling is not /roll: it's chat", () => {
    expect(slashCommand("/rolling")).toBeNull();
  });

  // OME-1501: /sit toggles sitting on the floor.
  test("/sit is the floor sit toggle, any case, spaces around ignored; /sitting is chat", () => {
    expect(slashCommand("/sit")).toEqual({ type: "sit" });
    expect(slashCommand("  /SIT ")).toEqual({ type: "sit" });
    expect(slashCommand("/sitting")).toBeNull();
    expect(slashCommand("/sit down")).toBeNull();
  });

  test("/help names /sit", () => {
    expect(HELP_LINE.verb).toContain("/sit");
  });

  // OME-1547: aliases for the existing emotes; they return the same emote, so they go through the same token bucket.
  test("each alias is its emote, any case, spaces around ignored", () => {
    const aliases = { lol: "laugh", yay: "cheer", love: "heart", hi: "wave", bye: "wave", wow: "exclaim", hmm: "question", sleepy: "yawn" } as const;
    for (const [alias, kind] of Object.entries(aliases)) expect(slashCommand(`/${alias}`)).toEqual({ type: "emote", kind });
    expect(slashCommand(" /LOL ")).toEqual({ type: "emote", kind: "laugh" });
    for (const text of ["/lolz", "/hi there", "/byebye", "/wowow"]) expect(slashCommand(text)).toBeNull();
  });

  test("/help lists each alias under the emote it maps to", () => {
    expect(HELP_LINE.verb).toContain("/heart (/love)");
    expect(HELP_LINE.verb).toContain("/laugh (/lol)");
    expect(HELP_LINE.verb).toContain("/question (/hmm)");
    expect(HELP_LINE.verb).toContain("/exclaim (/wow)");
    expect(HELP_LINE.verb).toContain("/wave (/hi /bye)");
    expect(HELP_LINE.verb).toContain("/cheer (/yay)");
    expect(HELP_LINE.verb).toContain("/yawn (/sleepy)");
    expect(HELP_LINE.verb).toContain("/clap ");
  });

  test("/help names /roll", () => {
    expect(HELP_LINE.verb).toContain("/roll");
  });

  test("anything else is chat: unknown commands, words after a command, no slash, a slash mid-line", () => {
    for (const text of ["/x", "/dancing", "/wave hi", "wave", "hi /wave", "/", "//wave", "/ wave"]) expect(slashCommand(text)).toBeNull();
  });
});

describe("rollSticker", () => {
  test("a max roll pops the cheer sticker; anything lower pops nothing", () => {
    expect(rollSticker(20, 20)).toBe("cheer");
    expect(rollSticker(6, 6)).toBe("cheer");
    expect(rollSticker(20, 19)).toBeNull();
    expect(rollSticker(6, 1)).toBeNull();
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
    for (const text of ["hello", "really?", "whoa!", "lollipop", "aloha", "ha", "shahaha", "3 < 4"]) expect(chatSticker(text)).toBeNull();
  });

  // OME-1547: more triggers into the same stickers.
  test(":) is a heart, :D and xD a laugh, gg a cheer, wow a surprise, hi all and bye all a wave", () => {
    expect(chatSticker("nice :)")).toBe("heart");
    expect(chatSticker(":D")).toBe("laugh");
    expect(chatSticker("that cat xD")).toBe("laugh");
    expect(chatSticker("XD")).toBe("laugh");
    expect(chatSticker("gg")).toBe("cheer");
    expect(chatSticker("GG everyone")).toBe("cheer");
    expect(chatSticker("wow")).toBe("exclaim");
    expect(chatSticker("Wow, look")).toBe("exclaim");
    expect(chatSticker("hi all")).toBe("wave");
    expect(chatSticker("Bye all, see you")).toBe("wave");
  });

  test("a trigger inside a longer word pops nothing", () => {
    for (const text of ["ggplot", "eggs", "egg", "wowza", "kowow", "0xDEAD", "xDraw", "boxD", ":Day", "chi all", "hi alley", "maybe allright", "goodbye all"]) {
      expect(chatSticker(text)).toBeNull();
    }
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

// OME-1375: `/me <text>` is a plain chat line on the wire; every client reads it as an action ("Sam waves").
describe("meAction", () => {
  test("/me and a space, then words, is that action, trimmed; any case", () => {
    expect(meAction("/me waves at the screen")).toBe("waves at the screen");
    expect(meAction("  /ME   dances  ")).toBe("dances");
  });

  test("anything else is not: no words after it, no space, mid-line, other commands", () => {
    for (const text of ["/me", "/me ", "/meow", "/mewaves", "hi /me waves", "me waves", "/wave", "//me waves"]) expect(meAction(text)).toBeNull();
  });

  test("/me is plain chat to the slash parser: it goes on the wire as a chat line", () => {
    expect(slashCommand("/me waves")).toBeNull();
  });

  test("/help lists /me", () => {
    expect(HELP_LINE.verb).toContain("/me");
  });
});

// OME-1454: /poll Question? A | B | C. The question is the text up to and including the first "?", the options are
// what follows, split on "|" and trimmed. Anything the server would refuse is the usage hint, and nothing is sent.
describe("/poll", () => {
  test("a question and 2 to 4 options opens a poll", () => {
    expect(slashCommand("/poll Next video? A | B | C")).toEqual({ type: "poll", question: "Next video?", options: ["A", "B", "C"] });
    expect(slashCommand("  /POLL  Pizza?   Yes|No  ")).toEqual({ type: "poll", question: "Pizza?", options: ["Yes", "No"] });
    expect(slashCommand("/poll Pick? a | b | c | d")?.type).toBe("poll");
  });

  test("a later ? belongs to the options", () => {
    expect(slashCommand("/poll Go? Yes? | No")).toEqual({ type: "poll", question: "Go?", options: ["Yes?", "No"] });
  });

  test("anything else is the usage hint: no question mark, no question, too few or too many options, empty or too long parts", () => {
    const long = "x".repeat(41);
    for (const text of ["/poll", "/poll hello", "/poll ? A | B", "/poll Q?", "/poll Q? A", "/poll Q? A |", "/poll Q? A | | B", "/poll Q? a | b | c | d | e", `/poll Q? A | ${long}`, `/poll ${"q".repeat(80)}? A | B`]) {
      expect(slashCommand(text)).toEqual({ type: "poll-usage" });
    }
    expect(POLL_USAGE_LINE.verb).toContain("/poll");
    expect(POLL_USAGE_LINE.self).toBe(true);
  });

  test("/polls is not /poll: it's chat; /help names /poll", () => {
    expect(slashCommand("/polls")).toBeNull();
    expect(HELP_LINE.verb).toContain("/poll");
  });
});

// OME-1465: `/think <text>` is a plain chat line on the wire; every client draws it as a thought.
describe("thinkText", () => {
  test("/think and a space, then words, is that thought, trimmed; any case", () => {
    expect(thinkText("/think is this live?")).toBe("is this live?");
    expect(thinkText("  /THINK   hmm  ")).toBe("hmm");
  });

  test("anything else is not: no words after it, no space, mid-line, /me, other commands", () => {
    for (const text of ["/think", "/think ", "/thinking", "/thinkhmm", "hi /think hmm", "think hmm", "/me hmm", "//think hmm"]) expect(thinkText(text)).toBeNull();
  });

  test("/think is plain chat to the slash parser and not a /me action", () => {
    expect(slashCommand("/think hmm")).toBeNull();
    expect(meAction("/think hmm")).toBeNull();
  });

  test("/help lists /think", () => {
    expect(HELP_LINE.verb).toContain("/think <thought>");
  });
});
