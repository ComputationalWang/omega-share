/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Base URL of apps/server, e.g. `https://omega.example`. Default: the page's own origin (built site), or this host on port 8787 (Vite dev). */
  readonly VITE_SERVER_URL?: string;
  /** "1" exposes the test handle `window.__omega` in a built site (the perf runner's build only). */
  readonly VITE_TEST_HANDLE?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
