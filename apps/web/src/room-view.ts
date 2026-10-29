// The PixiJS layer: floor, furniture, seats and avatars, on the 2D canvas renderer (ADR 0029). Rendered on demand (no ticker): frames
// run only while someone walks (once per step in Basic, every frame in Smooth, ADR 0037), and breathing redraws only
// when its frame changes (walk/animator.ts).
import { Application, Container, Graphics, Sprite, Ticker, type Texture } from "pixi.js";
import { AVATAR_COUNT, type FloorCell, type LieStyle, type MemberId, type RoomMood } from "@omega/shared";
import type { Sheet } from "./atlas-sheet";
import { drawCursor } from "./cell-cursor";
import { standDepth, type CatWalker, type Scene } from "./furniture";
import { AVATAR_COLORS, FLOOR_CELLS, STAGE_H, STAGE_W, TILE_H, TILE_W, cellCenter, type Point } from "./layout";
import { EMOTE_LIFT, createAnimator, type FurnitureLoop } from "./walk/animator";
import { oneShotFrame, type AvatarEmote } from "./walk/motion";
import { isLieFrame } from "./walk/lie";
import { isPairFrame } from "./walk/pair";
import type { MotionAtlas } from "./walk/motion-atlas";
import { CAT_SLOT_MS, catRest, catSlot, catWait } from "./walk/cat";
import { createTier, createTierProbe, readTierHints, weakDevice } from "./walk/tier";
import { createWalks, emptyPose, type Dir, type Pose } from "./walk/walks";
import { wearsBare, wornHat } from "./accessory/hat";
import type { TintableSheets } from "./walk/tint-sheets";
import type { AccessoryAtlas } from "./accessory/accessories-sheet";
import type { ThemeAtlas } from "./theme/atlas";
import { decorSprites } from "./theme/decor";
import { CONFETTI_MS, CONFETTI_SPRITES, EFFECT_MIN_INTERVAL_MS, SPARKLE_MS, SPARKLE_SPRITES, confettiMotion, createEffectPainter, createParticles, effectBounds, sparkleMotion, type EffectFrame, type EffectMotion, type EffectPainter, type Particles } from "./theme/effect";
import { DOOR, cellAt, centerOf, colOf, rowOf } from "./walk/path";
import { resolveTheme } from "./theme/periods";
import { ambienceFor, type Ambience } from "./theme/ambience";
import { livePieces, type LivePieces } from "./live-pieces";
import { clockFace, handSteps, minuteTicks, type HandSteps } from "./wall-clock";
import { EMOTE_SOUNDS } from "./emote/emotes";

export interface AvatarPlacement {
  readonly id: MemberId;
  readonly avatar: number;
  /** Shirt tint (ADR 0053), 0 the avatar's own colours. */
  readonly tint: number;
  /** Hair colour (OME-1438), 0 the avatar's own. */
  readonly hair: number;
  /** Accessory (OME-1391), 0 none. */
  readonly accessory: number;
  readonly at: Point;
  /** Depth among furniture and other avatars (furniture.ts: a sitter takes its seat's, others `standDepth`). */
  readonly z: number;
  /** The seat's facing if they sit, null if they stand (walk/walks.ts). */
  readonly seatFacing: Dir | null;
  /** They jog there (OME-1464, walk/walks.ts). */
  readonly run?: boolean;
  /** Sitting on the floor of their cell (OME-1501, walk/walks.ts). */
  readonly floorSit?: boolean;
  /** Lying on a sofa, couch or cat bed (OME-1691): `at` is their floor point on it, `seatFacing` the piece's facing. */
  readonly lie?: LieStyle;
  /** Arrived by a teleport pad (OME-1548): snapped, with a sparkle at both pads. */
  readonly teleport?: boolean;
  /** Walked in through the door they stand in front of (OME-1558): there at once, with a sparkle. */
  readonly door?: boolean;
}

export interface RoomViewOptions {
  /** An avatar moved while walking (stage px), for the DOM name tags and bubbles. */
  readonly onMove?: (id: MemberId, x: number, y: number) => void;
  /** An avatar came to rest after a walk or a jump (stage px): the bubbles resolve overlap here, never per frame. */
  readonly onStop?: (id: MemberId, x: number, y: number) => void;
  /** The room (OME-1520): with the slot of server time, it seeds where each cat wanders. */
  readonly roomId?: string;
  /** Server time now (clock.ts), so every client's cats change slot together; the local clock without one. */
  readonly serverNow?: () => number;
  /** The room's sounds (OME-1638, audio/): each drawn pose (footfalls, sit/stand), the door, emote pops. */
  readonly sound?: RoomSound;
}

/** What the room view tells the sound engine; room.ts forwards it to the lazy audio chunk once loaded. */
export interface RoomSound {
  pose(id: MemberId, pose: Pose): void;
  play(name: string): void;
}

export interface RoomView {
  readonly canvas: HTMLCanvasElement;
  /** The room's shell, furniture and seat markers; rebuilt once per layout change (or when an atlas arrives). Draws on the next `update`. */
  setScene(scene: Scene, sheets: readonly (Sheet | null)[], walkGrid: Uint8Array): void;
  /** The layout's pieces in use (furniture.ts `piecesInUse`, OME-1407): theirs loop, the rest show their still frame. Per change. */
  setInUse(pieces: ReadonlySet<number>): void;
  /** The furniture loops running now: each piece's idle frame key and the loop frame shown (-1 still), for e2e. */
  loops(): { key: string; frame: number }[];
  /** The wandering cats (OME-1520), for e2e: each one's floor cell ("col,row"), whether it walks, and the 20 s slot it is in. */
  cats(): { cell: string; walking: boolean; slot: number }[];
  /** The cats' cells now (walk cells; a walking cat: the one it crosses), for /pet and a pet's heart (OME-1669). */
  catCells(): number[];
  /** The cat on `cell` shows a heart for one play (OME-1669); nothing under reduced motion. */
  petCat(cell: number): void;
  /** Where members stand (walk cells: a cat waits rather than walk into one), and the owner editor's freeze (cats home). Per change. */
  setCatRules(taken: ReadonlySet<number>, frozen: boolean): void;
  /** Seat occupancy and who sits or stands where; redraws once, then walks anyone whose spot changed (walk/). */
  update(seatTaken: readonly boolean[], avatars: readonly AvatarPlacement[]): void;
  /** Where an avatar is drawn now (mid-walk, between cells), stage px. */
  position(id: MemberId): Point | undefined;
  /** The owner editor's layer (set (h) grid and footprint markers): over the floor, rugs and walls, under seats and objects. */
  readonly editLayer: Container;
  /** Free walking (OME-1350): the editor's cursor diamond on the floor cell under the pointer, or none. Draws once per change. `scale`: screen px per stage px. */
  marker(cell: FloorCell | null, scale: number): void;
  /** Draw once now, after the editor changed its layer. */
  redraw(): void;
  /** Full screen hides the room (OME-597): stop drawing until resumed, then draw once as things are now. */
  setPaused(paused: boolean): void;
  readonly paused: () => boolean;
  /** How many times the room has been drawn, for e2e "a bubble costs no render" checks. */
  renders(): number;
  /** The Dank Dungeon's pose sheet (OME-1672): fetched once, only for a layout with `pairs`. */
  loadPairPoses(): void;
  /** Two members paired: the thruster and the bender play their poses, once the sheet is in (OME-1672). */
  pair(thruster: MemberId, bender: MemberId): void;
  /** Who's in the /conga line (OME-1690): they dance while they walk. */
  conga(ids: readonly MemberId[]): void;
  /** `id` emoted (OME-415): a one-shot on the render loop. Nothing under prefers-reduced-motion (room.ts shows a badge). */
  emote(id: MemberId, kind: AvatarEmote): void;
  /** The motion frame each is drawn with now, their sticker's (null: none) and the shirt tint and hair drawn, for e2e checks. */
  frames(id: MemberId): { avatar: string | null; sticker: string | null; tint: number; hair: number; accessory: number; bare: boolean; hatAnchored: boolean } | undefined;
  /** "Hide for me" (OME-769): draw this member's avatar dimmed (or not). One alpha write and one draw per change. */
  setDimmed(id: MemberId, dimmed: boolean): void;
  /** A member is away (OME-911): draw the avatar dimmed (or not). One alpha write and one draw per change; the seat stays. */
  setAway(id: MemberId, away: boolean): void;
  /** The avatar's alpha now, for e2e checks. */
  alpha(id: MemberId): number | undefined;
  /** Labels in draw order (floor, furniture frame keys, `seat:<i>`, `avatar:<id>`), for e2e depth checks. */
  drawOrder(): string[];
  /** The holiday theme drawn now (ADR 0052): its id, decor pieces, hats and effect sprites shown, effect frames run. */
  theme(): { id: string | null; decor: number; hats: number; effect: number; ticks: number; worstTickMs: number };
  /** Crowd applause (OME-1389): one confetti burst over the room, unless reduced motion or the Basic tier rules it out. */
  confetti(): void;
  /** How many confetti bursts have played, for e2e. */
  confettiBursts(): number;
  /** The room mood's ambience (OME-1689): night snow, warm dust motes, on the theme effect's pool; none under a holiday theme. */
  ambience(mood: RoomMood): void;
  /**
   * Reaction glyph bursts (OME-1631) may play now: Smooth, no reduced motion, and the last render's work under
   * REACTION_NEAR_BUDGET_MS. Read once per burst.
   */
  reactionsAllowed(): boolean;
  destroy(): void;
}

