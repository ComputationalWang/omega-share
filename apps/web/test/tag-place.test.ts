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

test("the first placement writes the anchor and the stack move", () => {
  const e = document.createElement("span");
  placeAt(e, 10, 20, -16, -30);
  expect(e.style.translate).toBe("10px 20px");
  expect(e.style.marginLeft).toBe("-16px");
  expect(e.style.marginTop).toBe("-30px");
});

test("the same placement again writes nothing", () => {
  const e = document.createElement("span");
  placeAt(e, 10, 20, -16, -30);
  e.style.translate = "1px 1px";
  e.style.marginLeft = "1px";
  e.style.marginTop = "1px";
  placeAt(e, 10, 20, -16, -30);
  expect([e.style.translate, e.style.marginLeft, e.style.marginTop]).toEqual(["1px 1px", "1px", "1px"]);
});

test("only what changed is written", () => {
  const e = document.createElement("span");
  placeAt(e, 10, 20, -16, -30);
  e.style.marginLeft = "1px";
  e.style.marginTop = "1px";
  placeAt(e, 11, 20, -16, -30);
  expect([e.style.translate, e.style.marginLeft, e.style.marginTop]).toEqual(["11px 20px", "1px", "1px"]);
  placeAt(e, 11, 20, 0, -30);
  expect([e.style.translate, e.style.marginLeft, e.style.marginTop]).toEqual(["11px 20px", "0px", "1px"]);
  placeAt(e, 11, 20, 0, 4);
  expect(e.style.marginTop).toBe("4px");
});

test("each element keeps its own record", () => {
  const a = document.createElement("span");
  const b = document.createElement("span");
  placeAt(a, 10, 20, 0, 0);
  placeAt(b, 10, 20, 0, 0);
  expect(b.style.translate).toBe("10px 20px");
});
