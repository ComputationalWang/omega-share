// Theme decor (OME-1186, ADR 0052): overlay sprites on the classic room's wall frames. Not furniture: not in the layout,
// never sent, so an owner's layout can't collide with it. Each piece's anchor is its wall frame's floor point
// (assets/STYLE.md "Holiday themes"). Pure; built once per scene, never per frame.
import type { Scene } from "../furniture";

export interface DecorPiece {
  readonly key: string;
  /** The wall frame it hangs on, e.g. `wall/l/window0`; `wall/l` / `wall/r` is every segment of that wall (a garland). */
  readonly on: string;
}

/** Where each decor piece goes in `scene`: only in the classic room, only on wall frames it has. */
export function decorSprites(scene: Scene, decor: readonly DecorPiece[]): { key: string; x: number; y: number }[] {
  if (!scene.classic) return [];
  return decor.flatMap((d) => {
    const segment = d.on === "wall/l" || d.on === "wall/r" ? `${d.on}/` : null;
    // A wall's open end is its edge, not a segment.
    const hangs = (key: string): boolean => (segment === null ? key === d.on : key.startsWith(segment) && key !== `${segment}end`);
    return scene.sprites.filter((s) => s.layer === "wall" && hangs(s.key)).map((s) => ({ key: d.key, x: s.x, y: s.y }));
  });
}
