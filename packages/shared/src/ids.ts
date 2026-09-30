import * as v from "valibot";

/** Server-assigned, opaque. */
export const MemberIdSchema = v.pipe(v.string(), v.regex(/^[A-Za-z0-9_-]{1,64}$/));
export type MemberId = v.InferOutput<typeof MemberIdSchema>;
