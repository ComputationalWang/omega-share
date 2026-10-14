// Corpora for the S2a slice (OME-1155): contract ids, text rules, confusables. Inputs are built
// from code-point escapes so a reader can see what each one is. No lone surrogates (JSON can't
// carry them through serde; PORTING.md lists them as an allowed disagreement).
import * as v from "valibot";
import {
  AvatarSchema,
  ChatTextSchema,
  ControlPolicySchema,
  InviteKeySchema,
  MemberIdSchema,
  NicknameSchema,
  OwnerTokenSchema,
  QueueItemIdSchema,
  ReportNoteSchema,
  ResumeTokenSchema,
  RoomIdSchema,
  RoomTitleSchema,
  RoomVisibilitySchema,
  SeatIndexSchema,
  ShareTokenSchema,
  StandingSlotSchema,
  parseBearer,
} from "@omega/shared";
import { nicknameKey } from "@omega/shared/confusables";
import { CONFUSABLES } from "../../../packages/shared/src/confusables-table";
import type { Case } from "./corpora";

/** A schema as a corpus: the parsed output on success, `ok: false` on refusal. */
export const parsed = (schema: v.GenericSchema, inputs: readonly unknown[]): Case[] =>
  inputs.map((input) => {
    const r = v.safeParse(schema, input);
    return r.success ? { input, ok: true, output: r.output } : { input, ok: false };
  });

const cp = (...points: number[]): string => String.fromCodePoint(...points);
const rep = (s: string, n: number): string => s.repeat(n);
const WRONG_TYPES: unknown[] = [null, 0, 1, 42, -1, 1.5, true, false, [], ["a"], {}, { a: 1 }];

// ---- ids --------------------------------------------------------------------------------------

const idInputs = (max: number): unknown[] => [
  "",
  "a",
  "A",
  "0",
  "_",
  "-",
  "a-b_c",
  "lobby",
  "room-1",
  "Lobby",
  "a/b",
  "a b",
  " a",
  "a ",
  "a\n",
  "\na",
  "a.b",
  "a+b",
  "a=",
  "é",
  "ａ",
  "á",
  "😀",
  "a😀",
  "a‍",
  "﻿a",
  "\u0085",
  rep("a", max - 1),
  rep("a", max),
  rep("a", max + 1),
  rep("A", max),
  rep("A", max + 1),
  rep("z9_-", max / 4),
  rep("é", max),
  rep("😀", max / 2),
  rep("a", 1000),
  ...WRONG_TYPES,
];
export const memberIdCases = (): Case[] => parsed(MemberIdSchema, idInputs(64));
export const queueItemIdCases = (): Case[] => parsed(QueueItemIdSchema, idInputs(32));
export const roomIdCases = (): Case[] => parsed(RoomIdSchema, [...idInputs(32), "lobby", "a-b-c", "k3v4m5n6p7q2r3s4t5u6v7w2x3", "-", "--", "a_b", "UPPER", "ä"]);

const TOKEN = "AbCdEfGhIjKlMnOpQr_-09";
const tokenInputs = (len: number): unknown[] => {
  const t = (TOKEN + TOKEN + TOKEN).slice(0, len);
  return [
    "",
    t,
    t.slice(1),
    `${t}A`,
    `${t.slice(0, len - 2)}==`,
    `${t.slice(0, len - 1)}+`,
    `${t.slice(0, len - 1)}/`,
    `${t.slice(0, len - 1)} `,
    ` ${t.slice(1)}`,
    `${t.slice(0, len - 1)}é`,
    `${t.slice(0, len - 1)}\n`,
    `${t}\n`,
    `${t.slice(0, len - 1)}😀`,
    `${t.slice(0, len - 2)}😀`,
    rep("A", len),
    rep("-", len),
    rep("_", len),
    rep("0", len),
    rep("a", len - 1),
    rep("a", len + 1),
    rep("é", len),
    rep("ａ", len),
    rep("a", 100000),
    ...WRONG_TYPES,
  ];
};
export const shareTokenCases = (): Case[] => {
  const same = [OwnerTokenSchema, InviteKeySchema].map((s) => parsed(s, tokenInputs(22)));
  if (JSON.stringify(same[0]) !== JSON.stringify(same[1]) || JSON.stringify(same[0]) !== JSON.stringify(parsed(ShareTokenSchema, tokenInputs(22))))
    throw new Error("share, owner and invite tokens must agree");
  return parsed(ShareTokenSchema, tokenInputs(22));
};
export const resumeTokenCases = (): Case[] => parsed(ResumeTokenSchema, [...tokenInputs(43), "Ab_-" + rep("x", 39), "Ab_-" + rep("x", 39) + "\n", rep("x", 42), rep("x", 44)]);

