# Building the omega share extension from source

For Mozilla add-on reviewers (AMO source-code submission) and anyone who wants to check that the uploaded
extension matches this source. The build bundles and minifies with [WXT](https://wxt.dev) (Vite); it does not
obfuscate. The extension is AGPL-3.0-only (`LICENSE`); the full repository is public.

This archive, `omega-share-0.1.1-sources.zip`, holds only what the extension build reads: the root
`package.json`, `bun.lock` and `tsconfig.base.json`, `apps/extension/` (the extension), `packages/shared/` (the
wire contract it imports), `assets/store/icon-*.png` (its icons) and the `package.json` of the other two
workspaces, which the lockfile lists.

## Environment

- Any 64-bit Linux, macOS or Windows (WSL); tested on Linux x64. Ubuntu 24.04 ARM64 works too, because Bun ships
  linux-arm64 builds.
- **Bun 1.4.2** exactly (open source, MIT): `curl -fsSL https://bun.sh/install | bash -s "bun-v1.4.2"`.
  Node and npm are not used.
- `unzip`, and network access to the npm registry for the install.

## Steps

```sh
unzip omega-share-0.1.1-sources.zip -d omega-share && cd omega-share
bun install --frozen-lockfile
bun run ext:store
```

`bun run ext:store` builds both store packages into `apps/extension/.output/`:

| File | What it is |
|---|---|
| `omega-share-0.1.1-firefox.zip` | The AMO upload (the unpacked build is `apps/extension/.output/firefox-mv3/`) |
| `omega-share-0.1.1-chrome.zip` | The Chrome Web Store upload |

It prints the sha256 of each. The zips are reproducible (sorted entries, fixed timestamps, no host metadata),
so they are byte-identical to the uploaded ones:

```sh
sha256sum apps/extension/.output/omega-share-0.1.1-firefox.zip
```

Before zipping, the build checks the manifest (exact permissions, the add-on ID, the data-collection
declaration, no content scripts) and runs `web-ext lint`; it stops if either fails. It also says
"sources zip skipped", because the unpacked archive is not a git checkout.

## Where things are

- `apps/extension/wxt.config.ts`: the manifest, including the Firefox `browser_specific_settings`.
- `apps/extension/src/entrypoints/popup/`: the popup; it scans the active tab only when opened (`activeTab` +
  `scripting`), lists video embeds and sends the chosen one to an omega share server.
- `apps/extension/src/entrypoints/options/`: the server URL setting.
- `apps/extension/store/`: the packaging guard, lint step and reproducible zip.
