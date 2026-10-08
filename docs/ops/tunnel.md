# Running a public session through a tunnel

[ADR 0015](../adr/0015-public-tunnel-and-share-token.md) · research: `docs/research/m2-tunnel-safety.md` · [OME-128](/OME/issues/OME-128)

One `apps/server` process serves the built site (`apps/web/dist`), the API and the WebSocket on **one origin**. It listens on `127.0.0.1` only. A tunnel agent on the same machine is the only way in from outside. Never tunnel the Vite dev server.

## ngrok (primary)

ngrok is an **operator tool**: install it yourself (<https://ngrok.com/download>). Nothing in this repo installs, bundles or imports it.

- **Authtoken.** The token lives in the host user's own ngrok config, set up once by the board (`ngrok config add-authtoken`). It is not a Paperclip secret, and agents never handle it: they just run `ngrok`. Never pass `--authtoken` (it shows up in `ps`), never read or print the config file, and never commit, paste or write the token anywhere. `scripts/tunnel.sh` never reads or prints it, and it starts the server with `NGROK_AUTHTOKEN` unset.
- **Domain.** The free plan has one fixed dev domain, `<name>.ngrok-free.dev`. To learn it, run `ngrok http 127.0.0.1:8787`, read the host from the `Forwarding` line, and stop it (Ctrl-C). Use that as the public origin.
- **One session at a time.** The free plan allows one ngrok session per account. Claim it in the *Coordination* document on [OME-1](/OME/issues/OME-1) before you start and release it when you stop. If another session is running, `ngrok` fails to start.

```sh
scripts/tunnel.sh https://<name>.ngrok-free.dev            # build, start the server, start ngrok
scripts/tunnel.sh https://<name>.ngrok-free.dev --dry-run  # print what it would run
```

It runs, in order:

```sh
bun run --filter @omega/web build
PUBLIC_ORIGIN=https://<name>.ngrok-free.dev TRUST_PROXY=loopback HOST=127.0.0.1 PORT=8787 STATIC_DIR=$PWD/apps/web/dist bun apps/server/src/index.ts
ngrok http 127.0.0.1:8787 --url https://<name>.ngrok-free.dev
```

Ctrl-C stops both. **Stop the tunnel when the session ends**: the domain doesn't change, so anyone who has the URL can come back while it runs.

**Browser warning.** On the free plan, a visitor's first page load shows ngrok's "You are about to visit…" page once. Tell invitees to expect it and click *Visit Site*. The extension sends `ngrok-skip-browser-warning` on its requests, so it isn't affected.

The *Visit Site* pass is a cookie. If it expires or is cleared mid-session, the room page keeps running but its next lazily loaded chunk (`youtube-*.js` or `twitch-*.js`, fetched on the first share of that provider) gets the warning page's HTML instead of JavaScript, and that player never starts. Reloading the page shows the interstitial again; after *Visit Site* it works. Only free-plan ngrok is affected (paid plans and cloudflared have no interstitial). QA: don't clear the cookie while testing ([OME-133](/OME/issues/OME-133)).

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
| `GENERIC_EMBEDS` | `on` | `on` or `off` (anything else fails startup). `off` is the generic embed tier's kill switch (ADR 0024 §5): generic URLs get `unsupported_url`, a stored generic embed is restored as no embed, and the CSP `frame-src` drops `https:`. |
| `GENERIC_EMBED_DENYLIST` | empty | Comma-separated domains refused as generic embeds, each with its subdomains (ADR 0024 §6). A denied host gets `unsupported_url`. An entry that is not a bare hostname fails startup. |
| `ROOM_TITLE_BLOCKLIST` | empty | Comma-separated terms a room title may not contain, matched ignoring case and lookalike letters (`BADW0RD` matches `badword`). A matching title gets `invalid_body` on `POST /rooms`, and existing rooms whose titles match drop out of `GET /rooms` (ADR 0028). |

Limits behind the proxy: 10 sockets per client, 200 in total (503 past that). Shares: burst 5 then 1 per 3 s, per client and per member, and burst 20 then 2/s overall. Unauthorized share attempts have their own per-client bucket (burst 20, 1/s), so token guessing can't use up a member's allowance.

Verified on real ngrok ([OME-133](/OME/issues/OME-133), T4 in `docs/qa/m2-real-sign-off.md`): ngrok *appends* the real client address to `X-Forwarded-For`, so the rightmost entry is not client-controlled and `TRUST_PROXY=loopback` holds (30 shares with spoofed XFF shared one bucket: 20 × 401, then 429). If a tunnel sends no parseable address, every client falls into one `proxy:unknown` bucket: safe, but one noisy client then slows everyone. Set `EXTENSION_IDS` once the extension has a published id; until then any extension origin passes the `Origin` check (the share token is what authorizes a share). `POST /rooms/:id/share` always needs the sharing member's `Authorization: Bearer <shareToken>`, which comes from their `snapshot`. Readiness: `GET /healthz`.
