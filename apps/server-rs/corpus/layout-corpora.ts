// Room layout corpora (OME-1157): RoomLayoutSchema, RoomLayoutInputSchema, layoutSeats and footprintCells.
import { readFileSync } from "node:fs";
import * as v from "valibot";
import { DEFAULT_LAYOUT, FACINGS, FURNITURE, FURNITURE_KINDS, RoomLayoutInputSchema, RoomLayoutSchema, footprintCells, layoutSeats } from "../../../packages/shared/src/layout";
import { decidedRaw, type Case, type Corpus, type RawInput } from "./corpora";

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
const PRESETS = ["classic", "cinema", "living", "lounge", "cafe", "bar", "empty", "dank-dungeon"].map(preset);

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
  const used = new Set(["0,0", ...SEATS.map(([c, r]) => String([c, r]))]);
  const free: Piece[] = [];
  for (let c = 0; c < 10; c++) for (let r = 0; r < 10; r++) if (!used.has(String([c, r]))) free.push({ kind: "sidetable", col: c, row: r, facing: "sw" });
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
  for (const kind of ["frame", "wallshelf", "garland", "neonsign", "wallclock", "bookshelf", "fireplace", "mirror", "washbasin", "desk"] as const)
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

/** Doors (OME-1423): the target is a room id, only a door has one, at most MAX_DOORS. */
const doors = (): unknown[] => {
  const door = (col: number, row: number, target: unknown, more: Piece = {}): Piece => ({ kind: "door", col, row, facing: row === 0 ? "sw" : "se", target, ...more });
  const targets = ["lobby", "a", "a-b-9", "a".repeat(32), "a".repeat(33), "", "Lobby", "lob by", "https://evil.example/", "/rooms/lobby", "lobby/", "ö", "-", 7, null, true, [], {}, ["lobby"]];
  return [
    ...targets.map((target) => base(door(3, 0, target))),
    base({ kind: "door", col: 3, row: 0, facing: "sw" }),
    base(door(3, 0, "lobby", { variant: 1 })), base(door(3, 0, "lobby", { variant: 2 })),
    base(door(0, 3, "lobby", { facing: "sw" })), base(door(3, 1, "lobby")), base(door(3, 0, "lobby", { facing: "ne" })),
    base(door(3, 0, "lobby"), door(0, 3, "lobby")),
    base(door(3, 0, "lobby"), door(4, 0, "x"), door(0, 3, "y")),
    base(door(3, 0, "lobby"), door(4, 0, "x"), door(0, 3, "y"), door(0, 4, "z")),
    base(door(3, 0, "lobby"), door(3, 0, "x")),
    base(door(3, 0, "lobby"), { kind: "bookshelf", col: 3, row: 0, facing: "sw" }),
    base(door(3, 0, "lobby"), { kind: "frame", col: 3, row: 0, facing: "sw" }),
    ...["plant", "frame", "armchair", "rug"].map((kind) => base({ kind, col: kind === "frame" ? 2 : 9, row: kind === "frame" ? 0 : 9, facing: kind === "frame" ? "sw" : "se", target: "lobby" })),
  ];
};

/** Room mood (OME-1499): optional, one of ROOM_MOODS; absent means none. */
const moods = (): unknown[] =>
  ["none", "warm", "cool", "night", "dark", "Warm", "none ", "", null, 0, true, [], {}].flatMap((mood) => [{ ...(base() as object), mood }, { ...DEFAULT_LAYOUT, mood }]);

/** Teleport pads (OME-1545): 0 or exactly 2; one fixed facing, 2 variants, a floor piece (walkable, may lie under objects, not on a rug). */
const pads = (): unknown[] => {
  const pad = (col: number, row: number, more: Piece = {}): Piece => ({ kind: "pad", col, row, facing: "se", ...more });
  const PAIR = [pad(9, 1), pad(1, 9)];
  return [
    base(...PAIR), base(pad(9, 1)), base(...PAIR, pad(8, 9)), base(...PAIR, pad(9, 9), pad(8, 9)), base(pad(9, 1), pad(9, 1)),
    ...[0, 1, 2, -1].map((variant) => base(pad(9, 1, { variant }), pad(1, 9))),
    ...FACINGS.map((facing) => base(pad(9, 1, { facing }), pad(1, 9))),
    base(pad(9, 1), pad(0, 9)), base(pad(9, 1), pad(3, 3)), base(pad(9, 1), pad(1, 9), { kind: "rug", col: 1, row: 1, facing: "se" }),
    layout(TV, ...CHAIRS, { kind: "rug", col: 1, row: 1, facing: "se" }, pad(9, 1), pad(2, 2)),
    base(pad(9, 1), pad(1, 9), { kind: "sidetable", col: 9, row: 1, facing: "se" }),
  ];
};

