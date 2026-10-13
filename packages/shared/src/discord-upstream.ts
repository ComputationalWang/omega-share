import * as v from "valibot";
import { DiscordAccessTokenSchema, DiscordInstanceIdSchema } from "./activity";

/**
 * Discord API responses the server reads (ADR 0046). Server-only: a subpath export, so the web
 * bundle never pulls it in. Unknown fields are stripped, so the refresh token, email and
 * location never get past the boundary.
 */

/** Discord user and application ids. */
export const DiscordSnowflakeSchema = v.pipe(v.string(), v.regex(/^[1-9][0-9]{16,19}$/));
export type DiscordSnowflake = v.InferOutput<typeof DiscordSnowflakeSchema>;

/** Longer than any real Discord grant (7 days); bounds the arithmetic, not our session. */
const TOKEN_EXPIRES_MAX_S = 30 * 24 * 3600;
export const MAX_INSTANCE_USERS = 1000;

/** `POST /api/v10/oauth2/token`. Must grant `identify`. */
export const DiscordTokenResponseSchema = v.object({
  access_token: DiscordAccessTokenSchema,
  token_type: v.literal("Bearer"),
  expires_in: v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(TOKEN_EXPIRES_MAX_S)),
  scope: v.pipe(
    v.string(),
    v.maxLength(256),
    v.check((s) => s.split(" ").includes("identify"), "identify scope missing"),
  ),
});
export type DiscordTokenResponse = v.InferOutput<typeof DiscordTokenResponseSchema>;

const name = v.pipe(v.string(), v.minLength(1), v.maxLength(64));

/** `GET /api/v10/users/@me`. Names are untrusted display text, never identity. */
export const DiscordUserSchema = v.object({
  id: DiscordSnowflakeSchema,
  username: name,
  global_name: v.optional(v.nullable(name)),
});
export type DiscordUser = v.InferOutput<typeof DiscordUserSchema>;

/** `GET /applications/<app>/activity-instances/<instance>` with the bot token. */
export const DiscordActivityInstanceSchema = v.object({
  application_id: DiscordSnowflakeSchema,
  instance_id: DiscordInstanceIdSchema,
  users: v.pipe(v.array(DiscordSnowflakeSchema), v.maxLength(MAX_INSTANCE_USERS)),
});
export type DiscordActivityInstance = v.InferOutput<typeof DiscordActivityInstanceSchema>;

/** The returned instance is the one asked for, of our app, and lists the verified user. */
export function instanceAdmits(
  instance: DiscordActivityInstance,
  expected: { applicationId: string; instanceId: string; userId: string },
): boolean {
  return (
    instance.application_id === expected.applicationId &&
    instance.instance_id === expected.instanceId &&
    instance.users.includes(expected.userId)
  );
}
