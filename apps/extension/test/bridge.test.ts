import { describe, expect, test } from "bun:test";
import { bridgeMatches, fromBackground, fromPage } from "../src/bridge";

// ADR 0047 §5 (OME-1040): the content script on our origin passes on only parsed messages from its own window.
const OUR = "https://omega.example";
const self = {};

describe("fromPage", () => {
  const event = (data: unknown, over: { source?: unknown; origin?: string } = {}) => ({ source: self, origin: OUR, data, ...over });

  test("passes unlock and relock from our own window", () => {
    expect(fromPage(event({ source: "omega-share", kind: "unlock", host: "video.cdn-host.net" }), self, OUR)).toEqual({ source: "omega-share", kind: "unlock", host: "video.cdn-host.net" });
    expect(fromPage(event({ source: "omega-share", kind: "relock" }), self, OUR)).toEqual({ source: "omega-share", kind: "relock" });
  });

  test("drops another window, another origin, our own replies and anything malformed", () => {
    const ok = { source: "omega-share", kind: "unlock", host: "video.cdn-host.net" };
    expect(fromPage(event(ok, { source: {} }), self, OUR)).toBeNull();
    expect(fromPage(event(ok, { origin: "https://evil.example" }), self, OUR)).toBeNull();
    expect(fromPage(event({ source: "omega-share", kind: "present", version: "1.0" }), self, OUR)).toBeNull();
    expect(fromPage(event({ ...ok, host: "localhost" }), self, OUR)).toBeNull();
    expect(fromPage(event({ ...ok, extra: 1 }), self, OUR)).toBeNull();
    expect(fromPage(event("unlock"), self, OUR)).toBeNull();
  });
});

describe("fromBackground", () => {
  test("passes only extension → page messages", () => {
    const result = { source: "omega-share", kind: "unlock-result", host: "video.cdn-host.net", outcome: "denied" } as const;
    expect(fromBackground(result)).toEqual(result);
    expect(fromBackground({ source: "omega-share", kind: "unlock", host: "video.cdn-host.net" })).toBeNull();
    expect(fromBackground({ ...result, outcome: "maybe" })).toBeNull();
  });
});

describe("bridgeMatches", () => {
  test("the default origin, plus a valid self-hosted origin from storage, port-less", () => {
    expect(bridgeMatches("https://omega.example", undefined)).toEqual(["https://omega.example/*"]);
    expect(bridgeMatches("https://omega.example", "https://omega.example")).toEqual(["https://omega.example/*"]);
    expect(bridgeMatches("http://localhost:8787", "https://mine.example")).toEqual(["http://localhost/*", "https://mine.example/*"]);
    expect(bridgeMatches("https://omega.example", "http://evil.example")).toEqual(["https://omega.example/*"]);
  });
});
