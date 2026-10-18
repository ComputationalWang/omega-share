// Head accessories (OME-1388): a party hat, a crown, headphones and a beanie, each drawn over every avatar frame exactly like
// a holiday theme's hat (theme.ts `buildHatFrames`). build.ts packs all four into one lazy sheet, accessories/accessories.png.
import { AVATARS, type AvatarDef, type Overlay } from "./avatars";
import type { RoleMap } from "./sprite";
import { pad, type HatDef, type HatRows } from "./theme";
import { BAND_FITS, type BandFit } from "./valentines";

const fitOf = <T>(fits: Readonly<Record<string, T>>, id: string, what: string): T => {
  const f = fits[id];
  if (!f) throw new Error(`no ${what} fit for ${id}`);
  return f;
};

// ---------------------------------------------------------------- bare heads (OME-1409)

// An overlay can't erase pixels, so a hat worn over Pip's beanie or Mo's bucket hat would sit on top of it. Under the party hat,
// crown and headphones the web shows these bare-headed looks instead (accessories/bare.png), and the overlay is diffed against them.

/** Pip without the beanie: a messy ginger mop with two cowlick spikes where the pom was, the old fringe below. */
function barePip(a: AvatarDef): AvatarDef {
  const dome = [".....H..HH........", "....HHHHHHHHH.....", "..HHHHHHHHHHHHH...", ".HHHHHHHHHHHHHHHH."];
  const overlays = a.overlays.map((ov): Overlay => {
    if (ov.on !== "head" || !ov.rows.some((r) => r.includes("P"))) return ov;
    // Beanie rows: y -9…0 knit and pom, then the ribbed band (y 1–2, now hair) and the fringe.
    return { ...ov, y: -3, rows: [...dome, ...ov.rows.slice(10).map((r) => r.replace(/b/g, "H"))] };
  });
  return { ...a, overlays };
}

/** Mo without the bucket hat: a short dark crop with a hairline above the brow (back hair, sideburn and beard stay). */
function bareMo(a: AvatarDef): AvatarDef {
  const crop = (view: "front" | "back"): Overlay => ({
    on: "head",
    view,
    x: 0,
    y: -1,
    rows: ["....HHHHHHHH....", "..HHHHHHHHHHHH..", ".HHHHHHHHHHHHHH.", ...(view === "front" ? ["HHHHHHHHHHHHHHH.", "HHHHHHHHHHHH...."] : ["HHHHHHHHHHHHHHHH", "HHHHHHHHHHHHHHHH"])],
  });
  return { ...a, overlays: [...a.overlays.filter((ov) => !ov.rows.some((r) => r.includes("a"))), crop("front"), crop("back")] };
}

const avatar = (id: string): AvatarDef => {
  const a = AVATARS.find((x) => x.id === id);
  if (!a) throw new Error(`no avatar ${id}`);
  return a;
};
/** Bare-headed Pip and Mo, keyed by avatar id (`buildHatFrames`' `bases`). */
export const BARE: ReadonlyMap<string, AvatarDef> = new Map([
  ["pip", barePip(avatar("pip"))],
  ["mo", bareMo(avatar("mo"))],
]);

/** Band fits on the bare heads: Pip's mop tops out at y -2, Mo's crop at y -1. */
const FITS: Readonly<Record<string, BandFit>> = {
  ...BAND_FITS,
  pip: { ...fitOf(BAND_FITS, "pip", "bare"), topY: -2 },
  mo: { ...fitOf(BAND_FITS, "mo", "bare"), topY: -1 },
};

// ---------------------------------------------------------------- party hat

/** Pink cone with cream stripes and a mustard pom, perched on top and tipped toward the face. */
const PARTY_ROLES: RoleMap = {
  K: { ramp: "pink", hi: true, group: "K" },
  V: { ramp: "cream", tone: 0, group: "K" },
  N: { ramp: "mustard", hi: true, group: "N" },
};

