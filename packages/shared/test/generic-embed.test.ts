import { describe, expect, test } from "bun:test";
import * as v from "valibot";
import {
  AnyEmbedSchema,
  GenericEmbedSchema,
  MAX_GENERIC_EMBED_URL_LENGTH,
  MAX_URL_LENGTH,
  RoomStateSchema,
  SYNCED_PROVIDERS,
  ServerMessageSchema,
  ShareResponseSchema,
  canonicalizeAnyEmbed,
  canonicalizeEmbed,
  canonicalizeGenericEmbed,
  isSyncedEmbed,
  normalizeHostname,
  parseServerMessage,
  type GenericEmbed,
} from "../src/index";

const GENERIC: GenericEmbed = { provider: "generic", host: "player.example.com", url: "https://player.example.com/embed/42" };

describe("canonicalizeGenericEmbed: accepted", () => {
  const table: readonly [string, string, GenericEmbed][] = [
    ["plain https embed", "https://player.example.com/embed/42", GENERIC],
    ["host is lowercased", "https://Player.EXAMPLE.com/embed/42", GENERIC],
    ["surrounding whitespace is trimmed", "  https://player.example.com/embed/42 \n", GENERIC],
    ["default port is dropped", "https://player.example.com:443/embed/42", GENERIC],
    ["dot segments are resolved", "https://player.example.com/a/../embed/42", GENERIC],
    [
      "query is kept",
      "https://media.example.org/v?id=7&t=30",
      { provider: "generic", host: "media.example.org", url: "https://media.example.org/v?id=7&t=30" },
    ],
    [
      "bare host gets a / path",
      "https://example.net",
      { provider: "generic", host: "example.net", url: "https://example.net/" },
    ],
    [
      "IDN host is stored as punycode (homographs stay visible)",
      "https://bücher.de/e",
      { provider: "generic", host: "xn--bcher-kva.de", url: "https://xn--bcher-kva.de/e" },
    ],
  ];
  for (const [name, input, expected] of table) {
    test(name, () => {
      const got = canonicalizeGenericEmbed(input);
      expect(got).toEqual(expected);
      expect(v.is(GenericEmbedSchema, got)).toBe(true);
    });
  }
});

