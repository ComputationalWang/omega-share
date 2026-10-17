// Inbound contract corpora (OME-1161): WebSocket frames (`parseClientMessage`) and HTTP request bodies, all
// as RAW text, since the server reads text. What `JSON.stringify` never writes (-0, 1.0, 1e2, duplicate
// keys, lone surrogates) is marked `rustRefuses` (PORTING.md "Deliberate differences").
import * as v from "valibot";
import { CreateRoomRequestSchema, ReportRequestSchema, ShareRequestSchema, parseClientMessage } from "../../../packages/shared/src";
import { decidedRaw, type Case, type Corpus } from "./corpora";

interface Raw {
  text: string;
  rustRefuses?: true;
}
const ok = (text: string): Raw => ({ text });
const js = (o: unknown): Raw => ({ text: JSON.stringify(o) });
const rr = (text: string): Raw => ({ text, rustRefuses: true });

const TOKEN = "A".repeat(22);
const RESUME = "B".repeat(43);
const URL128 = (n: number): string => "https://a.example/" + "x".repeat(n - 18);
const LAYOUT = {
  furniture: [
    { kind: "tv", col: 0, row: 0, facing: "se" },
    ...([[1, 5], [2, 4], [4, 2], [5, 1], [3, 7], [4, 6], [6, 4], [7, 3]] as const).map(([col, row]) => ({ kind: "armchair", col, row, facing: col < row ? "ne" : "nw" })),
  ],
};
const JOIN = { type: "join", nickname: "Alice", avatar: 1 };
const CONTROL = { type: "control", url: "https://youtu.be/dQw4w9WgXcQ", playing: true, position: 12.5 };

const WRONG = [null, true, false, 0, 1, -1, 1.5, "", "x", [], {}, [1], { a: 1 }];

/** Every key of `base` replaced by every wrong value, and removed. */
const mutations = (base: Record<string, unknown>): Raw[] =>
  Object.keys(base).flatMap((k) => {
    const without = Object.fromEntries(Object.entries(base).filter(([key]) => key !== k));
    return [js(without),...WRONG.map((w) => js({ ...base, [k]: w }))];
  });

const valid: Raw[] = [
  js(JOIN),
  js({ ...JOIN, ownerToken: TOKEN }),
  js({ ...JOIN, inviteKey: TOKEN }),
  js({ ...JOIN, ownerToken: TOKEN, inviteKey: TOKEN, durableSession: true, resumeToken: RESUME }),
  js({ ...JOIN, nickname: " Ａｌｉｃｅ ", avatar: 3 }),
  js({ ...JOIN, avatar: 0 }),
  js({ type: "leave" }),
  js({ type: "presence", away: true }),
  js({ type: "presence", away: false }),
  js({ type: "sit", seat: 0 }),
  js({ type: "sit", seat: 7 }),
  js({ type: "sit", seat: null }),
  js({ type: "walk", cell: { x: 0, y: 0 } }), js({ type: "walk", cell: { x: 9, y: 9 } }), js({ type: "walk", cell: { y: 3, x: 8 } }),
  ...[0, 1, 2, 3, 4, 5].map((tint) => js({ type: "set-tint", tint })),
  js({ ...JOIN, tint: 0 }), js({ ...JOIN, tint: 5 }),
  js({ type: "chat", text: "hello there" }),
  js({ type: "chat", text: "  Ｈello  " }),
  js({ type: "ping", id: 0 }),
  js({ type: "ping", id: 2147483647 }),
  js(CONTROL),
  js({ ...CONTROL, playing: false, position: 0 }),
  js({ ...CONTROL, position: 43200 }),
  js({ ...CONTROL, url: "" }),
  js({ ...CONTROL, url: URL128(128) }),
  js({ ...CONTROL, url: "é".repeat(128) }),
  js({ ...CONTROL, url: "😀".repeat(64) }),
  js({ type: "status", catching: true }),
  js({ type: "layout-set", layout: LAYOUT }),
  js({ type: "title-set", title: " Ｆｉｌｍｓ " }),
  ...["clap", "exclaim", "heart", "laugh", "question", "wave", "cheer", "yawn"].map((kind) => js({ type: "emote", kind })),
  js({ type: "kick", memberId: "m2" }),
  js({ type: "mute", memberId: "m2", muted: true }),
  js({ type: "mute", memberId: "m2", muted: false }),
  js({ type: "control-policy", policy: "owner" }),
  js({ type: "control-policy", policy: "everyone" }),
  js({ type: "queue-add", url: "https://youtu.be/dQw4w9WgXcQ" }),
  js({ type: "queue-add", url: "" }),
  js({ type: "queue-add", url: URL128(2048) }),
  js({ type: "queue-add", url: "😀".repeat(1024) }),
  js({ type: "queue-remove", itemId: "q1" }),
  js({ type: "queue-move", itemId: "q1", toIndex: 0 }),
  js({ type: "queue-move", itemId: "q1", toIndex: 19 }),
  js({ type: "queue-advance", fromItemId: "q1" }),
  js({ type: "ended", itemId: "q1", position: 212.5 }),
  js({ type: "ended", itemId: "q1", position: 0 }),
  // key order, whitespace, escapes
  ok('{"avatar":1,"nickname":"Alice","type":"join"}'),
  ok('  {"type":"leave"}\n'),
  ok('{"type":"cha\\u0074","text":"hi \\ud83d\\ude00"}'),
  ok('{"type":"control","url":"https:\\/\\/youtu.be\\/x","playing":true,"position":1}'),
  // numbers
  ok('{"type":"control","url":"u","playing":true,"position":1.5e1}'),
  ok('{"type":"control","url":"u","playing":true,"position":4.32e4}'),
  ok('{"type":"ended","itemId":"q1","position":0.0}'),
  ok('{"type":"control","url":"u","playing":true,"position":-0}'),
  ok('{"type":"control","url":"u","playing":true,"position":-0.0}'),
];