const bearerInputs: unknown[] = [
  `Bearer ${TOKEN}`,
  `bearer ${TOKEN}`,
  `BEARER ${TOKEN}`,
  `BeArEr ${TOKEN}`,
  `bEARER ${TOKEN}`,
  "",
  "Bearer",
  "Bearer ",
  TOKEN,
  `Basic ${TOKEN}`,
  `Bearer${TOKEN}`,
  `Bearer  ${TOKEN}`,
  `Bearer\t${TOKEN}`,
  `Bearer ${TOKEN} x`,
  `Bearer ${TOKEN}, Bearer ${TOKEN}`,
  `Bearer ${TOKEN.slice(0, 21)}!`,
  `Bearer ${TOKEN.slice(2)}`,
  `Bearer ${TOKEN}AA`,
  `Bearer ${TOKEN.slice(0, 20)}==`,
  `Bearer ${rep("A", 100000)}`,
  ` Bearer ${TOKEN.slice(1)}`,
  `Bearer ${TOKEN}\n`,
  `Bearer ${TOKEN.slice(0, 21)}\n`,
  `Bearer ${TOKEN.slice(0, 21)}é`,
  `Bearer ${TOKEN.slice(0, 20)}😀`,
  `Bearer ${TOKEN.slice(0, 21)}😀`,
  `Kearer ${TOKEN}`, // KELVIN SIGN: not a "b"/"e"/"a"/"r" fold in non-unicode /i
  `Bearer ${rep("a", 22)}`,
  `bearer ${rep("-", 22)}`,
  `bearer ${rep("_", 22)}`,
  `Bearer: ${TOKEN}`,
  `Bearer ${TOKEN}`,
  `ſearer ${TOKEN}`, // LATIN SMALL LETTER LONG S
  `Bearer ${TOKEN.replace("A", "Α")}`,
  null,
  0,
];
export const parseBearerCases = (): Case[] =>
  bearerInputs.map((input) => {
    const out = typeof input === "string" ? parseBearer(input) : null;
    return out === null ? { input, ok: false } : { input, ok: true, output: out };
  });

// ---- text ---------------------------------------------------------------------------------------

/** Characters whose NFKC form differs, or that a name filter might treat oddly. */
const ODD = [
  "ﬁ", // fi ligature
  "ﬆ",
  "ﷺ", // 18 units after NFKC
  "²",
  "①", // circled one
  "㎒", // square MHz
  "ℌ", // black-letter H
  "Ǆ", // DZ digraph
  "ｶ", // halfwidth katakana KA
  "ﾞ",
  "ᵀ0", // math bold A: astral, NFKC → A
  cp(0x1d400),
  cp(0x1d7ce), // math bold digit zero
  cp(0x1d504), // fraktur A
  cp(0x1d670), // monospace A
  cp(0x1d7e2), // sans digit
  "Ω", // ohm → omega (Greek)
  "K", // kelvin → K
  "Å", // angstrom
  "ẞ", // capital sharp s
  "ß",
  "İ", // I with dot
  "ı",
  "ς", // final sigma
  "Σ",
  "Ⅰ", // roman numeral one
  "Ⅳ",
  "Ａ", // fullwidth A
  "１", // fullwidth 1
  "＿", // fullwidth low line
  "．",
  "－",
  "﹣", // small hyphen-minus
  "․", // one dot leader
  "‥",
  "‑", // non-breaking hyphen
  "‐",
  "­",
  " ",
  "　",
  " ",
  " ",
  " ",
  "\u0085",
  "﻿",
  "᠎",
  "​",
  "‌",
  "‍",
  "⁠",
  "‎",
  "‏",
  "‪",
  "‮",
  "⁦",
  "⁩",
  "؜",
  "ᅟ",
  "ᅠ",
  "ㅤ",
  "ﾠ",
  "⠀", // braille blank
  "឴",
  "឵",
  "͏",
  "\u0000",
  "\u0007",
  "\u007F",
  "\u0080",
  "\u009F",
  "︎",
  "️",
  "⃣",
  "", // private use
  "�",
  "￿",
  cp(0xe0001), // tag
  cp(0xe0061),
  cp(0xe0100), // variation selector supplement
  cp(0x10ffff),
  cp(0x1f600),
  cp(0x1f3fd),
  cp(0x1f468, 0x200d, 0x1f469, 0x200d, 0x1f467),
  cp(0x1f469, 0x1f3fd, 0x200d, 0x1f4bb),
  cp(0x1f3f3, 0xfe0f, 0x200d, 0x1f308),
  cp(0x2764, 0xfe0f, 0x200d, 0x1f525),
  cp(0x1f1fa, 0x1f1f8), // flag
  cp(0x1f9d1, 0x1f3fb, 0x200d, 0x1f91d, 0x200d, 0x1f9d1, 0x1f3ff),
];

