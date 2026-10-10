import { describe, expect, test } from "bun:test";
import { WHEEL_SIZE, placeWheel } from "../src/emote/wheel-place";

// OME-732 (M8 W3): where the emote wheel opens, in viewport px. Over your own head with its tail tip on it (set l:
// wheel/disc 77 art px at 2×, the 9×7 tail hanging from 3 px above the rim), clamped inside the room's visible box. With
// no avatar of yours in view, or no room above your head for the wheel and its label chip, it docks centred above the
// composer without a tail.

const room = { x: 0, y: 0, w: 960, h: 600 };
const composer = { x: 100, y: 700, w: 400, h: 40 };

describe("placeWheel", () => {
  test("the wheel is 154 CSS px: 77 art px at 2×", () => {
    expect(WHEEL_SIZE).toBe(154);
  });

  test("over your head: the tail tip (the rim's middle, 162 px below the top) is on the head", () => {
    expect(placeWheel({ x: 500, y: 400 }, room, composer)).toEqual({ x: 423, y: 238, tail: true });
  });

  test("whole px, so the pixel art never sits between pixels", () => {
    expect(placeWheel({ x: 500.4, y: 400.6 }, room, composer)).toEqual({ x: 423, y: 239, tail: true });
  });

  test("no avatar of yours: docked centred above the composer, no tail", () => {
    expect(placeWheel(null, room, composer)).toEqual({ x: 223, y: 538, tail: false });
  });

  test("your avatar panned out of the room's window: docked", () => {
    expect(placeWheel({ x: -40, y: 400 }, room, composer)).toEqual({ x: 223, y: 538, tail: false });
    expect(placeWheel({ x: 500, y: 640 }, room, composer)).toEqual({ x: 223, y: 538, tail: false });
  });

  test("too near the top for the wheel and its label chip (clamped vertically): docked", () => {
    expect(placeWheel({ x: 500, y: 180 }, room, composer)).toEqual({ x: 223, y: 538, tail: false });
    // 196 px of room above the head: the wheel (162 to the tip) and the chip (34) just fit.
    expect(placeWheel({ x: 500, y: 196 }, room, composer)).toEqual({ x: 423, y: 34, tail: true });
  });

  test("near a side: clamped inside the room, and the tail goes (it would point past you)", () => {
    expect(placeWheel({ x: 30, y: 400 }, room, composer)).toEqual({ x: 0, y: 238, tail: false });
    expect(placeWheel({ x: 940, y: 400 }, room, composer)).toEqual({ x: 806, y: 238, tail: false });
  });

  test("a room window narrower than the wheel: docked", () => {
    expect(placeWheel({ x: 50, y: 400 }, { x: 0, y: 0, w: 100, h: 600 }, composer)).toEqual({ x: 223, y: 538, tail: false });
  });

  test("a composer at the top of the window: the dock never pushes the chip off-screen", () => {
    expect(placeWheel(null, room, { x: 100, y: 20, w: 400, h: 40 })).toEqual({ x: 223, y: 34, tail: false });
  });
});
