import { describe, expect, test } from "bun:test";
import { roomPageTitle } from "../src/page-title";

// The room tab's title (OME-1238): the pop-out room window's format, with the unread count in front.
describe("roomPageTitle", () => {
  test("the room's title, or Room when it has none", () => {
    expect(roomPageTitle("Movie night", 0)).toBe("Movie night · omega-share");
    expect(roomPageTitle(null, 0)).toBe("Room · omega-share");
  });
  test("unread chat leads in brackets", () => {
    expect(roomPageTitle("Movie night", 3)).toBe("(3) Movie night · omega-share");
    expect(roomPageTitle(null, 1)).toBe("(1) Room · omega-share");
  });
});