const invalid: Raw[] = [
  // the frame itself
  ok(""), ok(" "), ok("{"), ok("{nope"), ok("null"), ok("true"), ok("0"), ok('"leave"'), ok("[]"), ok("{}"), ok("[[]]"),
  ok('{"type":"leave"} x'), ok('{"type":"leave"}{"type":"leave"}'), ok('{"type":"leave",}'), ok("{'type':'leave'}"),
  ok('{"type":"leave"}\u0000'), ok("﻿" + '{"type":"leave"}'),
  // tags
  js({}), js({ type: null }), js({ type: 1 }), js({ type: true }), js({ type: ["leave"] }), js({ type: {} }), js({ type: "" }),
  js({ type: "Leave" }), js({ type: "LEAVE" }), js({ type: "leave " }), js({ type: "queue_add" }), js({ type: "layoutSet" }),
  js({ type: "snapshot" }), js({ type: "pong", id: 1, at: 1 }), js({ type: "member-joined" }), js({ type: "__proto__" }),
  // arrays in place of objects, every variant
  ok('["leave"]'), ok('["join","Alice",1]'), ok('["sit",3]'), ok('["chat","hi"]'), ok('[{"type":"leave"}]'),
  ok('{"type":"sit","seat":[3]}'), ok('{"type":"layout-set","layout":[[{"kind":"tv"}]]}'),
  ok('{"type":"layout-set","layout":[{"kind":"tv","col":0,"row":0,"facing":"se"}]}'),
  ok('{"type":"layout-set","layout":{"furniture":[["tv",0,0,"se"]]}}'),
  // unknown keys
  js({ type: "leave", extra: 1 }), js({ ...JOIN, extra: 1 }), js({ ...JOIN, shareToken: TOKEN }), js({ type: "presence", away: true, by: "m1" }),
  js({ type: "sit", seat: 1, x: null }), js({ type: "chat", text: "hi", at: 1 }), js({ ...CONTROL, rate: 1 }),
  js({ type: "layout-set", layout: { ...LAYOUT, extra: 1 } }),
  js({ type: "layout-set", layout: { furniture: [{ kind: "tv", col: 0, row: 0, facing: "se", extra: 1 }] } }),
  js({ type: "layout-set", layout: LAYOUT, by: "m1" }),
  js({ type: "layout-set", layout: { furniture: [] } }), js({ type: "layout-set" }), js({ type: "layout-set", layout: null }),
  // wrong types per field, and missing, for every variant
  ...mutations(JOIN), ...mutations({ type: "presence", away: true }), ...mutations({ type: "sit", seat: 1 }),
  ...mutations({ type: "chat", text: "hi" }), ...mutations({ type: "ping", id: 1 }), ...mutations(CONTROL),
  ...mutations({ type: "status", catching: true }), ...mutations({ type: "title-set", title: "Films" }),
  ...mutations({ type: "emote", kind: "wave" }), ...mutations({ type: "kick", memberId: "m2" }),
  ...mutations({ type: "mute", memberId: "m2", muted: true }), ...mutations({ type: "control-policy", policy: "owner" }),
  ...mutations({ type: "queue-add", url: "u" }), ...mutations({ type: "queue-remove", itemId: "q1" }),
  ...mutations({ type: "queue-move", itemId: "q1", toIndex: 0 }),
  ...mutations({ type: "walk", cell: { x: 1, y: 1 } }), ...mutations({ type: "set-tint", tint: 1 }),
  ...mutations({ type: "queue-advance", fromItemId: "q1" }), ...mutations({ type: "ended", itemId: "q1", position: 1 }),
  // optional join fields: null is not absent, wrong shapes
  js({ ...JOIN, ownerToken: null }), js({ ...JOIN, inviteKey: null }), js({ ...JOIN, resumeToken: null }), js({ ...JOIN, durableSession: null }),
  js({ ...JOIN, ownerToken: "short" }), js({ ...JOIN, ownerToken: TOKEN + "A" }), js({ ...JOIN, ownerToken: "A".repeat(21) + "!" }),
  js({ ...JOIN, inviteKey: 5 }), js({ ...JOIN, resumeToken: TOKEN }), js({ ...JOIN, resumeToken: RESUME + "B" }), js({ ...JOIN, resumeToken: "B".repeat(42) + "=" }),
  js({ ...JOIN, durableSession: false }), js({ ...JOIN, durableSession: "true" }), js({ ...JOIN, durableSession: 1 }),
  js({ ...JOIN, avatar: 4 }), js({ ...JOIN, avatar: -1 }), js({ ...JOIN, avatar: 1.5 }), js({ ...JOIN, avatar: "1" }),
  js({ ...JOIN, nickname: "" }), js({ ...JOIN, nickname: "   " }), js({ ...JOIN, nickname: "a".repeat(21) }), js({ ...JOIN, nickname: "a‮b" }),
  js({ ...JOIN, nickname: "a".repeat(20) + "b" }), js({ ...JOIN, nickname: "Alicе" }),
  // sit
  js({ type: "sit", seat: 8 }), js({ type: "sit", seat: -1 }), js({ type: "sit", seat: 1.5 }), js({ type: "sit", seat: "1" }), js({ type: "sit" }),
  js({ type: "sit", seat: undefined }), js({ type: "sit", seat: false }), js({ type: "sit", seat: 99 }),
  // chat
  js({ type: "chat", text: "" }), js({ type: "chat", text: "   " }), js({ type: "chat", text: "a".repeat(281) }), js({ type: "chat", text: "a\nb" }),
  js({ type: "chat", text: "a​b" }), js({ type: "chat", text: "‍" }), js({ type: "chat", text: "€".repeat(1400) }),
  // ping
  js({ type: "ping", id: 2147483648 }), js({ type: "ping", id: -1 }), js({ type: "ping", id: 1.5 }), js({ type: "ping", id: "1" }), js({ type: "ping", id: 1e10 }),
  ok('{"type":"ping","id":1e400}'), ok('{"type":"ping","id":-1e400}'), ok('{"type":"ping","id":NaN}'), ok('{"type":"ping","id":Infinity}'),
  // control
  js({ ...CONTROL, url: URL128(129) }), js({ ...CONTROL, url: "é".repeat(129) }), js({ ...CONTROL, url: "😀".repeat(65) }), js({ ...CONTROL, url: 1 }),
  js({ ...CONTROL, position: -1 }), js({ ...CONTROL, position: 43201 }), js({ ...CONTROL, position: -0.001 }), js({ ...CONTROL, position: "1" }),
  js({ ...CONTROL, playing: "true" }), js({ ...CONTROL, playing: 1 }),
  ok('{"type":"control","url":"u","playing":true,"position":1e400}'), ok('{"type":"control","url":"u","playing":true,"position":-1e400}'),
  ok('{"type":"control","url":"u","playing":true,"position":1e999}'), ok('{"type":"control","url":"u","playing":true,"position":NaN}'),
  ok('{"type":"control","url":"u","playing":true,"position":Infinity}'), ok('{"type":"control","url":"u","playing":true,"position":-Infinity}'),
  ok('{"type":"control","url":"u","playing":true,"position":43200.0000001}'),
  // title, emote, ids
  js({ type: "title-set", title: "" }), js({ type: "title-set", title: "a‮b" }), js({ type: "title-set", title: "a".repeat(33) }),
  // walk, set-tint, join tint (OME-1346)
  ...[10, -1, 1.5, "1", null, 1e400].flatMap((n) => [js({ type: "walk", cell: { x: n, y: 0 } }), js({ type: "walk", cell: { x: 0, y: n } })]),
  js({ type: "walk", cell: { x: 1 } }), js({ type: "walk", cell: null }), js({ type: "walk", cell: [1, 1] }), js({ type: "walk", cell: { x: 1, y: 1, z: 1 } }),
  ok('{"type":"walk","cell":{"x":1.0,"y":2}}'), ok('{"type":"walk","cell":{"x":1,"y":1e400}}'),
  ...[6, -1, 0.5, "1", null, true].map((tint) => js({ type: "set-tint", tint })), js({ ...JOIN, tint: 6 }), js({ ...JOIN, tint: null }),
  js({ type: "emote", kind: "Wave" }), js({ type: "emote", kind: "dance" }), js({ type: "emote", kind: "" }), js({ type: "emote", kind: 1 }),
  js({ type: "kick", memberId: "" }), js({ type: "kick", memberId: "a".repeat(65) }), js({ type: "kick", memberId: "a b" }), js({ type: "kick", memberId: "mé" }),
  js({ type: "control-policy", policy: "Owner" }), js({ type: "control-policy", policy: "all" }),
  js({ type: "queue-remove", itemId: "" }), js({ type: "queue-remove", itemId: "a".repeat(33) }), js({ type: "queue-remove", itemId: "q 1" }),
  js({ type: "queue-advance", fromItemId: "a".repeat(33) }),
  js({ type: "queue-move", itemId: "q1", toIndex: 20 }), js({ type: "queue-move", itemId: "q1", toIndex: -1 }),
  js({ type: "queue-move", itemId: "q1", toIndex: 1.5 }), js({ type: "queue-move", itemId: "q1", toIndex: "1" }),
  js({ type: "queue-move", itemId: "q 1", toIndex: 0 }), ok('{"type":"queue-move","itemId":"q1","toIndex":1e400}'),
  // queue-add / ended
  js({ type: "queue-add", url: URL128(2049) }), js({ type: "queue-add", url: "😀".repeat(1025) }), js({ type: "queue-add", url: "é".repeat(2049) }),
  js({ type: "ended", itemId: "q1", position: -1 }), js({ type: "ended", itemId: "q1", position: 43201 }),
  ok('{"type":"ended","itemId":"q1","position":Infinity}'),
];

