/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Base URL of apps/server, e.g. `https://omega.example`. Default: the page's own origin (built site), or this host on port 8787 (Vite dev). */
  readonly VITE_SERVER_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
