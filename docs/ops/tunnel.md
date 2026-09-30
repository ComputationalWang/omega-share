# Running a public session through a tunnel

[ADR 0015](../adr/0015-public-tunnel-and-share-token.md) · research: `docs/research/m2-tunnel-safety.md` · [OME-128](/OME/issues/OME-128)

One `apps/server` process serves the built site (`apps/web/dist`), the API and the WebSocket on **one origin**. It listens on `127.0.0.1` only. A tunnel agent on the same machine is the only way in from outside. Never tunnel the Vite dev server.

## ngrok (primary)

ngrok is an **operator tool**: install it yourself (<https://ngrok.com/download>). Nothing in this repo installs, bundles or imports it.

- **Authtoken.** ngrok reads it from `NGROK_AUTHTOKEN`. For agents that is the Paperclip secret `ngrok_authtoken`, injected as that env var into the run that hosts the session. A human operator may use their own `~/.config/ngrok/ngrok.yml` instead. The token is never committed, never written to a file in the repo, never pasted into an issue, and never passed as `--authtoken` (that shows up in `ps`). `scripts/tunnel.sh` never reads or prints it.
- **Domain.** The free plan has one fixed dev domain (`<name>.ngrok-free.app`). Use it as the public origin.

```sh
scripts/tunnel.sh https://<name>.ngrok-free.app            # build, start the server, start ngrok
scripts/tunnel.sh https://<name>.ngrok-free.app --dry-run  # print what it would run
```

It runs, in order:

```sh
bun run --filter @omega/web build
PUBLIC_ORIGIN=https://<name>.ngrok-free.app TRUST_PROXY=loopback HOST=127.0.0.1 PORT=8787 STATIC_DIR=$PWD/apps/web/dist bun apps/server/src/index.ts
ngrok http 127.0.0.1:8787 --url https://<name>.ngrok-free.app
```

Ctrl-C stops both. **Stop the tunnel when the session ends**: the domain doesn't change, so anyone who has the URL can come back while it runs.

**Browser warning.** On the free plan, a visitor's first page load shows ngrok's "You are about to visit…" page once. Tell invitees to expect it and click *Visit Site*. The extension sends `ngrok-skip-browser-warning` on its requests, so it isn't affected.

**Gating.** Whether the whole tunnel sits behind ngrok's `oauth` edge action with an email allowlist is board decision B3 (ADR 0015 §9). If it does, the Traffic Policy file is generated at run time from Paperclip secrets into `$PAPERCLIP_RUN_SCRATCH_DIR` and passed with `--traffic-policy-file`. It is never committed: the allowlist is personal data.

## cloudflared (fallback, no account)

`cloudflared` (Apache-2.0) gives a random `*.trycloudflare.com` host each run. Start the tunnel first to learn it, then start the server with it:

```sh
cloudflared tunnel --url http://127.0.0.1:8787    # prints https://<random>.trycloudflare.com
bun run --filter @omega/web build
PUBLIC_ORIGIN=https://<random>.trycloudflare.com TRUST_PROXY=loopback STATIC_DIR=$PWD/apps/web/dist bun apps/server/src/index.ts
```

## Server config

Parsed at startup. A bad value exits non-zero with a message naming the variable.

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `8787` | Listen port. |
| `HOST` | `127.0.0.1` | Listen address. Keep it loopback: the tunnel connects locally. |
| `PUBLIC_ORIGIN` | unset | The tunnel's `https://` origin. Its host joins the `Host` allowlist (anything else gets 421) and it joins the `Origin` allowlist (anything else gets 403). |
| `SITE_ORIGIN` | `http://localhost:5173` | The Vite dev site, also allowed as an `Origin`. `https:`, or `http:` on loopback. |
| `TRUST_PROXY` | `off` | `loopback`: key rate limits by the rightmost `X-Forwarded-For` entry, and only when the peer is loopback (the tunnel agent). Without it, every tunnelled client shares one bucket, and a warning is logged. |
| `STATIC_DIR` | unset | Built site to serve on the same origin. It must contain `index.html`. |
| `EXTENSION_IDS` | unset (any id) | Comma-separated extension ids allowed as an `Origin`. |

Limits behind the proxy: 10 sockets per client, 200 in total (503 past that). Shares: burst 5 then 1 per 3 s, per client and per member, and burst 20 then 2/s overall. Unauthorized share attempts have their own per-client bucket (burst 20, 1/s), so token guessing can't use up a member's allowance.

Assumptions to confirm against real ngrok ([OME-133](/OME/issues/OME-133)): ngrok *appends* the client address to `X-Forwarded-For` (so the rightmost entry is not client-controlled). If a tunnel sends no parseable address, every client falls into one `proxy:unknown` bucket: safe, but one noisy client then slows everyone. Set `EXTENSION_IDS` once the extension has a published id; until then any extension origin passes the `Origin` check (the share token is what authorizes a share). `POST /rooms/:id/share` always needs the sharing member's `Authorization: Bearer <shareToken>`, which comes from their `snapshot`. Readiness: `GET /healthz`.
