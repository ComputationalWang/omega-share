// Room layout corpora (OME-1157): RoomLayoutSchema, RoomLayoutInputSchema, layoutSeats and footprintCells.
import { readFileSync } from "node:fs";
import * as v from "valibot";
import { DEFAULT_LAYOUT, FACINGS, FURNITURE, FURNITURE_KINDS, RoomLayoutInputSchema, RoomLayoutSchema, footprintCells, layoutSeats } from "../../../packages/shared/src/layout";
import type { Case, Corpus } from "./corpora";

type Piece = Record<string, unknown>;
const TV: Piece = { kind: "tv", col: 0, row: 0, facing: "se" };
const SEATS = [[1, 5], [2, 4], [4, 2], [5, 1], [3, 7], [4, 6], [6, 4], [7, 3]] as const;
const chair = (col: number, row: number): Piece => ({ kind: "armchair", col, row, facing: col < row ? "ne" : "nw" });
const CHAIRS = SEATS.map(([c, r]) => chair(c, r));
const layout = (...furniture: unknown[]): unknown => ({ furniture });
/** A valid room around `p`: the TV, `p`, and as many chairs as keep the seat total at eight. */
const around = (p: Piece): unknown => {
  const own = layoutSeats({ furniture: [p as never] }).length;
  return layout(TV, p, ...CHAIRS.slice(0, Math.max(0, 8 - own)));
};
const base = (...more: unknown[]): unknown => layout(TV, ...CHAIRS, ...more);

const parsed = (schema: v.GenericSchema, inputs: readonly unknown[]): Case[] =>
  inputs.map((input) => {
    const r = v.safeParse(schema, input);
    return r.success ? { input, ok: true, output: r.output } : { input, ok: false };
  });

const preset = (id: string): unknown => JSON.parse(readFileSync(new URL(`../../../assets/presets/${id}.json`, import.meta.url), "utf8"));
const PRESETS = ["classic", "cinema", "living", "lounge", "cafe", "empty"].map(preset);

const POSITIONS = [[0, 0], [0, 9], [9, 0], [9, 9], [4, 4], [5, 0], [0, 5], [8, 0], [0, 8], [2, 0], [0, 2], [9, 5], [3, 9]] as const;
const everyKindEveryFacing = (): unknown[] =>
  FURNITURE_KINDS.flatMap((kind) => FACINGS.flatMap((facing) => POSITIONS.map(([col, row]) => around({ kind, col, row, facing }))));

/** Each kind at a spot that suits it, with `variant` at and around its limit and of every wrong type. */
const variants = (): unknown[] =>
  FURNITURE_KINDS.flatMap((kind) => {
    const spec = FURNITURE[kind];
    const facing = spec.facings[0];
    const at = spec.layer === "wall" ? (facing === "se" ? { col: 0, row: 2 } : { col: 2, row: 0 }) : { col: 4, row: 4 };
    return [undefined, 0, spec.variants - 1, spec.variants, spec.variants + 1, -1, 0.5, 1.5, "0", null, true, [0], {}].map((variant) =>
      around({ kind, ...at, facing, ...(variant === undefined ? {} : { variant }) }),
    );
  });

const cellGrid = (): unknown[] =>
  [-1, 10, 11, 0.5, 1.5, -0.5, 255, 256, 1e9, "1", null, true, [], {}].flatMap((x) => [
    around({ kind: "plant", col: x, row: 4, facing: "se" }),
    around({ kind: "plant", col: 4, row: x, facing: "se" }),
  ]);

