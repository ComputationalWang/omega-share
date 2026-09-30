/**
 * The `omega-sdk` Trusted Types policy (threat model §4). The only script URLs the page ever assigns to a
 * `<script src>` are the three provider SDKs; anything else throws. The URL constants live here (the loaders
 * re-export them) so this module and the loaders do not import each other in a cycle.
 */
export const IFRAME_API_URL = "https://www.youtube.com/iframe_api";
export const TWITCH_SDK_URL = "https://player.twitch.tv/js/embed/v1.js";
export const VIMEO_SDK_URL = "https://player.vimeo.com/api/player.js";

export const SDK_SCRIPT_URLS: readonly string[] = [IFRAME_API_URL, TWITCH_SDK_URL, VIMEO_SDK_URL];

export const SDK_POLICY_NAME = "omega-sdk";

/** A TrustedScriptURL where Trusted Types exist (lib.dom has no types for it), else the plain validated string. */
export type SdkScriptUrl = (url: string) => unknown;

function checkUrl(url: string): string {
  if (!SDK_SCRIPT_URLS.includes(url)) throw new TypeError(`script URL not allowlisted: ${url}`);
  return url;
}

function isPolicyFactory(v: unknown): v is { createPolicy(name: string, rules: { createScriptURL(input: string): string }): unknown } {
  return typeof v === "object" && v !== null && typeof Reflect.get(v, "createPolicy") === "function";
}

/** Builds the URL guard: through a Trusted Types factory when there is one, else a plain-string allowlist check. */
export function createSdkPolicy(factory: unknown): SdkScriptUrl {
  if (!isPolicyFactory(factory)) return checkUrl;
  const policy: unknown = factory.createPolicy(SDK_POLICY_NAME, { createScriptURL: checkUrl });
  const create: unknown = typeof policy === "object" && policy !== null ? Reflect.get(policy, "createScriptURL") : undefined;
  if (typeof create !== "function") return checkUrl;
  return (url) => {
    const out: unknown = Reflect.apply(create, policy, [url]);
    return typeof out === "string" || (typeof out === "object" && out !== null) ? out : checkUrl(url);
  };
}

let page: SdkScriptUrl | null = null;

/** Validated (and, where supported, trusted) value to assign to a script's `src`. The policy is created once per page. */
export function sdkScriptUrl(url: string): unknown {
  page ??= createSdkPolicy(Reflect.get(globalThis, "trustedTypes"));
  return page(url);
}