/** Code points added to Unicode recently: where Bun's ICU (Unicode 17) and Rust's tables may differ. */
const NEW_BLOCK_STARTS = [
  0xa7c0, 0xa7ce, 0xa7d2, 0xa7da, 0xa7dc, 0x1c89, 0x2c2f, 0x2c5f, 0x31350, 0x2ebf0, 0x323b0, 0x10570, 0x10780, 0x10d40, 0x10ec2, 0x10ef0, 0x11380, 0x11bc0, 0x11db0, 0x11f00,
  0x12f90, 0x1342f, 0x13460, 0x16100, 0x16d40, 0x16ea0, 0x16f00, 0x18cff, 0x1e290, 0x1e4d0, 0x1e5d0, 0x1e6c0, 0x1e030, 0x10940, 0x1d2c0, 0x1fa89, 0x1fac6, 0x1fadc, 0x1fae9, 0x1fbca, 0x0897, 0x0c5c, 0x0cdc, 0x1b4e, 0x1dfa,
  0x2427, 0x31e4, 0xa7cd, 0xa7d0, 0xfa6e, 0x1e08f, 0x1f6dc, 0x1f77b, 0x1fa7c, 0x1f8b0,
].filter((n) => n > 0);
const NEW_CODE_POINTS = NEW_BLOCK_STARTS.flatMap((s) => [0, 1, 2, 3, 4, 7, 15, 31].map((d) => cp(s + d)));

const LATIN_PLAIN = "AaBbCcEeHhIiJjKkMmNnOoPpSsTtXxYyZzDdFfGgLlQqRrUuVvWw";
const lookalikes = (script: string, chars: string): string[] => [...chars].flatMap((c) => [`${script}${c}lice`, `Ali${c}e`, `${c}${c}`, `bob ${c}${c}`, `${c}bc 12`]);
const CYRILLIC = "АаВЕеКкМНОоРрСсТуХхІіЈјԁԛԝѕѵ";
const GREEK = "ΑΒΕΖΗΙΚΜΝΟΡΤΥΧαινοορυ";
const ARMENIAN = "ցհոօսԱԲԳ";
const CHEROKEE = "ᎪᎠᏴᏂᏚᎢᎬ";

const marks = (base: string, n: number, mark = "́"): string => base + rep(mark, n);

