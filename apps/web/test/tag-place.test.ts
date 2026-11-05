import { afterAll, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { placeAt } from "../src/tag-place";

// A real DOM for this file only; the other web tests stay DOM-free.
beforeAll(() => {
  GlobalRegistrator.register();
});
afterAll(async () => {
  await GlobalRegistrator.unregister();
});

// OME-2219: a render re-places every name tag, mostly where it already is; each inline style write makes garbage that
// fed major GCs into the Pixel 7 /conga frames. A write that changes nothing is skipped (a value written behind the
// helper's back stays, which is how these tests see a skip).

test("the first placement writes the anchor", () => {
  const e = document.createElement("span");
  placeAt(e, 10, 20);
  expect(e.style.translate).toBe("10px 20px");
});

test("the same placement again writes nothing", () => {
  const e = document.createElement("span");
  placeAt(e, 10, 20);
  e.style.translate = "1px 1px";
  placeAt(e, 10, 20);
  expect(e.style.translate).toBe("1px 1px");
});

test("a moved anchor is written", () => {
  const e = document.createElement("span");
  placeAt(e, 10, 20);
  placeAt(e, 11, 20);
  expect(e.style.translate).toBe("11px 20px");
  placeAt(e, 11, 21);
  expect(e.style.translate).toBe("11px 21px");
});

test("each element keeps its own record", () => {
  const a = document.createElement("span");
  const b = document.createElement("span");
  placeAt(a, 10, 20);
  placeAt(b, 10, 20);
  expect(b.style.translate).toBe("10px 20px");
});
