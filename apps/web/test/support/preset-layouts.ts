import * as v from "valibot";
import { RoomLayoutSchema, type RoomLayout } from "@omega/shared";
import cafeJson from "../../../../assets/presets/cafe.json";
import cinemaJson from "../../../../assets/presets/cinema.json";
import classicJson from "../../../../assets/presets/classic.json";
import emptyJson from "../../../../assets/presets/empty.json";
import livingJson from "../../../../assets/presets/living.json";
import loungeJson from "../../../../assets/presets/lounge.json";

// The design's preset layouts (assets/presets), parsed into the contract's type: known-good fixtures for the tests.
const parse = (json: unknown): RoomLayout => v.parse(RoomLayoutSchema, json);

export const cafe = parse(cafeJson);
export const cinema = parse(cinemaJson);
export const classic = parse(classicJson);
export const empty = parse(emptyJson);
export const living = parse(livingJson);
export const lounge = parse(loungeJson);
