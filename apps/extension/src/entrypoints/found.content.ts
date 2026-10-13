import { browser } from "wxt/browser";
import { defineContentScript } from "wxt/utils/define-content-script";
import { RECHECK_MS, checkPage, throttle } from "../found";
import { SERVER_BASE_URL_KEY, ownHostsOf, readServerBaseUrl } from "../settings";

// OME-1042: the opt-in "video found" indicator. Registered at runtime by the background only while the viewer has
// granted https://*/* (no manifest entry). Counts the page's shareable embeds and sends just the count.
export default defineContentScript({
  registration: "runtime",
  noScriptStartedPostMessage: true,
  async main() {
    const ownHosts = ownHostsOf(readServerBaseUrl((await browser.storage.local.get(SERVER_BASE_URL_KEY))[SERVER_BASE_URL_KEY]));
    let sent = "";
    const check = (): void => {
      const start = performance.now();
      const message = checkPage(document, ownHosts);
      // e2e builds only: the perf spec reads each check's main-thread time (OME-1042 budget, ≤ 2 ms).
      if (import.meta.env.MODE === "e2e") {
        const el = document.documentElement;
        el.dataset["omegaFoundMs"] = `${el.dataset["omegaFoundMs"] ?? ""} ${String(performance.now() - start)}`.trim();
      }
      // Once per page and count: a single-page app's new URL resends what its own navigation reset.
      const key = `${location.href} ${String(message.count)}`;
      if (key === sent) return;
      sent = key;
      void browser.runtime.sendMessage(message).catch(() => undefined);
    };
    check();
    new MutationObserver(throttle(check, RECHECK_MS, { now: () => performance.now(), setTimeout: (fn, ms) => setTimeout(fn, ms) })).observe(document, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["src", "data"],
    });
  },
});
