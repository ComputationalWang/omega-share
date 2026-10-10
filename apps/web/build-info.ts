/**
 * The footer's version: the short sha of the commit the site was built from (OME-767). The deploy builds from a
 * `git archive` with no .git, so it passes the sha in `OMEGA_BUILD_SHA`; a checkout falls back to git; else "dev".
 * Only hex gets through, so nothing a build environment sets can reach the page as markup.
 */
const PLACEHOLDER = "%OMEGA_VERSION%";
const SHA = /^[0-9a-f]{7,40}$/;

const short = (s: string | undefined): string | null => {
  const t = s?.trim().toLowerCase() ?? "";
  return SHA.test(t) ? t.slice(0, 7) : null;
};

export function buildSha(configured: string | undefined, git: () => string | undefined): string {
  const fromEnv = short(configured);
  if (fromEnv !== null) return fromEnv;
  try {
    return short(git()) ?? "dev";
  } catch {
    return "dev";
  }
}

export function withBuildInfo(html: string, sha: string): string {
  return html.replaceAll(PLACEHOLDER, () => sha);
}