function partyRows(f: BandFit): HatRows {
  const { put, span, rows } = pad();
  const H = 9, base = 4;
  const by = f.topY; // bottom row overlaps the top of the hair or headwear, so it sits rather than floats
  let tipX = f.cx;
  for (let k = 0; k < H; k++) {
    const t = k / H;
    const half = Math.round(base * (1 - t));
    const c = f.cx + Math.round(1.5 * t); // tips toward the face (template-right)
    // A cream stripe every third row, slanting with the cone.
    for (let x = c - half; x <= c + half; x++) put(x, by - k, (k + x - c) % 3 === 0 && k > 0 && k < H - 1 ? "V" : "K");
    tipX = c;
  }
  const ty = by - H;
  span(ty - 2, tipX - 1, tipX + 1, "N");
  span(ty - 1, tipX - 1, tipX + 1, "N");
  put(tipX, ty - 3, "N");
  put(tipX, ty, "N");
  return rows();
}

export const PARTY_HAT: HatDef = { roles: PARTY_ROLES, replaces: false, rows: (id) => partyRows(fitOf(FITS, id, "party hat")) };

// ---------------------------------------------------------------- crown

/** A small gold crown: a band with three points and pearl tips, a rust gem flanked by teal ones. */
const CROWN_ROLES: RoleMap = {
  K: { ramp: "mustard", hi: true, group: "K" },
  U: { ramp: "rust", tone: 1, group: "K" },
  J: { ramp: "teal", tone: 0, group: "K" },
  Q: { ramp: "cream", tone: 0, group: "Q" },
};

function crownRows(f: BandFit, view: "front" | "back"): HatRows {
  const { put, span, rows } = pad();
  const half = 6, cx = f.cx, by = f.topY + 1; // band's bottom row
  span(by, cx - half, cx + half, "K");
  span(by - 1, cx - half, cx + half, "K");
  span(by - 2, cx - half, cx + half, "K");
  // Three points (2 px wide where they leave the band, 1 px at the top), each with a pearl.
  for (const dx of [-half + 1, 0, half - 1]) {
    const x = cx + dx;
    span(by - 3, x - 1, x + 1, "K");
    span(by - 4, x, x, "K");
    put(x, by - 5, "Q");
  }
  // From behind the gems sit on the far side: the back keeps only the gold band.
  if (view === "front") {
    put(cx, by - 1, "U");
    put(cx - 4, by - 1, "J");
    put(cx + 4, by - 1, "J");
  }
  return rows();
}

export const CROWN: HatDef = { roles: CROWN_ROLES, replaces: false, rows: (id, view) => crownRows(fitOf(FITS, id, "crown"), view) };

// ---------------------------------------------------------------- headphones

/** Lilac band over the top (light enough to part from Juno's dark puff), teal cups on both ears (the far cup peeks past the face), a cream glint on the near cup. */
const PHONES_ROLES: RoleMap = {
  K: { ramp: "lilac", hi: true, group: "K" },
  N: { ramp: "teal", hi: true, group: "N" },
  Q: { ramp: "cream", tone: 0, group: "N" },
};

function phonesRows(f: BandFit, view: "front" | "back"): HatRows {
  const { put, rows } = pad();
  // Head template: the near ear is at x 4–5 facing SE and x 11–12 facing NE (avatars.ts HEAD / HEAD_BACK), rows 8–9.
  const near = view === "front" ? 4 : 11, far = view === "front" ? 16 : -1;
  const x0 = Math.min(near, far) + 0.5, x1 = Math.max(near, far) + 0.5, yb = 6;
  const cx = (x0 + x1) / 2, rx = (x1 - x0) / 2, ry = yb - (f.topY - 1);
  for (let t = 0; t <= Math.PI; t += 0.02) {
    const x = cx + rx * Math.cos(t), y = yb - ry * Math.sin(t);
    // 2×2 brush: a solid band, not a wire, at 1×.
    for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]] as const) put(x + dx, y + dy, "K");
  }
  // Near cup: 4×6, glint top-left. Far cup: a 2 px sliver past the head's edge.
  const cup = [".NN.", "NQNN", "NNNN", "NNNN", "NNNN", ".NN."];
  cup.forEach((r, y) => {
    for (let i = 0; i < 4; i++) if (r.charAt(i) !== ".") put(near - 1 + i, yb + y, r.charAt(i));
  });
  for (let y = yb + 1; y <= yb + 4; y++) for (let i = 0; i < 2; i++) put(far + (view === "front" ? i : -i), y, "N");
  return rows();
}

