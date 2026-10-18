import * as v from "valibot";
export const AccessoryManifestSchema = v.object({ frames: v.record(v.string(), v.unknown()), meta: v.object({ omega: v.object({ accessories: v.record(v.string(), v.object({ prefix: v.string() })) }) }) });
