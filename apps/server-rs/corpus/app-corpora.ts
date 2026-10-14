// App-core corpora (OME-1164): the small pure functions of server.ts, reports.ts and rooms-gc.ts, driven by the
// real TS code. No lone surrogates, and no input whose output would hold one (PORTING.md).
//  - redact-note: `redactNote`, the address redaction plus the phone-number lookarounds.
//  - block-key / title-blocker: server.ts `blockKey` and `titleBlocker` (ROOM_TITLE_BLOCKLIST).
//  - room-gc-expired: rooms-gc.ts `expired(room, now)`.
import { Room } from "../../server/src/room";
import { expired, ROOM_IDLE_TTL_MS } from "../../server/src/rooms-gc";
import { redactNote } from "../../server/src/reports";
import { blockKey, titleBlocker } from "../../server/src/server";
import { redactInputs } from "./address-inputs";
import { decided, type Corpus } from "./corpora";

const dedup = <T,>(xs: readonly T[]): T[] => [...new Set(xs)];

// ---- redact-note

const PHONE_BODIES = [
  "1234567", "123456", "12345678", "1 2 3 4 5 6 7", "1 2 3 4 5 6 7 8 9", "1-2-3-4-5-6-7", "1.2.3.4.5.6.7", "12-34-56-78", "12.34.56.78", "12 34 56 78",
  "+44 20 7946 0958", "+1 (555) 123-4567", "555-123-4567", "555.123.4567", "555 123 4567", "5551234567", "+5551234567", "++5551234567", "+ 5551234567",
  "1234567 8", "1234567  8", "1234567--8", "1234567-8", "123 456 7890", "1  2 3 4 5 6 7", "0123456", "٠١٢٣٤٥٦٧", "１２３４５６７", "1234567٣", "12345٦789",
];
const PHONE_PREFIXES = ["", "a", "Z", "_", "/", ".", "=", "?", "&", "#", "%", "+", ":", "-", " ", "\u{1F600}", "(", "[", ",", " ", "﻿", "\u0085", "é", "٣", "$"];
const PHONE_SUFFIXES = ["", "a", "_", " ", ".", "-", "x", "9", "\u{1F600}", ")", ",", " ", "﻿", "\u0085", "é", "٣", "/", "?"];

function redactNoteInputs(): string[] {
  const out: string[] = [...redactInputs()];
  for (const body of PHONE_BODIES) {
    for (const prefix of PHONE_PREFIXES) out.push(`${prefix}${body}`);
    for (const suffix of PHONE_SUFFIXES) out.push(`${body}${suffix}`);
  }
  for (const prefix of ["", "a", "-", " "]) for (const suffix of ["", "a", " ", "-"]) out.push(`${prefix}1234567${suffix}`, `${prefix}12345678${suffix}`);
  out.push(
    "call +44 20 7946 0958 or 555-123-4567 or 555.123.4567",
    "see https://vimeo.com/76979871 at 12:30, 3 people, 123456",
    "mail ada.l@example.org now",
    "from 203.0.113.9 and 2001:db8::1",
    "1234567 and 7654321 and 1111111",
    "a1234567 b 1234567 c1234567",
    "id=1234567&x=7654321",
    "https://example.org/?q=1234567#8765432",
    "ip 1.2.3.4 phone 5551234567 mail a@b.co",
    "0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9",
    "9".repeat(40),
    "9 ".repeat(40),
    "9-".repeat(40),
    "9x".repeat(10),
  );
  return dedup(out);
}

// ---- block-key and the title blocker

const SEPARATOR_TITLES = [
  "bad word", "b.a.d-w_o r d", "BADWORD", "BADW0RD", "badw0rd", "bad word", "bad word", "bad﻿word", "bad\u0085word", "bad​word", "bad　word",
  "bad word", "bad word", "bad\tword", "bad\nword", "bad$word", "bad€word", "bad©word", "bad¡word", "bad¿word", "bad«word»", "bad\u{1F600}word",
  "b\u{1D41A}dword", "bаdword", "bɑdword", "ｂａｄｗｏｒｄ", "Ｂad Ｗord", "ﬁnd", "find", "ﬃ", "ffi", "I", "l", "1", "Il1|", "O0o", "rn m", "vv w", "cl d",
  "é", "é", "é́", "bad́word", "李雷", "李 雷", "हिन्दी", "ä ö ü", "ß", "SS", "ς σ", "İ", "ı", "K", "K", "Å", "Å",
  "", " ", "...", "---", "a", "ab", "abc", "a b c", "a-b-c", "a_b_c", "a+b=c", "a<b>c", "a|b", "a~b", "a^b", "a`b", "a'b", "a\"b", "a,b;c:d", "(a)[b]{c}",
  "evil", "EVIL", "3vil", "ev1l", "ev!l", "Ev.il", "e v i l", "Friday films", "Film club", "Taylor's party", "Mario Kart", "Bad Word Club", "the badword club",
  "x".repeat(40), "bad".repeat(10), "word".repeat(10), "badwor", "adword", "badwordd", "bbadword", "badword badword",
];

const TERM_SETS: string[][] = [
  [], ["badword"], ["BADWORD"], ["bad word"], ["b.a.d-w_o r d"], ["badword", "evil"], ["evil", "badword"], ["...", ""], ["", ""], [" "], ["bad", "word"],
  ["badw0rd"], ["ev1l"], ["3vil"], ["李雷"], ["é"], ["é"], ["ß"], ["ﬁnd"], ["I"], ["1"], ["x y"], ["a-b-c", "club"], ["\u{1F600}"], ["film", "friday films"],
];

const blockedCases = (): { input: [string[], string]; ok: boolean; output: boolean }[] => {
  const out = [];
  for (const terms of TERM_SETS) {
    const blocked = titleBlocker(terms);
    for (const title of SEPARATOR_TITLES) out.push({ input: [terms, title] as [string[], string], ok: true, output: blocked(title) });
  }
  return out;
};

// ---- room-gc-expired

interface GcInput {
  pinned: boolean;
  createdAt: number;
  lastActiveAt: number | null;
  now: number;
}

function gcInputs(): GcInput[] {
  const out: GcInput[] = [];
  const T0 = 1_700_000_000_000;
  for (const pinned of [true, false]) {
    for (const createdAt of [0, 1000, T0]) {
      for (const lastActiveAt of [null, 0, 5, createdAt, createdAt + 1, createdAt + 60_000, T0 + 30 * 86_400_000]) {
        const base = lastActiveAt ?? createdAt;
        for (const delta of [-1, 0, 1, ROOM_IDLE_TTL_MS - 1, ROOM_IDLE_TTL_MS, ROOM_IDLE_TTL_MS + 1, 2 * ROOM_IDLE_TTL_MS, 10_000 * 86_400_000]) {
          out.push({ pinned, createdAt, lastActiveAt, now: base + delta });
        }
      }
    }
  }
  return out;
}

const gcExpired = ({ pinned, createdAt, lastActiveAt, now }: GcInput): boolean =>
  expired(new Room("aaaaaaaaaaaaaaaaaaaaaaaaaa", { pinned, createdAt, lastActiveAt }), now);

export const appCorpora: Corpus[] = [
  { name: "redact-note", cases: () => decided(redactNoteInputs(), redactNote) },
  { name: "block-key", cases: () => decided(dedup(SEPARATOR_TITLES), blockKey) },
  { name: "title-blocker", cases: blockedCases },
  { name: "room-gc-expired", cases: () => decided(gcInputs(), gcExpired) },
];
