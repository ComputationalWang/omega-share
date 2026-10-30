/**
 * Site ↔ extension bridge and the unlock rule shape (ADR 0047 §2, §3, §5). A subpath
 * export (`@omega/shared/extension-bridge`) so the main entry doesn't grow.
 */
import * as v from "valibot";
import { PLAYBACK_RATE_MAX, PLAYBACK_RATE_MIN } from "./constants";
import { canonicalizeGenericEmbed, normalizeHostname } from "./generic-embed";
import { PositionSchema } from "./playback";

/** Fixed tag on every bridge message, so other `postMessage` traffic on the page is ignored. */
export const BRIDGE_SOURCE = "omega-share";

/** True when `host` is already canonical and passes the ADR 0024 §1 generic host rules. */
function isGenericHost(host: string, ownHosts: readonly string[] = []): boolean {
  return canonicalizeGenericEmbed(`https://${host}/`, { ownHosts })?.host === host;
}

/** A canonical generic-embed hostname (ADR 0024 §1): no IP literal, private name or synced provider. */
export const GenericHostSchema = v.pipe(v.string(), v.maxLength(253), v.check((h) => isGenericHost(h), "not a generic embed host"));

const source = v.literal(BRIDGE_SOURCE);

export const UnlockMessageSchema = v.strictObject({ source, kind: v.literal("unlock"), host: GenericHostSchema });
export const RelockMessageSchema = v.strictObject({ source, kind: v.literal("relock") });

/** A rate the room can share, PLAYBACK_RATE_MIN–PLAYBACK_RATE_MAX. */
const RateSchema = v.pipe(v.number(), v.finite(), v.minValue(PLAYBACK_RATE_MIN), v.maxValue(PLAYBACK_RATE_MAX));

/** Page → extension (ADR 0057 §3): inject the frame script into `host`'s frame in this tab, after `unlock-result: unlocked` and the iframe's `load`. */
export const AttachMessageSchema = v.strictObject({ source, kind: v.literal("attach"), host: GenericHostSchema });

const command = <const E extends v.ObjectEntries>(op: string, entries: E) =>
  v.strictObject({ source, kind: v.literal("frame-command"), host: GenericHostSchema, op: v.literal(op), ...entries });
/** Page → extension → the attached frame (ADR 0057 §3). `seek` in seconds, `volume` 0–100 like `PlayerAdapter.setVolume`. */
export const FrameCommandMessageSchema = v.variant("op", [
  command("play", {}),
  command("pause", {}),
  command("unmute", {}),
  command("seek", { value: PositionSchema }),
  command("rate", { value: RateSchema }),
  command("volume", { value: v.pipe(v.number(), v.finite(), v.minValue(0), v.maxValue(100)) }),
]);
export type FrameCommand = v.InferOutput<typeof FrameCommandMessageSchema>;

/** Page → extension. */
export const PageToExtensionSchema = v.variant("kind", [UnlockMessageSchema, RelockMessageSchema, AttachMessageSchema, FrameCommandMessageSchema]);
export type PageToExtension = v.InferOutput<typeof PageToExtensionSchema>;

export const UNLOCK_OUTCOMES = ["unlocked", "denied", "unsupported"] as const;
export type UnlockOutcome = (typeof UNLOCK_OUTCOMES)[number];

export const PresentMessageSchema = v.strictObject({
  source,
  kind: v.literal("present"),
  /** The extension's manifest version: one to four dot-separated integers. */
  version: v.pipe(v.string(), v.regex(/^\d{1,9}(?:\.\d{1,9}){0,3}$/)),
});
export const UnlockResultMessageSchema = v.strictObject({
  source,
  kind: v.literal("unlock-result"),
  host: GenericHostSchema,
  outcome: v.picklist(UNLOCK_OUTCOMES),
});

export const FRAME_STATES = ["playing", "paused", "buffering", "ended"] as const;
export type FrameState = (typeof FRAME_STATES)[number];

/**
 * Frame → extension → page (ADR 0057 §3): the attached `<video>`'s media state, on every media event and once a
 * second while playing. Untrusted: the host page can fake it (§5). The same shape crosses `runtime.sendMessage`,
 * which can't carry NaN or Infinity, hence `duration: null` and `live`.
 */
