/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Base URL of apps/server, e.g. `https://omega.example`. Default: this host, port 8787. */
  readonly VITE_SERVER_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
