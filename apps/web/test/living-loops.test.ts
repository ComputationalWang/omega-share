import { describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import * as v from "valibot";
import { RoomLayoutSchema } from "@omega/shared";
import { FurnitureManifestSchema, sceneOf } from "../src/furniture";

// OME-2558: the revamped Living ("Movie night by the fire") loops at rest on the shared ambient tick with exactly the fire
// under the screen and the long-case clock's pendulum; the aquarium has no loop.

const DIR = new URL("../../../assets/furniture/", import.meta.url);
const load = async (path: string): Promise<unknown> => Bun.file(new URL(path, DIR)).json();
const sheets = readdirSync(DIR).filter((f) => /^furniture(-v\d+)?\.json$/.test(f));
const manifests = await Promise.all(sheets.map(async (f) => v.parse(FurnitureManifestSchema, await load(f))));
const living = v.parse(RoomLayoutSchema, await Bun.file(new URL("../../../assets/presets/living.json", import.meta.url)).json());

describe("Living at rest", () => {
  test("loops fireplace/stone and longclock/wood, nothing else", () => {
    const s = sceneOf(living, manifests);
    const looping = new Map<number, string>();
    // One loop per piece: `furniture/<id>/<colour>/…` of any of its ambient sprites.
    for (const x of s.sprites) if (x.use?.ambient === true) looping.set(x.use.piece, x.key.split("/").slice(1, 3).join("/"));
    expect([...looping.values()].sort()).toEqual(["fireplace/stone", "longclock/wood"]);
  });
});
