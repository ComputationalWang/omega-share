import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Embed } from "@omega/shared";
import { Client, postShare, start, tokenOf, type TestServer } from "./helpers";

let t: TestServer;
const clients: Client[] = [];
async function join(nickname: string) {
  const r = await Client.join(t.ws(), nickname);
  clients.push(r.client);
  return r;
}
/** Shares `url` as a fresh member; returns the response and that member's client. */
async function share(url: string) {
  const m = await join("sharer");
  const res = await postShare(t, JSON.stringify({ url }), { token: tokenOf(m.snapshot) });
  return { res, m };
}

beforeEach(() => {
  t = start();
});
afterEach(async () => {
  for (const c of clients.splice(0)) c.close();
  await t.server.stop(true);
});

const CASES: [string, Embed][] = [
  ["https://www.twitch.tv/SomeChannel", { provider: "twitch", kind: "live", channel: "somechannel", url: "https://player.twitch.tv/?channel=somechannel" }],
  ["https://www.twitch.tv/videos/123456789", { provider: "twitch", kind: "vod", videoId: "123456789", url: "https://player.twitch.tv/?video=v123456789" }],
  ["https://vimeo.com/76979871", { provider: "vimeo", videoId: "76979871", hash: null, url: "https://player.vimeo.com/video/76979871" }],
  ["https://vimeo.com/76979871/abcdef1234", { provider: "vimeo", videoId: "76979871", hash: "abcdef1234", url: "https://player.vimeo.com/video/76979871?h=abcdef1234" }],
];

describe("share: Twitch and Vimeo", () => {
  for (const [input, embed] of CASES) {
    test(`${input} is stored and broadcast in canonical form`, async () => {
      const { res, m } = await share(input);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true, embed });
      expect((await m.client.next("embed-changed")).embed).toEqual(embed);
    });
  }

  for (const url of [
    "https://twitch.tv.evil.example/somechannel",
    "https://www.twitch.tv/somechannel/clip/Abc",
    "https://www.twitch.tv/directory",
    "https://vimeo.com.evil.example/76979871",
    "https://player.vimeo.com/video/76979871?h=zz",
    "https://vimeo.com/showcase/123",
  ]) {
    test(`${url} is rejected with unsupported_url and not broadcast`, async () => {
      const { res, m } = await share(url);
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ ok: false, error: { code: "unsupported_url" } });
      await m.client.none("embed-changed");
    });
  }
});

describe("control per capability", () => {
  test("live: a seek is not a seek — playback stays at 0 and reports play", async () => {
    const { m } = await share("https://www.twitch.tv/somechannel");
    await m.client.next("embed-changed");
    m.client.send({ type: "control", url: "https://player.twitch.tv/?channel=somechannel", playing: true, position: 300 });
    expect((await m.client.next("playback")).playback).toMatchObject({ playing: true, position: 0, action: "play" });
  });

  test("VOD: a seek is accepted", async () => {
    const { m } = await share("https://vimeo.com/76979871");
    await m.client.next("embed-changed");
    m.client.send({ type: "control", url: "https://player.vimeo.com/video/76979871", playing: false, position: 95 });
    expect((await m.client.next("playback")).playback).toMatchObject({ playing: false, position: 95, action: "seek" });
  });
});