const counts = (): unknown[] => {
  const used = new Set(["0,0", ...SEATS.map(([c, r]) => `${c},${r}`)]);
  const free: Piece[] = [];
  for (let c = 0; c < 10; c++) for (let r = 0; r < 10; r++) if (!used.has(`${c},${r}`)) free.push({ kind: "sidetable", col: c, row: r, facing: "sw" });
  const spare = [chair(9, 9), chair(9, 8), chair(8, 9), chair(8, 8), chair(9, 7)];
  const tvs = (n: number): Piece[] => [[9, 9], [9, 8], [8, 9]].slice(0, n).map(([col, row]) => ({ kind: "tv", col, row, facing: "se" }));
  return [
    layout(...CHAIRS),
    layout(...CHAIRS, TV),
    layout(...CHAIRS, TV, ...tvs(1)),
    layout(...CHAIRS, TV, ...tvs(2)),
    ...Array.from({ length: 13 }, (_, n) => layout(TV, ...CHAIRS.slice(0, Math.min(n, 8)), ...spare.slice(0, Math.max(0, n - 8)))),
    base({ kind: "sofa", col: 8, row: 8, facing: "ne" }),
    layout(TV, ...CHAIRS.slice(1), { kind: "sofa", col: 8, row: 8, facing: "ne" }),
    layout(TV, ...CHAIRS.slice(2), { kind: "sofa", col: 8, row: 8, facing: "ne" }),
    ...[22, 23, 24, 25].map((n) => base(...free.slice(0, n))),
    layout(),
    layout(TV),
    base(...free.slice(0, 22), { kind: "rug", col: 1, row: 1, facing: "se" }, { kind: "runner", col: 7, row: 8, facing: "ne" }),
  ];
};

const overlaps = (): unknown[] => [
  base({ kind: "plant", col: 0, row: 0, facing: "se" }),
  base({ kind: "plant", col: 1, row: 5, facing: "se" }),
  base({ kind: "sofa", col: 0, row: 5, facing: "ne" }),
  base({ kind: "sofa", col: 3, row: 5, facing: "ne" }),
  base({ kind: "rug", col: 1, row: 1, facing: "se" }),
  base({ kind: "rug", col: 1, row: 1, facing: "se" }, { kind: "rug", col: 3, row: 3, facing: "se" }),
  base({ kind: "rug", col: 1, row: 1, facing: "se" }, { kind: "runner", col: 2, row: 2, facing: "ne" }),
  base({ kind: "rug", col: 1, row: 1, facing: "se" }, { kind: "runner", col: 7, row: 8, facing: "ne" }),
  base({ kind: "rug", col: 0, row: 0, facing: "se" }),
  base({ kind: "runner", col: 3, row: 5, facing: "nw" }),
  base({ kind: "runner", col: 3, row: 5, facing: "ne" }, { kind: "runner", col: 5, row: 6, facing: "ne" }),
  base({ kind: "runner", col: 3, row: 5, facing: "ne" }, { kind: "runner", col: 5, row: 5, facing: "ne" }),
  base({ kind: "lamp", col: 9, row: 0, facing: "se" }, { kind: "lamp", col: 9, row: 0, facing: "se" }),
  base({ kind: "bookshelf", col: 3, row: 0, facing: "sw" }, { kind: "bookshelf", col: 4, row: 0, facing: "sw" }),
  base({ kind: "bookshelf", col: 3, row: 0, facing: "sw" }, { kind: "bookshelf", col: 5, row: 0, facing: "sw" }),
];

const wallPieces = (): unknown[] => {
  const out: unknown[] = [];
  for (const kind of ["frame", "wallshelf", "garland", "bookshelf"] as const)
    for (let i = 0; i < 10; i++) {
      out.push(around({ kind, col: i, row: 0, facing: "sw" }), around({ kind, col: 0, row: i, facing: "se" }));
      out.push(around({ kind, col: i, row: 1, facing: "sw" }), around({ kind, col: 1, row: i, facing: "se" }));
      out.push(around({ kind, col: i, row: 0, facing: "se" }), around({ kind, col: 0, row: i, facing: "sw" }));
    }
  out.push(
    base({ kind: "frame", col: 2, row: 0, facing: "sw" }, { kind: "frame", col: 2, row: 0, facing: "sw", variant: 1 }),
    base({ kind: "frame", col: 2, row: 0, facing: "sw" }, { kind: "wallshelf", col: 2, row: 0, facing: "sw" }),
    base({ kind: "frame", col: 2, row: 0, facing: "sw" }, { kind: "frame", col: 0, row: 2, facing: "se" }),
    base({ kind: "frame", col: 2, row: 0, facing: "sw" }, { kind: "garland", col: 3, row: 0, facing: "sw" }, { kind: "wallshelf", col: 0, row: 2, facing: "se" }),
    base({ kind: "frame", col: 0, row: 3, facing: "se" }, { kind: "garland", col: 0, row: 3, facing: "se" }),
  );
  return out;
};