describe("canonicalizeGenericEmbed: rejected", () => {
  const table: readonly [string, string][] = [
    ["http", "http://player.example.com/embed/42"],
    ["javascript:", "javascript:alert(1)"],
    ["javascript: with https-looking text", "javascript://player.example.com/%0aalert(1)"],
    ["data:", "data:text/html,<script>alert(1)</script>"],
    ["blob:", "blob:https://player.example.com/550e8400-e29b-41d4-a716-446655440000"],
    ["file:", "file:///etc/passwd"],
    ["ftp:", "ftp://player.example.com/x"],
    ["ws:", "wss://player.example.com/x"],
    ["userinfo (user)", "https://user@player.example.com/embed/42"],
    ["userinfo (user:pass)", "https://user:pass@player.example.com/embed/42"],
    ["userinfo spoof", "https://player.example.com@evil.example/embed/42"],
    ["non-default port", "https://player.example.com:8443/embed/42"],
    ["IPv4 literal", "https://93.184.216.34/embed"],
    ["IPv4 loopback", "https://127.0.0.1/embed"],
    ["IPv4 private", "https://192.168.1.10/embed"],
    ["IPv4 link-local (cloud metadata)", "https://169.254.169.254/latest/meta-data/"],
    ["IPv4 as one decimal number", "https://2130706433/"],
    ["IPv4 in hex", "https://0x7f.0.0.1/"],
    ["IPv4 short form", "https://127.1/"],
    ["IPv6 loopback", "https://[::1]/embed"],
    ["IPv6 mapped IPv4", "https://[::ffff:127.0.0.1]/embed"],
    ["IPv6 public", "https://[2606:2800:220:1:248:1893:25c8:1946]/embed"],
    ["localhost", "https://localhost/embed"],
    ["localhost with trailing dot", "https://localhost./embed"],
    ["localhost subdomain", "https://app.localhost/embed"],
    ["single-label host", "https://intranet/embed"],
    [".local", "https://printer.local/embed"],
    [".internal", "https://metadata.google.internal/embed"],
    [".home.arpa", "https://nas.home.arpa/embed"],
    [".localdomain", "https://box.localdomain/embed"],
    [".lan", "https://router.lan/embed"],
    ["reverse-DNS .arpa", "https://1.0.0.127.in-addr.arpa/"],
    ["reserved .test", "https://example.test/embed"],
    ["reserved .example", "https://player.example/embed"],
    ["reserved .invalid", "https://player.invalid/embed"],
    ["reserved .onion", "https://abc.onion/embed"],
    ["reserved .alt", "https://abc.alt/embed"],
    ["wildcard loopback DNS (localtest.me)", "https://a.localtest.me/embed"],
    ["wildcard loopback DNS (lvh.me)", "https://lvh.me/embed"],
    ["IP-in-DNS (nip.io)", "https://127.0.0.1.nip.io/embed"],
    ["IP-in-DNS (sslip.io)", "https://10-0-0-1.sslip.io/embed"],
    ["trailing-dot host", "https://player.example.com./embed/42"],
    ["underscore in host", "https://my_host.example.com/embed"],
    ["numeric TLD", "https://player.example.123/embed"],
    ["over the raw length cap", `https://player.example.com/${"a".repeat(MAX_URL_LENGTH)}`],
    ["canonical url over the stored cap", `https://player.example.com/${"a".repeat(MAX_GENERIC_EMBED_URL_LENGTH)}`],
    ["relative url", "/embed/42"],
    ["garbage", "not a url"],
    ["empty", ""],
    // A synced provider's URL is either its synced embed or nothing, never an unsynced iframe.
    ["YouTube page", "https://www.youtube.com/playlist?list=PL123"],
    ["YouTube watch url", "https://www.youtube.com/watch?v=dQw4w9WgXcQ"],
    ["youtu.be", "https://youtu.be/dQw4w9WgXcQ"],
    ["youtube-nocookie", "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ"],
    ["Twitch clip", "https://clips.twitch.tv/embed?clip=AwkwardHelplessSalamander"],
    ["Twitch channel", "https://www.twitch.tv/some_streamer"],
    ["Vimeo player", "https://player.vimeo.com/video/76979871"],
    ["Vimeo subdomain", "https://foo.vimeo.com/x"],
  ];
  for (const [name, input] of table) {
    test(name, () => {
      expect(canonicalizeGenericEmbed(input)).toBeNull();
    });
  }
});

describe("canonicalizeGenericEmbed: own origin", () => {
  const opts = { ownHosts: ["omega.example.org"] };
  test("rejects our own host", () => {
    expect(canonicalizeGenericEmbed("https://omega.example.org/rooms/lobby", opts)).toBeNull();
  });
  test("rejects our own host in another case", () => {
    expect(canonicalizeGenericEmbed("https://OMEGA.example.org/x", opts)).toBeNull();
  });
  test("rejects a subdomain of our own host", () => {
    expect(canonicalizeGenericEmbed("https://cdn.omega.example.org/x", opts)).toBeNull();
  });
  test("accepts a sibling host that only shares a suffix", () => {
    expect(canonicalizeGenericEmbed("https://notomega.example.org/x", opts)?.host).toBe("notomega.example.org");
  });
  test("own hosts are normalised: case, trailing dot, IDN, whitespace", () => {
    const messy = { ownHosts: [" Share.Example.ORG. ", "bücher.de"] };
    expect(canonicalizeGenericEmbed("https://x.share.example.org/", messy)).toBeNull();
    expect(canonicalizeGenericEmbed("https://share.example.org/", messy)).toBeNull();
    expect(canonicalizeGenericEmbed("https://xn--bcher-kva.de/", messy)).toBeNull();
  });
  test("normalizeHostname gives the canonical host, or null for a non-hostname", () => {
    expect(normalizeHostname(" Share.Example.ORG. ")).toBe("share.example.org");
    expect(normalizeHostname("bücher.de")).toBe("xn--bcher-kva.de");
    expect(normalizeHostname("localhost")).toBe("localhost");
    expect(normalizeHostname("https://share.example.org/")).toBeNull();
    expect(normalizeHostname("share.example.org:8080")).toBeNull();
    expect(normalizeHostname("")).toBeNull();
  });
  test("accepts other hosts", () => {
    expect(canonicalizeGenericEmbed("https://player.example.com/embed/42", opts)).toEqual(GENERIC);
  });
});

