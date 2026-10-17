// Shared by m7-a11y, m10-a11y and a11y-sweep (OME-1326).
import type { Page } from "@playwright/test";

/**
 * Contrast axe can't compute: our keys and chat lines are painted by `border-image` slices (assets/ui/slices), which axe
 * doesn't read, so it falls back to the page colour behind them (an unreadable 1.06 : 1 on every key and line). For
 * those nodes this reads the slice the way the browser paints it, takes the colour that fills most of its middle, and
 * applies WCAG's own thresholds (4.5 : 1, or 3 : 1 for large text) to the node's text colour. Returns one line per node
 * that really fails, or that has no painted background to read (so it can't be passed by accident).
 */
export const paintedContrast = (page: Page, selector: string): Promise<string[]> =>
  page.evaluate(async (sel): Promise<string[]> => {
    const channel = (c: number): number => {
      const v = c / 255;
      return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    };
    const luminance = (rgb: readonly number[]): number => 0.2126 * channel(rgb[0] ?? 0) + 0.7152 * channel(rgb[1] ?? 0) + 0.0722 * channel(rgb[2] ?? 0);
    const out: string[] = [];
    for (const el of document.querySelectorAll(sel)) {
      let painter: Element | null = el;
      while (painter !== null && getComputedStyle(painter).borderImageSource === "none") painter = painter.parentElement;
      const url = painter === null ? null : /url\("?([^")]+)"?\)/.exec(getComputedStyle(painter).borderImageSource)?.[1];
      if (url === undefined || url === null) {
        out.push(`${sel}: no painted background to read`);
        continue;
      }
      const image = new Image();
      image.src = url;
      await image.decode();
      const canvas = document.createElement("canvas");
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      const ctx = canvas.getContext("2d");
      if (ctx === null) throw new Error("no 2d context");
      ctx.drawImage(image, 0, 0);
      const w = Math.max(1, Math.floor(canvas.width * 0.5));
      const h = Math.max(1, Math.floor(canvas.height * 0.5));
      const data = ctx.getImageData(Math.floor(canvas.width * 0.25), Math.floor(canvas.height * 0.25), w, h).data;
      const counts = new Map<string, number>();
      for (let i = 0; i < data.length; i += 4) {
        if ((data[i + 3] ?? 0) < 255) continue;
        const k = `${String(data[i])},${String(data[i + 1])},${String(data[i + 2])}`;
        counts.set(k, (counts.get(k) ?? 0) + 1);
      }
      const top = [...counts.entries()].sort((p, q) => q[1] - p[1])[0];
      if (top === undefined) {
        out.push(`${sel}: the painted background has no opaque middle`);
        continue;
      }
      const bg = top[0].split(",").map(Number);
      const cs = getComputedStyle(el);
      const fg = (cs.color.match(/\d+(\.\d+)?/g) ?? []).slice(0, 3).map(Number);
      const [hi, lo] = [luminance(fg), luminance(bg)].sort((p, q) => q - p);
      const ratio = ((hi ?? 0) + 0.05) / ((lo ?? 0) + 0.05);
      const px = parseFloat(cs.fontSize);
      const need = px >= 24 || (px >= 18.66 && Number(cs.fontWeight) >= 700) ? 3 : 4.5;
      if (ratio < need) out.push(`${sel}: text rgb(${fg.join(",")}) on painted rgb(${bg.join(",")}) is ${ratio.toFixed(2)} : 1, needs ${String(need)} : 1`);
    }
    return out;
  }, selector);
