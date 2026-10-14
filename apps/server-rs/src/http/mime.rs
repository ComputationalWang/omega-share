//! Hono's `getMimeType`: the content type of a static file by its extension (corpus `mime-type`).

/// Hono's `baseMimes`, by lowercase extension.
const BASE: &[(&str, &str)] = &[
    ("aac", "audio/aac"),
    ("avi", "video/x-msvideo"),
    ("avif", "image/avif"),
    ("av1", "video/av1"),
    ("bin", "application/octet-stream"),
    ("bmp", "image/bmp"),
    ("css", "text/css; charset=utf-8"),
    ("csv", "text/csv; charset=utf-8"),
    ("eot", "application/vnd.ms-fontobject"),
    ("epub", "application/epub+zip"),
    ("gif", "image/gif"),
    ("gz", "application/gzip"),
    ("htm", "text/html; charset=utf-8"),
    ("html", "text/html; charset=utf-8"),
    ("ico", "image/x-icon"),
    ("ics", "text/calendar; charset=utf-8"),
    ("jpeg", "image/jpeg"),
    ("jpg", "image/jpeg"),
    ("js", "text/javascript; charset=utf-8"),
    ("json", "application/json"),
    ("jsonld", "application/ld+json"),
    ("map", "application/json"),
    ("mid", "audio/x-midi"),
    ("midi", "audio/x-midi"),
    ("mjs", "text/javascript; charset=utf-8"),
    ("mp3", "audio/mpeg"),
    ("mp4", "video/mp4"),
    ("mpeg", "video/mpeg"),
    ("oga", "audio/ogg"),
    ("ogv", "video/ogg"),
    ("ogx", "application/ogg"),
    ("opus", "audio/opus"),
    ("otf", "font/otf"),
    ("pdf", "application/pdf"),
    ("png", "image/png"),
    ("rtf", "application/rtf"),
    ("svg", "image/svg+xml; charset=utf-8"),
    ("tif", "image/tiff"),
    ("tiff", "image/tiff"),
    ("ts", "video/mp2t"),
    ("ttf", "font/ttf"),
    ("txt", "text/plain; charset=utf-8"),
    ("wasm", "application/wasm"),
    ("webm", "video/webm"),
    ("weba", "audio/webm"),
    ("webmanifest", "application/manifest+json"),
    ("webp", "image/webp"),
    ("woff", "font/woff"),
    ("woff2", "font/woff2"),
    ("xhtml", "application/xhtml+xml; charset=utf-8"),
    ("xml", "application/xml; charset=utf-8"),
    ("zip", "application/zip"),
    ("3gp", "video/3gpp"),
    ("3g2", "video/3gpp2"),
    ("gltf", "model/gltf+json"),
    ("glb", "model/gltf-binary"),
];

/// `/\.([a-zA-Z0-9]+?)$/` on the name, looked up in lowercase: the text after the last dot, if it is all ASCII
/// letters and digits. `None` for a name with no recognised extension (the caller falls back to
/// `application/octet-stream`).
pub fn mime_type(name: &str) -> Option<&'static str> {
    let (_, ext) = name.rsplit_once('.')?;
    if ext.is_empty() || !ext.bytes().all(|b| b.is_ascii_alphanumeric()) {
        return None;
    }
    BASE.iter().find(|(e, _)| e.eq_ignore_ascii_case(ext)).map(|(_, mime)| *mime)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extensions_are_case_insensitive_and_must_be_alphanumeric_to_the_end() {
        assert_eq!(mime_type("a.JS"), Some("text/javascript; charset=utf-8"));
        assert_eq!(mime_type("assets/index-Ab12.css"), Some("text/css; charset=utf-8"));
        assert_eq!(mime_type("manifest.webmanifest"), Some("application/manifest+json"));
        assert_eq!(mime_type("a.tar.gz"), Some("application/gzip"));
        for none in ["noext", "a.", ".unknown", "a.js/", "a.j s"] {
            assert_eq!(mime_type(none), None, "{none}");
        }
    }
}
