//! Hono's `getMimeType`: the content type of a static file by its extension.

/// `None` for a name with no recognised extension (the caller falls back to `application/octet-stream`).
pub fn mime_type(name: &str) -> Option<&'static str> {
    let _ = name;
    None
}