/** A hidden member's avatar (OME-769): still there, plainly set apart. */
export const DIMMED_ALPHA = 0.4;
/** A Smooth render that took this long (ms) is near the 8 ms walk25 budget: reaction glyphs sit it out (OME-1631). */
export const REACTION_NEAR_BUDGET_MS = 6;
/** An away member's avatar (OME-911): dimmed, but less than a hidden one. */
export const AWAY_ALPHA = 0.55;

/** The avatar alpha for hidden-by-me and away; independent flags, hidden wins. */
export function avatarAlphaFor(hidden: boolean, away: boolean): number {
  return hidden ? DIMMED_ALPHA : away ? AWAY_ALPHA : 1;
}

/** localStorage, or null where reading it throws (storage blocked). */
function storage(): Storage | null {
  try {
    return globalThis.localStorage;
  } catch {
    return null;
  }
}

function diamond(g: Graphics, p: Point, w: number, h: number): Graphics {
  return g.poly([p.x, p.y - h / 2, p.x + w / 2, p.y, p.x, p.y + h / 2, p.x - w / 2, p.y]);
}

/** One shape per avatar index so they differ without colour too. */
function drawAvatar(g: Graphics, avatar: number): void {
  const color = AVATAR_COLORS[avatar % AVATAR_COUNT] ?? 0xffffff;
  g.clear();
  g.ellipse(0, 0, 14, 6).fill({ color: 0x000000, alpha: 0.25 });
  switch (avatar) {
    case 0:
      g.circle(0, -22, 14);
      break;
    case 1:
      g.roundRect(-13, -36, 26, 30, 6);
      break;
    case 2:
      g.poly([0, -40, 15, -6, -15, -6]);
      break;
    default:
      g.poly([0, -40, 14, -22, 0, -4, -14, -22]);
  }
  g.fill(color).stroke({ color: 0x111111, width: 2 });
}

/**
 * Stop `ticker`'s rAF loop for good and return a pump that runs its listeners once. Pixi's SchedulerSystem (GC timers)
 * and EventsTicker sit on Ticker.system, which auto-starts and would otherwise tick every frame of an idle room (OME-185).
 */
export function quietSystemTicker(ticker: Ticker): () => void {
  ticker.autoStart = false;
  ticker.stop();
  return () => {
    ticker.update();
  };
}

/** Per member: the placeholder shape until the motion atlas is in, then a sprite. `x`/`y` is where it's drawn. */
interface Entry {
  node: Graphics | Sprite;
  avatar: number;
  /** The shirt tint and hair colour asked for; drawn once the atlas has that look's sheets (until then, the shipped look). */
  tint: number;
  hair: number;
  x: number;
  y: number;
  walking: boolean;
  frame: string | null;
  sticker: Sprite | null;
  stickerFrame: string | null;
  /** The holiday theme's hat or their own accessory over the avatar (ADR 0052, OME-1391); made on first need, then hidden or re-framed. */
  hat: Sprite | null;
  /** Their accessory (OME-1391), 0 none; drawn once the accessories sheet is in. */
  accessory: number;
}

/** A piece that can play its "in use" loop: its sprite, idle texture and loop textures. */
interface Loop extends FurnitureLoop {
  readonly sprite: Sprite;
  readonly piece: number;
  readonly idle: Texture;
  readonly textures: readonly Texture[];
}

/** Caches the static room shell as one texture, repainted on the next render (OME-1341). */
export function bakeShell(layer: Container): void {
  if (layer.isCachedAsTexture) layer.updateCacheTexture();
  // Drawn 1:1 at the canvas resolution; nearest keeps the pixel art crisp if a bound lands off the pixel grid.
  else layer.cacheAsTexture({ scaleMode: "nearest" });
}