const shapes = (): unknown[] => {
  const piece = { kind: "plant", col: 9, row: 9, facing: "se" };
  const withPiece = (p: unknown): unknown => layout(TV, ...CHAIRS, p);
  const without = (key: string): Piece => Object.fromEntries(Object.entries(piece).filter(([k]) => k !== key));
  return [
    DEFAULT_LAYOUT,
    ...PRESETS,
    { ...(base() as object), extra: 1 },
    { ...(base() as object), extra: null },
    withPiece({ ...piece, glow: true }),
    withPiece({ ...piece, Kind: "tv" }),
    withPiece({ ...piece, variant: 0, extra: [] }),
    withPiece({ ...piece, "kind\u0000": "plant" }),
    ...[null, 0, 1, "", "x", true, [], [1], [{}], { furniture: null }, { furniture: {} }, { furniture: "x" }, { furniture: [null] }, { furniture: [[]] }, { furniture: [1] }, { furniture: ["tv"] }, { Furniture: [] }, {}, { furnitur: [] }],
    ...["kind", "col", "row", "facing"].map((k) => withPiece(without(k))),
    ...[null, 1, "Plant", "PLANT", "plant ", "", "kilim", "constructor", "toString", "__proto__", [], {}, true].map((kind) => withPiece({ ...piece, kind })),
    ...[null, 1, "se ", "SE", "", "n", "north", [], {}, true, "constructor"].map((facing) => withPiece({ ...piece, facing })),
    ...[null, true, "tv", "ne", "sw", 0].map((facing) => layout(...CHAIRS, { kind: "tv", col: 0, row: 0, facing })),
    base({ kind: "rug", col: 3, row: 3, facing: "se" }),
    base({ kind: "rug", col: 4, row: 3, facing: "se" }),
    base({ kind: "rug", col: 3, row: 4, facing: "se" }),
    base({ kind: "runner", col: 8, row: 0, facing: "ne" }),
    base({ kind: "runner", col: 0, row: 8, facing: "nw" }),
    base({ kind: "runner", col: 8, row: 7, facing: "nw" }),
    base({ kind: "bench", col: 9, row: 0, facing: "ne" }),
  ];
};

const inputs = (): unknown[] => [...shapes(), ...everyKindEveryFacing(), ...variants(), ...cellGrid(), ...counts(), ...overlaps(), ...wallPieces()];

const footprintInputs = (): Piece[] =>
  FURNITURE_KINDS.flatMap((kind) => FACINGS.flatMap((facing) => [[0, 0], [3, 2], [9, 9], [8, 1]].map(([col, row]) => ({ kind, col, row, facing }))));
const seatInputs = (): unknown[] => [
  layout(),
  DEFAULT_LAYOUT,
  ...PRESETS,
  layout(...footprintInputs().filter((_, i) => i % 7 === 0)),
  ...FURNITURE_KINDS.flatMap((kind) => FACINGS.map((facing) => layout({ kind, col: 2, row: 3, facing }))),
  layout({ kind: "sofa", col: 1, row: 5, facing: "ne" }, { kind: "couch", col: 6, row: 1, facing: "nw" }, { kind: "bench", col: 4, row: 4, facing: "se" }),
];

export const layoutCorpora: Corpus[] = [
  { name: "room-layout", cases: () => parsed(RoomLayoutSchema, inputs()) },
  { name: "room-layout-input", cases: () => parsed(RoomLayoutInputSchema, inputs()) },
  { name: "layout-seats", cases: () => seatInputs().map((input) => ({ input, ok: true, output: layoutSeats(input as never) })) },
  { name: "footprint-cells", cases: () => footprintInputs().map((input) => ({ input, ok: true, output: footprintCells(input as never) })) },
];
