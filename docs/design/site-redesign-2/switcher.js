// PROTOTYPE tooling, not part of the design: a floating bar that cycles the sibling files
// entry-{A,B,C}.html and room-{A,B,C}.html (← → keys too). Throwaway.
(() => {
  const m = /(entry|room)-([A-D])\.html$/.exec(location.pathname);
  if (m === null) return;
  const keys = ["A", "B", "C", "D"];
  const page = m[1], cur = m[2];
  const go = (d) => { location.href = `${page}-${keys[(keys.indexOf(cur) + d + 4) % 4]}.html${location.search}`; };
  const other = page === "entry" ? "room" : "entry";
  const bar = document.createElement("div");
  bar.setAttribute("role", "navigation");
  bar.setAttribute("aria-label", "Prototype switcher");
  bar.style.cssText = "position:fixed;left:50%;bottom:12px;transform:translateX(-50%);z-index:99999;display:flex;gap:8px;align-items:center;padding:6px 10px;background:#000;color:#fff;font:600 13px/1 system-ui,sans-serif;border:2px solid #0f0;border-radius:999px;box-shadow:0 4px 16px #000c";
  bar.innerHTML = `<button type="button" aria-label="Previous variant" style="font:inherit;background:#222;color:#fff;border:0;border-radius:999px;min-width:32px;min-height:32px">←</button><span>PROTOTYPE ${page} ${cur}${document.title ? " · " + document.title : ""}</span><button type="button" aria-label="Next variant" style="font:inherit;background:#222;color:#fff;border:0;border-radius:999px;min-width:32px;min-height:32px">→</button><a href="${other}-${cur}.html" style="color:#0f0;min-height:32px;display:inline-flex;align-items:center">${other} ${cur}</a>`;
  const [prev, next] = bar.querySelectorAll("button");
  prev.addEventListener("click", () => go(-1));
  next.addEventListener("click", () => go(1));
  addEventListener("keydown", (e) => {
    const t = e.target;
    if (t instanceof HTMLElement && (t.matches("input,textarea,select,[contenteditable]"))) return;
    if (e.key === "ArrowLeft") go(-1);
    if (e.key === "ArrowRight") go(1);
  });
  document.body.append(bar);
})();
