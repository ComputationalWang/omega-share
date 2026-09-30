import { defineConfig, loadEnv, type Plugin } from "vite";
import { devConnectSrc, withConnectSrc } from "./csp";

/** Keeps the meta CSP's dev origins in step with VITE_SERVER_URL and the dev server port (see csp.ts). */
function cspDevOrigins(mode: string): Plugin {
  const serverUrl = process.env["VITE_SERVER_URL"] ?? loadEnv(mode, process.cwd(), "VITE_")["VITE_SERVER_URL"];
  return {
    name: "omega-csp-dev-origins",
    transformIndexHtml: {
      order: "pre",
      handler(html, ctx) {
        const webPort = ctx.server?.config.server.port;
        return withConnectSrc(html, devConnectSrc({ serverUrl, webPort }));
      },
    },
  };
}

export default defineConfig(({ mode }) => ({
  plugins: [cspDevOrigins(mode)],
  build: { target: "es2023", sourcemap: true, reportCompressedSize: true },
}));
