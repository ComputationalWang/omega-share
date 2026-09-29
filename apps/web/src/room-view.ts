// The PixiJS layer: floor, seats and placeholder avatars. Rendered on demand (no ticker), so an idle room costs no frames.
import { Application, Container, Graphics } from "pixi.js";
import { AVATAR_COUNT, type MemberId } from "@omega/shared";
import { AVATAR_COLORS, FLOOR_CELLS, SEATS, STAGE_H, STAGE_W, TILE_H, TILE_W, cellCenter, type Point } from "./layout";

export interface AvatarPlacement {
  readonly id: MemberId;
  readonly avatar: number;
  readonly at: Point;
}

export interface RoomView {
  readonly canvas: HTMLCanvasElement;
  /** Seat occupancy and who stands where; redraws once. */
  update(seatTaken: readonly boolean[], avatars: readonly AvatarPlacement[]): void;
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

  const floor = new Graphics();
  for (let c = 0; c < FLOOR_CELLS; c++) {
    for (let r = 0; r < FLOOR_CELLS; r++) diamond(floor, cellCenter(c, r), TILE_W, TILE_H).fill((c + r) % 2 ? 0x3a3450 : 0x443d5e);
  }
  const seats = SEATS.map((p) => {
    const g = new Graphics();
    g.position.set(p.x, p.y);
    return g;
  });
  const avatarLayer = new Container({ sortableChildren: true });
  app.stage.addChild(floor, ...seats, avatarLayer);

  const pool = new Map<MemberId, { g: Graphics; avatar: number }>();
  const lastTaken: (boolean | null)[] = SEATS.map(() => null);

  return {
    canvas: app.canvas,
    update(seatTaken, avatars) {
      seats.forEach((g, i) => {
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
          entry = { g: new Graphics(), avatar: -1 };
          pool.set(a.id, entry);
          avatarLayer.addChild(entry.g);
        }
        if (entry.avatar !== a.avatar) {
          drawAvatar(entry.g, a.avatar);
          entry.avatar = a.avatar;
        }
        entry.g.position.set(a.at.x, a.at.y);
        entry.g.zIndex = a.at.y;
      }
      for (const [id, entry] of pool) {
        if (seen.has(id)) continue;
        entry.g.destroy();
        pool.delete(id);
      }
      app.render();
    },
    destroy() {
      app.destroy(true, { children: true });
    },
  };
}