export const HEADPHONES: HatDef = { roles: PHONES_ROLES, replaces: false, rows: (id, view) => phonesRows(fitOf(FITS, id, "headphones"), view) };

// ---------------------------------------------------------------- beanie

/** A navy knit beanie with a ribbed cuff and a mustard pom (not red and white, so it never reads as the Santa hat). Like the Santa hat it takes off Pip's beanie and Mo's bucket hat, so it is
 *  wide enough to hide them; it sits on Juno's puff and between Kiki's buns. */
const BEANIE_ROLES: RoleMap = {
  K: { ramp: "navy", hi: true, group: "K" },
  V: { ramp: "navy", tone: 1, group: "V" },
  D: { ramp: "navy", tone: 2, group: "V" },
  Q: { ramp: "mustard", hi: true, group: "Q" },
};

/** baseY: the cuff's bottom row; trim: the cuff's half-width; height: the dome above the cuff. */
interface BeanieFit {
  baseY: number;
  cx: number;
  trim: number;
  height: number;
}
const BEANIE_FITS: Readonly<Record<string, BeanieFit>> = {
  juno: { baseY: -3, cx: 8, trim: 9, height: 7 },
  pip: { baseY: 2, cx: 8, trim: 10, height: 10 },
  mo: { baseY: 3, cx: 8, trim: 11, height: 8 },
  kiki: { baseY: -1, cx: 8, trim: 7, height: 6 },
};

function beanieRows(f: BeanieFit): HatRows {
  const { put, span, rows } = pad();
  const { baseY, cx, trim, height } = f;
  const cuffTop = baseY - 2;
  // Dome: a half-ellipse that slouches a pixel or two toward the back of the head (template-left) near the top.
  let topC = cx;
  for (let k = 1; k <= height; k++) {
    const t = k / height;
    const half = Math.round((trim - 1) * Math.sqrt(Math.max(0, 1 - t * t * 0.92)));
    const c = cx - Math.round(2 * t * t);
    span(cuffTop - k, c - half, c + half, "K");
    topC = c;
  }
  // Ribbed cuff: three rows, alternating light and shaded columns.
  for (let y = cuffTop; y <= baseY; y++) for (let x = cx - trim; x <= cx + trim; x++) put(x, y, (x - cx) % 2 === 0 ? "V" : "D");
  // Pom.
  const py = cuffTop - height - 3;
  span(py, topC - 1, topC + 1, "Q");
  span(py + 1, topC - 2, topC + 2, "Q");
  span(py + 2, topC - 2, topC + 2, "Q");
  span(py + 3, topC - 1, topC + 1, "Q");
  return rows();
}

export const BEANIE: HatDef = { roles: BEANIE_ROLES, replaces: true, rows: (id) => beanieRows(fitOf(BEANIE_FITS, id, "beanie")) };

/** The sheet's order; each id is also its frame-key prefix (`<id>/hat/<avatar frame key>`). `bare`: worn over the head, so Pip and
 *  Mo wear it bare-headed (their frames come from accessories/bare.png); the beanie replaces their headwear itself. */
export const ACCESSORIES: readonly { id: string; hat: HatDef; bare: boolean }[] = [
  { id: "partyhat", hat: PARTY_HAT, bare: true },
  { id: "crown", hat: CROWN, bare: true },
  { id: "headphones", hat: HEADPHONES, bare: true },
  { id: "beanie", hat: BEANIE, bare: false },
];