const NAME_INPUTS: unknown[] = [
  // plain, limits
  "alice", "Bob 2", "zoë", "李雷", "हिन्दी", "a.b_c-d", "x", "_", ".", "-", "1", "7", "a b", "a  b", " a", "a ", "  a  b  ", "a b c d", "a-", "-a", "a_ ", "_ _",
  rep("x", 19), rep("x", 20), rep("x", 21), rep("x", 40), rep("1", 20), rep("1", 21), rep("-", 20), rep("-", 21), rep("a ", 10).trim(), rep("a ", 11).trim(), rep("ab ", 7).trim(),
  `${rep("x", 19)} `, `${rep("x", 20)} `, ` ${rep("x", 20)}`, `　${rep("x", 20)}　`, `${rep("x", 21)}　`,
  "李".repeat(20), "李".repeat(21), "é".repeat(20), "é".repeat(21), rep("ａ", 20), rep("ａ", 21), rep("ｂ", 25),
  rep("ﬁ", 10), rep("ﬁ", 11), "abcﷺ", "ﷺ", "㊱", "㋏",
  // astral math alphanumerics (NFKC shrinks 2 units to 1)
  rep(cp(0x1d400), 20), rep(cp(0x1d400), 21), cp(0x1d400) + cp(0x1d41a), cp(0x1d7ce, 0x1d7cf), cp(0x1d504) + "lice", cp(0x1d670) + "lice",
  rep(cp(0x1d7e2), 20), rep(cp(0x1d7e2), 21),
  "Ａｌｉｃｅ", "ｂｏｂ２", "  Ｆｉｌｍｓ  ", "ﾎﾟｹﾓﾝ", "ｱｲｳ", "ＡＢＣ　ＤＥＦ", "ａ　ｂ",
  // whitespace and trim order
  "　", "   ", "\t", "\n", "a\nb", "a\tb", "a b", "a　b", "a b", " a", "a ", "﻿a", "a﻿", "﻿", "﻿﻿", "\u0085a", "a\u0085", "\u0085", "᠎a", "a᠎",
  "​a", "a​", "a​b", "⁠a", "a b ", " a b",
  // invisible and bidi
  "ㅤ", "aㅤ", "ㅤa", "aﾠb", "ﾠ", "ᅟ", "ᅠ", "aᅟb", "aᅠb", "ㅤㅤ", "a឴b", "a⠀b", "a͏b", "a؜b", "a‎b", "a‮b", "a⁦b", "a‍b", "a‌b", "al­ice",
  // marks 0..5 deep, on letters, digits, after spaces, mid-word
  ...[0, 1, 2, 3, 4, 5].flatMap((n) => [marks("x", n), marks("e", n, "̈"), marks("1", n), marks("李", n), marks("a", n, "̀") + "b", `a ${marks("b", n)}`, marks("z", n) + marks("y", n), marks("क", n, "्")]),
  marks("x", 2, "⃣"), "x́̂̃", "x́̂", "́a", "́", " ́a", "a ́b", "á ́", "हिन्दी", "हिन्दी", "کَُِ", "é́", "ệ", "zoë", "́̂", "a᪰b",
  // NFKC decompositions that create marks
  "ẛ̣", "̈́", "ཱི", "ཱུ", "ཱྀ", "יִ", "Ω", "K", "Å", "ẞ", "ß", "İ", "ı",
  "Ⅰ", "Ⅳ", "①", "²", "x²", "㎒", "ℌ", "Ǆ", "ｶﾞ", "＿", "．", "－", "﹣", "․", "‥", "‑", "‐",
  // shape
  "<b>hi</b>", "a/b", "a\\b", "a@b", "a!b", "a'b", "a,b", "a:b", "a#b", "a+b", "a(b)", "a&b", "a?b", "a\"b", "a=b", "a$b", "a%b", "a~b", "a*b", "a;b", "cool😎", "😎", "a😎", "", "�", "a\u0000b", "\u007F", "\u0080", "a\u009Fb", cp(0xe0001), cp(0xe0061), cp(0xe0100),
  "a︎", "a️", "1️⃣", "#️⃣", "a⃣",
  // scripts
  "Борис", "Σοφία", "Alice 李", "Alice Борис", "Борис Alice", "李 Alice", "bob боб", "Привет", "Ελληνικά", "Ողջույն", "ᏣᎳᎩ", "שלום", "مرحبا", "שלום Alice", "مرحبا bob", "สวัสดี", "한국어", "日本語", "ひらがな", "カタカナ", "ｶﾀｶﾅ", "हिन्दी हिन्दी", "ᚠᚢᚦ", "ሰላም", "ქართული", "Ꭺlice", "ᎠᏴ", "ꓡꓡ", "Aꓡ",
  "αβγ", "ΑΒΓ", "Aα", "αA", "ÅÄÖ", "ǅ", "ǈ", "ǋ", "ǲ", "Ǆ",
  // new code points
  ...NEW_CODE_POINTS,
  ...NEW_CODE_POINTS.slice(0, 40).map((c) => `a${c}b`),
  ...ODD,
  ...ODD.map((c) => `a${c}b`),
  ...ODD.map((c) => ` ${c} `),
  // lookalike mixes
  ...lookalikes("Alice", CYRILLIC),
  ...lookalikes("Alice", GREEK),
  ...lookalikes("Alice", ARMENIAN),
  ...lookalikes("Alice", CHEROKEE),
  ...[...LATIN_PLAIN].slice(0, 20).map((c) => `${c}${CYRILLIC[3]}`),
  // very long, RTL, wrong types
  rep("a", 10000), rep("é", 10000), rep("😀", 10000), rep(" ", 10000), rep("​", 10000),
  ...WRONG_TYPES,
];

export const nicknameCases = (): Case[] => parsed(NicknameSchema, NAME_INPUTS);

