import { expect, test } from "bun:test";
import * as v from "valibot";
import {
  DiscordActivityInstanceSchema,
  DiscordTokenResponseSchema,
  DiscordUserSchema,
  instanceAdmits,
} from "../src/discord-upstream";

const app = "1288744420012345678";
const alice = "123456789012345678";
const bob = "876543210987654321";
const instanceId = "i-1288744420012345678-gc-123456789012345678-987654321098765432";

test("token exchange keeps only a bounded access token and drops the refresh token", () => {
  const raw = { access_token: "6qrZcUqja7812RVdnEKjpzOL4CvHBFG", token_type: "Bearer", expires_in: 604_800, refresh_token: "D43f5y0ahjqew82jZ4NViEr2YafMKhue", scope: "identify" };
  const parsed = v.parse(DiscordTokenResponseSchema, raw);
  expect(parsed).toEqual({ access_token: raw.access_token, token_type: "Bearer", expires_in: 604_800, scope: "identify" });
  expect("refresh_token" in parsed).toBe(false);
  for (const bad of [
    { ...raw, token_type: "Basic" },
    { ...raw, expires_in: 0 },
    { ...raw, expires_in: 1.5 },
    { ...raw, expires_in: 31 * 24 * 3600 },
    { ...raw, access_token: "" },
    { ...raw, access_token: "x".repeat(513) },
    { ...raw, scope: "guilds" },
    { ...raw, scope: "x".repeat(257) },
  ]) {
    expect(v.safeParse(DiscordTokenResponseSchema, bad).success).toBe(false);
  }
  expect(v.parse(DiscordTokenResponseSchema, { ...raw, scope: "rpc.activities.write identify" }).scope).toBe("rpc.activities.write identify");
});

test("current user is a snowflake id with untrusted bounded display text", () => {
  const raw = { id: alice, username: "alice", global_name: "Alice ✨", avatar: null, email: "a@example.com" };
  const parsed = v.parse(DiscordUserSchema, raw);
  expect(parsed).toEqual({ id: alice, username: "alice", global_name: "Alice ✨" });
  expect(v.parse(DiscordUserSchema, { id: alice, username: "alice" })).toEqual({ id: alice, username: "alice" });
  expect(v.parse(DiscordUserSchema, { id: alice, username: "alice", global_name: null })).toEqual({ id: alice, username: "alice", global_name: null });
  for (const bad of [{ ...raw, id: "0123" }, { ...raw, id: 123456789012345678 }, { ...raw, id: "1".repeat(21) }, { ...raw, username: "" }, { ...raw, username: "x".repeat(65) }, { ...raw, global_name: "x".repeat(65) }]) {
    expect(v.safeParse(DiscordUserSchema, bad).success).toBe(false);
  }
});

test("instance lookup is bounded and admits only the same app, instance and listed user", () => {
  const raw = { application_id: app, instance_id: instanceId, launch_id: "1288744420099999999", location: { id: "gc-1", kind: "gc", channel_id: "1", guild_id: "2" }, users: [alice] };
  const instance = v.parse(DiscordActivityInstanceSchema, raw);
  expect(instance).toEqual({ application_id: app, instance_id: instanceId, users: [alice] });
  expect(instanceAdmits(instance, { applicationId: app, instanceId, userId: alice })).toBe(true);
  expect(instanceAdmits(instance, { applicationId: app, instanceId, userId: bob })).toBe(false);
  expect(instanceAdmits(instance, { applicationId: "1288744420012345679", instanceId, userId: alice })).toBe(false);
  expect(instanceAdmits(instance, { applicationId: app, instanceId: instanceId + "0", userId: alice })).toBe(false);
  for (const bad of [
    { ...raw, users: Array.from({ length: 1001 }, () => alice) },
    { ...raw, users: ["nope"] },
    { ...raw, instance_id: "x".repeat(129) },
    { ...raw, application_id: "app" },
    { ...raw, users: undefined },
  ]) {
    expect(v.safeParse(DiscordActivityInstanceSchema, bad).success).toBe(false);
  }
});