const LAYOUT_JSON = JSON.stringify(LAYOUT);
const F = JSON.stringify(LAYOUT.furniture);
const POS = (n: string): string => `{"type":"control","url":"u","playing":true,"position":${n}}`;

// Long-digit decimals: JS rounds correctly, so serde_json needs float_roundtrip to take the same side of a limit.
const floats: Raw[] = [
  ok(POS("43200.0000000000031806322522291669")),
  ok(POS("43200.00000000000001")),
  ok(POS("43199.99999999999999999")),
  ok(POS("43200.000000000007")),
  ok(POS("43200.00000000001")),
  ok(POS("0.30000000000000004441")),
  ok(POS("-0.0000000000000000000001")),
  ok(POS("5e-324")),
  ok(POS("2.2250738585072011e-308")),
  ok(POS("1.7976931348623157e308")),
  ok(POS("123456789.123456789123456789")),
  ok(POS("1e-400")),
  ok(`{"type":"ended","itemId":"q1","position":43200.0000000000031806322522291669}`),
  ok(`{"type":"ended","itemId":"q1","position":8.98846567431158e307}`),
];

// Duplicate keys inside the layout: TS takes the last, Rust refuses like everywhere else.
const layoutDuplicates: Raw[] = [
  rr(`{"type":"layout-set","layout":{"furniture":${F},"furniture":${F}}}`),
  rr(`{"type":"layout-set","layout":${LAYOUT_JSON.replace('"kind":"tv"', '"kind":"tv","kind":"tv"')}}`),
  rr(`{"type":"layout-set","layout":${LAYOUT_JSON.replace('"col":0', '"col":0,"col":0')}}`),
];