const TITLE_EXTRA: unknown[] = [
  "Friday films", "Tom's movie night!", "Anime & chill (EU)", "Café #2", "  Ｆｉｌｍｓ  ", "Room #️⃣", "Room 1️⃣", "Room 1⃣", "Room ❤︎", "Room ❤️", "Filмs", "Фильмы",
  "a\u0000b", "a‮b", "a​b", "a‍b", "<b>x</b>", "a/b", "film 🎬", "a  b", "a\nb", "ㅤ", "say \"hi\"", "a;b", "a=b", "a~b", "a*b", "a$b", "a%b", "a@b", "a[b]", "a{b}", "a|b", "a`b", "a^b", "a\\b", "a<b", "a>b", "a’b", "a‘b", "a…", "a!?,:#+()&'", "!", "?!", "'", "(", ")", "#", "#1", "1#", "+", "&", ",", ":", "a, b: c", "(a)", "((a))", "a (b) c",
  rep("a", 31), rep("a", 32), rep("a", 33), rep("!", 32), rep("!", 33), rep("(", 32), `${rep("a", 31)} `, `${rep("a", 32)} `, `${rep("a ", 16)}`.trim(), `${rep("a ", 17)}`.trim(), rep("é", 32), rep("é", 33), rep("李", 32), rep("李", 33), rep("ａ", 32), rep("ａ", 33), rep(cp(0x1d400), 32), rep(cp(0x1d400), 33), rep("ﬁ", 16), rep("ﬁ", 17),
  `x${rep("́", 2)}`, `x${rep("́", 3)}`, `x${rep("́", 2)} y${rep("́", 2)}`, "#⃣", "1︎", "©️", "™️", "©", "™", "®", "a™", "a™b",
  "❤️", "☺️", "☃", "☃︎", "a☃", "☃", "♥", "★", "♪ music", "→", "a→b",
  "Ελληνικά ταινίες", "Фильмы", "映画の夜", "Movie 映画", "Мovie", "Movіe", "Ꮯinema", "Ողջույն films",
  ...NEW_CODE_POINTS.slice(0, 80),
  ...ODD,
  ...ODD.map((c) => `a${c}b`),
];
export const roomTitleCases = (): Case[] => parsed(RoomTitleSchema, [...NAME_INPUTS.slice(0, 160), ...TITLE_EXTRA, ...WRONG_TYPES]);

