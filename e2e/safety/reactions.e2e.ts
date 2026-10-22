// Movie night safety (OME-1644, ADR 0056), on the wire against the e2e server:
//  1. `react` frames that are oversized, malformed, of a wrong kind, XSS-shaped or carry their own time never reach
//     anyone or the ring; a flood closes the sender with 4029 and relays no more than its emote bucket allows.
//  2. `GET /rooms` names a listed room's video (`nowPlaying`: provider and id only) and never a private room's.
//  3. A share's `startSeconds` out of range is refused and leaves the room as it was; in range, the room starts there.
// Server parts: OME-1632 (reactions), OME-1633 (`nowPlaying`, `startSeconds`).
import {
  CLOSE_CODES,
  EMOTE_BURST,
  MAX_CLIENT_MESSAGE_BYTES,
  MAX_POSITION_S,
  REACTION_KINDS,
  RoomListResponseSchema,
} from "@omega/shared";
import * as v from "valibot";
import { PENDING, URLS, available } from "../support/apps";
import { expect, test } from "../support/csp";
import { EMBED_URL, VIDEO_ID } from "../support/network";
import { ownedRoom } from "../support/owned-rooms";
import { testRoom } from "../support/room";
import { postShare } from "../support/share";
import { WsMember } from "../support/ws-member";
import { shareVideo } from "../../perf/sync";

test.describe.configure({ mode: "parallel" });
test.fixme(!available.server, PENDING.server);

/** A YouTube id only the private room ever plays, so finding it anywhere in `GET /rooms` is a leak. */
const PRIVATE_VIDEO_ID = "PrivRoomVid";
/** How long a frame that should be relayed would take to arrive, at most, on localhost. */
const RELAY_WINDOW_MS = 1_000;

let members: WsMember[] = [];
test.afterEach(() => {
  for (const m of members) m.close();
  members = [];
});

async function join(roomId: string, nickname: string, fields: Parameters<typeof WsMember.join>[2] = {}): Promise<WsMember> {
  const m = await WsMember.join(roomId, nickname, fields);
  members.push(m);
  return m;
}

const reactedFrom = (m: WsMember, sender: WsMember): number => m.frames.filter((f) => f.type === "reacted" && f.memberId === sender.self).length;

function shareToken(m: WsMember): string {
  const token = m.snapshot.shareToken;
  if (token === undefined) throw new Error("no share token");
  return token;
}

test.describe("react frames an attacker sends", () => {
  test("wrong kind, XSS-shaped, malformed or extra keys: bad_message, nothing relayed or stored; a client time is never used", async ({ request }) => {
    const room = testRoom("reactions", "shape");
    await shareVideo(request, room.id);
    const sender = await join(room.id, "sender");
    const watcher = await join(room.id, "watcher");

    const bad: unknown[] = [
      { type: "react", kind: "fire" },
      { type: "react", kind: "<img src=x onerror=alert(1)>" },
      { type: "react", kind: "heart<script>alert(1)</script>" },
      { type: "react", kind: 1 },
      { type: "react", kind: ["heart"] },
      { type: "react" },
      { type: "react", kind: "heart", memberId: watcher.self },
      { type: "react", kind: "heart", nickname: "<b>x</b>" },
      '{"type":"react","kind":',
      '{"type":"react","kind":"heart"',
    ];
    for (const frame of bad) {
      const from = sender.frames.length;
      sender.send(frame);
      await sender.next("error", (e) => e.code === "bad_message", from);
    }
    // A client-sent time: refused as an unknown key, or the server's own clock used. Never the client's.
    const forged = 9_999_000;
    sender.send({ type: "react", kind: "heart", mediaMs: forged });
    sender.send({ type: "react", kind: "laugh", at: 0, position: forged / 1000 });
    await new Promise((r) => setTimeout(r, RELAY_WINDOW_MS));
    const leaked = (m: WsMember) => m.frames.filter((f) => f.type === "reacted" && f.mediaMs >= forged / 2);
    expect(leaked(watcher)).toEqual([]);

    // The pipeline is live: a well-formed react is relayed (so the refusals above aren't a dead feature).
    const from = watcher.frames.length;
    sender.send({ type: "react", kind: "clap" });
    const relayed = await watcher.next("reacted", (r) => r.memberId === sender.self && r.kind === "clap", from);
    expect(relayed.mediaMs).toBeLessThan(60_000);
    expect(sender.closed).toBeNull();

    const late = await join(room.id, "late");
    const ring = late.snapshot.reactions ?? [];
    expect(ring.length).toBeGreaterThanOrEqual(1);
    for (const r of ring) {
      expect(REACTION_KINDS).toContain(r.kind);
      expect(r.memberId).toBe(sender.self);
      expect(r.mediaMs).toBeLessThan(forged / 2);
    }
  });

  test("an oversized react frame drops the socket before it is read; nobody gets it", async ({ request }) => {
    const room = testRoom("reactions", "big");
    await shareVideo(request, room.id);
    const sender = await join(room.id, "big");
    const watcher = await join(room.id, "watcher");
    const frame = JSON.stringify({ type: "react", kind: "heart", pad: "x".repeat(MAX_CLIENT_MESSAGE_BYTES) });
    expect(frame.length).toBeGreaterThan(MAX_CLIENT_MESSAGE_BYTES);
    sender.send(frame);
    expect([1009, 1006]).toContain((await sender.whenClosed()).code);
    await new Promise((r) => setTimeout(r, RELAY_WINDOW_MS));
    expect(reactedFrom(watcher, sender)).toBe(0);
    expect(watcher.closed).toBeNull();
  });

  test("a react flood closes the sender with 4029; the room only ever sees the emote bucket's worth", async ({ request }) => {
    const room = testRoom("reactions", "flood");
    await shareVideo(request, room.id);
    const flooder = await join(room.id, "flooder");
    const watcher = await join(room.id, "watcher");
    const started = Date.now();
    for (let i = 0; i < 200; i++) flooder.send({ type: "react", kind: REACTION_KINDS[i % REACTION_KINDS.length] });
    const closed = await flooder.whenClosed();
    expect(closed.code).toBe(CLOSE_CODES.RATE_LIMITED);
    await new Promise((r) => setTimeout(r, RELAY_WINDOW_MS));
    // The burst, plus one per EMOTE_REFILL_MS (1 s) the flood lasted.
    const allowed = EMOTE_BURST + Math.ceil((Date.now() - started) / 1_000);
    expect(reactedFrom(watcher, flooder)).toBeLessThanOrEqual(allowed);
    expect(watcher.closed).toBeNull();
    const ring = (await join(room.id, "late")).snapshot.reactions ?? [];
    expect(ring.filter((r) => r.memberId === flooder.self).length).toBeLessThanOrEqual(allowed);
  });
});

