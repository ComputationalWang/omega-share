// The TV's shelf in the desktop wide layout (OME-642, QA OME-658 F2): the shelf is narrower there (about 400–700 px), so
// the words that don't fit (the plate's name, "syncs by skipping", the live note) are hidden from sight only. A screen
// reader still hears them, and nothing on the shelf overlaps.
import { expect, test } from "./support/csp";
import { joinRoom, leaveAll, testRoom, type Client } from "./support/room";
import { site } from "./support/selectors";
import { providerCase, shareProvider, waitProviderPlaying } from "../perf/providers";

let clients: Client[] = [];
test.afterEach(async () => {
  await leaveAll(clients);
  clients = [];
});

const CASES = [
  { room: "vimeo", key: "vimeo", words: ["syncs by skipping", "Vimeo"] },
  { room: "live", key: "twitchLive", words: ["Live: everyone watches the same moment", "Twitch"] },
] as const;

for (const k of CASES) {
  test(`${k.key} at 1280×720: the shelf's words are in the accessibility tree, and nothing on the shelf overlaps`, async ({ browser, request }) => {
    const c = providerCase(k.key);
    const room = testRoom("provider-shelf", k.room);
    await shareProvider(request, c.shareUrl, room.id);
    clients = await joinRoom(browser, { roomUrl: room.url, count: 1, nicknamePrefix: `shelf-${k.room}`, contextOptions: () => ({ viewport: { width: 1280, height: 720 } }) });
    await waitProviderPlaying(clients, c.provider);
    const [a] = clients;
    if (a === undefined) throw new Error("no client");
    const shelf = a.page.locator(".controls");
    const tree = await shelf.ariaSnapshot();
    for (const w of k.words) expect(tree).toContain(w);

    // Every part you can see (keys, chips, readouts, the seek, the pod) is clear of the others and inside the shelf.
    const overlaps = await shelf.evaluate((root) => {
      const box = root.getBoundingClientRect();
      const parts = [...root.querySelectorAll<HTMLElement>(".ui-transport > *, .ui-volume, .fs-key")].filter((e) => e.getClientRects().length > 0 && e.getBoundingClientRect().width > 2);
      const out: string[] = [];
      for (const p of parts) {
        const r = p.getBoundingClientRect();
        if (r.left < box.left - 1 || r.right > box.right + 1) out.push(`${p.className} outside`);
      }
      for (let i = 0; i < parts.length; i++) {
        for (let j = i + 1; j < parts.length; j++) {
          const pi = parts[i];
          const pj = parts[j];
          if (pi === undefined || pj === undefined || pi.contains(pj) || pj.contains(pi)) continue;
          const r = pi.getBoundingClientRect();
          const s = pj.getBoundingClientRect();
          if (r.left < s.right - 1 && s.left < r.right - 1 && r.top < s.bottom - 1 && s.top < r.bottom - 1) out.push(`${pi.className} × ${pj.className}`);
        }
      }
      return out;
    });
    expect(overlaps).toEqual([]);
  });
}

// OME-1864: Twitch's TV is taller than the others (its minimum width) and its "Start Watching" hint takes a line above it,
// so at 1280×720 the band under it is the shortest. The band looked at the audience's front row (OME-1843) and left the
// seats behind the TV, where no click reaches them: the perf walk rows (perf/polish.perf.ts) hung on their seat clicks.
for (const [name, key] of [["twseats", "twitchVod"], ["liveseats", "twitchLive"]] as const) {
  test(`${key} at 1280×720: every seat shows whole in the room's band, and a click on one sits there`, async ({ browser, request }) => {
    const c = providerCase(key);
    const room = testRoom("provider-shelf", name);
    await shareProvider(request, c.shareUrl, room.id);
    clients = await joinRoom(browser, { roomUrl: room.url, count: 1, nicknamePrefix: `shelf-${name}`, contextOptions: () => ({ viewport: { width: 1280, height: 720 } }) });
    await waitProviderPlaying(clients, c.provider);
    const [a] = clients;
    if (a === undefined) throw new Error("no client");
    const band = await a.page.locator(site.roomWindow).boundingBox();
    if (band === null) throw new Error("no band");
    const seats = a.page.locator(site.seat);
    await expect(seats).toHaveCount(8);
    for (const seat of await seats.all()) {
      const s = await seat.boundingBox();
      if (s === null) throw new Error("no seat box");
      expect(s.y, "seat top in the band").toBeGreaterThanOrEqual(band.y - 1);
      expect(s.y + s.height, "seat foot in the band").toBeLessThanOrEqual(band.y + band.height + 1);
    }
    const back = a.page.locator(`${site.seat}[data-seat="0"]`);
    await back.click({ timeout: 5000 });
    await expect(back).toHaveClass(/\bmine\b/, { timeout: 15_000 });
  });
}