const CHAT_INPUTS: unknown[] = [
  "hi", "hello world", "a", "1", ".", "!", "?!", "+", "$", "©", "…", "😀", "👍", "  hi  ", "\thi\n", "hi\nthere", "hi\tthere", "hi\rthere", "hi there", "hi there", "hi\u0085there", "\u0085hi", "hi\u0085", " hi ", "　hi　", "﻿hi﻿", "hi﻿there", "᠎hi", "hi᠎",
  "", " ", "   ", "\n", "\t", "​", "ㅤ", "ﾠ", "ᅟ", "ᅠ", "aㅤb", "ㅤa", "aᅟb", "aᅠb", "aﾠb", "́", "́́", "́́́́", "⠀", "a⠀", "⠀a", "­", "a­b", "͏", "឴", "️", "️️", "⃣",
  "zoë", "é", "é̂̃", "é̂̃̄", "x́̂̃", "x́̂̃̄", "é́̂̃", "é̂̃ ̄", "ẛ̣", "̈́", "ཱི", "יִ", "Ω", "K", "ẞ", "ﬁ", "ａ", "Ａｌｉｃｅ",
  rep("a", 279), rep("a", 280), rep("a", 281), rep(" ", 281) + "a", `a${rep(" ", 280)}`, `${rep(" ", 10)}${rep("a", 280)}${rep(" ", 10)}`, `${rep(" ", 10)}${rep("a", 281)}${rep(" ", 10)}`, rep("😀", 139), rep("😀", 140), rep("😀", 141), `${rep("a", 279)}😀`, `${rep("a", 278)}😀`, rep("é", 280), rep("é", 281), rep("é", 140), rep("é", 141), rep("é", 280), rep("李", 280), rep("李", 281),
  rep("é", 100), rep("á̂̃", 70), rep("á̂̃", 71), rep("ẛ", 281), rep("ﬁ", 280), `${rep("a", 280)}́`, `${rep("e", 279)}́`,
  // ZWJ: only inside emoji sequences
  "hi " + cp(0x1f468, 0x200d, 0x1f469, 0x200d, 0x1f467), "hi " + cp(0x2764, 0xfe0f, 0x200d, 0x1f525), "hi " + cp(0x1f469, 0x1f3fd, 0x200d, 0x1f4bb), "hi " + cp(0x1f3f3, 0xfe0f, 0x200d, 0x1f308),
  "a‍b", cp(0x1f44d, 0x200d), "x " + cp(0x200d, 0x1f44d), "a" + cp(0x200d, 0x1f44d), "‍", "‍‍", cp(0x1f44d, 0x200d, 0x200d, 0x1f44d), cp(0x1f44d, 0x200d, 0x1f44d, 0x200d), cp(0x1f44d, 0x200d, 0x1f44d, 0x200d, 0x1f44d), cp(0x1f44d, 0x200d, 0x1f44d, 0x200d, 0x200d), cp(0x1f44d, 0x200d, 0x61), cp(0x61, 0x200d, 0x1f44d),
  cp(0x1f468, 0x1f3fb, 0x200d, 0x1f469, 0x1f3fc), cp(0x1f469, 0x1f3ff, 0x200d, 0x2695, 0xfe0f), cp(0x1f469, 0x1f3ff, 0x200d, 0x2695), cp(0x1f9d1, 0x1f3fb, 0x200d, 0x1f91d, 0x200d, 0x1f9d1, 0x1f3ff), cp(0x1f3fb, 0x200d, 0x1f44d), cp(0x1f44d, 0x1f3fb, 0x1f3fc, 0x200d, 0x1f44d), cp(0x1f44d, 0x0301, 0x0302, 0x200d, 0x1f44d), cp(0x1f44d, 0x0301, 0x200d, 0x1f44d), cp(0x1f44d, 0x20e3, 0x200d, 0x1f44d), cp(0x1f44d, 0xfe0f, 0xfe0f, 0x200d, 0x1f44d), cp(0x1f44d, 0x200c, 0x1f44d), cp(0x1f44d, 0x200d, 0xfe0f, 0x1f44d), cp(0x1f44d, 0x200d, 0x1f3fb), cp(0x1f44d, 0x200d, 0x2764), cp(0x2764, 0x200d, 0x2764), cp(0x00a9, 0x200d, 0x00ae), cp(0x00a9, 0x200d, 0x1f44d), cp(0x203c, 0x200d, 0x1f44d), cp(0x2328, 0x200d, 0x1f4bb), cp(0x23, 0x200d, 0x1f44d), cp(0x31, 0x200d, 0x1f44d), cp(0x1f1fa, 0x1f1f8, 0x200d, 0x1f44d), cp(0x1f600, 0x200d, 0x1f600, 0x200d, 0x1f600, 0x200d, 0x1f600),
  cp(0x1fae9, 0x200d, 0x1fae9), cp(0x1fac6, 0x200d, 0x1fac6), cp(0x1f6dc, 0x200d, 0x1f6dc), cp(0x1fa89, 0x200d, 0x1fa89), cp(0x1fa8f), cp(0x1f8b0), cp(0x1fbca), cp(0x1fadc), cp(0x1fac8, 0x200d, 0x1fac8), cp(0x1f7f0),
  // controls and format characters
  ...["\u0000", "\u0007", "\u007F", "\u0080", "\u009F", "­", "​", "‌", "‎", "‏", "‪", "‮", "⁠", "⁦", "⁧", "⁩", "؜", "﻿", "￹", "￻", cp(0xe0001), cp(0xe0061), cp(0xe007f), cp(0x110bd), cp(0x1d173), "؀", "۝", "܏", "࣢", "", "�", "￿", cp(0xf0000), cp(0x10ffff), " ", " ", " ", " ", " "].flatMap((c) => [`a${c}b`, `${c}a`, `a${c}`]),
  // visible: needs a letter, number, punctuation or symbol
  " ́", "a", "́a", " ́", "⃣", "️1", "⠀⠀", " .", ". ", "ः", "ःः", "ั", "᪰", "̀ a", "̀ .", " .", "", "a", "　　",
  "©", "♥", "→", "€", "+", "<", "=", "^", "`", "~", "|", "$", "¢", "¬", "°", "¦", "µ", "ª", "º", "¼", "²", "Ⅷ", "①", "٣", "𝟘", cp(0x1d7ce), cp(0x1d400), cp(0x1f600), cp(0x1f3fb), cp(0x1f3fb, 0x1f3fb),
  "ꓡ", "ꓡꓡ", cp(0x1e6c0), cp(0x16ea0), cp(0x11db0), cp(0x10940), cp(0x1c89), "Ᲊ", cp(0xa7ce), cp(0xa7dc),
  ...NEW_CODE_POINTS.slice(0, 100),
  ...NEW_CODE_POINTS.slice(0, 100).map((c) => `a ${c} b`),
  "RTL: שלום עולם", "مرحبا بالعالم", "a‮b", "‏שלום", "שלום‎", "mixed שלום and english", "日本語のテキスト", "한국어 텍스트", "Привет, мир!", "Ελληνικά!", "हिन्दी", "ไทย", "emoji 🎉 time 🎊", "👨‍👩‍👧‍👦", cp(0x1f468, 0x200d, 0x1f469, 0x200d, 0x1f467, 0x200d, 0x1f466), "🏳️‍🌈", "🏴󠁧󠁢󠁥󠁮󠁧󠁿", "🇺🇸", "1️⃣", "#️⃣", "©️", "❤️", "👍🏽",
  "Hello,\nworld", "line1\r\nline2", "tab\there", "\u0009", "https://example.com/path?x=1", "a".repeat(5000), rep("​", 300), rep("a​", 300), rep("😀", 5000),
  ...WRONG_TYPES,
];
export const chatTextCases = (): Case[] => parsed(ChatTextSchema, CHAT_INPUTS);

