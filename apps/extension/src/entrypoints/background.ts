import { defineBackground } from "wxt/utils/define-background";

// Event-driven MV3 service worker with no listeners: the popup does all the work.
// It exists so the extension has a stable worker (Playwright uses it to find tab ids).
export default defineBackground(() => undefined);
