// Stored/sent embed JSON as text: the array form serde's derive would also read, duplicate keys, and numbers
// JSON.stringify never writes (PORTING.md "Deliberate differences").
import * as v from "valibot";
import { AnyEmbedSchema } from "@omega/shared";
import { decidedRaw, type Corpus, type RawInput } from "./corpora";

const U = "https://www.youtube.com/embed/dQw4w9WgXcQ";
const T = "https://player.twitch.tv/?channel=some_streamer";
const V = "https://player.twitch.tv/?video=v40464143";
const M = "https://player.vimeo.com/video/76979871";
const G = "https://player.example.com/embed/42";

const OK = [
  `{"provider":"youtube","videoId":"dQw4w9WgXcQ","url":"${U}","n":1e2}`,
  `{"provider":"youtube","videoId":"dQw4w9WgXcQ","url":"${U}","n":-0}`,
  `{"provider":"youtube","videoId":"dQw4w9WgXcQ","url":"${U}","n":1.0}`,
  `{"provider":"youtube","videoId":"dQw4w9WgXcQ","url":"${U}"}`,
  `{"url":"${U}","videoId":"dQw4w9WgXcQ","provider":"youtube"}`,
  `{"provider":"twitch","kind":"live","channel":"some_streamer","url":"${T}"}`,
  `{"provider":"twitch","kind":"vod","videoId":"40464143","url":"${V}"}`,
  `{"provider":"vimeo","videoId":"76979871","hash":null,"url":"${M}"}`,
  `{"provider":"vimeo","videoId":"76979871","hash":"abc123","url":"${M}?h=abc123"}`,
  `{"provider":"generic","host":"player.example.com","url":"${G}"}`,
  `{"provider":"youtube","videoId":"dQw4w9WgXcQ","url":"https:\\/\\/www.youtube.com\\/embed\\/dQw4w9WgXcQ"}`,
  ` {"provider":"youtube","videoId":"dQw4w9WgXcQ","url":"${U}"} `,
];

// Arrays (fields in declaration order, in key order, with and without the tags) and other non-objects: TS refuses.
const REFUSED = [
  `["youtube","dQw4w9WgXcQ","${U}"]`,
  `["dQw4w9WgXcQ","${U}"]`,
  `["youtube","dQw4w9WgXcQ","${U}","extra"]`,
  `["twitch","live","some_streamer","${T}"]`,
  `["live","some_streamer","${T}"]`,
  `["twitch","vod","40464143","${V}"]`,
  `["vimeo","76979871",null,"${M}"]`,
  `["76979871",null,"${M}"]`,
  `["generic","player.example.com","${G}"]`,
  `["player.example.com","${G}"]`,
  "[]", "[{}]", "[[]]", "{}", "null", '"youtube"', "1", "true", "",
  `{"provider":"youtube","videoId":"dQw4w9WgXcQ","url":"${U}"} x`,
  `{"provider":"youtube","videoId":"dQw4w9WgXcQ","url":"${U}",}`,
  `{"provider":1,"videoId":"dQw4w9WgXcQ","url":"${U}"}`,
  `{"provider":"twitch","kind":0,"channel":"some_streamer","url":"${T}"}`,
];

// TS accepts, Rust deliberately refuses (duplicate keys). Numbers in ignored keys are accepted by both.
const RUST_REFUSES = [
  `{"provider":"youtube","videoId":"aaaaaaaaaaa","videoId":"dQw4w9WgXcQ","url":"${U}"}`,
  `{"provider":"vimeo","provider":"youtube","videoId":"dQw4w9WgXcQ","url":"${U}"}`,
  `{"provider":"generic","host":"x","host":"player.example.com","url":"${G}"}`,
];

const inputs: RawInput[] = [
  ...[...OK, ...REFUSED].map((text): RawInput => ({ text })),
  ...RUST_REFUSES.map((text): RawInput => ({ text, rustRefuses: true })),
];

export const rawEmbedCorpus: Corpus = {
  name: "any-embed-raw",
  cases: () =>
    decidedRaw(inputs, (parsed) => {
      const r = v.safeParse(AnyEmbedSchema, parsed);
      return r.success ? JSON.stringify(r.output) : null;
    }),
};
