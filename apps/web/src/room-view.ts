// The PixiJS layer: floor, furniture, seats and placeholder avatars. Rendered on demand (no ticker), so an idle room costs no frames.
import { Application, Container, Graphics, Sprite, Ticker } from "pixi.js";
import { AVATAR_COUNT, type MemberId } from "@omega/shared";
import type { FurnitureAtlas } from "./furniture-atlas";
import type { Scene } from "./furniture";
import { AVATAR_COLORS, FLOOR_CELLS, STAGE_H, STAGE_W, TILE_H, TILE_W, cellCenter, type Point } from "./layout";

export interface AvatarPlacement {
  readonly id: MemberId;
  readonly avatar: number;
  readonly at: Point;
  /** Depth among furniture and other avatars (furniture.ts: a sitter takes its seat's, others `standDepth`). */
  readonly z: number;
}

export interface RoomView {
  readonly canvas: HTMLCanvasElement;
  /** The room's furniture and seat markers; rebuilt once per layout change (or when the atlas arrives). Draws on the next `update`. */
  setScene(scene: Scene, atlas: FurnitureAtlas | null): void;
  /** Seat occupancy and who stands where; redraws once. */
  update(seatTaken: readonly boolean[], avatars: readonly AvatarPlacement[]): void;
  /** Labels in draw order (floor, furniture frame keys, `seat:<i>`, `avatar:<id>`), for e2e depth checks. */
  drawOrder(): string[];
  destroy(): void;
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

export async function createRoomView(): Promise<RoomView> {
  const app = new Application();
  await app.init({
    width: STAGE_W,
    height: STAGE_H,
    backgroundAlpha: 0,
    antialias: false,
    autoStart: false,
    resolution: Math.min(2, globalThis.devicePixelRatio || 1),
    autoDensity: true,
    preference: "webgl",
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
  const markerLayer = new Container();
  const objectLayer = new Container({ sortableChildren: true });
  app.stage.addChild(background, markerLayer, objectLayer);

  /** Marker per placeholder seat, by seat index. */
  let markers: (Graphics | null)[] = [];
  let lastTaken: (boolean | null)[] = [];
  let furniture: Sprite[] = [];
  const pool = new Map<MemberId, { g: Graphics; avatar: number }>();

  const render = (): void => {
    pumpSystem();
    app.render();
  };

  return {
    canvas: app.canvas,
    setScene(scene, atlas) {
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
        let entry = pool.get(a.id);
        if (entry === undefined) {
          entry = { g: new Graphics({ label: `avatar:${a.id}` }), avatar: -1 };
          pool.set(a.id, entry);
          objectLayer.addChild(entry.g);
        }
        if (entry.avatar !== a.avatar) {
          drawAvatar(entry.g, a.avatar);
          entry.avatar = a.avatar;
        }
        entry.g.position.set(a.at.x, a.at.y);
        entry.g.zIndex = a.z;
      }
      for (const [id, entry] of pool) {
        if (seen.has(id)) continue;
        entry.g.destroy();
        pool.delete(id);
      }
      render();
    },
    drawOrder() {
      const sorted = [...objectLayer.children].sort((a, b) => a.zIndex - b.zIndex);
      return [...background.children, ...markerLayer.children, ...sorted].map((c) => c.label);
    },
    destroy() {
      app.destroy(true, { children: true });
    },
  };
}