// TS accepts, Rust deliberately refuses.
const deliberate: Raw[] = [
  ...layoutDuplicates,
  rr('{"type":"leave","type":"leave"}'),
  rr('{"type":"sit","seat":1,"seat":2}'),
  rr('{"type":"leave","type":"chat"}'),
  rr('{"type":"chat","text":"a","text":"b"}'),
  rr('{"type":"sit","seat":1.0}'), rr('{"type":"sit","seat":-0}'), rr('{"type":"sit","seat":1e0}'), rr('{"type":"sit","seat":0e5}'),
  rr('{"type":"ping","id":1.0}'), rr('{"type":"ping","id":-0}'), rr('{"type":"ping","id":1e2}'), rr('{"type":"ping","id":2147483647.0}'),
  rr('{"type":"join","nickname":"Alice","avatar":1.0}'), rr('{"type":"join","nickname":"Alice","avatar":1e0}'),
  rr('{"type":"chat","text":"a\\ud800"}'), rr('{"type":"chat","text":"\\udc00a"}'),
  rr('{"type":"control","url":"\\ud800","playing":true,"position":1}'), rr('{"type":"queue-add","url":"\\udc00"}'),
  rr('{"type":"layout-set","layout":{"furniture":[{"kind":"tv","col":0.0,"row":0,"facing":"se"}]}}'),
];

