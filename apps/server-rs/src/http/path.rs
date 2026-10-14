//! The request path as the TS server sees it: Bun's URL parser resolves dot segments, Hono decodes the rest.

/// The pathname of the request URL: backslashes are slashes, `.` and `..` segments (and their `%2e` spellings) are
/// resolved and never climb above the root. `raw` starts with `/` and has no query.
pub fn normalize_path(raw: &str) -> String {
    let _ = raw;
    String::new()
}

/// Hono's `getPath` on an already normalized path (`decodeURI`: reserved escapes and `%25` stay): what routes and
/// static files are matched on.
pub fn route_path(normalized: &str) -> String {
    let _ = normalized;
    String::new()
}
