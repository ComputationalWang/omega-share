// The PixiJS layer: floor, furniture, seats and avatars, on the 2D canvas renderer (ADR 0029). Rendered on demand (no ticker): frames
// run only while someone walks (once per step in Basic, every frame in Smooth, ADR 0037), and breathing redraws only
// when its frame changes (walk/animator.ts).
import { Application, Container, Graphics, Sprite, Ticker } from "pixi.js";
import { AVATAR_COUNT, type EmoteKind, type MemberId } from "@omega/shared";
import type { FurnitureAtlas } from "./furniture-atlas";
import type { Scene } from "./furniture";
import { AVATAR_COLORS, FLOOR_CELLS, STAGE_H, STAGE_W, TILE_H, TILE_W, cellCenter, type Point } from "./layout";
import { createAnimator } from "./walk/animator";
import type { MotionAtlas } from "./walk/motion-atlas";
import { createTier, createTierProbe, readTierHints } from "./walk/tier";
import { createWalks, type Dir } from "./walk/walks";

export interface AvatarPlacement {
  readonly id: MemberId;
  readonly avatar: number;
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
  /** The room's furniture and seat markers; rebuilt once per layout change (or when the atlas arrives). Draws on the next `update`. */
  setScene(scene: Scene, atlas: FurnitureAtlas | null, walkGrid: Uint8Array): void;
  /** Seat occupancy and who sits or stands where; redraws once, then walks anyone whose spot changed (walk/). */
  update(seatTaken: readonly boolean[], avatars: readonly AvatarPlacement[]): void;
  /** Where an avatar is drawn now (mid-walk, between cells), stage px. */
  position(id: MemberId): Point | undefined;
  /** The owner editor's layer (set (h) grid and footprint markers): over the floor, rugs and walls, under seats and objects. */
  readonly editLayer: Container;
  /** Draw once now, after the editor changed its layer. */
  redraw(): void;
  /** Full screen hides the room (OME-597): stop drawing until resumed, then draw once as things are now. */
  setPaused(paused: boolean): void;
  readonly paused: () => boolean;
  /** How many times the room has been drawn, for e2e "a bubble costs no render" checks. */
  renders(): number;
  /** `id` emoted (OME-415): a one-shot on the render loop. Nothing under prefers-reduced-motion (room.ts shows a badge). */
  emote(id: MemberId, kind: EmoteKind): void;
  /** The motion frame each is drawn with now, and their sticker's (null: none), for e2e checks. */
  frames(id: MemberId): { avatar: string | null; sticker: string | null } | undefined;
  /** Labels in draw order (floor, furniture frame keys, `seat:<i>`, `avatar:<id>`), for e2e depth checks. */
  drawOrder(): string[];
  destroy(): void;
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
  const editLayer = new Container({ label: "edit" });
  const markerLayer = new Container();
  const objectLayer = new Container({ sortableChildren: true });
  // Emote stickers float over everyone (OME-415).
  const emoteLayer = new Container({ label: "emotes" });
  app.stage.addChild(background, editLayer, markerLayer, objectLayer, emoteLayer);

  /** Marker per placeholder seat, by seat index. */
  let markers: (Graphics | null)[] = [];
  let lastTaken: (boolean | null)[] = [];
  let furniture: Sprite[] = [];
  /** Per member: the placeholder shape until the motion atlas is in, then a sprite. `x`/`y` is where it's drawn. */
  const pool = new Map<MemberId, { node: Graphics | Sprite; avatar: number; x: number; y: number; walking: boolean; frame: string | null; sticker: Sprite | null; stickerFrame: string | null }>();

  let paused = false;
  let renders = 0;
  const render = (): void => {
    if (paused) return;
    pumpSystem();
    app.render();
    renders++;
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
  const walks = createWalks({ reducedMotion: () => reduced.matches, smooth: tier.smooth });
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
      const texture = frame === null ? undefined : motion?.texture(frame);
      if (texture !== undefined) {
        if (!(entry.node instanceof Sprite)) {
          const sprite = new Sprite({ texture, label: entry.node.label });
          objectLayer.addChild(sprite);
          entry.node.destroy();
          entry.node = sprite;
        } else if (entry.node.texture !== texture) entry.node.texture = texture;
      } else if (entry.node instanceof Graphics && entry.avatar !== avatar) drawAvatar(entry.node, avatar);
      entry.avatar = avatar;
      entry.frame = texture === undefined ? null : frame;
      entry.node.position.set(pose.x, pose.y);
      entry.node.zIndex = pose.z;
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

  return {
    canvas: app.canvas,
    setScene(scene, atlas, walkGrid) {
      walks.setGrid(walkGrid);
      for (const s of furniture) s.destroy();
      for (const m of markers) m?.destroy();
      furniture = [];
      // Rugs, then wall pieces, then objects; the background keeps that order, objects sort by depth.
      const ordered = atlas === null ? [] : ["floor", "wall", "object"].flatMap((layer) => scene.sprites.filter((f) => f.layer === layer));
      for (const f of ordered) {
        const texture = atlas?.texture(f.key);
        if (texture === undefined) continue;
        const s = new Sprite({ texture, label: f.key, x: f.x, y: f.y, zIndex: f.z });
        furniture.push(s);
        (f.layer === "object" ? objectLayer : background).addChild(s);
      }
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
        if (pool.has(a.id)) continue;
        const g = new Graphics({ label: `avatar:${a.id}` });
        drawAvatar(g, a.avatar);
        pool.set(a.id, { node: g, avatar: a.avatar, x: NaN, y: NaN, walking: false, frame: null, sticker: null, stickerFrame: null });
        objectLayer.addChild(g);
      }
      for (const [id, entry] of pool) {
        if (seen.has(id)) continue;
        entry.node.destroy();
        entry.sticker?.destroy();
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
          })
          // Without the sheets the room still works: placeholder avatars that walk. The next join retries.
          .catch((e: unknown) => {
            motionLoad = false;
            console.warn("motion atlas failed to load", e);
          });
      }
    },
    editLayer,
    redraw: render,
    setPaused(next) {
      if (next === paused) return;
      paused = next;
      // Resuming queues one frame that draws everyone where they are now (a walk may have ended meanwhile).
      animator.pause(next);
    },
    paused: () => paused,
    renders: () => renders,
    emote(id, kind) {
      animator.emote(id, kind);
    },
    frames(id) {
      const e = pool.get(id);
      return e === undefined ? undefined : { avatar: e.frame, sticker: e.stickerFrame };
    },
    position(id) {
      const e = pool.get(id);
      return e === undefined || Number.isNaN(e.x) ? undefined : { x: e.x, y: e.y };
    },
    drawOrder() {
      const sorted = [...objectLayer.children].sort((a, b) => a.zIndex - b.zIndex);
      return [...background.children, ...markerLayer.children, ...sorted].map((c) => c.label);
    },
    destroy() {
      animator.dispose();
      app.destroy(true, { children: true });
    },
  };
}
