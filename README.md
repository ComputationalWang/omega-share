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

## Roadmap
M1a extension → localhost room · M1b YouTube sync · M2 ngrok + Twitch/Vimeo · M3 safety · M4 hosting · M5 polish. See [`docs/product-spec.md`](docs/product-spec.md).

## License
Code: [AGPL-3.0-only](LICENSE). Art in `assets/`: [CC BY-SA 4.0](assets/LICENSE). Not affiliated with Sulake or Habbo.