/** Theatre kinds (OME-1625): exactly one screen (tv or bigscreen), raised rows, curtains, carpet and aisle lights. */
const theatre = (): unknown[] => {
  const BIG: Piece = { kind: "bigscreen", col: 0, row: 0, facing: "se" };
  const row = (col: number, r: number, variant: number, facing = "ne"): Piece => ({ kind: "theatrerow", col, row: r, facing, variant });
  const ROWS = [row(2, 5, 0), row(5, 2, 0), row(2, 7, 1), row(5, 4, 2)];
  const curtains: Piece[] = [{ kind: "curtain", col: 1, row: 0, facing: "sw" }, { kind: "curtain", col: 0, row: 1, facing: "se" }];
  const carpet = (col: number, r: number): Piece => ({ kind: "carpet", col, row: r, facing: "se" });
  const light = (col: number, r: number, facing = "ne"): Piece => ({ kind: "aislelight", col, row: r, facing });
  const THEATRE = [BIG, ...ROWS, ...curtains, carpet(2, 5), light(1, 1)];
  return [
    layout(...THEATRE),
    layout(BIG, ...CHAIRS), layout(TV, { ...BIG, col: 9, row: 9 }, ...CHAIRS), layout({ ...BIG, col: 9, row: 9 }, ...CHAIRS),
    layout(...THEATRE, light(3, 6)), layout(...THEATRE, light(4, 4, "nw")), layout(...THEATRE, carpet(8, 8)), layout(...THEATRE, carpet(9, 9)), layout(...THEATRE, carpet(3, 6)),
    ...[-1, 0, 1, 2, 3].map((variant) => layout(BIG, row(2, 5, variant), ...ROWS.slice(1))),
    ...["ne", "nw", "se", "sw"].map((facing) => layout(BIG, row(2, 5, 0, facing), ...ROWS.slice(1))),
    layout(BIG, ...ROWS.slice(0, 3), ...CHAIRS.slice(0, 2)), layout(BIG, ...ROWS.slice(0, 3), ...CHAIRS.slice(0, 1)), layout(BIG, ...ROWS, row(8, 8, 0)),
    layout(BIG, ...ROWS, { kind: "curtain", col: 5, row: 0, facing: "sw" }), layout(BIG, ...ROWS, { kind: "curtain", col: 1, row: 1, facing: "sw" }),
    layout(BIG, ...ROWS, ...curtains, { kind: "curtain", col: 1, row: 0, facing: "sw" }), layout(BIG, ...ROWS, { kind: "curtain", col: 0, row: 1, facing: "ne" }),
    layout({ ...BIG, facing: "sw" }, ...ROWS), layout({ ...BIG, variant: 1 }, ...ROWS), layout(BIG, ...ROWS, { ...carpet(4, 4), variant: 1 }),
    // MAX_FURNITURE ±1: the 9-piece theatre plus 23 or 24 aisle lights on free floor cells
    ...[22, 23, 24].map((n) => layout(...THEATRE, ...[...Array.from({ length: 20 }, (_, i) => light(i % 10, 8 + Math.floor(i / 10))), light(9, 0), light(9, 1), light(9, 2), light(9, 3)].slice(0, n))),
  ];
};


/** The dank-dungeon pair flag (OME-1671): an optional boolean; absent stays absent. */
const pairs = (): unknown[] =>
  [true, false, "true", 1, 0, null, [], {}].flatMap((pairs) => [{ ...(base() as object), pairs }, { ...DEFAULT_LAYOUT, pairs }, { ...DEFAULT_LAYOUT, mood: "night", pairs }]);

/** The shell skin (OME-1989, OME-2065): optional, one of ROOM_SHELLS; absent stays absent. */
const shells = (): unknown[] =>
  ["dungeon", "penthouse", "studio", "Penthouse", "studio ", "Dungeon", "default", "", " dungeon", null, 0, true, [], {}].flatMap((shell) => [{ ...(base() as object), shell }, { ...DEFAULT_LAYOUT, mood: "night", pairs: true, shell }]);

