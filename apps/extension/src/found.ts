import * as v from "valibot";
import { listEmbeds } from "./embeds";
import { collectCandidateUrls } from "./scan";

// OME-1042: the opt-in "video found" toolbar indicator. Off by default; on means the optional https://*/* grant.

export const FOUND_SCRIPT_ID = "omega-found";
/** The optional host permission the toggle asks for, and where the content script runs. */
export const FOUND_ORIGINS = ["https://*/*"] as const;
/** DOM changes trigger a recheck at most this often. */
export const RECHECK_MS = 1000;

const FoundMessageSchema = v.strictObject({ kind: v.literal("omega-found"), count: v.pipe(v.number(), v.safeInteger(), v.minValue(0)) });
export type FoundMessage = v.InferOutput<typeof FoundMessageSchema>;

/** One check of the page: how many shareable embeds it has. Only the count leaves the page, never a URL. */
export function checkPage(doc: Document, ownHosts: readonly string[]): FoundMessage {
  return { kind: "omega-found", count: listEmbeds(collectCandidateUrls(doc), ownHosts).length };
}

/** The count from a content-script message, or null for anything else. */
export function parseFoundMessage(raw: unknown): number | null {
  const parsed = v.safeParse(FoundMessageSchema, raw);
  return parsed.success ? parsed.output.count : null;
}

const FOUND_ICONS = { 16: "icon/found-16.png", 32: "icon/found-32.png", 48: "icon/found-48.png", 64: "icon/found-64.png" };
const IDLE_ICONS = { 16: "icon/16.png", 32: "icon/32.png", 48: "icon/48.png", 64: "icon/idle-64.png" };

/** The tab's toolbar icon and title: the lit tally lamp (assets/README.md, OME-1041) when it has a video. */
export function actionState(count: number): { path: Record<number, string>; title: string } {
  return count > 0 ? { path: FOUND_ICONS, title: "omega share: video found" } : { path: IDLE_ICONS, title: "omega share" };
}

/** `fn` at once, then at most once per `ms`: a burst of triggers inside the window gets one trailing run. */
export function throttle(fn: () => void, ms: number, clock: { now(): number; setTimeout(fn: () => void, ms: number): unknown }): () => void {
  let last = -Infinity;
  let pending = false;
  const run = (): void => {
    pending = false;
    last = clock.now();
    fn();
  };
  return () => {
    if (pending) return;
    const wait = last + ms - clock.now();
    if (wait <= 0) {
      run();
      return;
    }
    pending = true;
    clock.setTimeout(run, wait);
  };
}

export interface FoundScript {
  id: string;
  js: string[];
  matches: string[];
  excludeMatches: string[];
  runAt: "document_idle";
  persistAcrossSessions: boolean;
}

export interface FoundDeps {
  granted(): Promise<boolean>;
  register(script: FoundScript): Promise<void>;
  unregister(id: string): Promise<void>;
  /** Puts every tab's icon and title back to idle. */
  resetIcons(): Promise<void>;
}

/** Registers the content script when the found grant is held, else unregisters it and clears the indicators. `ours`: our server's patterns. */
export async function syncFound(deps: FoundDeps, ours: readonly string[]): Promise<void> {
  await deps.unregister(FOUND_SCRIPT_ID).catch(() => undefined);
  if (!(await deps.granted())) return deps.resetIcons();
  await deps.register({
    id: FOUND_SCRIPT_ID,
    js: ["content-scripts/found.js"],
    matches: [...FOUND_ORIGINS],
    // Our own room page is full of embeds, none of them worth sharing back.
    excludeMatches: [...ours],
    runAt: "document_idle",
    persistAcrossSessions: false,
  });
}