const NOTE_INPUTS: unknown[] = [
  "  hi  ", "é", "line one\r\n\r\nline\ttwo", "a\nb", "a\r\nb", "a\rb", "a\tb", "a \n b", "\n\na", "a\n\n", "\n", "\t", "\r\n", " \n\t ", "a b", "a\u0085b", "a\u000Bb", "a\u000Cb", "a b",
  rep("a", 299), rep("a", 300), rep("a", 301), rep("a", 600), rep("a", 601), rep("a", 1200), rep("a\n", 299), rep("a\n", 300), rep("a\n", 301), rep("a\n", 600), rep("a\n", 1000), rep("\n", 600), rep("\n", 601), `a${rep("\n", 598)}b`, `a${rep("\n", 599)}b`, `a${rep("\n", 600)}b`,
  rep("a\r\n", 200), rep("a\r\n", 201), rep("a\t", 300), rep("a\t", 301), `${rep("a", 300)}\n`, `${rep("a", 301)}\n`, `${rep("a", 299)}\n\n`, `\n${rep("a", 300)}`, `\n\n${rep("a", 301)}`, `${rep("a", 298)}\n\nb`, `${rep("a", 299)}\n\nb`,
  rep("😀", 150), rep("😀", 151), rep("😀", 300), rep("😀", 301), `${rep("😀", 299)}\n`, `${rep("😀", 300)}\n`, rep("é", 300), rep("é", 301), rep("é", 300), rep("é", 150), rep("é", 301), `${rep("é", 100)}\n${rep("é", 100)}`,
  '"', "\\", "€", rep('"', 300), rep("\\", 300), rep("€", 300), rep("€", 301),
  "", "   ", "\n\t", "​", "ㅤ", "́́", "a\u0000b", "a‮b", "a﻿b", "a​b", "a\u0007b", `q${rep("́", 3)}`, `q${rep("́", 4)}`, "a‍b", cp(0x1f468, 0x200d, 0x1f469),
  "a\nb​", "x\ń́́́", "\ńa", "é\n̂", "á\n̂̃̄",
  ...NEW_CODE_POINTS.slice(0, 40),
  ...WRONG_TYPES,
];
export const reportNoteCases = (): Case[] => parsed(ReportNoteSchema, NOTE_INPUTS);

// ---- room primitives ----------------------------------------------------------------------------

const NUMS: unknown[] = [-1, 0, 1, 2, 3, 4, 5, 7, 8, 9, 24, 25, 26, 255, 256, 1000, 1e9, 1e21, -0, 1.5, 0.5, 3.0000001, "0", "1", "", null, true, false, [], [0], {}, { v: 0 }];
export const avatarCases = (): Case[] => parsed(AvatarSchema, NUMS);
export const seatIndexCases = (): Case[] => parsed(SeatIndexSchema, NUMS);
export const standingSlotCases = (): Case[] => parsed(StandingSlotSchema, NUMS);
const WORDS: unknown[] = ["everyone", "owner", "Owner", "EVERYONE", "", " owner", "owner ", "public", "private", "Public", "secret", "own", "everyone\n", null, 0, 1, true, [], {}];
export const controlPolicyCases = (): Case[] => parsed(ControlPolicySchema, WORDS);
export const roomVisibilityCases = (): Case[] => parsed(RoomVisibilitySchema, WORDS);

// ---- confusables --------------------------------------------------------------------------------

/** Every `step`th table entry as a bare source character, so each prototype shape is exercised. */
const tableSources = (step: number): string[] => {
  const entries = CONFUSABLES.split("\n").filter((e) => e !== "");
  return entries.filter((_, i) => i % step === 0).map((e) => String.fromCodePoint(e.codePointAt(0) ?? 0));
};