/** Wall screens and partition lines (OME-2065, ADR 0058): a span covers 2 or 3 segments, off fixtures, on the wall; one partition line. */
const wave2 = (): unknown[] => {
  const scr = (kind: string, col: number, row: number, facing = row === 0 ? "sw" : "se"): Piece => ({ kind, col, row, facing });
  const at = (s: Piece, ...more: unknown[]): unknown => layout(s, ...CHAIRS, ...more);
  const part = (col: number, row: number, facing: string): Piece => ({ kind: "partition", col, row, facing });
  return [
    // Every anchor on both walls, and off the wall: the span crossing fixture segments 5, 6, 8 and running past segment 9.
    ...["wallscreen", "projector"].flatMap((kind) => Array.from({ length: 10 }, (_, i) => [at(scr(kind, i, 0)), at(scr(kind, 0, i)), at(scr(kind, i, 1, "sw")), at(scr(kind, 1, i, "se"))]).flat()),
    ...["ne", "nw"].map((facing) => at(scr("wallscreen", 0, 1, facing))),
    at({ ...scr("projector", 0, 1), variant: 1 }),
    // Span overlap with other wall pieces, with each other, and with a second screen.
    at(scr("projector", 1, 0), { kind: "frame", col: 3, row: 0, facing: "sw" }),
    at(scr("projector", 1, 0), { kind: "frame", col: 4, row: 0, facing: "sw" }),
    at(scr("projector", 1, 0), { kind: "curtain", col: 1, row: 0, facing: "sw" }),
    at(scr("wallscreen", 0, 2), { kind: "mirror", col: 0, row: 3, facing: "se" }),
    at(scr("wallscreen", 0, 2), { kind: "mirror", col: 0, row: 1, facing: "se" }),
    at(scr("wallscreen", 1, 0), scr("projector", 0, 1)),
    at(scr("wallscreen", 1, 0), TV),
    at(scr("wallscreen", 1, 0), { kind: "bookshelf", col: 1, row: 0, facing: "sw" }),
    // Partition lines: one row, one column, two rows, two columns, a row and a column.
    base(part(8, 9, "sw"), part(9, 9, "sw")),
    base(part(9, 8, "se"), part(9, 9, "se")),
    base(part(9, 8, "sw"), part(9, 9, "sw")),
    base(part(8, 9, "se"), part(9, 9, "se")),
    base(part(8, 9, "sw"), part(9, 9, "se")),
    base(part(9, 9, "sw")),
    base(part(9, 9, "se")),
  ];
};

/** Fixtures exist only in the default shell (OME-2085, ADR 0058 amendment): every wall anchor with and without a shell. */
const fixtures = (): unknown[] =>
  [undefined, "penthouse", "studio", "dungeon"].flatMap((shell) =>
    ["frame", "window", "wallscreen", "projector"].flatMap((kind) =>
      Array.from({ length: 10 }, (_, i) => [
        { kind, col: i, row: 0, facing: "sw" },
        { kind, col: 0, row: i, facing: "se" },
      ]).flatMap((pieces) => pieces.map((p) => ({ furniture: [...(kind === "wallscreen" || kind === "projector" ? [] : [TV]), ...CHAIRS, p], ...(shell === undefined ? {} : { shell }) }))),
    ),
  );

const inputs = (): unknown[] => [...fixtures(), ...wave2(),...theatre(), ...shapes(), ...doors(), ...moods(), ...pairs(), ...shells(), ...pads(), ...everyKindEveryFacing(), ...variants(), ...cellGrid(), ...counts(), ...overlaps(), ...wallPieces()];

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

const tvText = '{"kind":"tv","col":0,"row":0,"facing":"se"}';
const chairText = SEATS.map(([c, r]) => JSON.stringify(chair(c, r)));
const chairArrays = SEATS.map(([c, r]) => `["armchair",${String(c)},${String(r)},"${c < r ? "ne" : "nw"}"]`);
const roomText = (...pieces: string[]): string => `{"furniture":[${pieces.join(",")}]}`;