test.describe("GET /rooms and nowPlaying", () => {
  test("a listed room shows its video as provider and id only; a private room's video is never in the list", async ({ request }) => {
    const listed = testRoom("listed", "nowplaying");
    await shareVideo(request, listed.id);
    await join(listed.id, "listed");

    const secret = ownedRoom("mnprivate");
    const insider = await join(secret.id, "insider", { inviteKey: secret.inviteKey });
    const shared = await postShare(request, secret.id, shareToken(insider), `https://www.youtube.com/watch?v=${PRIVATE_VIDEO_ID}`);
    expect(shared.status()).toBe(200);
    await insider.next("embed-changed");

    const res = await request.get(`${URLS.server}/rooms`);
    expect(res.status()).toBe(200);
    const text = await res.text();
    const body = v.parse(RoomListResponseSchema, JSON.parse(text));
    const row = body.rooms.find((r) => r.id === listed.id);
    expect(row, "the listed room is in the first page").toBeDefined();
    expect(row?.nowPlaying).toEqual({ provider: "youtube", id: VIDEO_ID });
    // Raw text, not the parsed rows: the schema strips unknown keys, and a leak may hide in one.
    expect(text).not.toContain(secret.id);
    expect(text).not.toContain(PRIVATE_VIDEO_ID);
    expect(text).not.toContain(secret.title);
    expect(text).not.toContain("youtube.com/");
  });
});

test.describe("share startSeconds", () => {
  test.setTimeout(90_000);

  test("out of range or not an integer: 400 and the room unchanged; in range: the room starts there", async ({ request }) => {
    const room = testRoom("reactions", "start");
    const member = await join(room.id, "member");
    const token = shareToken(member);
    for (const startSeconds of [-1, 1.5, MAX_POSITION_S + 1, Number.MAX_SAFE_INTEGER, "30", null, true, { s: 30 }]) {
      const res = await postShare(request, room.id, token, EMBED_URL, { startSeconds });
      expect(res.status(), `startSeconds ${JSON.stringify(startSeconds)}`).toBe(400);
    }
    await new Promise((r) => setTimeout(r, RELAY_WINDOW_MS));
    expect(member.frames.filter((f) => f.type === "embed-changed")).toEqual([]);
    expect((await join(room.id, "unchanged")).snapshot.room.embed).toEqual(member.snapshot.room.embed);

    const from = member.frames.length;
    expect((await postShare(request, room.id, token, EMBED_URL, { startSeconds: 90 })).status()).toBe(200);
    const changed = await member.next("embed-changed", () => true, from);
    expect(changed.playback?.position).toBe(90);
    expect(changed.playback?.action).toBe("load");
    const late = (await join(room.id, "late")).snapshot.room.playback;
    expect(late?.position ?? 0).toBeGreaterThanOrEqual(90);
  });
});
