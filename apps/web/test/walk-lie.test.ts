import { describe, expect, test } from "bun:test";
import * as v from "valibot";
import { AVATAR_COUNT, FURNITURE, type FurnitureKind } from "@omega/shared";
import { FramesSchema } from "../src/walk/motion";
import { AVATAR_IDS } from "../src/walk/avatar-ids";
import { LIE_MS, isLieFrame, lieKeys, lieOffset } from "../src/walk/lie";
import type { Dir } from "../src/walk/walks";

// OME-1691: the lying sheet's keys, breath and per-piece offsets are read off assets/avatars/lying.json; the web copies are pinned here.
const Point = v.object({ x: v.number(), y: v.number() });
const sheet = v.parse(
  v.object({
    frames: FramesSchema,
    meta: v.object({ omega: v.object({ anims: v.record(v.string(), v.object({ frames: v.array(v.string()), ms: v.array(v.number()) })), pieces: v.record(v.string(), v.object({ style: v.string(), dirs: v.record(v.string(), Point), beside: v.optional(v.record(v.string(), Point)) })) }) }),
  }),
  await Bun.file(new URL("../../../assets/avatars/lying.json", import.meta.url)).json(),
);
const DIRS: readonly Dir[] = ["se", "sw", "ne", "nw"];

describe("lie keys", () => {
  test("every avatar and facing the art has gets its two frames, and they are frames of the sheet", () => {
    for (let avatar = 0; avatar < AVATAR_COUNT; avatar++) {
      for (const dir of DIRS) {
        const id = AVATAR_IDS[avatar] ?? "";
        const lie = lieKeys("lie", avatar, dir);
        const curl = lieKeys("curl", avatar, dir);
        expect(lie).toEqual([`lie/${id}/${dir}/0`, `lie/${id}/${dir}/1`]);
        if (dir === "ne" || dir === "nw") expect(curl).toBeUndefined();
        else expect(curl).toEqual([`curl/${id}/${dir}/0`, `curl/${id}/${dir}/1`]);
        // The bed's sleepers (OME-2008): every facing.
        const sleep = lieKeys("sleep", avatar, dir);
        expect(sleep).toEqual([`sleep/${id}/${dir}/0`, `sleep/${id}/${dir}/1`]);
        for (const k of [...(lie ?? []), ...(curl ?? []), ...(sleep ?? [])]) expect(sheet.frames[k]).toBeDefined();
      }
    }
  });

  test("the breath is the sheet's anim", () => {
    for (const anim of Object.values(sheet.meta.omega.anims)) expect(anim.ms).toEqual([...LIE_MS]);
  });

  test("only the lying sheet's frames are lie frames", () => {
    expect(isLieFrame("lie/juno/se/0")).toBe(true);
    expect(isLieFrame("curl/pip/sw/1")).toBe(true);
    expect(isLieFrame("sleep/mo/ne/0")).toBe(true);
    for (const k of ["juno/sit/se", "walk/juno/se/0", "thrust/juno/se/0", "bendover/mo/sw/0", "wave/kiki/idle/se/0", "emote/heart/0"]) expect(isLieFrame(k)).toBe(false);
  });
});

describe("lie offsets", () => {
  test("each piece's offsets are the sheet's meta.omega.pieces, and a piece without them has none", () => {
    expect(Object.keys(sheet.meta.omega.pieces)).toContain("bed");
    for (const [kind, piece] of Object.entries(sheet.meta.omega.pieces)) {
      expect(FURNITURE[kind as FurnitureKind].lie).toBe(piece.style as "lie" | "curl" | "sleep");
      for (const dir of DIRS) {
        expect(lieOffset(kind as FurnitureKind, dir)).toEqual(piece.dirs[dir]);
        expect(lieOffset(kind as FurnitureKind, dir, 0)).toEqual(piece.dirs[dir]);
        // The bed's second sleeper (OME-2009) lies `beside` the first; a one-lier piece has no second spot.
        expect(lieOffset(kind as FurnitureKind, dir, 1)).toEqual(piece.beside?.[dir]);
      }
    }
    expect(lieOffset("lamp", "se")).toBeUndefined();
    expect(lieOffset("cat", "ne")).toBeUndefined();
  });
});