/** Text JSON.stringify never writes: the array form of an object (TS refuses), numbers written `-0`/`1.0`/`1e2` and duplicate keys (TS accepts, Rust refuses). */
const rawInputs = (): RawInput[] => {
  const full = (...pieces: string[]): string => roomText(tvText, ...chairText, ...pieces);
  return [
    { text: full() },
    { text: roomText(tvText, ...chairText.slice(0, 7)) },
    // Array forms: serde's derive would read these; Valibot refuses.
    { text: roomText('["tv",0,0,"se"]', ...chairText) },
    { text: roomText('["tv",0,0,"se"]', ...chairArrays) },
    { text: roomText(tvText, ...chairArrays) },
    { text: `[[${tvText},${chairText.join(",")}]]` },
    { text: `[${tvText},${chairText.join(",")}]` },
    { text: "[]" },
    { text: "[[]]" },
    { text: '[["tv",0,0,"se"]]' },
    { text: full('["plant",9,9,"se"]') },
    { text: full("[]") },
    { text: full("{}") },
    { text: "not json" },
    { text: "" },
    // Numbers JSON.stringify never writes: TS accepts, Rust refuses.
    { text: roomText(tvText.replace('"col":0', '"col":-0'), ...chairText), rustRefuses: true },
    { text: roomText(tvText.replace('"row":0', '"row":-0'), ...chairText), rustRefuses: true },
    { text: roomText(tvText.replace('"col":0', '"col":0.0'), ...chairText), rustRefuses: true },
    { text: roomText(tvText.replace('"row":0', '"row":0e0'), ...chairText), rustRefuses: true },
    { text: full('{"kind":"plant","col":1e1,"row":9,"facing":"se"}') },
    { text: full('{"kind":"plant","col":9.0,"row":9,"facing":"se"}'), rustRefuses: true },
    { text: full('{"kind":"plant","col":9,"row":0.9e1,"facing":"se"}'), rustRefuses: true },
    { text: full('{"kind":"plant","col":9,"row":9,"facing":"se","variant":-0}'), rustRefuses: true },
    { text: full('{"kind":"plant","col":9,"row":9,"facing":"se","variant":0.0}'), rustRefuses: true },
    { text: full('{"kind":"plant","col":9,"row":9,"facing":"se","variant":0e5}'), rustRefuses: true },
    { text: full('{"kind":"plant","col":9,"row":9,"facing":"se","variant":1e0}'), rustRefuses: true },
    // Duplicate keys: TS keeps the last, Rust refuses.
    { text: `{"furniture":[],"furniture":[${tvText},${chairText.join(",")}]}`, rustRefuses: true },
    { text: `{"furniture":[${tvText},${chairText.join(",")}],"furniture":[]}`, rustRefuses: true },
    { text: full('{"kind":"plant","kind":"lamp","col":9,"row":9,"facing":"se"}'), rustRefuses: true },
    { text: full('{"kind":"plant","col":9,"row":9,"facing":"se","facing":"sw"}'), rustRefuses: true },
    { text: full('{"kind":"door","col":3,"row":0,"facing":"sw","target":"lobby"}') },
    { text: full('{"kind":"door","col":3,"row":0,"facing":"sw","target":"lobby","target":"a"}'), rustRefuses: true },
    { text: full('{"kind":"door","col":3,"row":0,"facing":"sw","target":"lob\\u0062y"}') },
  ];
};

const rawDecision = (schema: v.GenericSchema) => (json: unknown): unknown => {
  const r = v.safeParse(schema, json);
  return r.success ? r.output : null;
};

export const layoutCorpora: Corpus[] = [
  { name: "room-layout-raw", cases: () => decidedRaw(rawInputs(), rawDecision(RoomLayoutSchema)) },
  { name: "room-layout-input-raw", cases: () => decidedRaw(rawInputs(), rawDecision(RoomLayoutInputSchema)) },
  { name: "room-layout", cases: () => parsed(RoomLayoutSchema, inputs()) },
  { name: "room-layout-input", cases: () => parsed(RoomLayoutInputSchema, inputs()) },
  { name: "layout-seats", cases: () => seatInputs().map((input) => ({ input, ok: true, output: layoutSeats(input as never) })) },
  // The catalogue lie style (OME-1773): a kind's `lie`, null when it has none (wrapped: a bare null output reads as absent).
  { name: "furniture-lie", cases: () => FURNITURE_KINDS.map((input) => ({ input, ok: true, output: { lie: FURNITURE[input].lie ?? null } })) },
  { name: "footprint-cells", cases: () => footprintInputs().map((input) => ({ input, ok: true, output: footprintCells(input as never) })) },
];
