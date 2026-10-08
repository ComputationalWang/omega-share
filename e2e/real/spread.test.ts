import { describe, expect, test } from "bun:test";
import { heldMaxAbsMs, needsConfirmSample } from "./spread";

describe("heldMaxAbsMs (OME-377)", () => {
  test("a one-sample spike during a corrective seek does not count", () => {
    // M2-vimeo rerun on main@c88a568: the two clients' sync loops hard-seek one ~250 ms apart after a resume.
    expect(heldMaxAbsMs([-23, -18, -3, -2, -2, -3, -2, -3, -3, 1463, -20])).toBe(20);
    expect(heldMaxAbsMs([1389, -874, -215, -214, -180])).toBe(874);
  });

  test("an offset held for two samples in a row counts, either sign", () => {
    expect(heldMaxAbsMs([212, 213, -21, 241, 486, 524, 524, 525, -294])).toBe(524);
    expect(heldMaxAbsMs([5, -600, -700, 5])).toBe(600);
  });

  test("a steady drift fails like the plain max would", () => {
    expect(heldMaxAbsMs([600, 610, 620, 630])).toBe(620);
  });

  test("one sample alone is held by nothing, so it counts as is", () => {
    expect(heldMaxAbsMs([900])).toBe(900);
  });

  test("no samples is NaN, so a budget check fails", () => {
    expect(heldMaxAbsMs([])).toBeNaN();
  });
});

describe("needsConfirmSample (OME-377)", () => {
  test("a window that ends over the budget needs one more sample to tell a spike from a drift", () => {
    expect(needsConfirmSample([1, 2, 1463], 500)).toBe(true);
    expect(needsConfirmSample([1, 2, -501], 500)).toBe(true);
  });

  test("a window ending inside the budget, or empty, does not", () => {
    expect(needsConfirmSample([1463, 2], 500)).toBe(false);
    expect(needsConfirmSample([1, 2, 500], 500)).toBe(false);
    expect(needsConfirmSample([], 500)).toBe(false);
  });
});
