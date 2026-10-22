// Movie night replay timing (OME-1644, ADR 0056). A `react` is stamped by the server's room clock (`mediaMs`), kept
// in a ring for the current item and handed to late joiners in their snapshot (server: OME-1632); a late joiner's
// page replays each one through the emote bubbles when its video reaches that `mediaMs` (web: OME-1628).
//  1. Wire: `mediaMs` is the room clock at arrival (±500 ms), relayed to everyone, kept across a seek and handed to a
//     late joiner in order; a new item clears it.
//  2. Page: a late joiner sees a reaction ahead of it bubble over the reactor's avatar at its timestamp (±500 ms).
// The reactor is a raw-socket member (support/ws-member.ts); the reaction bar is OME-1631's.
import type { Page } from "@playwright/test";
import * as v from "valibot";
import type { PlaybackState } from "@omega/shared";
import { PENDING, available } from "../support/apps";
import { expect, test } from "../support/csp";
import { joinRoom, leaveAll, testRoom, type Client } from "../support/room";
import { joinForToken, postShare } from "../support/share";
import { WsMember, type Of } from "../support/ws-member";
import { shareVideo, waitPlaying } from "../../perf/sync";

test.describe.configure({ mode: "parallel" });
test.fixme(!available.server, PENDING.server);

/** The acceptance's window: a reaction lands this close to its timestamp. */
const REPLAY_TOLERANCE_MS = 500;
/** Another public YouTube id: sharing it is a new item. The server never fetches it. */
const OTHER_VIDEO_URL = "https://www.youtube.com/embed/OtherVideo1";

let members: WsMember[] = [];
let clients: Client[] = [];
test.afterEach(async () => {
  for (const m of members) m.close();
  members = [];
  await leaveAll(clients);
  clients = [];
});

async function join(roomId: string, nickname: string): Promise<WsMember> {
  const m = await WsMember.join(roomId, nickname);
  members.push(m);
  return m;
}

/** The room clock in ms at server time `t` (PlaybackStateSchema's formula; the server shares this machine's clock). */
function clockMs(p: PlaybackState, t: number): number {
  const from = p.startAt ?? p.at;
  const running = p.playing && t > from ? ((t - from) / 1000) * p.rate : 0;
  return (p.position + running) * 1000;
}

function playbackOf(m: WsMember): PlaybackState {
  const p = m.snapshot.room.playback;
  if (!p?.playing) throw new Error("the room isn't playing");
  return p;
}

/** Sends one `react` and returns the relay to the sender, and when the server must have stamped it (the round trip's middle). */
async function react(m: WsMember, kind: "heart" | "laugh" | "wow" | "clap"): Promise<{ relay: Of<"reacted">; stampedAt: number }> {
  const from = m.frames.length;
  const sent = Date.now();
  m.send({ type: "react", kind });
  const relay = await m.next("reacted", (r) => r.memberId === m.self && r.kind === kind, from);
  return { relay, stampedAt: (sent + Date.now()) / 2 };
}

/** Seeks the room to `position`, playing, and returns the new playback. */
async function seek(m: WsMember, position: number): Promise<PlaybackState> {
  const embed = m.snapshot.room.embed;
  if (embed === null) throw new Error("no embed");
  const from = m.frames.length;
  m.send({ type: "control", url: embed.url, playing: true, position });
  return (await m.next("playback", (p) => p.playback.action === "seek", from)).playback;
}

