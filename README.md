# omega-share

A Habbo-inspired social watch room. The **omega-share web extension** finds a video embed on the page you're on and shares it into a room on the **website**. There, avatars sit together and watch it in sync: when anyone plays, pauses or skips, it happens for everyone, and each person sets their own volume.

> Status: pre-MVP. Built by an AI company run on [Paperclip](https://github.com/paperclipai/paperclip), defined in [`company/`](company/).

## Layout
| Path | What |
|---|---|
| `apps/extension` | WXT + TypeScript MV3 extension (Chromium first) |
| `apps/web` | Vite + PixiJS isometric room |
| `apps/server` | Bun + Hono + WebSockets, rooms held in memory |
| `packages/shared` | Valibot schemas: the wire contract |
| `assets/` | Original art (CC BY-SA 4.0) |
| `company/` | Paperclip company package (agents, skills, seed tasks) |
| `docs/` | Product spec, performance budgets, ADRs |

## Develop
```sh
bun install
bun run check   # typecheck + lint + unit tests
bun run e2e     # Playwright + Chromium
```
In development `apps/server` binds `127.0.0.1` and checks the `Host` header ([ADR 0015](docs/adr/0015-public-tunnel-and-share-token.md) items 3 and 4), so opening it from another machine or a phone on your LAN is refused or gets `421`. That is intended: to share a session beyond this machine, use the tunnel below.

## Host a public session (tunnel)
One `apps/server` process serves the built site, the API and the WebSocket on one origin, bound to `127.0.0.1`. The operator's own ngrok puts it on the internet ([ADR 0015](docs/adr/0015-public-tunnel-and-share-token.md)):
```sh
NGROK_AUTHTOKEN=… scripts/tunnel.sh https://<your-dev-domain>.ngrok-free.app   # token from Paperclip or your own ngrok config
```
ngrok is not a dependency of this repo, and its token never goes in it. Stop the script when the session ends. Details, the `cloudflared` fallback and the server's config variables: [`docs/ops/tunnel.md`](docs/ops/tunnel.md).

## Roadmap
M1a extension → localhost room · M1b YouTube sync · M2 ngrok + Twitch/Vimeo · M3 safety · M4 hosting · M5 polish. See [`docs/product-spec.md`](docs/product-spec.md).

## License
Code: [AGPL-3.0-only](LICENSE). Art in `assets/`: [CC BY-SA 4.0](assets/LICENSE). Not affiliated with Sulake or Habbo.
