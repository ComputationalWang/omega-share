# ADR 0038 — Firefox releases through the AMO API

**Status:** accepted (2026-10-10) · Extension Engineer · [OME-757](/OME/issues/OME-757) · key from the board on [OME-694](/OME/issues/OME-694) · first version 0.1.0 submitted by hand on [OME-747](/OME/issues/OME-747)

**Context:** The board gave us an addons.mozilla.org API key (a JWT issuer and secret). Agents can now read the add-on's review state and submit new Firefox versions themselves instead of queuing a board upload. A submit is outward-facing and can't be undone: AMO never accepts the same version number twice, and every listed version goes to Mozilla's reviewers. So the tool and the rules for using it are recorded together.

**Decision:**
- **Tool:** `bun run ext:amo status|submit` (`apps/extension/store/amo.ts`, `amo-cli.ts`). It is a small AMO v5 client with no new dependency: HS256 JWT through WebCrypto (`iss`, a fresh `jti`, `iat`, `exp` = `iat` + 300 s), one token per request, and every response parsed with Valibot.
  - We don't use `web-ext sign`, though it is already a dev dependency. It zips a source directory itself, so it can't upload the reproducible `ext:store` zip whose hash QA and the sources zip vouch for. It also has no read-only status command.
- **Credentials:** `AMO_JWT_ISSUER` and `AMO_JWT_SECRET` come from the environment only. Agents read them at run time from the Paperclip secret bindings `omega-share-firefox-firefox_jwt_issuer` and `omega-share-firefox-firefox_jwt_secret` (`POST /api/agents/me/secrets/<key>/value`; the value endpoint takes these binding keys, not `FIREFOX_JWT_*`, corrected on [OME-794](/OME/issues/OME-794)). Never put them on a command line, in a file, a log, a comment or an attachment. The client replaces the issuer, the secret and every token it signed with `[redacted]` in its errors, and it refuses a pagination link off `https://addons.mozilla.org/api/v5/`.
- **`status` is read-only and any agent may run it at any time.** It prints the listing status and every version's channel, review status (`file.status`: public = approved, unreviewed = awaiting review, disabled) and whether the developer disabled it.
- **`submit` uploads a new listed version:** the Firefox zip, compatible with Firefox and Firefox for Android, plus the sources zip from `bun run ext:store`. It then prints the AMO version URL, the commit and both sha256s. It refuses when:
  - the version in `apps/extension/package.json` isn't greater than the newest version on AMO, listed or unlisted;
  - `git status --porcelain` shows anything, untracked files included;
  - either zip differs from a fresh rebuild of the same tree.
- **Release notes:** `submit --notes "<text>"` or `submit --notes-file <path>` sends them as `release_notes: {"en-US": …}` in the create-version request ([OME-794](/OME/issues/OME-794)). The tool refuses empty notes, both options at once and any other argument, before it builds or uploads anything. Without either option the version has no notes. Take the text from the release issue.
- **A newer submit disables an unreviewed listed version:** when a new listed version is submitted while an older one is still awaiting review, AMO disables the older one. Only the newest goes to review. This happened to 0.1.0 when 0.1.1 was submitted ([OME-777](/OME/issues/OME-777)). Don't submit to "fix" a pending version unless the release issue accepts that the pending one is dropped.
- **Who may submit, and when:** `submit` runs only:
  - on a release issue the CEO filed;
  - after QA signed off on that exact SHA;
  - with a version bump merged to `main`.

  Post the tool's output (URL, commit, hashes) on the release issue.
- **Not automated:** listing text, screenshots, categories, license, privacy policy and other add-on metadata. Those stay a board or CEO call, made in the AMO dashboard or on a board issue. The tool never PATCHes the add-on itself.

**Consequences:**
- Firefox releases no longer wait on a board upload. Review time is still Mozilla's.
- A leaked or revoked key only breaks `ext:amo`. The board rotates it on AMO and updates the two Paperclip secrets.
- Notes forgotten at submit time can still be set later with a `PATCH …/versions/<id>/` carrying `release_notes`, as on [OME-777](/OME/issues/OME-777), but `--notes` is the normal path.
- Chrome Web Store uploads are unchanged: still a board step ([OME-591](/OME/issues/OME-591)).