test.describe("timed reactions on the wire", () => {
  test("mediaMs is the room clock at arrival; everyone gets it; a seek keeps it and a late joiner's snapshot has it in order", async ({ request }, info) => {
    const room = testRoom("replay", "wire");
    await shareVideo(request, room.id);
    const reactor = await join(room.id, "reactor");
    const watcher = await join(room.id, "watcher");
    const playback = playbackOf(reactor);
    await new Promise((r) => setTimeout(r, 1_500));

    const sent: Of<"reacted">[] = [];
    const errors: number[] = [];
    for (const kind of ["heart", "laugh", "wow"] as const) {
      const { relay, stampedAt } = await react(reactor, kind);
      sent.push(relay);
      errors.push(relay.mediaMs - clockMs(playback, stampedAt));
      // One a second: the emote bucket refills that fast, so none is dropped.
      await new Promise((r) => setTimeout(r, 1_100));
    }
    info.annotations.push({ type: "mediaMs − room clock (ms)", description: errors.map((e) => e.toFixed(0)).join(", ") });
    for (const e of errors) expect(Math.abs(e)).toBeLessThanOrEqual(REPLAY_TOLERANCE_MS);
    for (const r of sent) await watcher.next("reacted", (w) => w.memberId === r.memberId && w.kind === r.kind && w.mediaMs === r.mediaMs);

    await seek(reactor, 0);
    const late = await join(room.id, "late");
    expect(late.snapshot.reactions).toEqual(sent.map(({ memberId, kind, mediaMs }) => ({ memberId, kind, mediaMs })));
  });

  test("a new item clears the reactions: a late joiner after it gets none", async ({ request }) => {
    const room = testRoom("replay", "clear");
    await shareVideo(request, room.id);
    const reactor = await join(room.id, "reactor");
    await react(reactor, "clap");
    expect((await join(room.id, "before")).snapshot.reactions).toHaveLength(1);

    const sharer = await joinForToken(room.id, "sharer");
    try {
      expect((await postShare(request, room.id, sharer.token, OTHER_VIDEO_URL)).status()).toBe(200);
    } finally {
      sharer.close();
    }
    await reactor.next("embed-changed");
    expect((await join(room.id, "after")).snapshot.reactions ?? []).toEqual([]);
  });
});

/** The dev handle (apps/web/src/main.ts `window.__omega.room`), as emotes.e2e.ts reads it: whether `id` shows a sticker now. */
function stickerShownAt(page: Page, id: string, timeoutMs: number): Promise<number> {
  return page
    .evaluate(
      ({ id, timeoutMs }) =>
        new Promise<number>((resolve, reject) => {
          const started = Date.now();
          // 10 ms polling of a test handle, not the app's: the replay itself schedules one timer per reaction.
          const timer = setInterval(() => {
            const debug: unknown = Reflect.get(window, "__omega");
            const room: unknown = typeof debug === "object" && debug !== null ? Reflect.get(debug, "room") : null;
            const get: unknown = typeof room === "object" && room !== null ? Reflect.get(room, "avatarFrames") : null;
            const frames: unknown = typeof get === "function" ? Reflect.apply(get, room, [id]) : null;
            const sticker: unknown = typeof frames === "object" && frames !== null ? Reflect.get(frames, "sticker") : null;
            if (sticker !== null && sticker !== undefined) {
              clearInterval(timer);
              resolve(Date.now());
            } else if (Date.now() - started > timeoutMs) {
              clearInterval(timer);
              reject(new Error(`no bubble over ${id} within ${String(timeoutMs)} ms`));
            }
          }, 10);
        }),
      { id, timeoutMs },
    )
    .then((t) => v.parse(v.number(), t));
}

test.describe("replay on a late joiner's page", () => {
  test.fixme(!available.web, PENDING.web);
  test.setTimeout(90_000);

  test("a reaction ahead of the late joiner bubbles over the reactor's avatar at its timestamp (±500 ms)", async ({ browser, request }, info) => {
    const room = testRoom("replay", "ui");
    await shareVideo(request, room.id);
    const reactor = await join(room.id, "reactor");
    // React well into the video, then seek back: the late joiner arrives before the reaction's moment.
    await seek(reactor, 40);
    const { relay } = await react(reactor, "heart");
    const back = await seek(reactor, relay.mediaMs / 1000 - 20);

    clients = await joinRoom(browser, { roomUrl: room.url, count: 1, nicknamePrefix: `late${Math.random().toString(36).slice(2, 7)}` });
    const [late] = clients;
    if (late === undefined) throw new Error("no late joiner");
    await waitPlaying(clients);
    const left = relay.mediaMs - clockMs(back, Date.now());
    expect(left, "the late joiner must arrive before the reaction's moment").toBeGreaterThan(2_000);

    const shownAt = await stickerShownAt(late.page, reactor.self, left + 5_000);
    const error = clockMs(back, shownAt) - relay.mediaMs;
    info.annotations.push({ type: "bubble − mediaMs (ms)", description: error.toFixed(0) });
    expect(Math.abs(error)).toBeLessThanOrEqual(REPLAY_TOLERANCE_MS);
  });
});