/** Frames at 4096 bytes ±1 with multi-byte characters: padded with spaces (JSON whitespace) to exact byte counts. */
const sizeEdges = (): Raw[] => {
  const bytes = (s: string): number => new TextEncoder().encode(s).length;
  const out: Raw[] = [];
  for (const body of ['{"type":"leave"}', '{"type":"chat","text":"héllo"}', '{"type":"chat","text":"😀 ok"}', '{"type":"chat","text":"€€€"}']) {
    for (const target of [4094, 4095, 4096, 4097, 4098]) out.push(ok(body + " ".repeat(target - bytes(body))));
    // multi-byte whitespace is not JSON: padding at the front with U+00A0 is refused by JSON.parse at any size.
    out.push(ok(body + " ".repeat(10)));
  }
  // 1365 euro signs = 4095 UTF-8 bytes of text but only 1365 UTF-16 units: the byte rule decides.
  for (const n of [1364, 1365, 1366]) out.push(ok(JSON.stringify({ type: "chat", text: "€".repeat(n) })));
  // A valid layout-set near the cap, padded to the limit.
  const lay = JSON.stringify({ type: "layout-set", layout: LAYOUT });
  for (const target of [4095, 4096, 4097]) out.push(ok(lay + " ".repeat(Math.max(0, target - bytes(lay)))));
  return out;
};

const frames = (): Raw[] => [...valid, ...floats, ...invalid, ...deliberate, ...sizeEdges()];

/** A lone-surrogate output can't be written as corpus JSON serde reads; such cases are `rustRefuses`, so the record gets U+FFFD. */
const safe = (o: unknown): unknown =>
  typeof o === "string"
    ? o.replace(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g, "\ufffd")
    : Array.isArray(o)
      ? o.map(safe)
      : o !== null && typeof o === "object"
        ? Object.fromEntries(Object.entries(o).map(([k, x]) => [k, safe(x)]))
        : o;

const rawCases = (inputs: readonly Raw[], parse: (text: string) => unknown): Case[] =>
  inputs.map(({ text, rustRefuses }) => {
    const output = safe(parse(text) ?? null);
    const base: Case = output === null ? { input: text, ok: false } : { input: text, ok: true, output };
    return rustRefuses === true ? { ...base, rust: "refuses" } : base;
  });

const body = (schema: v.GenericSchema) => (parsed: unknown): unknown => {
  const r = v.safeParse(schema, parsed);
  return r.success ? safe(r.output) : null;
};

