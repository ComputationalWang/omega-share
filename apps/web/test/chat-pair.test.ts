import { describe, expect, test } from "bun:test";
import { COMMANDS, commandsFor } from "../src/chat/commands";
import { HELP_LINE, helpLine, pairInvitedLine, slashCommand } from "../src/chat/effects";

// OME-1672: /thrust and /bendover exist only in a room whose layout has `pairs: true` (the Dank Dungeon).

const names = (pairs: boolean): string[] => commandsFor(pairs).flatMap((c) => (c.section === "moves" ? [] : [c.name]));

describe("/thrust and /bendover", () => {
  test("with pairs on they are pair commands", () => {
    expect(slashCommand("/thrust", true)).toEqual({ type: "pair", pose: "thrust" });
    expect(slashCommand("  /BENDOVER ", true)).toEqual({ type: "pair", pose: "bendover" });
  });

  test("elsewhere they don't exist: chat, never a command", () => {
    expect(slashCommand("/thrust")).toBeNull();
    expect(slashCommand("/bendover", false)).toBeNull();
  });

  test("with an argument they are chat, like an emote", () => {
    expect(slashCommand("/thrust @bob", true)).toBeNull();
  });

  test("not in /help or the palette's table unless pairs are on", () => {
    expect(names(false)).not.toContain("thrust");
    expect(names(false)).not.toContain("bendover");
    expect(names(true)).toContain("thrust");
    expect(names(true)).toContain("bendover");
    expect(commandsFor(false)).toBe(COMMANDS);
    expect(HELP_LINE.verb).not.toMatch(/thrust|bendover/);
    expect(helpLine(false)).toEqual(HELP_LINE);
    expect(helpLine(true).verb).toMatch(/\/thrust/);
    expect(helpLine(true).verb).toMatch(/\/bendover/);
  });
});

describe("pairInvitedLine", () => {
  test("names the pose to answer with", () => {
    expect(pairInvitedLine("Bob", false, "thrust").verb).toBe("wants to /thrust, to join in use /bendover");
    expect(pairInvitedLine("Bob", false, "bendover").verb).toBe("wants to /bendover, to join in use /thrust");
    expect(pairInvitedLine("Bob", false, "thrust").actor).toBe("Bob");
  });

  test("my own reads in the second person", () => {
    expect(pairInvitedLine("Bob", true, "thrust")).toMatchObject({ actor: "You", verb: "want to /thrust, to join in use /bendover" });
  });
});