const KEY_WORDS = [
  "Alice", "alice", "ALICE", "Аӏісе", "АӀІСЕ", "A1ice", "Ａlice", "ＡＬＩＣＥ", "AIice", "Alicé", "Alicia", "coco", "сосо", "TOM", "ΤΟΜ", "Tom", "tom", "Bob", "B0b", "bob", "Rob", "Arnie", "Amie", "Arnie", "José", "jose", "Zoë", "zoë", "zoë", "Алиса", "李雷", "李", "Kai", "Kal", "KAI", "Ann", "Anna", "bob 2", "bob2", "Eve", "Eva", "Sam", "Pam", "Mia", "Nia", "m", "rn", "M", "I", "l", "1", "0", "O", "o", "i", "İ", "ı", "ǅ", "ǈ", "Σ", "ς", "σ", "ΑΣ", "ΑΣ ", "ΑΣΑ", "ΣΑ", "ß", "ẞ", "SS", "ss", "ﬁ", "fi", "ǆ", "Ǆ", "ǈ", "K", "K", "k", "Å", "Å", "Ω", "Ω", "ω", "ẞ",
  "Ａ", "ａ", "０", "１", "Ⅰ", "ⅰ", "①", "²", "²", "x²", cp(0x1d400), cp(0x1d41a), cp(0x1d7ce), cp(0x1d7cf), cp(0x1d504), cp(0x1d670), cp(0x1d4d0), cp(0x1d538), cp(0x1d5a0), cp(0x1d608), cp(0x1d63c), cp(0x1d6a8), cp(0x1d7d8), cp(0x1d7e2), cp(0x1d7ec), cp(0x1d7f6),
  "ᎪᎢᏴᎠ", "ᎪᎢᏴ", "Ꭺlice", "ցհ", "օ", "Ձ", "ԁ", "ԛ", "ѕ", "ј", "ӏ", "Ӏ", "І", "і", "Ι", "ι", "ί", "ΐ", "ά", "ί",
  "ㅤ", "ﾠ", "ᅟ", "ᅠ", "aㅤ", "﻿", "\u0085", "​", "a​b", "‍", "⁠", "­", "᠎", "⠀", "　", " ",
  "שלום", "مرحبا", "ﷺ", "ﷺ", "Ԁ", "ᗅ", "ꓮ", "ꓡ", "ⵔ", "〇", "ｌ", "ⅼ", "ǀ", "|", "│", "∣", "ⵏ", "ߊ", "ｏ", "ｏ", "𐐬", "𐓂", "𐊫", "𐊒", "𑣠", "𑢵", "𖼖",
  ...[0, 1, 2, 3, 4, 5].flatMap((n) => [marks("x", n), marks("e", n, "̈"), marks("1", n), marks("l", n, "̸"), marks("m", n, "̇"), marks("İ", n), marks("Å", n, "̊"), marks("ǅ", n)]),
  "é", "é", "ệ", "ệ", "á̂", "ấ", "́", "́̂", "̣", "⃣", "️", "︎", "ཱི", "̈́", "ẛ̣", "क़", "क़", "नि", "க", "가", "가", "힌",
  cp(0x1f468, 0x200d, 0x1f469, 0x200d, 0x1f467), cp(0x1f469, 0x1f3fd, 0x200d, 0x1f4bb), cp(0x2764, 0xfe0f, 0x200d, 0x1f525), cp(0x1f3f3, 0xfe0f, 0x200d, 0x1f308), cp(0x1f1fa, 0x1f1f8), cp(0x1f9d1, 0x1f3fb, 0x200d, 0x1f91d, 0x200d, 0x1f9d1, 0x1f3ff), "1️⃣", "#️⃣", "😎", "cool😎",
  "‮", "‮abc", "abc‮", "a‏b", "שלום Alice", "Alice שלום", "AΑАА", "Ａ１", "ＡＢＣ１２３", "ａｂｃ", "ｌｏｌ", "lol", "1o1", "I0I",
  rep("a", 1000), rep("A", 1000), rep("1", 1000), rep("m", 500), rep("Ａ", 500), rep("é", 1000), rep("é", 500), rep("😀", 500), rep("ꓡ", 300), rep("́", 1000), rep("á̂̃̄̅", 100), rep("ΑΣ ", 100), rep("İ", 300), rep(cp(0x1d400), 400),
  "", " ", "  ", "a b", "a  b", " a ", "-", "_", ".", "a-b", "a_b", "a.b", "a.b_c-d",
  ...NEW_CODE_POINTS.slice(0, 120),
];
const keyInputs = (): string[] => {
  const out = new Set<string>([...KEY_WORDS, ...ODD.filter((c): c is string => typeof c === "string")]);
  for (const s of tableSources(5)) out.add(s);
  for (const s of tableSources(37)) {
    out.add(`a${s}b`);
    out.add(`${s} ${s}`);
    out.add(`A${s}${s}Z`);
  }
  return [...out];
};
export const nicknameKeyCases = (): Case[] => keyInputs().map((input) => ({ input, ok: true, output: nicknameKey(input) }));
