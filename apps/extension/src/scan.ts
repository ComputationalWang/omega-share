/** An iframe source and its rendered size in CSS px; 0×0 when it is not visible. */
export interface FrameCandidate {
  url: string;
  width: number;
  height: number;
}

/** What the page scan found. `urls` feed the synced tier, `media` and `frames` the generic tier (ADR 0024). */
export interface PageScan {
  /** The page URL, then every iframe/embed/object source. */
  urls: string[];
  /** `<video>` (or `<video><source>`) sources: candidates for an unsynced embed. */
  media: string[];
  /** Iframes: candidates for an unsynced embed, ranked by size in the popup (OME-1037). */
  frames: FrameCandidate[];
  /** Seconds into the first `<video>` that has moved off 0 (a watch page's player), else 0 (OME-1636). */
  currentTime: number;
}

/**
 * Injected into the active tab by `chrome.scripting.executeScript({ func })`, so it
 * is serialized with `toString()`: it must stay self-contained (no imports, no
 * outside helpers). Returns raw URLs; the popup decides what is supported.
 */
export function collectCandidateUrls(doc: Document = document): PageScan {
  const urls = [doc.location.href];
  const media: string[] = [];
  const frames: FrameCandidate[] = [];
  for (const el of doc.querySelectorAll("iframe[src], embed[src], object[data], video[src], video source[src]")) {
    const tag = el.localName;
    const raw = el.getAttribute(tag === "object" ? "data" : "src");
    if (raw === null) continue;
    let href: string;
    try {
      href = new URL(raw, doc.baseURI).href;
    } catch {
      continue; // Not a URL; skip it.
    }
    if (tag === "iframe" || tag === "embed" || tag === "object") urls.push(href);
    if (tag === "video" || tag === "source") media.push(href);
    if (tag === "iframe") {
      // display:none, visibility:hidden or opacity:0 (on the frame or an ancestor) is hidden, so 0×0.
      const visible = typeof el.checkVisibility !== "function" || el.checkVisibility({ visibilityProperty: true, opacityProperty: true });
      // client size: the frame's own box without its border, so it matches the page's width/height.
      frames.push(visible ? { url: href, width: el.clientWidth, height: el.clientHeight } : { url: href, width: 0, height: 0 });
    }
    if (urls.length + media.length + frames.length >= 1000) break;
  }
  // shortcut: the first moved <video> is the player; a page playing two videos at once may pick the wrong one.
  let currentTime = 0;
  for (const video of doc.querySelectorAll("video")) {
    if (video.currentTime > 0) {
      currentTime = video.currentTime;
      break;
    }
  }
  return { urls, media, frames, currentTime };
}
