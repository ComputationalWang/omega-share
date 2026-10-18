// The PixiJS layer: floor, furniture, seats and avatars, on the 2D canvas renderer (ADR 0029). Rendered on demand (no ticker): frames
// run only while someone walks (once per step in Basic, every frame in Smooth, ADR 0037), and breathing redraws only
// when its frame changes (walk/animator.ts).
import { Application, Container, Graphics, Sprite, Ticker } from "pixi.js";
import { AVATAR_COUNT, type EmoteKind, type FloorCell, type MemberId } from "@omega/shared";
import type { Sheet } from "./atlas-sheet";
import { drawCursor } from "./cell-cursor";
import type { Scene } from "./furniture";
import { AVATAR_COLORS, FLOOR_CELLS, STAGE_H, STAGE_W, TILE_H, TILE_W, cellCenter, type Point } from "./layout";
import { createAnimator } from "./walk/animator";
import type { MotionAtlas } from "./walk/motion-atlas";
import { createTier, createTierProbe, readTierHints } from "./walk/tier";
import { createWalks, type Dir } from "./walk/walks";
import type { ThemeAtlas } from "./theme/atlas";
import { decorSprites } from "./theme/decor";
import { CONFETTI_MS, CONFETTI_SPRITES, EFFECT_MIN_INTERVAL_MS, SPARKLE_MS, SPARKLE_SPRITES, confettiMotion, createEffectPainter, createParticles, effectBounds, sparkleMotion, type EffectFrame, type EffectMotion, type EffectPainter, type Particles } from "./theme/effect";
import { DOOR, centerOf } from "./walk/path";
import { resolveTheme } from "./theme/periods";

export interface AvatarPlacement {
  readonly id: MemberId;
  readonly avatar: number;
  /** Shirt tint (ADR 0053), 0 the avatar's own colours. */
  readonly tint: number;
  readonly at: Point;
  /** Depth among furniture and other avatars (furniture.ts: a sitter takes its seat's, others `standDepth`). */
  readonly z: number;
  /** The seat's facing if they sit, null if they stand (walk/walks.ts). */
  readonly seatFacing: Dir | null;
}

export interface RoomViewOptions {
  /** An avatar moved while walking (stage px), for the DOM name tags and bubbles. */
  readonly onMove?: (id: MemberId, x: number, y: number) => void;
  /** An avatar came to rest after a walk or a jump (stage px): the bubbles resolve overlap here, never per frame. */
  readonly onStop?: (id: MemberId, x: number, y: number) => void;
}

export interface RoomView {
  readonly canvas: HTMLCanvasElement;
  /** The room's shell, furniture and seat markers; rebuilt once per layout change (or when an atlas arrives). Draws on the next `update`. */
  setScene(scene: Scene, sheets: readonly (Sheet | null)[], walkGrid: Uint8Array): void;
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
  /** `id` emoted (OME-415): a one-shot on the render loop. Nothing under prefers-reduced-motion (room.ts shows a badge). */
  emote(id: MemberId, kind: EmoteKind): void;
  /** The motion frame each is drawn with now, their sticker's (null: none) and the shirt tint drawn, for e2e checks. */
  frames(id: MemberId): { avatar: string | null; sticker: string | null; tint: number } | undefined;
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
  destroy(): void;
}