export const FrameStateMessageSchema = v.strictObject({
  source,
  kind: v.literal("frame-state"),
  host: GenericHostSchema,
  state: v.picklist(FRAME_STATES),
  position: PositionSchema,
  rate: RateSchema,
  /** Seconds; null while unknown (NaN before metadata) or live. */
  duration: v.nullable(v.pipe(v.number(), v.finite(), v.minValue(0))),
  /** `duration === Infinity`: treated like Twitch live on the client (play/pause only). */
  live: v.boolean(),
  muted: v.boolean(),
});
/** Frame → page: a play/pause/seek the user made inside the frame, sent only under `navigator.userActivation.isActive` (§5). */
export const FrameIntentMessageSchema = v.strictObject({
  source,
  kind: v.literal("frame-intent"),
  host: GenericHostSchema,
  playing: v.boolean(),
  position: PositionSchema,
});
/** The attached frame went away (navigation, video gone, detach). */
export const FrameLostMessageSchema = v.strictObject({ source, kind: v.literal("frame-lost"), host: GenericHostSchema });

/** Extension → page. */
export const ExtensionToPageSchema = v.variant("kind", [
  PresentMessageSchema,
  UnlockResultMessageSchema,
  FrameStateMessageSchema,
  FrameIntentMessageSchema,
  FrameLostMessageSchema,
]);
export type ExtensionToPage = v.InferOutput<typeof ExtensionToPageSchema>;

/**
 * DNR session rule, the subset we build. Plain string literals, so it is assignable to the
 * browser's `declarativeNetRequest.Rule` without shared depending on extension types.
 */
export interface UnlockRule {
  id: number;
  priority: 1;
  condition: {
    resourceTypes: ["sub_frame"];
    initiatorDomains: [string];
    requestDomains: [string];
    tabIds: [number];
    responseHeaders?: [{ header: "content-security-policy"; values: ["*frame-ancestors*"] }];
  };
  action:
    | { type: "modifyHeaders"; responseHeaders: [{ header: "x-frame-options" | "content-security-policy"; operation: "remove" }] }
    | { type: "modifyHeaders"; requestHeaders: [{ header: "referer"; operation: "set"; value: string }] };
}

/** Ids a tab's rule set occupies: `ruleIdBase` up to `ruleIdBase + UNLOCK_RULE_COUNT - 1`, whatever the flags. */
export const UNLOCK_RULE_COUNT = 3;

export interface UnlockRulesInput {
  readonly tabId: number;
  /** Our server's hostname, the frame's initiator. */
  readonly ownHost: string;
  readonly host: string;
  /** DNR rule ids must be positive integers. */
  readonly ruleIdBase: number;
  /** Chromium only: Firefox has no `responseHeaders` rule condition (§2). */
  readonly csp: boolean;
  /** §3, pending board sign-off. */
  readonly referer: boolean;
}

/**
 * The session rules that unlock `host` in one tab (ADR 0047 §2/§3), or null when an input
 * is invalid: `host` not a generic host or under `ownHost`, a bad `ownHost`, `tabId` not a
 * tab, or `ruleIdBase` not a positive integer. Ids are fixed per rule, so removing
 * `UNLOCK_RULE_COUNT` ids from `ruleIdBase` always clears the set.
 */
export function unlockRules(input: UnlockRulesInput): UnlockRule[] | null {
  const own = normalizeHostname(input.ownHost);
  const { tabId, host, ruleIdBase } = input;
  if (own === null || !isGenericHost(host, [own])) return null;
  if (!Number.isSafeInteger(tabId) || tabId < 0 || !Number.isSafeInteger(ruleIdBase) || ruleIdBase < 1) return null;
  const condition = {
    resourceTypes: ["sub_frame"],
    initiatorDomains: [own],
    requestDomains: [host],
    tabIds: [tabId],
  } satisfies UnlockRule["condition"];
  const rules: UnlockRule[] = [
    {
      id: ruleIdBase,
      priority: 1,
      condition,
      action: { type: "modifyHeaders", responseHeaders: [{ header: "x-frame-options", operation: "remove" }] },
    },
  ];
  if (input.csp) {
    rules.push({
      id: ruleIdBase + 1,
      priority: 1,
      // DNR can only drop the whole CSP, so only where it carries frame-ancestors.
      condition: { ...condition, responseHeaders: [{ header: "content-security-policy", values: ["*frame-ancestors*"] }] },
      action: { type: "modifyHeaders", responseHeaders: [{ header: "content-security-policy", operation: "remove" }] },
    });
  }
  if (input.referer) {
    rules.push({
      id: ruleIdBase + 2,
      priority: 1,
      condition,
      action: { type: "modifyHeaders", requestHeaders: [{ header: "referer", operation: "set", value: `https://${host}/` }] },
    });
  }
  return rules;
}