export async function createRoomView(opts: RoomViewOptions = {}): Promise<RoomView> {
  const app = new Application();
  await app.init({
    width: STAGE_W,
    height: STAGE_H,
    backgroundAlpha: 0,
    antialias: false,
    autoStart: false,
    resolution: Math.min(2, globalThis.devicePixelRatio || 1),
    autoDensity: true,
    // 2D canvas, not WebGL (ADR 0029): under software compositing a WebGL canvas is read back from the GPU process on
    // every frame (~6 ms main thread), which walking avatars would pay 60 times a second.
    preference: "canvas",
  });
  app.ticker.stop();
  const pumpSystem = quietSystemTicker(Ticker.system);

  const floor = new Graphics({ label: "floor" });
  for (let c = 0; c < FLOOR_CELLS; c++) {
    for (let r = 0; r < FLOOR_CELLS; r++) diamond(floor, cellCenter(c, r), TILE_W, TILE_H).fill((c + r) % 2 ? 0x3a3450 : 0x443d5e);
  }
  // Static: the floor, then rugs and wall pieces in furniture order. Objects sort with the avatars by depth.
  const background = new Container();
  // Static object pieces, depth-sorted, baked with the shell (OME-1448): their live copies draw only when needed (live-pieces.ts).
  // The shell sorts by zIndex (Pixi sorts a parent once a child has one): over every floor and wall piece.
  const baked = new Container({ label: "baked", sortableChildren: true, zIndex: Number.MAX_VALUE });
  background.addChild(floor, baked);
  bakeShell(background);
  // Wall pieces with a loop (the neon sign, OME-1407) sit just over the baked shell, so a loop frame never repaints it.
  const liveWall = new Container({ label: "live-wall" });
  // The holiday theme (ADR 0052): decor over the walls, behind the furniture and avatars (the effect has its own canvas).
  const decorLayer = new Container({ label: "decor" });
  const editLayer = new Container({ label: "edit" });
  const markerLayer = new Container();
  // Free walking's hover diamond (OME-1350): on the floor, under seats and avatars; not in `drawOrder`.
  const hover = new Graphics({ label: "walk-marker", visible: false });
  const objectLayer = new Container({ sortableChildren: true });
  // Emote stickers float over everyone (OME-415).
  const emoteLayer = new Container({ label: "emotes" });
  app.stage.addChild(background, liveWall, decorLayer, editLayer, hover, markerLayer, objectLayer, emoteLayer);

  /** Marker per placeholder seat, by seat index. */
  let markers: (Graphics | null)[] = [];
  let lastTaken: (boolean | null)[] = [];
  let furniture: Container[] = [];
  /** The object pieces' live copies, by `live` index; `shadows` the same as a set, to tell them from avatars and hats. */
  let pieceSprites: Sprite[] = [];
  /** By the same index: the piece loops, so it has no baked copy and always draws live. */
  let pieceLoops: boolean[] = [];
  let shadows: ReadonlySet<Container> = new Set<Container>();
  let live: LivePieces | null = null;
  /** The layers under the objects changed (scene, decor): which pieces must always draw live is computed again. */
  let pinDirty = false;
  /** The walk hover's box, stage px (it draws under every object). */
  let hoverBox = { x0: 0, y0: 0, x1: 0, y1: 0 };
  /** Every piece that can loop, in scene order; `running` the ones in use now (the animator's loop indices). */
  let looping: Loop[] = [];
  let running: Loop[] = [];
  let inUse: ReadonlySet<number> = new Set<number>();
  /** Wall clocks' faces (OME-1557), in the baked shell over their sprites: repainted on the minute, never per frame. */
  let clocks: { readonly g: Graphics; readonly facing: "se" | "sw" }[] = [];
  let clockSteps: HandSteps | null = null;
  let stopClocks: (() => void) | null = null;
  const pool = new Map<MemberId, Entry>();

  /** Members drawn dimmed (OME-769); a member's node takes it on when made or swapped for a sprite. */
  const dimmed = new Set<MemberId>();
  const away = new Set<MemberId>();
  const alphaOf = (id: MemberId): number => avatarAlphaFor(dimmed.has(id), away.has(id));

  let paused = false;
  let renders = 0;
  /** A sprite's box in stage px, from its texture and anchor (not `getBounds()`: that skips a sprite that isn't renderable). */
  const spriteBox = { x0: 0, y0: 0, x1: 0, y1: 0 };
  const boxOf = (c: Sprite): typeof spriteBox => {
    const t = c.texture;
    spriteBox.x0 = c.x - c.anchor.x * t.width;
    spriteBox.y0 = c.y - c.anchor.y * t.height;
    spriteBox.x1 = spriteBox.x0 + t.width;
    spriteBox.y1 = spriteBox.y0 + t.height;
    return spriteBox;
  };
  /** Pieces that always draw live: those with a loop, or under decor, a wall loop or a seat marker (drawn over the shell). */
  const pin = (): void => {
    pinDirty = false;
    // Decor and wall loops are sprites, drawn over the shell.
    const over = [...decorLayer.children, ...liveWall.children].flatMap((c) => (c instanceof Sprite ? [{ ...boxOf(c) }] : []));
    // A seat marker is drawn on its next update: its cell's diamond.
    for (const m of markerLayer.children) over.push({ x0: m.x - TILE_W / 2, y0: m.y - TILE_H / 2, x1: m.x + TILE_W / 2, y1: m.y + TILE_H / 2 });
    live = livePieces(
      pieceSprites.map((sprite, i) => {
        const box = { ...boxOf(sprite) };
        const pinned = pieceLoops[i] === true || over.some((o) => o.x0 < box.x1 && box.x0 < o.x1 && o.y0 < box.y1 && box.y0 < o.y1);
        return { ...box, z: sprite.zIndex, pinned };
      }),
    );
  };
  /** Which pieces' live copies draw this frame: the ones something behind them overlaps (live-pieces.ts). Allocates nothing. */
  const showLive = (): void => {
    if (pinDirty) pin();
    if (live === null) return;
    // The editor's grid and markers sit under the objects: while it's open, every piece draws live, as before.
    let all = editLayer.children.length > 0;
    if (!all) {
      live.begin();
      for (const c of objectLayer.children) {
        if (!c.visible || shadows.has(c)) continue;
        // A placeholder avatar (before the motion atlas) has no cheap box: everything live until it's a sprite.
        if (!(c instanceof Sprite)) {
          all = true;
          break;
        }
        const b = boxOf(c);
        // A px of margin: an avatar between pixels touches its neighbours' at resolution 2.
        live.cover(b.x0 - 1, b.y0 - 1, b.x1 + 1, b.y1 + 1, c.zIndex);
      }
      if (hover.visible) live.cover(hoverBox.x0, hoverBox.y0, hoverBox.x1, hoverBox.y1, -Infinity);
      live.end();
    }
    for (let i = 0; i < pieceSprites.length; i++) {
      const s = pieceSprites[i];
      const want = all || live.live[i] === true;
      if (s !== undefined && s.renderable !== want) s.renderable = want;
    }
  };
  const render = (): void => {
    if (paused) return;
    pumpSystem();
    showLive();
    app.render();
    renders++;
  };

  // The holiday theme (ADR 0052): from the local date, or forced by localStorage["omega.theme"]. Its art loads in its
  // own chunk; until then (or without it) the room is drawn as usual.
  const themeId = resolveTheme(new Date(), storage()?.getItem("omega.theme") ?? null);
  let theme: ThemeAtlas | null = null;
  /** The scene as last set, so the decor can be placed when the theme arrives after it. */
  let lastScene: Scene | null = null;
  let hatsShown = 0;
  const placeDecor = (): void => {
    pinDirty = true;
    for (const c of decorLayer.removeChildren()) c.destroy();
    if (theme === null || lastScene === null) return;
    for (const d of decorSprites(lastScene, theme.decor)) {
      const texture = theme.texture(d.key);
      if (texture !== undefined) decorLayer.addChild(new Sprite({ texture, label: d.key, x: d.x, y: d.y }));
    }
  };
  // Head accessories (OME-1391): the sheet is its own chunk, fetched once someone in the room wears one.
  let accessories: AccessoryAtlas | null = null;
  let accessoriesLoad = false;
  const loadAccessories = (): void => {
    if (accessoriesLoad) return;
    accessoriesLoad = true;
    void import("./accessory/accessories-sheet")
      .then((m) => m.loadAccessories())
      .then((a) => {
        if (destroyed) return;
        accessories = a;
        for (const [id, entry] of pool) {
          wearHat(entry);
          if (entry.hair !== 0) relook(id, entry, entry.tint, entry.hair);
        }
        render();
      })
      // Without the sheet everyone is drawn bare-headed (or in the theme's hat); the next wearer retries.
      .catch((e: unknown) => {
        accessoriesLoad = false;
        console.warn("accessories sheet failed to load", e);
      });
  };
  // Pip's and Mo's bare heads under an accessory (OME-1404, art OME-1409): their own chunk, fetched once one of them wears one.
  let bare: TintableSheets | null = null;
  let bareLoad = false;
  const loadBare = (): void => {
    if (bareLoad) return;
    bareLoad = true;
    void import("./accessory/bare-sheet")
      .then((m) => m.loadBare())
      .then((b) => {
        if (destroyed) return;
        bare = b;
        for (const [id, entry] of pool) if (wearsBare(entry.avatar, entry.accessory)) reframe(id, entry);
        render();
      })
      // Without it they keep their own headwear and wear no accessory (its overlay fits the bare head); the next wearer retries.
      .catch((e: unknown) => {
        bareLoad = false;
        console.warn("bare heads sheet failed to load", e);
      });
  };
  // The Dank Dungeon's poses (OME-1672, walk/pair-atlas.ts): their own lazy chunk, fetched once a room with `pairs` is drawn.
  let pairSheet: TintableSheets | null = null;
  let pairLoad = false;
  // The lying sheet (OME-1691, walk/lie-atlas.ts): its own lazy chunk, fetched once someone lies down.
  let lieSheet: TintableSheets | null = null;
  let lieLoad = false;
  const loadLie = (): void => {
    if (lieLoad) return;
    lieLoad = true;
    void import("./walk/lie-atlas")
      .then((m) => m.loadLieAtlas())
      .then((l) => {
        if (destroyed) return;
        lieSheet = l;
        for (const [id, e] of pool) if (e.tint !== 0 || e.hair !== 0) relook(id, e, e.tint, e.hair);
        animator.wake();
      })
      // Without it a lier is drawn standing at the piece; the next one retries.
      .catch((e: unknown) => {
        lieLoad = false;
        console.warn("lying sheet failed to load", e);
      });
  };
  /** The member's body frame: the bare head under an accessory that takes their headwear off, once that sheet is in. */
  const body = (entry: Entry, frame: string, avatar: number): Texture | undefined =>
    (lieSheet !== null && isLieFrame(frame) ? lieSheet.texture(frame, avatar, entry.tint, entry.hair) : undefined) ??
    (pairSheet !== null && isPairFrame(frame) ? pairSheet.texture(frame, avatar, entry.tint, entry.hair) : undefined) ??
    (bare !== null && wearsBare(avatar, entry.accessory) ? bare.texture(frame, avatar, entry.tint, entry.hair) : undefined) ?? motion?.texture(frame, avatar, entry.tint, entry.hair);
  /** Their accessory changed, or the bare sheet came in: the body frame and the hat again, their look's sheets too. */
  const reframe = (id: MemberId, entry: Entry): void => {
    if (entry.frame !== null && entry.node instanceof Sprite) {
      const t = body(entry, entry.frame, entry.avatar);
      if (t !== undefined && t !== entry.node.texture) entry.node.texture = t;
    }
    wearHat(entry);
    if (entry.tint !== 0 || entry.hair !== 0) relook(id, entry, entry.tint, entry.hair);
  };
  /** Put the member's accessory, else the theme's hat, over the avatar's frame (the sprite is the difference to the hatted frame), or take it off. */
  const wearHat = (entry: Entry): void => {
    // A hat fitted to the bare head waits for it: on their own headwear it would misfit.
    const own = wearsBare(entry.avatar, entry.accessory) && bare === null ? null : accessories;
    // No lying frames in the hat sheets (assets/README.md, Lying pose): hide the overlay.
    const texture = entry.frame === null || isLieFrame(entry.frame) ? undefined : wornHat(entry.accessory, entry.frame, own, theme, entry.avatar, entry.hair);
    if (texture === undefined) {
      if (entry.hat?.visible === true) {
        entry.hat.visible = false;
        hatsShown--;
      }
      return;
    }
    if (entry.hat === null) {
      entry.hat = new Sprite({ texture, label: `hat:${entry.node.label}`, visible: false });
      objectLayer.addChild(entry.hat);
    } else if (entry.hat.texture !== texture) {
      entry.hat.texture = texture;
      // A texture swap keeps the old anchor; each hat and frame has its own.
      entry.hat.anchor.copyFrom(texture.defaultAnchor ?? { x: 0, y: 0 });
    }
    entry.hat.position.copyFrom(entry.node.position);
    // Just over its own avatar and under whatever sorts next (depths are whole numbers).
    entry.hat.zIndex = entry.node.zIndex + 0.5;
    entry.hat.alpha = entry.node.alpha;
    if (!entry.hat.visible) {
      entry.hat.visible = true;
      hatsShown++;
    }
  };

  // Walking (OME-408): every client walks avatars to their spot itself; frames run only while someone walks.
  const reduced = globalThis.matchMedia("(prefers-reduced-motion: reduce)");
  // The walk tier (ADR 0037), chosen at room start: forced by localStorage["omega.motion"], gated by the device, else probed.
  const hints = readTierHints({ reducedMotion: reduced.matches, navigator: globalThis.navigator, storage: storage() });
  const tier = createTier(hints);
  const probe = createTierProbe(tier, {
    now: () => performance.now(),
    raf: (fn) => requestAnimationFrame(fn),
    channel: (onMessage) => {
      const ch = new MessageChannel();
      ch.port1.onmessage = onMessage;
      return () => {
        ch.port2.postMessage(null);
      };
    },
  });
  /** The tier as last shown on the canvas (`data-motion`, for e2e and perf); written only when it changes. */
  let shownTier = "";
  const showTier = (): void => {
    const t = tier.smooth() ? "smooth" : "basic";
    if (t === shownTier) return;
    shownTier = t;
    app.canvas.dataset["motion"] = t;
  };
  showTier();
  /** The rAF timestamp of the frame being drawn; one callback made once, so a frame allocates nothing. */
  let frameTs = 0;
  /** The last render's own work (ms), for the reaction glyphs' gate. */
  let lastWorkMs = 0;
  let frameFn: (() => void) | null = null;
  const onFrame = (t: number): void => {
    frameTs = t;
    frameFn?.();
  };
  const walks = createWalks({
    reducedMotion: () => reduced.matches,
    smooth: tier.smooth,
    onDoor: () => {
      opts.sound?.play("door");
      arrive();
    },
    onTeleport: (from, to) => {
      spotSparkle(from);
      spotSparkle(to);
    },
    onDoorway: (at) => {
      spotSparkle(at);
    },
  });
  let motion: MotionAtlas | null = null;
  let motionLoad = false;
  const animator = createAnimator({
    walks,
    now: () => performance.now(),
    raf: (fn) => {
      frameFn = fn;
      requestAnimationFrame(onFrame);
    },
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (h) => {
      clearTimeout(h as ReturnType<typeof setTimeout>);
    },
    reducedMotion: () => reduced.matches,
    smooth: tier.smooth,
    drawProps: (now) => drawCats(now),
    rendered(start, walking) {
      lastWorkMs = performance.now() - start;
      probe.rendered(start, frameTs, walking);
      showTier();
    },
    draw(id, avatar, pose, frame) {
      const entry = pool.get(id);
      if (entry === undefined) return;
      const texture = frame === null ? undefined : body(entry, frame, avatar);
      if (texture !== undefined) {
        if (!(entry.node instanceof Sprite)) {
          const sprite = new Sprite({ texture, label: entry.node.label, alpha: entry.node.alpha });
          objectLayer.addChild(sprite);
          entry.node.destroy();
          entry.node = sprite;
        } else if (entry.node.texture !== texture) entry.node.texture = texture;
      } else if (entry.node instanceof Graphics && entry.avatar !== avatar) drawAvatar(entry.node, avatar);
      entry.avatar = avatar;
      entry.frame = texture === undefined ? null : frame;
      entry.node.position.set(pose.x, pose.y);
      entry.node.zIndex = pose.z;
      wearHat(entry);
      // The DOM followers (tags, bubbles, badges) move in whole px, and only when the pixel changes: each move is a
      // fresh transform string, so a Smooth frame that stays on the same pixel writes nothing (R-M8a §2).
      const x = Math.round(pose.x);
      const y = Math.round(pose.y);
      // A thruster is drawn at their partner's spot (OME-1672); their tag and bubble stay where they stand.
      const thrust = frame?.startsWith("thrust/") === true;
      const moved = !thrust && (entry.x !== x || entry.y !== y);
      if (moved) {
        entry.x = x;
        entry.y = y;
        opts.onMove?.(id, x, y);
      }
      if (!pose.walking && !thrust && (entry.walking || moved)) opts.onStop?.(id, x, y);
      entry.walking = pose.walking;
      opts.sound?.pose(id, pose);
    },
    drawEmote(id, frame, x, y) {
      const entry = pool.get(id);
      if (entry === undefined) return;
      const texture = frame === null ? undefined : motion?.texture(frame);
      if (texture === undefined) {
        if (entry.sticker?.visible === true) entry.sticker.visible = false;
        entry.stickerFrame = null;
        return;
      }
      // One sprite per member, made on their first emote and reused: frame swaps only.
      if (entry.sticker === null) {
        entry.sticker = new Sprite({ texture, label: `emote:${id}` });
        emoteLayer.addChild(entry.sticker);
      } else if (entry.sticker.texture !== texture) entry.sticker.texture = texture;
      entry.sticker.position.set(x, y);
      entry.sticker.visible = true;
      entry.stickerFrame = frame;
    },
    drawLoop(i, frame) {
      const l = running[i];
      if (l === undefined) return;
      const t = frame < 0 ? l.idle : (l.textures[frame] ?? l.idle);
      if (l.sprite.texture !== t) l.sprite.texture = t;
    },
    render,
  });

  // The wandering cats (OME-1520): their own walks on the walkers' step clock, drawn on the animator's frames, moved
  // once per 20 s slot of server time. Home on their placed cell under reduced motion, on a weak device's Basic, and
  // while the owner edits.
  interface Cat {
    readonly id: string;
    readonly w: CatWalker;
    /** The piece's own sprite: the sleeping cat at home, its empty bed while it's out. */
    readonly bedSprite: Sprite;
    readonly asleep: Texture;
    readonly bed: Texture;
    readonly walk: { readonly se: readonly Texture[]; readonly sw: readonly Texture[] };
    readonly sit: { readonly se: Texture; readonly sw: Texture };
    /** The cat out of bed, walking or sitting. */
    readonly sprite: Sprite;
    /** Where this slot's walk ends (or ended). */
    cell: number;
    /** Petted (OME-1669): when the heart sticker over the cat started (-1: none), and its sprite, made on the first pet. */
    petAt: number;
    heart: Sprite | null;
  }
  const catWalks = createWalks({ reducedMotion: () => reduced.matches, smooth: tier.smooth });
  const catPose = emptyPose();
  const serverNow = opts.serverNow ?? (() => Date.now());
  const weak = weakDevice(hints);
  let cats: Cat[] = [];
  let catGrid: Uint8Array = new Uint8Array(0);
  /** The cats' homes and grid as last set: an atlas rebuild of the same layout keeps them where they are. */
  let catsKey = "";
  let catTaken: ReadonlySet<number> = new Set<number>();
  let catsFrozen = false;
  let catTimer: ReturnType<typeof setTimeout> | undefined;
  const wanders = (): boolean => !catsFrozen && !reduced.matches && !(weak && !tier.smooth());
  const catTarget = (c: Cat): { id: string; at: Point; z: number; seatFacing: null } => {
    const at = centerOf(c.cell);
    return { id: c.id, at, z: standDepth(at), seatFacing: null };
  };
  /** This slot's walks (`due`: the slot a timer fired for), timed from the slot's start on my clock so every client's cats step together; or everyone home. Returns the slot. */
  const moveCats = (home: boolean, due?: number): number => {
    const s = serverNow();
    const slot = catSlot(s, due);
    for (const c of cats) c.cell = home ? c.w.home : catRest(catGrid, c.w.home, opts.roomId ?? "", c.w.piece, slot, catTaken);
    catWalks.place(cats.map(catTarget), performance.now() - Math.max(0, s - slot * CAT_SLOT_MS));
    animator.wake();
    return slot;
  };
  /** Arms the timer for the slot after `slot` (by default the slot of now). */
  const scheduleCats = (slot = catSlot(serverNow())): void => {
    clearTimeout(catTimer);
    catTimer = undefined;
    if (cats.length === 0 || destroyed || !wanders()) return;
    catTimer = setTimeout(() => {
      scheduleCats(moveCats(!wanders(), slot + 1));
    }, catWait(serverNow(), slot));
  };
  /** The scene's cats, put on this slot's resting cell like on every other client. */
  const setCats = (found: readonly { readonly w: CatWalker; readonly bedSprite: Sprite; readonly asleep: Texture }[], sheets: readonly (Sheet | null)[], grid: Uint8Array): void => {
    for (const c of cats) {
      c.sprite.destroy();
      c.heart?.destroy();
    }
    const tex = (k: string): Texture | undefined => sheets.map((sh) => sh?.texture(k)).find((t) => t !== undefined);
    const was = new Map(cats.map((c) => [c.id, c.cell]));
    const key = `${found.map((f) => String(f.w.home)).join(",")}|${grid.join("")}`;
    const keep = key === catsKey;
    catsKey = key;
    catGrid = grid;
    cats = found.flatMap((f) => {
      const walk = { se: f.w.walk.se.flatMap((k) => tex(k) ?? []), sw: f.w.walk.sw.flatMap((k) => tex(k) ?? []) };
      const se = tex(f.w.sit.se);
      const sw = tex(f.w.sit.sw);
      const bed = tex(f.w.bed);
      // Without all its frames (an older sheet) the cat just sleeps on its cell.
      if (se === undefined || sw === undefined || bed === undefined || walk.se.length !== f.w.walk.se.length || walk.sw.length !== f.w.walk.sw.length) return [];
      const id = `cat:${String(f.w.piece)}`;
      const sprite = new Sprite({ texture: se, label: id, visible: false });
      objectLayer.addChild(sprite);
      return [{ id, w: f.w, bedSprite: f.bedSprite, asleep: f.asleep, bed, walk, sit: { se, sw }, sprite, cell: keep ? (was.get(id) ?? f.w.home) : f.w.home, petAt: -1, heart: null }];
    });
    catWalks.setGrid(grid);
    if (keep) catWalks.place(cats.map(catTarget), performance.now());
    else moveCats(!wanders());
    scheduleCats();
  };
  /** Draws each cat at `now` (allocates nothing); true while one walks. */
  function drawCats(now: number): boolean {
    let walking = false;
    for (const c of cats) {
      if (!catWalks.sample(c.id, now, catPose)) continue;
      // Drawn first and unconditionally: `walking ||= drawHeart()` would skip it once another cat walks.
      if (drawHeart(c, now)) walking = true;
      const home = !catPose.walking && c.cell === c.w.home;
      const bedTexture = home ? c.asleep : c.bed;
      if (c.bedSprite.texture !== bedTexture) c.bedSprite.texture = bedTexture;
      if (c.sprite.visible === home) c.sprite.visible = !home;
      if (home) continue;
      // The art has se and sw only: ne walks use se, nw sw.
      const se = catPose.dir === "se" || catPose.dir === "ne";
      const loop = se ? c.walk.se : c.walk.sw;
      const t = catPose.walking ? (loop[Math.floor(catPose.step / 2) % loop.length] ?? c.sit.se) : se ? c.sit.se : c.sit.sw;
      if (c.sprite.texture !== t) {
        c.sprite.texture = t;
        // A texture swap keeps the old anchor; walk and sit frames each have their own.
        c.sprite.anchor.copyFrom(t.defaultAnchor ?? { x: 0, y: 0 });
      }
      c.sprite.position.set(catPose.x, catPose.y);
      c.sprite.zIndex = catPose.z;
      walking ||= catPose.walking;
    }
    return walking;
  }
  /** The petted cat's heart (OME-1669: `emote/heart`, one play over `catPose`; allocates only its sprite, once); true while it plays so frames keep coming. */
  function drawHeart(c: Cat, now: number): boolean {
    if (c.petAt < 0) return false;
    const cycle = motion?.frames.emote.heart;
    const f = cycle === undefined ? null : oneShotFrame(cycle.ms, now - c.petAt);
    const key = f === null || f.index < 0 ? undefined : cycle?.frames[f.index];
    const t = key === undefined ? undefined : motion?.texture(key);
    if (t === undefined) {
      if (c.heart !== null) c.heart.visible = false;
      if (f === null || f.nextIn === Infinity) c.petAt = -1;
      return false;
    }
    if (c.heart === null) {
      c.heart = new Sprite({ texture: t, label: `emote:${c.id}` });
      emoteLayer.addChild(c.heart);
    } else if (c.heart.texture !== t) c.heart.texture = t;
    c.heart.position.set(catPose.x, catPose.y - EMOTE_LIFT.idle);
    c.heart.visible = true;
    return true;
  }

  // The theme's effect (ADR 0052): particles on a small overlay canvas over the effect's band only, at 1 px per stage px
  // (QA OME-1211), drawn without reading any canvas (OME-1212); a tick never renders the room (OME-1206). Its own rAF
  // loop at ≤ 30 Hz; off under reduced motion and once the tier settles Basic; stops while the room is paused, and rAF
  // stops with a hidden tab.
  const fxCanvas = document.createElement("canvas");
  fxCanvas.className = "scene-fx";
  let particles: Particles | null = null;
  let painter: EffectPainter | null = null;
  let effectMs = 1000;
  /** The slowest effect tick so far (ms), for e2e. */
  let worstTick = 0;
  let effectRunning = false;
  let effectLast = 0;
  let effectTicks = 0;
  let destroyed = false;
  const effectAllowed = (): boolean => !reduced.matches && (tier.smooth() || tier.probing());
  /** At least half the effect's band is on screen. The phone's room window crops the back walls away, so the effect
   * sleeps there until the room is zoomed out (QA OME-1216); an observer, so it costs nothing per frame. */
  let inView = false;
  const stopEffect = (): void => {
    effectRunning = false;
    painter?.clear();
    fxCanvas.style.visibility = "hidden";
  };
  const effectFrame = (t: number): void => {
    if (destroyed || paused || particles === null || painter === null) {
      effectRunning = false;
      return;
    }
    if (!inView) {
      stopEffect();
      return;
    }
    if (!effectAllowed()) {
      // shortcut: once off (reduced motion turned on, tier settled Basic) it stays off until the room is opened again.
      stopEffect();
      return;
    }
    requestAnimationFrame(effectFrame);
    const dt = t - effectLast;
    if (dt < EFFECT_MIN_INTERVAL_MS) return;
    effectLast = t;
    const start = performance.now();
    // A long gap (tab back, resume): step as one frame, not a jump across the room.
    particles.step(Math.min(dt, 100));
    painter.paint(particles, Math.floor(t / effectMs));
    effectTicks++;
    // The first ticks pay one-off costs (the sheet's first upload); the guard is for the steady state.
    if (effectTicks > 3) worstTick = Math.max(worstTick, performance.now() - start);
  };
  const startEffect = (): void => {
    if (effectRunning || paused || !inView || particles === null || !effectAllowed()) return;
    effectRunning = true;
    fxCanvas.style.visibility = "visible";
    effectLast = performance.now();
    requestAnimationFrame(effectFrame);
  };
  const fxObserver = new IntersectionObserver(
    (entries) => {
      const e = entries.at(-1);
      if (e === undefined) return;
      inView = e.intersectionRatio >= 0.5;
      if (inView) startEffect();
    },
    { threshold: [0, 0.5, 1] },
  );
  /** Puts `max` particles of `frames` from `image` on the effect's overlay, sized to their band (theme or mood ambience: one pool). */
  const mountEffect = (image: CanvasImageSource, frames: readonly EffectFrame[], ms: number, max: number, m: EffectMotion): void => {
    const b = effectBounds(m, frames);
    // 1 backing px per stage px: the pixel art scales up with CSS (image-rendering: pixelated) like the rest.
    fxCanvas.width = b.w;
    fxCanvas.height = b.h;
    Object.assign(fxCanvas.style, { left: `${String(b.x)}px`, top: `${String(b.y)}px`, width: `${String(b.w)}px`, height: `${String(b.h)}px` });
    const ctx = fxCanvas.getContext("2d");
    if (ctx === null || frames.length === 0) return;
    ctx.imageSmoothingEnabled = false;
    effectMs = ms;
    particles = createParticles(m, max, Math.random);
    painter = createEffectPainter({ ctx, image, frames, origin: b });
    if (effectAllowed()) {
      // In the DOM only for an effect, right over the room canvas: a room without one keeps its DOM unchanged. Hidden
      // with visibility, not display, so the observer can still see where it is.
      fxCanvas.style.visibility = "hidden";
      app.canvas.after(fxCanvas);
      fxObserver.observe(fxCanvas);
    }
  };
  /** The mood ambience shown (OME-1689); stays null under a holiday theme, whose effect owns the pool. */
  let ambienceKind: Ambience["kind"] | null = null;
  if (themeId !== null) {
    void import("./theme/atlas")
      .then((m) => m.loadTheme(themeId))
      .then((t) => {
        if (destroyed) return;
        theme = t;
        placeDecor();
        for (const [id, entry] of pool) {
          wearHat(entry);
          if (entry.hair !== 0) relook(id, entry, entry.tint, entry.hair);
        }
        mountEffect(t.effect.image, t.effect.frames, t.effect.ms, t.effect.max, t.effect.motion);
        render();
      })
      // Without the theme's art the room is drawn as usual.
      .catch((e: unknown) => {
        console.warn("theme atlas failed to load", e);
      });
  }

  // One-off bursts on the effect engine (ADR 0052), each on its own small canvas made at its first burst: the door's
  // arrival sparkle (OME-1376, 12 sprites for 600 ms) and the crowd applause's confetti (OME-1389, 30 for 1.5 s). Off
  // where the theme effect is: reduced motion, and the Basic tier. A second burst while one runs restarts it.
  interface Burst { fire(): boolean; remove(): void }
  /** `art`: draws the frames side by side on a `w` × `h` canvas (original art, no sheet to fetch). */
  const createBurst = (motion: EffectMotion, frames: readonly EffectFrame[], w: number, h: number, art: (g: CanvasRenderingContext2D) => void, count: number, ms: number, frameMs: number): Burst => {
    const box = effectBounds(motion, frames);
    let fx: { canvas: HTMLCanvasElement; painter: EffectPainter } | null = null;
    let parts: Particles | null = null;
    let end = 0;
    let last = 0;
    const make = (): { canvas: HTMLCanvasElement; painter: EffectPainter } | null => {
      const image = document.createElement("canvas");
      image.width = w;
      image.height = h;
      const g = image.getContext("2d");
      const canvas = document.createElement("canvas");
      const ctx = canvas.getContext("2d");
      if (g === null || ctx === null) return null;
      art(g);
      canvas.className = "scene-fx";
      canvas.width = box.w;
      canvas.height = box.h;
      Object.assign(canvas.style, { left: `${String(box.x)}px`, top: `${String(box.y)}px`, width: `${String(box.w)}px`, height: `${String(box.h)}px`, visibility: "hidden" });
      ctx.imageSmoothingEnabled = false;
      app.canvas.after(canvas);
      return { canvas, painter: createEffectPainter({ ctx, image, frames, origin: box }) };
    };
    const frame = (t: number): void => {
      if (fx === null || parts === null) return;
      if (destroyed || t >= end) {
        fx.painter.clear();
        fx.canvas.style.visibility = "hidden";
        parts = null;
        return;
      }
      requestAnimationFrame(frame);
      if (t - last < EFFECT_MIN_INTERVAL_MS) return;
      parts.step(t - last);
      last = t;
      fx.painter.paint(parts, Math.floor(t / frameMs));
    };
    return {
      fire() {
        if (destroyed || paused || !effectAllowed()) return false;
        fx ??= make();
        if (fx === null) return false;
        const running = parts !== null;
        // Once per burst, not per frame.
        parts = createParticles(motion, count, Math.random);
        last = performance.now();
        end = last + ms;
        fx.canvas.style.visibility = "visible";
        if (!running) requestAnimationFrame(frame);
        return true;
      },
      remove() {
        fx?.canvas.remove();
      },
    };
  };
  /** A 5 px and a 3 px plus side by side. */
  const makeSparkle = (at: Point): Burst => createBurst(
    sparkleMotion(at),
    [
      { sx: 0, sy: 0, w: 5, h: 5, ox: 2, oy: 2 },
      { sx: 5, sy: 1, w: 3, h: 3, ox: 1, oy: 1 },
    ],
    8,
    5,
    (g) => {
      g.fillStyle = "#ffd75e";
      g.fillRect(2, 0, 1, 5);
      g.fillRect(0, 2, 5, 1);
      g.fillRect(6, 1, 1, 3);
      g.fillRect(5, 2, 3, 1);
      g.fillStyle = "#fffbe8";
      g.fillRect(2, 2, 1, 1);
      g.fillRect(6, 2, 1, 1);
    },
    SPARKLE_SPRITES,
    SPARKLE_MS,
    100,
  );
  const sparkle = makeSparkle(centerOf(DOOR));
  function arrive(): void {
    sparkle.fire();
  }
  // The same sparkle at a teleport's two pads (OME-1548) and in front of a door someone came through (OME-1558), one
  // burst per spot, made at its first use; past MAX_SPOT_SPARKLES spots they are all replaced, so canvases stay few.
  const MAX_SPOT_SPARKLES = 4;
  let spotSparkles = new Map<string, Burst>();
  const spotSparkle = (at: Point): void => {
    const key = `${String(at.x)},${String(at.y)}`;
    let b = spotSparkles.get(key);
    if (b === undefined) {
      if (spotSparkles.size >= MAX_SPOT_SPARKLES) {
        for (const old of spotSparkles.values()) old.remove();
        spotSparkles = new Map();
      }
      b = makeSparkle(at);
      spotSparkles.set(key, b);
    }
    b.fire();
  };
  /** Four 2 × 4 px paper chips, one colour each; a piece cycles through them as it tumbles. */
  const CONFETTI_COLORS = ["#ff5e7a", "#ffd75e", "#5ed3ff", "#7cff8a"];
  const confetti = createBurst(
    confettiMotion,
    CONFETTI_COLORS.map((_, i) => ({ sx: i * 3, sy: 0, w: 2, h: 4, ox: 1, oy: 2 })),
    12,
    4,
    (g) => {
      for (const [i, c] of CONFETTI_COLORS.entries()) {
        g.fillStyle = c;
        g.fillRect(i * 3, 0, 2, 4);
      }
    },
    CONFETTI_SPRITES,
    CONFETTI_MS,
    150,
  );
  let confettiBursts = 0;

  /**
   * A member's shirt tint (ADR 0053) or hair (OME-1438) changed: their frame and hat swap to that look's sheets now, or
   * once they've loaded. Hats take the hair only (their own colours never tint).
   */
  function relook(id: MemberId, e: Entry, tint: number, hair: number): void {
    e.tint = tint;
    e.hair = hair;
    const m = motion;
    if (m === null) return;
    const b = wearsBare(e.avatar, e.accessory) ? bare : null;
    const a = e.accessory > 0 ? accessories : null;
    const swap = (): void => {
      if (pool.get(id) !== e || e.tint !== tint || e.hair !== hair || e.frame === null || !(e.node instanceof Sprite)) return;
      const t = body(e, e.frame, e.avatar);
      if (t !== undefined && t !== e.node.texture) e.node.texture = t;
      wearHat(e);
      render();
    };
    const l = lieSheet;
    if (m.ready(e.avatar, tint, hair) && l?.ready(e.avatar, tint, hair) !== false && b?.ready(e.avatar, tint, hair) !== false && a?.ready(e.avatar, 0, hair) !== false && theme?.ready(e.avatar, 0, hair) !== false) swap();
    else
      Promise.all([m.loadTint(e.avatar, tint, hair), l?.loadTint(e.avatar, tint, hair), b?.loadTint(e.avatar, tint, hair), a?.loadTint(e.avatar, 0, hair), theme?.loadTint(e.avatar, 0, hair)]).then(swap, (err: unknown) => {
        console.warn("look sheets failed to load", err);
      });
  }

  const paintClocks = (s: HandSteps): void => {
    for (const c of clocks) {
      c.g.clear();
      for (const p of clockFace(c.facing, s)) c.g.rect(p.x, p.y, 1, 1).fill(p.color);
    }
  };
  /** A minute tick: a new time repaints the faces and re-bakes the shell once. */
  const tickClocks = (now: Date): void => {
    const s = handSteps(now);
    if (clockSteps !== null && s.hour === clockSteps.hour && s.minute === clockSteps.minute) return;
    clockSteps = s;
    paintClocks(s);
    bakeShell(background);
    render();
  };

  /** Hand the in-use loops to the animator; pieces no longer in use go back to their idle frame. */
  const applyLoops = (): void => {
    const was = running.length;
    running = looping.filter((l) => inUse.has(l.piece));
    for (const l of looping) if (!inUse.has(l.piece)) l.sprite.texture = l.idle;
    // Nothing looped and nothing does: no frame to ask for (a scene build in a room without loops costs no render).
    if (was > 0 || running.length > 0) animator.setLoops(running);
  };

  return {
    canvas: app.canvas,
    setScene(scene, sheets, walkGrid) {
      walks.setGrid(walkGrid);
      lastScene = scene;
      placeDecor();
      for (const s of furniture) s.destroy();
      for (const c of baked.removeChildren()) c.destroy();
      for (const m of markers) m?.destroy();
      furniture = [];
      looping = [];
      clocks = [];
      const found: { w: CatWalker; bedSprite: Sprite; asleep: Texture }[] = [];
      pieceSprites = [];
      pieceLoops = [];
      // Floor tiles and rugs, then walls and wall pieces, then objects; the background keeps that order, objects sort by depth.
      const ordered = ["floor", "wall", "object"].flatMap((layer) => scene.sprites.filter((f) => f.layer === layer));
      // Room and set (g) keys never collide (set (g)'s all start with `furniture/`).
      let planks = false;
      for (const f of ordered) {
        let texture;
        for (const sheet of sheets) texture ??= sheet?.texture(f.key);
        if (texture === undefined) continue;
        planks ||= f.key.startsWith("floor/");
        const s = new Sprite({ texture, label: f.key, x: f.x, y: f.y, zIndex: f.z });
        furniture.push(s);
        let live = false;
        if (f.use !== undefined) {
          // A loop runs only with all its frames in a loaded sheet; otherwise the piece stays still.
          const textures = f.use.frames.flatMap((k) => sheets.map((sheet) => sheet?.texture(k)).find((t) => t !== undefined) ?? []);
          live = textures.length === f.use.frames.length;
          if (live) looping.push({ sprite: s, piece: f.use.piece, idle: texture, textures, frames: textures.length, ms: f.use.ms });
        }
        // The cat's bed swaps to empty while it's out (OME-1520): drawn live, like a loop.
        if (f.walker !== undefined) {
          live = true;
          found.push({ w: f.walker, bedSprite: s, asleep: texture });
        }
        (f.layer === "object" ? objectLayer : live ? liveWall : background).addChild(s);
        const [, kind, , facing] = f.key.split("/");
        if (kind === "wallclock" && (facing === "se" || facing === "sw") && !live) {
          // Same depth, added after the sprite: the shell's stable sort keeps it right over its clock.
          const g = new Graphics({ label: `${f.key}/hands`, x: f.x, y: f.y, zIndex: f.z });
          furniture.push(g);
          background.addChild(g);
          clocks.push({ g, facing });
        }
        if (f.layer !== "object") continue;
        pieceSprites.push(s);
        pieceLoops.push(live);
        // A loop's frames change: it has no baked copy.
        if (!live) baked.addChild(new Sprite({ texture, label: f.key, x: f.x, y: f.y, zIndex: f.z }));
      }
      if (clocks.length > 0) {
        clockSteps = handSteps(new Date());
        paintClocks(clockSteps);
        stopClocks ??= minuteTicks({ now: () => new Date(), setTimer: (fn, ms) => setTimeout(fn, ms), clearTimer: (h) => { clearTimeout(h as ReturnType<typeof setTimeout>); }, document, onTick: tickClocks });
      } else {
        stopClocks?.();
        stopClocks = null;
      }
      shadows = new Set(pieceSprites);
      pinDirty = true;
      applyLoops();
      setCats(found, sheets, walkGrid);
      // The room atlas's planks cover every cell: skip drawing the placeholder floor under them.
      floor.visible = !planks;
      bakeShell(background);
      markers = scene.seats.map((seat, i) => {
        if (!seat.marker) return null;
        const g = new Graphics({ label: `seat:${String(i)}` });
        g.position.set(seat.at.x, seat.at.y);
        markerLayer.addChild(g);
        return g;
      });
      lastTaken = markers.map(() => null);
    },
    setInUse(pieces) {
      if (pieces.size === inUse.size && [...pieces].every((p) => inUse.has(p))) return;
      inUse = pieces;
      applyLoops();
    },
    cats() {
      const slot = Math.floor(serverNow() / CAT_SLOT_MS);
      const now = performance.now();
      return cats.flatMap((c) => {
        if (!catWalks.sample(c.id, now, catPose)) return [];
        const cell = cellAt(catPose);
        return [{ cell: `${String(colOf(cell))},${String(rowOf(cell))}`, walking: catPose.walking, slot }];
      });
    },
    catCells() {
      const now = performance.now();
      return cats.flatMap((c) => (catWalks.sample(c.id, now, catPose) ? [cellAt(catPose)] : []));
    },
    petCat(cell) {
      if (reduced.matches) return;
      const now = performance.now();
      for (const c of cats) if (catWalks.sample(c.id, now, catPose) && cellAt(catPose) === cell) c.petAt = now;
      animator.wake();
    },
    setCatRules(taken, frozen) {
      catTaken = taken;
      if (frozen === catsFrozen) return;
      catsFrozen = frozen;
      moveCats(!wanders());
      scheduleCats();
    },
    loops: () => running.map((l) => ({ key: l.sprite.label, frame: l.textures.indexOf(l.sprite.texture) })),
    update(seatTaken, avatars) {
      markers.forEach((g, i) => {
        if (g === null) return;
        const taken = seatTaken[i] ?? false;
        if (lastTaken[i] === taken) return;
        lastTaken[i] = taken;
        g.clear();
        diamond(g, { x: 0, y: 0 }, TILE_W - 12, TILE_H - 6)
          .fill(taken ? 0x6d597a : 0xb56576)
          .stroke({ color: 0xeaac8b, width: 2 });
      });
      const seen = new Set<MemberId>();
      for (const a of avatars) {
        seen.add(a.id);
        const had = pool.get(a.id);
        if (had !== undefined) {
          if (had.tint !== a.tint || had.hair !== a.hair) relook(a.id, had, a.tint, a.hair);
          if (had.accessory !== a.accessory) {
            had.accessory = a.accessory;
            reframe(a.id, had);
          }
          continue;
        }
        const g = new Graphics({ label: `avatar:${a.id}`, alpha: alphaOf(a.id) });
        drawAvatar(g, a.avatar);
        pool.set(a.id, { node: g, avatar: a.avatar, tint: 0, hair: 0, x: NaN, y: NaN, walking: false, frame: null, sticker: null, stickerFrame: null, hat: null, accessory: a.accessory });
        objectLayer.addChild(g);
        const added = pool.get(a.id);
        if (added !== undefined && (a.tint !== 0 || a.hair !== 0)) relook(a.id, added, a.tint, a.hair);
      }
      for (const [id, entry] of pool) {
        if (seen.has(id)) continue;
        entry.node.destroy();
        entry.sticker?.destroy();
        if (entry.hat?.visible === true) hatsShown--;
        entry.hat?.destroy();
        pool.delete(id);
      }
      if (avatars.some((a) => a.lie !== undefined)) loadLie();
      if (avatars.some((a) => a.accessory !== 0)) loadAccessories();
      if (avatars.some((a) => wearsBare(a.avatar, a.accessory))) loadBare();
      walks.place(avatars, performance.now());
      animator.set(avatars);
      render();
      // The motion sheets load once people are in the room (after join), never on first paint (ADR 0010).
      if (!motionLoad && avatars.length > 0) {
        motionLoad = true;
        void import("./walk/motion-atlas")
          .then((m) => m.loadMotionAtlas())
          .then((loaded) => {
            motion = loaded;
            animator.setFrames(loaded.frames);
            for (const [id, e] of pool) if (e.tint !== 0 || e.hair !== 0) relook(id, e, e.tint, e.hair);
          })
          // Without the sheets the room still works: placeholder avatars that walk. The next join retries.
          .catch((e: unknown) => {
            motionLoad = false;
            console.warn("motion atlas failed to load", e);
          });
      }
    },
    editLayer,
    marker(cell, scale) {
      if (cell === null) {
        if (!hover.visible) return;
        hover.visible = false;
      } else {
        drawCursor(hover, { col: cell.x, row: cell.y, wall: null }, scale);
        hover.visible = true;
        const b = hover.getBounds();
        hoverBox = { x0: b.minX, y0: b.minY, x1: b.maxX, y1: b.maxY };
      }
      render();
    },
    redraw: render,
    setPaused(next) {
      if (next === paused) return;
      paused = next;
      // Resuming queues one frame that draws everyone where they are now (a walk may have ended meanwhile).
      animator.pause(next);
      if (!next) startEffect();
    },
    paused: () => paused,
    renders: () => renders,
    loadPairPoses() {
      if (pairLoad) return;
      pairLoad = true;
      void import("./walk/pair-atlas")
        .then((m) => m.loadPairAtlas())
        .then((p) => {
          if (!destroyed) pairSheet = p;
        })
        // Without it a pair just doesn't draw; the next pairs room retries.
        .catch((e: unknown) => {
          pairLoad = false;
          console.warn("pair poses failed to load", e);
        });
    },
    pair(thruster, bender) {
      const sheet = pairSheet;
      if (sheet === null) return;
      const looks = [thruster, bender].flatMap((id) => pool.get(id) ?? []);
      Promise.all(looks.map((e) => sheet.loadTint(e.avatar, e.tint, e.hair))).then(
        () => {
          if (!destroyed) animator.pair(thruster, bender);
        },
        (err: unknown) => {
          console.warn("pair look sheets failed to load", err);
        },
      );
    },
    conga(ids) {
      animator.conga(ids);
    },
    emote(id, kind) {
      // Petting the cat (reach) goes out to everyone else as a wave, so it sounds like one here too.
      opts.sound?.play(EMOTE_SOUNDS[kind === "reach" ? "wave" : kind]);
      animator.emote(id, kind);
    },
    setDimmed(id, on) {
      if (dimmed.has(id) === on) return;
      if (on) dimmed.add(id);
      else dimmed.delete(id);
      const e = pool.get(id);
      if (e === undefined) return;
      e.node.alpha = alphaOf(id);
      if (e.hat !== null) e.hat.alpha = e.node.alpha;
      render();
    },
    setAway(id, on) {
      if (away.has(id) === on) return;
      if (on) away.add(id);
      else away.delete(id);
      const e = pool.get(id);
      if (e === undefined) return;
      e.node.alpha = alphaOf(id);
      if (e.hat !== null) e.hat.alpha = e.node.alpha;
      render();
    },
    alpha: (id) => pool.get(id)?.node.alpha,
    frames(id) {
      const e = pool.get(id);
      if (e === undefined) return undefined;
      // The accessory drawn: the hat sprite shows its texture in their hair's copy (not the theme's hat, nor the shipped hair).
      const own = e.frame === null || e.hat?.visible !== true || accessories?.ready(e.avatar, 0, e.hair) !== true ? undefined : accessories.hat(e.accessory, e.frame, e.avatar, e.hair);
      const drawn = motion?.ready(e.avatar, e.tint, e.hair) === true;
      return {
        avatar: e.frame,
        sticker: e.stickerFrame,
        tint: drawn ? e.tint : 0,
        hair: drawn ? e.hair : 0,
        accessory: own !== undefined && own === e.hat?.texture ? e.accessory : 0,
        bare: e.frame !== null && e.node instanceof Sprite && bare !== null && wearsBare(e.avatar, e.accessory) && e.node.texture === bare.texture(e.frame, e.avatar, e.tint, e.hair),
        // The hat sits where its frame says: its anchor is its texture's (QA OME-1538).
        hatAnchored: e.hat?.visible === true && e.hat.anchor.x === (e.hat.texture.defaultAnchor?.x ?? 0) && e.hat.anchor.y === (e.hat.texture.defaultAnchor?.y ?? 0),
      };
    },
    position(id) {
      const e = pool.get(id);
      return e === undefined || Number.isNaN(e.x) ? undefined : { x: e.x, y: e.y };
    },
    drawOrder() {
      const sorted = [...objectLayer.children].sort((a, b) => a.zIndex - b.zIndex);
      return [...background.children.filter((c) => c !== baked), ...liveWall.children, ...markerLayer.children, ...sorted].map((c) => c.label);
    },
    theme: () => ({ id: themeId, decor: decorLayer.children.length, hats: hatsShown, effect: effectRunning ? (particles?.count ?? 0) : 0, ticks: effectTicks, worstTickMs: worstTick }),
    confetti() {
      if (confetti.fire()) confettiBursts++;
    },
    confettiBursts: () => confettiBursts,
    ambience(mood) {
      const a = ambienceFor(mood, themeId, effectAllowed());
      if ((a?.kind ?? null) === ambienceKind) return;
      ambienceKind = a?.kind ?? null;
      // Swapped under a running loop, not stopped and restarted: a stop leaves its rAF pending, so a start would add a second loop.
      painter?.clear();
      particles = null;
      painter = null;
      if (a === null) {
        fxCanvas.style.visibility = "hidden";
        return;
      }
      const image = document.createElement("canvas");
      image.width = a.w;
      image.height = a.h;
      const g = image.getContext("2d");
      if (g === null) return;
      a.art(g);
      mountEffect(image, a.frames, a.ms, a.max, a.motion);
      if (effectRunning) fxCanvas.style.visibility = "visible";
      else startEffect();
    },
    reactionsAllowed: () => !reduced.matches && tier.smooth() && lastWorkMs < REACTION_NEAR_BUDGET_MS,
    destroy() {
      destroyed = true;
      clearTimeout(catTimer);
      stopClocks?.();
      fxObserver.disconnect();
      fxCanvas.remove();
      sparkle.remove();
      for (const b of spotSparkles.values()) b.remove();
      confetti.remove();
      animator.dispose();
      app.destroy(true, { children: true });
    },
  };
}
