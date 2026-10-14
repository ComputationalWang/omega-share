//! The request path as the TS server sees it: Bun's URL parser resolves dot segments, Hono decodes the rest.
//! Corpora: `url-pathname` (the first) and `route-path` (both) against the real `URL` and Hono's `getPath`.

/// `%2e` in any case.
fn is_encoded_dot(s: &str) -> bool {
    s.eq_ignore_ascii_case("%2e")
}

/// WHATWG "single-dot path segment": `.` or `%2e`.
fn is_single_dot(seg: &str) -> bool {
    seg == "." || is_encoded_dot(seg)
}

/// WHATWG "double-dot path segment": `..`, `.%2e`, `%2e.` or `%2e%2e`.
fn is_double_dot(seg: &str) -> bool {
    match seg.len() {
        2 => seg == "..",
        4 => {
            let (a, b) = (seg.get(..1), seg.get(1..));
            // `.%2e`, `%2e.`
            (a == Some(".") && b.is_some_and(is_encoded_dot)) || (seg.get(..3).is_some_and(is_encoded_dot) && seg.get(3..) == Some("."))
        }
        6 => seg.get(..3).is_some_and(is_encoded_dot) && seg.get(3..).is_some_and(is_encoded_dot),
        _ => false,
    }
}

/// The pathname of the request URL: backslashes are slashes, `.` and `..` segments (and their `%2e` spellings) are
/// resolved and never climb above the root. `raw` starts with `/` and has no query.
pub fn normalize_path(raw: &str) -> String {
    let rest = raw.strip_prefix(['/', '\\']).unwrap_or(raw);
    let mut out: Vec<&str> = Vec::new();
    let mut segments = rest.split(['/', '\\']).peekable();
    while let Some(segment) = segments.next() {
        let last = segments.peek().is_none();
        if is_double_dot(segment) {
            out.pop();
            if last {
                out.push("");
            }
        } else if is_single_dot(segment) {
            if last {
                out.push("");
            }
        } else {
            out.push(segment);
        }
    }
    let mut path = String::with_capacity(raw.len());
    path.push('/');
    path.push_str(&out.join("/"));
    path
}

fn hex(b: u8) -> Option<u8> {
    char::from(b).to_digit(16).and_then(|d| u8::try_from(d).ok())
}

/// `%XX` at the start of `b`: the byte.
fn escape_at(b: &[u8]) -> Option<u8> {
    match b {
        [b'%', hi, lo, ..] => Some(hex(*hi)? << 4 | hex(*lo)?),
        _ => None,
    }
}

/// What `decodeURI` leaves escaped.
const fn is_reserved(c: char) -> bool {
    matches!(c, ';' | '/' | '?' | ':' | '@' | '&' | '=' | '+' | '$' | ',' | '#')
}

/// Hono's `getPath` on an already normalized path (`decodeURI`: reserved escapes stay; `%25` is a literal `%` that
/// the router keeps as `%25`; a run of escapes that isn't UTF-8 stays as written): what routes and static files are
/// matched on.
pub fn route_path(normalized: &str) -> String {
    if !normalized.contains('%') {
        return normalized.to_owned();
    }
    // Hono doubles `%25` first, then decodes the runs it can: `%2525` comes out as `%25`.
    let doubled = normalized.replace("%25", "%2525");
    let b = doubled.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        let rest = b.get(i..).unwrap_or(&[]);
        if escape_at(rest).is_none() {
            out.extend(rest.first());
            i += 1;
            continue;
        }
        // A maximal run of `%XX`.
        let mut bytes = Vec::new();
        let mut j = i;
        while let Some(byte) = b.get(j..).and_then(escape_at) {
            bytes.push(byte);
            j += 3;
        }
        let raw = b.get(i..j).unwrap_or(&[]);
        match std::str::from_utf8(&bytes) {
            Ok(text) => {
                let mut at = 0;
                for c in text.chars() {
                    let n = c.len_utf8();
                    if is_reserved(c) {
                        out.extend(raw.get(at * 3..(at + n) * 3).unwrap_or(&[]));
                    } else {
                        let mut buf = [0u8; 4];
                        out.extend(c.encode_utf8(&mut buf).as_bytes());
                    }
                    at += n;
                }
            }
            Err(_) => out.extend(raw),
        }
        i = j;
    }
    String::from_utf8(out).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    // apps/server/test/boundary.test.ts:339 (dot segments resolve before routing)
    #[test]
    fn dot_segments_resolve_and_never_climb_above_the_root() {
        for (raw, want) in [
            ("/", "/"),
            ("/..", "/"),
            ("/../..", "/"),
            ("/a/b/../c", "/a/c"),
            ("/a/./b", "/a/b"),
            ("/%2e%2e/secret.txt", "/secret.txt"),
            ("/assets/%2E%2e/index.html", "/index.html"),
            ("/a/.%2e/b", "/b"),
            ("/\\..\\secret.txt", "/secret.txt"),
            ("/a//b", "/a//b"),
            ("/a/b/", "/a/b/"),
            ("/a/..%2fb", "/a/..%2fb"),
        ] {
            assert_eq!(normalize_path(raw), want, "{raw}");
        }
    }

    #[test]
    fn route_path_decodes_what_decode_uri_does() {
        for (raw, want) in [
            ("/plain", "/plain"),
            ("/a%20b", "/a b"),
            ("/%41", "/A"),
            ("/a%2fb", "/a%2fb"),
            ("/a%25b", "/a%25b"),
            ("/%C3%A9", "/é"),
            ("/%C3", "/%C3"),
            ("/%00", "/\0"),
            ("/%2e%2e", "/.."),
            ("/%zz", "/%zz"),
            ("/a%3Bb", "/a%3Bb"),
        ] {
            assert_eq!(route_path(raw), want, "{raw}");
        }
    }
}