/** A hidden member's avatar (OME-769): still there, plainly set apart. */
export const DIMMED_ALPHA = 0.4;
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
  /** The shirt tint asked for; drawn once the atlas has its sheets (until then, tint 0's). */
  tint: number;
  x: number;
  y: number;
  walking: boolean;
  frame: string | null;
  sticker: Sprite | null;
  stickerFrame: string | null;
  /** The holiday theme's hat over the avatar (ADR 0052); made on first need, then hidden or re-framed. */
  hat: Sprite | null;
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
  background.addChild(floor);
  bakeShell(background);
  // The holiday theme (ADR 0052): decor over the walls, behind the furniture and avatars (the effect has its own canvas).
  const decorLayer = new Container({ label: "decor" });
  const editLayer = new Container({ label: "edit" });
  const markerLayer = new Container();
  // Free walking's hover diamond (OME-1350): on the floor, under seats and avatars; not in `drawOrder`.
  const hover = new Graphics({ label: "walk-marker", visible: false });
  const objectLayer = new Container({ sortableChildren: true });
  // Emote stickers float over everyone (OME-415).
  const emoteLayer = new Container({ label: "emotes" });
  app.stage.addChild(background, decorLayer, editLayer, hover, markerLayer, objectLayer, emoteLayer);

  /** Marker per placeholder seat, by seat index. */
  let markers: (Graphics | null)[] = [];
  let lastTaken: (boolean | null)[] = [];
  let furniture: Sprite[] = [];
  const pool = new Map<MemberId, Entry>();

  /** Members drawn dimmed (OME-769); a member's node takes it on when made or swapped for a sprite. */
  const dimmed = new Set<MemberId>();
  const away = new Set<MemberId>();
  const alphaOf = (id: MemberId): number => avatarAlphaFor(dimmed.has(id), away.has(id));

  let paused = false;
  let renders = 0;
  const render = (): void => {
    if (paused) return;
    pumpSystem();
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
    for (const c of decorLayer.removeChildren()) c.destroy();
    if (theme === null || lastScene === null) return;
    for (const d of decorSprites(lastScene, theme.decor)) {
      const texture = theme.texture(d.key);
      if (texture !== undefined) decorLayer.addChild(new Sprite({ texture, label: d.key, x: d.x, y: d.y }));
    }
  };
  /** Put the theme's hat over the avatar's frame (the hat sprite is the difference to the hatted frame), or take it off. */
  const wearHat = (entry: Entry): void => {
    const texture = theme === null || entry.frame === null ? undefined : theme.hat(entry.frame);
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
    } else if (entry.hat.texture !== texture) entry.hat.texture = texture;
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
  const tier = createTier(readTierHints({ reducedMotion: reduced.matches, navigator: globalThis.navigator, storage: storage() }));
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
  let frameFn: (() => void) | null = null;
  const onFrame = (t: number): void => {
    frameTs = t;
    frameFn?.();
  };
  const walks = createWalks({
    reducedMotion: () => reduced.matches,
    smooth: tier.smooth,
    onDoor: () => {
      arrive();
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
    rendered(start, walking) {
      probe.rendered(start, frameTs, walking);
      showTier();
    },
    draw(id, avatar, pose, frame) {
      const entry = pool.get(id);
      if (entry === undefined) return;
      const texture = frame === null ? undefined : motion?.texture(frame, avatar, entry.tint);
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
      const moved = entry.x !== x || entry.y !== y;
      if (moved) {
        entry.x = x;
        entry.y = y;
        opts.onMove?.(id, x, y);
      }
      if (!pose.walking && (entry.walking || moved)) opts.onStop?.(id, x, y);
      entry.walking = pose.walking;
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
    render,
  });

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
  if (themeId !== null) {
    void import("./theme/atlas")
      .then((m) => m.loadTheme(themeId))
      .then((t) => {
        if (destroyed) return;
        theme = t;
        placeDecor();
        for (const entry of pool.values()) wearHat(entry);
        const b = effectBounds(t.effect.motion, t.effect.frames);
        // 1 backing px per stage px: the pixel art scales up with CSS (image-rendering: pixelated) like the rest.
        fxCanvas.width = b.w;
        fxCanvas.height = b.h;
        Object.assign(fxCanvas.style, { left: `${String(b.x)}px`, top: `${String(b.y)}px`, width: `${String(b.w)}px`, height: `${String(b.h)}px` });
        const ctx = fxCanvas.getContext("2d");
        if (ctx !== null && t.effect.frames.length > 0) {
          ctx.imageSmoothingEnabled = false;
          effectMs = t.effect.ms;
          particles = createParticles(t.effect.motion, t.effect.max, Math.random);
          painter = createEffectPainter({ ctx, image: t.effect.image, frames: t.effect.frames, origin: b });
          if (effectAllowed()) {
            // In the DOM only for an effect, right over the room canvas: an unthemed room's DOM is unchanged. Hidden
            // with visibility, not display, so the observer can still see where it is.
            fxCanvas.style.visibility = "hidden";
            app.canvas.after(fxCanvas);
            fxObserver.observe(fxCanvas);
          }
        }
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
  const sparkle = createBurst(
    sparkleMotion(centerOf(DOOR)),
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
  function arrive(): void {
    sparkle.fire();
  }
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

  /** A member's shirt tint changed (ADR 0053): their frame swaps to that tint's sheets now, or once they've loaded. */
  function retint(id: MemberId, e: Entry, tint: number): void {
    e.tint = tint;
    const m = motion;
    if (m === null) return;
    const swap = (): void => {
      if (pool.get(id) !== e || e.tint !== tint || e.frame === null || !(e.node instanceof Sprite)) return;
      const t = m.texture(e.frame, e.avatar, tint);
      if (t === undefined || t === e.node.texture) return;
      e.node.texture = t;
      render();
    };
    if (m.ready(e.avatar, tint)) swap();
    else
      m.loadTint(e.avatar, tint).then(swap, (err: unknown) => {
        console.warn("tint sheets failed to load", err);
      });
  }

  return {
    canvas: app.canvas,
    setScene(scene, sheets, walkGrid) {
      walks.setGrid(walkGrid);
      lastScene = scene;
      placeDecor();
      for (const s of furniture) s.destroy();
      for (const m of markers) m?.destroy();
      furniture = [];
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
        (f.layer === "object" ? objectLayer : background).addChild(s);
      }
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
          if (had.tint !== a.tint) retint(a.id, had, a.tint);
          continue;
        }
        const g = new Graphics({ label: `avatar:${a.id}`, alpha: alphaOf(a.id) });
        drawAvatar(g, a.avatar);
        pool.set(a.id, { node: g, avatar: a.avatar, tint: 0, x: NaN, y: NaN, walking: false, frame: null, sticker: null, stickerFrame: null, hat: null });
        objectLayer.addChild(g);
        const added = pool.get(a.id);
        if (added !== undefined && a.tint !== 0) retint(a.id, added, a.tint);
      }
      for (const [id, entry] of pool) {
        if (seen.has(id)) continue;
        entry.node.destroy();
        entry.sticker?.destroy();
        if (entry.hat?.visible === true) hatsShown--;
        entry.hat?.destroy();
        pool.delete(id);
      }
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
            for (const [id, e] of pool) if (e.tint !== 0) retint(id, e, e.tint);
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
    emote(id, kind) {
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
      return e === undefined ? undefined : { avatar: e.frame, sticker: e.stickerFrame, tint: motion?.ready(e.avatar, e.tint) === true ? e.tint : 0 };
    },
    position(id) {
      const e = pool.get(id);
      return e === undefined || Number.isNaN(e.x) ? undefined : { x: e.x, y: e.y };
    },
    drawOrder() {
      const sorted = [...objectLayer.children].sort((a, b) => a.zIndex - b.zIndex);
      return [...background.children, ...markerLayer.children, ...sorted].map((c) => c.label);
    },
    theme: () => ({ id: themeId, decor: decorLayer.children.length, hats: hatsShown, effect: effectRunning ? (particles?.count ?? 0) : 0, ticks: effectTicks, worstTickMs: worstTick }),
    confetti() {
      if (confetti.fire()) confettiBursts++;
    },
    confettiBursts: () => confettiBursts,
    destroy() {
      destroyed = true;
      fxObserver.disconnect();
      fxCanvas.remove();
      sparkle.remove();
      confetti.remove();
      animator.dispose();
      app.destroy(true, { children: true });
    },
  };
}
