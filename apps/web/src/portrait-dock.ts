export interface PortraitDockOptions {
  readonly root: HTMLElement;
  readonly queueLayout?: (portrait: boolean) => void;
  readonly shelf?: HTMLElement;
  readonly pictureRegion?: HTMLElement;
  readonly onViewport?: () => void;
}

/**
 * The phone and narrow page (OME-905; Doorstep desk OME-2306): the page is the visual viewport, and typing gives the
 * picture the room's place. The panel itself (room-panel.ts) is placed by room-layout.ts; this keeps the viewport.
 */
export function createPortraitDock(o: PortraitDockOptions) {
  const picture = o.pictureRegion;
  const originalPicture = picture === undefined ? [] : ["tabindex", "role", "aria-label"].map((name) => ({ name, value: picture.getAttribute(name) }));
  const pictureScrollFocus = (typing: boolean): void => {
    if (picture === undefined) return;
    if (typing) {
      picture.tabIndex = 0;
      picture.setAttribute("role", "region");
      picture.setAttribute("aria-label", "Video; scroll to see the whole picture");
    } else {
      for (const { name, value } of originalPicture) {
        if (value === null) picture.removeAttribute(name);
        else picture.setAttribute(name, value);
      }
    }
  };
  let active = false;
  o.shelf?.addEventListener("focusin", (ev) => {
    if (active && ev.target instanceof HTMLElement) ev.target.scrollIntoView({ block: "nearest", inline: "nearest" });
  });
  /** Every viewport read comes before a write: a read after one forces a layout (OME-2265). */
  const measure = (): { height: number; top: number; typing: boolean } => {
    const v = window.visualViewport ?? null;
    const inner = window.innerHeight;
    return { height: v?.height ?? inner, top: v?.offsetTop ?? 0, typing: v !== null && v.scale === 1 && inner - v.height > 100 };
  };
  const show = (m: ReturnType<typeof measure>): void => {
    o.root.style.setProperty("--portrait-height", `${String(m.height)}px`);
    o.root.style.setProperty("--portrait-top", `${String(m.top)}px`);
    o.root.classList.toggle("portrait-typing", m.typing);
    pictureScrollFocus(m.typing);
  };
  const viewport = (): void => {
    if (active) show(measure());
  };
  const resized = (): void => { viewport(); o.onViewport?.(); };
  window.visualViewport?.addEventListener("resize", resized);
  window.visualViewport?.addEventListener("scroll", resized);
  window.addEventListener("resize", resized);
  return {
    setActive(on: boolean): void {
      if (on === active) { if (on) viewport(); return; }
      const m = on ? measure() : null;
      active = on;
      o.queueLayout?.(on);
      o.root.classList.toggle("room-portrait", on);
      document.body.classList.toggle("room-is-portrait", on);
      if (m !== null) show(m);
      else {
        pictureScrollFocus(false);
        o.root.classList.remove("portrait-typing");
        o.root.style.removeProperty("--portrait-height");
        o.root.style.removeProperty("--portrait-top");
      }
    },
  };
}