const BODY_VALUES = [...WRONG, "public", "private", "spam", "other", "classic", [[]]];
const createBodies = (): Raw[] => [
  js({ title: "Friday films", visibility: "public" }),
  js({ title: "Friday films", visibility: "private" }),
  js({ title: " Ｆｉｌｍｓ ", visibility: "public", preset: "cinema" }),
  ...["classic", "cinema", "living", "lounge", "cafe", "empty"].map((preset) => js({ title: "Room", visibility: "public", preset })),
  ...["", "Classic", "layout", "default", null, 1, [], {}].map((preset) => js({ title: "Room", visibility: "public", preset })),
  js({ title: "Friday films", visibility: "secret" }), js({ title: "Friday films" }), js({ visibility: "public" }), js({}),
  js({ title: "Friday films", visibility: "public", id: "lobby" }), js({ title: "Friday films", visibility: "public", layout: {} }),
  js({ title: "a".repeat(32), visibility: "public" }), js({ title: "a".repeat(33), visibility: "public" }), js({ title: "", visibility: "public" }),
  js({ title: "a‮b", visibility: "public" }), js({ title: "x", visibility: "Public" }), js({ title: 1, visibility: "public" }),
  js({ title: "x", visibility: null }), js({ title: null, visibility: "public" }),
  ...BODY_VALUES.flatMap((w) => [js({ title: w, visibility: "public" }), js({ title: "x", visibility: w }), js(w)]),
  ok(""), ok("{"), ok("null"), ok("[]"), ok('["Room","public"]'), ok('["Room","public","classic"]'), ok('{"title":"Room","visibility":"public"} x'),
  rr('{"title":"Room","title":"Room2","visibility":"public"}'),
  rr('{"title":"Room","visibility":"public","visibility":"private"}'),
  rr('{"title":"Room","visibility":"public","preset":"classic","preset":"cafe"}'),
  rr('{"title":"Room\\ud800","visibility":"public"}'),
  ok('{"title":"Room","visibility":"public","preset":"cafe"}'),
  ok('{"visibility":"public","preset":"cafe","title":"Room"}'),
];
const shareBodies = (): Raw[] => [
  js({ url: "https://youtu.be/dQw4w9WgXcQ" }), js({ url: "anything — server canonicalizes" }), js({ url: "" }),
  js({ url: URL128(2048) }), js({ url: URL128(2049) }),
  // Multi-byte units at the 2048 limit, kept under the 4096-byte body cap (which the parser also enforces).
  js({ url: "😀".repeat(512) + "a".repeat(1024) }), js({ url: "😀".repeat(512) + "a".repeat(1025) }),
  js({ url: "é".repeat(1024) + "a".repeat(1024) }), js({ url: "é".repeat(1024) + "a".repeat(1025) }),
  js({}), js({ url: null }), js({ url: 1 }), js({ url: ["x"] }), js({ url: {} }), js({ url: "x", extra: 1 }), js({ url: "x", u: "y" }),
  js("x"), js(null), js([]), js(["x"]), js(1), ok(""), ok("{"), ok('["https://x.example"]'), ok('{"url":"x"} x'), ok('{"url":"x",}'),
  rr('{"url":"a","url":"b"}'), rr('{"url":"\\ud800"}'),
];
const reportBodies = (): Raw[] => [
  ...["sexual", "violence", "hate", "spam", "danger", "other"].flatMap((reason) => [
    js({ reason }), js({ reason, note: "the chat posts slurs" }), js({ reason, note: "a".repeat(300) }),
  ]),
  js({ reason: "spam", note: "a".repeat(301) }), js({ reason: "spam", note: "a".repeat(600) }), js({ reason: "spam", note: "a".repeat(601) }),
  js({ reason: "spam", note: "a\nb\r\n\tc" }), js({ reason: "spam", note: "\n\n\n" }), js({ reason: "spam", note: "a\n".repeat(300) }),
  js({ reason: "spam", note: "\n".repeat(601) }), js({ reason: "spam", note: " " }), js({ reason: "spam", note: "" }),
  js({ reason: "spam", note: "😀".repeat(150) }), js({ reason: "spam", note: "😀".repeat(151) }), js({ reason: "spam", note: "a‮b" }),
  js({ reason: "spam", note: "a​b" }), js({ reason: "spam", note: null }), js({ reason: "spam", note: 1 }), js({ reason: "spam", note: [] }),
  js({ reason: "illegal" }), js({ reason: "SPAM" }), js({}), js({ reason: 1 }), js({ reason: null }), js({ reason: "" }), js({ note: "no reason" }),
  js({ reason: "spam", roomId: "lobby" }), js({ reason: "spam", email: "a@b.example" }), js({ reason: "spam", nickname: "ann" }),
  js(null), js("spam"), js(["spam"]), js(3), ok(""), ok("{"), ok('["spam"]'), ok('["spam","note"]'), ok('{"reason":"spam"} x'),
  rr('{"reason":"spam","reason":"hate"}'), rr('{"reason":"spam","note":"a","note":"b"}'), rr('{"reason":"spam","note":"a\\ud800"}'),
];

export const inboundCorpora: Corpus[] = [
  { name: "client-message-raw", cases: () => rawCases(frames(), (t) => parseClientMessage(t)) },
  { name: "create-room-request-raw", cases: () => decidedRaw(createBodies(), body(CreateRoomRequestSchema)) },
  { name: "share-request-raw", cases: () => decidedRaw(shareBodies(), body(ShareRequestSchema)) },
  { name: "report-request-raw", cases: () => decidedRaw(reportBodies(), body(ReportRequestSchema)) },
];