describe("canonicalizeGenericEmbed never throws", () => {
  const weird = ["https://", "https://%", "https://a..b/", "https://-a.example/", "https://a-.example/", "\u0000", "https://ex\u0000ample.com/"];
  for (const input of weird) {
    test(JSON.stringify(input), () => {
      expect(() => canonicalizeGenericEmbed(input)).not.toThrow();
      const got = canonicalizeGenericEmbed(input);
      if (got !== null) expect(v.is(GenericEmbedSchema, got)).toBe(true);
    });
  }
});

describe("GenericEmbedSchema", () => {
  test("accepts a canonical generic embed", () => {
    expect(v.is(GenericEmbedSchema, GENERIC)).toBe(true);
  });
  const bad: readonly [string, unknown][] = [
    ["non-canonical url", { ...GENERIC, url: "https://Player.example.com/embed/42" }],
    ["host does not match url", { ...GENERIC, host: "other.example.com" }],
    ["http url", { provider: "generic", host: "player.example.com", url: "http://player.example.com/embed/42" }],
    ["javascript url", { provider: "generic", host: "x", url: "javascript:alert(1)" }],
    ["IP literal", { provider: "generic", host: "127.0.0.1", url: "https://127.0.0.1/" }],
    ["localhost", { provider: "generic", host: "localhost", url: "https://localhost/" }],
    ["userinfo", { provider: "generic", host: "player.example.com", url: "https://u@player.example.com/" }],
    ["synced provider host", { provider: "generic", host: "player.vimeo.com", url: "https://player.vimeo.com/video/76979871" }],
    ["missing host", { provider: "generic", url: GENERIC.url }],
  ];
  for (const [name, value] of bad) {
    test(`rejects ${name}`, () => {
      expect(v.is(GenericEmbedSchema, value)).toBe(false);
    });
  }
});

describe("canonicalizeAnyEmbed", () => {
  test("a synced provider URL becomes its synced embed", () => {
    expect(canonicalizeAnyEmbed("https://youtu.be/dQw4w9WgXcQ", { generic: true })).toEqual(
      canonicalizeEmbed("https://youtu.be/dQw4w9WgXcQ"),
    );
  });
  test("any other https URL becomes a generic embed", () => {
    expect(canonicalizeAnyEmbed("https://player.example.com/embed/42", { generic: true })).toEqual(GENERIC);
  });
  test("generic off (kill switch): only synced embeds", () => {
    expect(canonicalizeAnyEmbed("https://player.example.com/embed/42", { generic: false })).toBeNull();
    expect(canonicalizeAnyEmbed("https://youtu.be/dQw4w9WgXcQ", { generic: false })?.provider).toBe("youtube");
  });
  test("own hosts are passed through", () => {
    expect(canonicalizeAnyEmbed("https://omega.example.org/x", { generic: true, ownHosts: ["omega.example.org"] })).toBeNull();
  });
  test("a malformed synced URL does not fall back to generic", () => {
    expect(canonicalizeAnyEmbed("https://www.youtube.com/watch?v=short", { generic: true })).toBeNull();
  });
  test("canonicalizeEmbed itself stays synced-only", () => {
    expect(canonicalizeEmbed("https://player.example.com/embed/42")).toBeNull();
  });
});

