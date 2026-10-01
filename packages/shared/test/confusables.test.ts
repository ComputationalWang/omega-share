import { describe, expect, test } from "bun:test";
import * as v from "valibot";
import { nicknameKey, skeleton } from "@omega/shared/confusables";
import { NicknameSchema } from "../src/index";

// M4 full confusables (OME-279, ADR 0022, threat model §10): the per-room nickname key
// is the UTS #39 skeleton, case-folded and accent-stripped. Pairs below are checked
// against confusables.txt 18.0.0, not against our own code.

const key = (s: string): string => nicknameKey(v.parse(NicknameSchema, s));

describe("skeleton (UTS #39)", () => {
  test("maps confusables to their prototype", () => {
    expect(skeleton("А")).toBe("A"); // CYRILLIC CAPITAL LETTER A
    expect(skeleton("1")).toBe("l"); // DIGIT ONE → LATIN SMALL LETTER L
    expect(skeleton("0")).toBe("O"); // DIGIT ZERO → LATIN CAPITAL LETTER O
    expect(skeleton("m")).toBe("rn"); // m → r n
  });

  test("leaves characters with no confusable alone", () => {
    expect(skeleton("Alice")).toBe("Alice");
    expect(skeleton("李雷")).toBe("李雷");
  });
});

describe("nicknameKey (UTS #39 skeleton)", () => {
  test("Latin and Cyrillic lookalikes collide", () => {
    // А ӏ і с е: Cyrillic A, palochka, Byelorussian-Ukrainian i, es, ie.
    expect(key("Alice")).toBe(key("Аӏісе"));
    // с о с о (Cyrillic) vs coco (Latin).
    expect(key("coco")).toBe(key("сосо"));
  });

  test("Latin and Greek lookalikes collide", () => {
    expect(key("TOM")).toBe(key("ΤΟΜ"));
  });

  test("fullwidth forms collide", () => {
    expect(key("Alice")).toBe(key("Ａlice"));
    expect(key("Alice")).toBe(key("ＡＬＩＣＥ"));
  });

  test("digit and letter lookalikes collide", () => {
    expect(key("Alice")).toBe(key("A1ice"));
    expect(key("Bob")).toBe(key("B0b"));
    expect(key("Arnie")).toBe(key("Amie"));
  });

  test("still collides for case, width and accents (M3 behaviour)", () => {
    expect(key("Alice")).toBe(key("alice"));
    expect(key("Alice")).toBe(key("ALICE"));
    expect(key("Alice")).toBe(key("АӀІСЕ")); // all-caps Cyrillic: A, palochka, I, ES, IE
    expect(key("José")).toBe(key("jose"));
    expect(key("Zoë")).toBe(key("zoë"));
  });

  test("legitimate distinct names stay apart", () => {
    const distinct: [string, string][] = [
      ["Alice", "Alicia"],
      ["Bob", "Rob"],
      ["Ann", "Anna"],
      ["Eve", "Eva"],
      ["Sam", "Pam"],
      ["Mia", "Nia"],
      ["bob 2", "bob2"],
      ["Alice", "Алиса"], // Алиса: same name, different letters
      ["李雷", "李"],
      ["Kai", "Kal"],
      // Case is folded before the skeleton, so capital I (TR39: I → l) is an i here.
      ["Alice", "AIice"],
    ];
    for (const [a, b] of distinct) expect([a, key(a)]).not.toEqual([a, key(b)]);
  });

  test("is stable: the key of a key-shaped name is itself", () => {
    for (const name of ["Alice", "A1ice", "Аӏісе", "B0b", "Amie"]) {
      const k = key(name);
      expect(nicknameKey(v.parse(NicknameSchema, k))).toBe(k);
    }
  });
});

describe("server-only table", () => {
  // U+A4E1 LISU LETTER LA is a confusable source for "L"; it is in the table, so it marks
  // the table's presence in a bundle.
  const bundle = async (entry: string): Promise<string> => {
    const out = await Bun.build({ entrypoints: [entry], target: "browser", minify: true });
    expect(out.success).toBe(true);
    const [file] = out.outputs;
    if (file === undefined) throw new Error("no output");
    return file.text();
  };

  test("the main entry (what the web app imports) does not carry the table", async () => {
    expect(await bundle(`${import.meta.dir}/../src/index.ts`)).not.toContain("ꓡ");
  });

  test("the confusables entry does", async () => {
    expect(await bundle(`${import.meta.dir}/../src/confusables.ts`)).toContain("ꓡ");
  });
});
