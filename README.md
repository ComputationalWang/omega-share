# omega-share

A Habbo-inspired social watch room. The **omega-share web extension** finds a video embed on the page you're on and shares it into a room on the **website**. There, avatars sit together and watch it in sync: when anyone plays, pauses or skips, it happens for everyone, and each person sets their own volume.

> Status (2026-10-14): milestones M1a–M10 are signed off by the board and the site is live at **https://omega-share.duckdns.org**. M11 (omega-share as a Discord Activity) is in progress. The extension runs on Chromium and Firefox; store listings are not public yet. Built by an AI company run on [Paperclip](https://github.com/paperclipai/paperclip), defined in [`company/`](company/).

## Layout
| Path | What |
|---|---|
| `apps/extension` | WXT + TypeScript MV3 extension (Chromium and Firefox) |
| `apps/web` | Vite + PixiJS isometric room |
| `apps/server` | Bun + Hono + WebSockets; rooms, queues and sessions persist in SQLite |
| `packages/shared` | Valibot schemas: the wire contract |
| `assets/` | Original art (CC BY-SA 4.0) |
| `company/` | Paperclip company package (agents, skills, seed tasks) |
| `deploy/` | Hosting kit for the production box ([runbook](docs/ops/hosting.md)) |
| `docs/` | Product spec, performance budgets, ADRs, QA sign-off reports (`docs/qa/`) |

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

## Hosting
Production runs one `apps/server` behind Caddy on a single box; deploys, backups and room operations are in [`docs/ops/`](docs/ops/) ([hosting](docs/ops/hosting.md), [backup](docs/ops/backup.md), [rooms](docs/ops/rooms.md)).

## Roadmap
Done: M1a extension → localhost room · M1b YouTube sync · M2 ngrok + Twitch/Vimeo · M3 safety · M4 hosting + SQLite · M5 polish · M6 public beta (moderation, queue, load test) · M7–M9 release readiness (a11y, Firefox, motion tiers, legal pages) · M10 phones, room presets, durable sessions.
Now: M11, run inside Discord as an Activity ([ADR 0046](docs/adr/0046-discord-activity-admission.md)). Sign-off evidence per milestone: [`docs/qa/`](docs/qa/). Spec: [`docs/product-spec.md`](docs/product-spec.md).

## License
Code: [AGPL-3.0-only](LICENSE). Art in `assets/`: [CC BY-SA 4.0](assets/LICENSE). Not affiliated with Sulake or Habbo.
