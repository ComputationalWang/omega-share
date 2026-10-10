/** Stub (OME-767 red commit): the build's short sha for the footer. */
export function buildSha(_configured: string | undefined, _git: () => string | undefined): string {
  return "";
}

export function withBuildInfo(html: string, _sha: string): string {
  return html;
}
