// Name tags painted on the room canvas (OME-2307, Doorstep desk 3): the `tag/0` / `tag/self` 9-slices (assets/ui/slices)
// with the nickname, the shirt-tint underline and the leader pip, in one layer over the avatars. A walker's tag moves on
// the walk frames the canvas draws anyway, so walking writes no DOM. The DOM keeps a transparent target per tag (stage.ts:
// moderation, focus, a11y) whose box gives each tag's width, so the two always match. Pooled: a member who leaves frees
// theirs for the next one.
import { CanvasTextMetrics, Container, Graphics, NineSliceSprite, Text, TextStyle, type Texture } from "pixi.js";
import { TAG_H } from "./layout";

/** The 9-slices' insets (assets/src/ui.ts: the tag frames are `all(4)`) and the text's inset past them (room.css padding). */
const BORDER = 4;
const PAD = 1;
/** room.css `.tag`: 12 px system type, semibold: on a 1× pixelated canvas the regular weight greys out; reference.css colours: text, the self tag's accent, a catching tag's muted italic. */
const FONT = "system-ui, sans-serif";
const TEXT = "#fff7ea";
const ACCENT = "#e8b33c";
const MUTED = "#c6a8ec";

/** How a tag looks; the stage reads it off the DOM target once per render. */
export interface TagLook {
  readonly text: string;
  readonly self: boolean;
  /** The shirt's colour under the name (OME-1375), or "" for none. */
  readonly tint: string;
  /** Hidden for me 0.5, away 0.6 (room.css), else 1. */
  readonly alpha: number;
  readonly catching: boolean;
  /** The DOM target's border-box width and its name box's (stage px, unscaled). */
  readonly w: number;
  readonly nameW: number;
}

export interface SceneTags {
  /** Paint a member's tag as `look`; false when it already looked so. */
  look(id: string, look: TagLook): boolean;
  /** Its top-left (stage px), its scale, and its leader pip: none, under the tag (`above`: it's over the head) or over it. */
  place(id: string, x: number, y: number, k: number, led: boolean, above: boolean): boolean;
  drop(id: string): void;
  /** Hide them all (e2e shots of the room without tags). */
  hide(hidden: boolean): void;
  /** Its box as placed (stage px), or undefined. */
  rect(id: string): { x: number; y: number; w: number; h: number } | undefined;
}

/** `text` cut to `max` px wide with an ellipsis, as the DOM's `text-overflow: ellipsis` does. */
export function fitText(text: string, max: number, width: (s: string) => number): string {
  if (width(text) <= max) return text;
  let n = text.length;
  while (n > 0 && width(`${text.slice(0, n)}…`) > max) n--;
  return `${text.slice(0, n)}…`;
}

interface Node {
  readonly root: Container;
  readonly frame: NineSliceSprite;
  readonly name: Text;
  readonly marks: Graphics;
  look: TagLook | null;
  at: { x: number; y: number; k: number; led: boolean; above: boolean } | null;
}

export function createSceneTags(layer: Container, textures: { readonly plain: Texture; readonly self: Texture }): SceneTags {
  const nodes = new Map<string, Node>();
  const free: Node[] = [];
  const style = (l: TagLook): TextStyle => new TextStyle({ fontFamily: FONT, fontSize: 12, fontWeight: "600", fontStyle: l.catching ? "italic" : "normal", fill: l.catching ? MUTED : l.self ? ACCENT : TEXT });
  const make = (): Node => {
    const root = new Container({ label: "tag" });
    const frame = new NineSliceSprite({ texture: textures.plain, leftWidth: BORDER, topHeight: BORDER, rightWidth: BORDER, bottomHeight: BORDER, height: TAG_H });
    const name = new Text({ text: "", anchor: { x: 0, y: 0.5 }, x: BORDER + PAD, y: TAG_H / 2 });
    const marks = new Graphics();
    root.addChild(frame, marks, name);
    layer.addChild(root);
    return { root, frame, name, marks, look: null, at: null };
  };
  /** The underline and the pip: redrawn when the width, tint or pip changes, never per frame. */
  const mark = (n: Node): void => {
    const l = n.look;
    if (l === null) return;
    n.marks.clear();
    // room.css `.tag::after`: 2 px, 3 px in from each side, 1 px over the bottom edge.
    if (l.tint !== "") n.marks.rect(3, TAG_H - 1, l.w - 6, 2).fill(l.tint);
    // The leader pip (OME-2172): an 8×4 triangle at the centre, just past the top edge (pointing up) or the bottom.
    if (n.at?.led === true) {
      const c = l.w / 2;
      const pip = n.at.above ? [c - 4, TAG_H, c + 4, TAG_H, c, TAG_H + 4] : [c - 4, 0, c + 4, 0, c, -4];
      n.marks.poly(pip).fill(l.tint === "" ? TEXT : l.tint);
    }
  };
  return {
    look(id, l) {
      let n = nodes.get(id);
      if (n === undefined) {
        n = free.pop() ?? make();
        n.root.visible = true;
        nodes.set(id, n);
      }
      const was = n.look;
      if (was !== null && was.text === l.text && was.self === l.self && was.tint === l.tint && was.alpha === l.alpha && was.catching === l.catching && was.w === l.w && was.nameW === l.nameW) return false;
      n.look = l;
      n.frame.texture = l.self ? textures.self : textures.plain;
      n.frame.width = l.w;
      n.root.alpha = l.alpha;
      const s = style(l);
      n.name.style = s;
      n.name.text = fitText(l.text, l.nameW, (t) => CanvasTextMetrics.measureText(t, s).width);
      mark(n);
      return true;
    },
    place(id, x, y, k, led, above) {
      const n = nodes.get(id);
      if (n === undefined) return false;
      const a = n.at;
      if (a !== null && a.x === x && a.y === y && a.k === k && a.led === led && a.above === above) return false;
      const pip = a?.led !== led || a.above !== above;
      n.at = { x, y, k, led, above };
      n.root.position.set(x, y);
      n.root.scale.set(k);
      // Whole scales only (the 9-slice stays crisp); the text renders at that scale, not stretched.
      if (n.name.resolution !== k) n.name.resolution = k;
      if (pip) mark(n);
      return true;
    },
    drop(id) {
      const n = nodes.get(id);
      if (n === undefined) return;
      nodes.delete(id);
      n.root.visible = false;
      n.look = null;
      n.at = null;
      free.push(n);
    },
    hide(hidden) {
      layer.visible = !hidden;
    },
    rect(id) {
      const n = nodes.get(id);
      if (n?.look == null || n.at === null) return undefined;
      return { x: n.at.x, y: n.at.y, w: n.look.w * n.at.k, h: TAG_H * n.at.k };
    },
  };
}
