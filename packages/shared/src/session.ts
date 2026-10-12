import * as v from "valibot";
import { AvatarSchema, NicknameSchema, RoomIdSchema } from "./room";

/** 32 server-generated random bytes encoded as unpadded base64url (ADR 0043). */
export const RESUME_TOKEN_LENGTH = 43;
export const RESUME_GRACE_MS = 120_000;
export const RESUME_STORAGE_KEY_PREFIX = "omega.resume.";

/** Shape only: the server checks room binding, authority and expiry. Never broadcast or logged. */
export const ResumeTokenSchema = v.pipe(v.string(), v.regex(/^[A-Za-z0-9_-]{43}$/));
export type ResumeToken = v.InferOutput<typeof ResumeTokenSchema>;

/** Per-room sessionStorage record; distinct from owner, invite and extension share records. */
export const ResumeRecordSchema = v.strictObject({
  roomId: RoomIdSchema,
  token: ResumeTokenSchema,
  nickname: NicknameSchema,
  avatar: AvatarSchema,
});
export type ResumeRecord = v.InferOutput<typeof ResumeRecordSchema>;