describe("provider registry", () => {
  test("lists the synced providers in order", () => {
    expect(SYNCED_PROVIDERS.map((p) => p.id)).toEqual(["youtube", "twitch", "vimeo"]);
  });
  test("each provider claims its own hosts", () => {
    const owner = (host: string): string | undefined => SYNCED_PROVIDERS.find((p) => p.ownsHost(host))?.id;
    expect(owner("youtu.be")).toBe("youtube");
    expect(owner("m.youtube.com")).toBe("youtube");
    expect(owner("clips.twitch.tv")).toBe("twitch");
    expect(owner("player.vimeo.com")).toBe("vimeo");
    expect(owner("player.example.com")).toBeUndefined();
    expect(owner("notyoutube.com")).toBeUndefined();
  });
});

describe("isSyncedEmbed", () => {
  test("narrows synced vs generic", () => {
    const yt = canonicalizeEmbed("https://youtu.be/dQw4w9WgXcQ");
    expect(yt !== null && isSyncedEmbed(yt)).toBe(true);
    expect(isSyncedEmbed(GENERIC)).toBe(false);
  });
});

describe("generic embeds on the wire", () => {
  const LOADED = { playing: false, position: 0, rate: 1, at: 1, rev: 0, action: "load", by: null };
  const seats = Array.from({ length: 8 }, () => null);
  const room = (embed: unknown, playback: unknown): unknown => ({ id: "lobby", seats, members: [], embed, playback });

  test("AnyEmbedSchema takes synced and generic embeds", () => {
    expect(v.is(AnyEmbedSchema, GENERIC)).toBe(true);
    expect(v.is(AnyEmbedSchema, canonicalizeEmbed("https://vimeo.com/76979871"))).toBe(true);
  });

  test("a room can hold a generic embed with null playback", () => {
    expect(v.is(RoomStateSchema, room(GENERIC, null))).toBe(true);
  });

  test("a generic embed never carries playback state", () => {
    expect(v.is(RoomStateSchema, room(GENERIC, LOADED))).toBe(false);
    expect(v.is(ServerMessageSchema, { type: "embed-changed", embed: GENERIC, by: null, playback: LOADED })).toBe(false);
  });

  test("embed-changed carries a generic embed", () => {
    expect(v.is(ServerMessageSchema, { type: "embed-changed", embed: GENERIC, by: "m1", playback: null })).toBe(true);
  });

  test("embed-changed rejects a non-canonical generic embed", () => {
    const bad = { provider: "generic", host: "localhost", url: "https://localhost/" };
    expect(v.is(ServerMessageSchema, { type: "embed-changed", embed: bad, by: null, playback: null })).toBe(false);
  });

  test("share response carries a generic embed", () => {
    expect(v.is(ShareResponseSchema, { ok: true, embed: GENERIC })).toBe(true);
  });

  test("a worst-case snapshot with a max-length generic embed fits the frame limit", () => {
    const path = "/" + "a".repeat(MAX_GENERIC_EMBED_URL_LENGTH - "https://player.example.com/".length);
    const embed = canonicalizeGenericEmbed(`https://player.example.com${path}`);
    expect(embed?.url.length).toBe(MAX_GENERIC_EMBED_URL_LENGTH);
    const members = Array.from({ length: 25 }, (_, i) => ({
      id: String(i).padStart(2, "0") + "x".repeat(62),
      nickname: "李".repeat(20),
      avatar: 3,
    }));
    const memberSeats = members.slice(0, 8).map((m) => m.id);
    const frame = JSON.stringify({
      type: "snapshot",
      self: members[0]?.id,
      room: { id: "a".repeat(32), seats: memberSeats, members, embed, playback: null },
    });
    expect(parseServerMessage(frame)?.type).toBe("snapshot");
  });
});
