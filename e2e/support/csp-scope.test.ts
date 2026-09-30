import { expect, test } from "bun:test";
import { isOurDocument } from "./csp-scope";

// OME-218: which documents the zero-CSP fixture fails on. Anything we can't place counts as ours (fail closed).
const TOP = "http://localhost:5173/r/lobby";
const TUNNEL = "https://omega.example.test/r/lobby";

test.each([
  ["the top page itself", TOP, TOP, true],
  ["another loopback origin (server, fixtures)", "http://127.0.0.1:4400/x", TOP, true],
  ["any 127/8 address", "http://127.0.0.2:8787/", TOP, true],
  ["IPv6 loopback", "http://[::1]:8787/", TOP, true],
  ["a *.localhost host", "http://web.localhost:5173/", TOP, true],
  ["an extension page", "chrome-extension://abcdefghijklmnop/popup.html", TOP, true],
  ["a srcdoc frame", "about:srcdoc", TOP, true],
  ["a blob document", "blob:http://localhost:5173/1234", TOP, true],
  ["an unparseable URI", "", TOP, true],
  ["the tunnel page", TUNNEL, TUNNEL, true],
  ["a same-origin frame of the tunnel page", "https://omega.example.test/other", TUNNEL, true],
  ["a provider's player frame", "https://player.vimeo.com/video/1?dnt=1", TOP, false],
  ["a provider's player frame on the tunnel page", "https://player.twitch.tv/?channel=x", TUNNEL, false],
  ["a third-party frame when the top URL is unknown", "https://player.vimeo.com/video/1", "", false],
] as const)("%s → ours: %p", (_name, doc, top, ours) => {
  expect(isOurDocument(doc, top)).toBe(ours);
});
