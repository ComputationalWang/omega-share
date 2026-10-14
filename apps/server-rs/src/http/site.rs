//! Port of `apps/server/src/static.ts` (`mountSite`): the built site on the API's origin, so one tunnel covers site,
//! API and WebSocket (ADR 0015 section 1). Only `/`, `/r/<valid id>` and the built files answer; anything else is a
//! real 404 (OME-764). The router calls this for every request no API route took.
//!
//! Files come from `STATIC_DIR` through the filesystem, never outside it: the path is checked as Hono's
//! `serveStatic` checks it (no `%`, no dot segments, no `//`, no backslash), and the resolved file, symlinks
//! followed, must still be under the root's real path (a deliberate difference: the TS server follows a symlink out).

use super::mime::mime_type;
use super::respond::{HTML, not_found, with_type};
use super::rooms::preview_title;
use super::site_meta::{security_txt, site_meta, with_meta};
use crate::app::App;
use crate::contract::ids::RoomId;
use axum::http::header::CACHE_CONTROL;
use axum::http::{HeaderValue, Method, StatusCode};
use axum::response::Response;
use std::path::{Path, PathBuf};

const IMMUTABLE: &str = "public, max-age=31536000, immutable";
/// Fixed names (icons, manifest, robots.txt) can't be immutable: a day, so a new icon shows up soon enough.
const DAY: &str = "public, max-age=86400";

/// The server's own site files (`apps/server/public`), served at the root by name only. Compiled in: the binary
/// has no source tree beside it.
const PUBLIC_FILES: &[(&str, &[u8])] = &[
    ("favicon.ico", include_bytes!("../../../server/public/favicon.ico")),
    (
        "apple-touch-icon.png",
        include_bytes!("../../../server/public/apple-touch-icon.png"),
    ),
    ("icon-192.png", include_bytes!("../../../server/public/icon-192.png")),
    ("icon-512.png", include_bytes!("../../../server/public/icon-512.png")),
    (
        "icon-maskable-512.png",
        include_bytes!("../../../server/public/icon-maskable-512.png"),
    ),
    ("og-image.png", include_bytes!("../../../server/public/og-image.png")),
    (
        "manifest.webmanifest",
        include_bytes!("../../../server/public/manifest.webmanifest"),
    ),
    ("robots.txt", include_bytes!("../../../server/public/robots.txt")),
];

const NOT_FOUND_TITLE: &str = "<title>Page not found · omega-share</title>";
const NOT_FOUND_MAIN: &str = r#"<main class="privacy"><h1>Page not found</h1><p>There is nothing at this address.</p><p><a href="/">Go to omega-share</a></p></main>"#;
/// Without a built `privacy.html` to borrow its look from.
const BARE_NOT_FOUND: &str = concat!(
    r#"<!doctype html><html lang="en"><head><meta charset="utf-8" />"#,
    "<title>Page not found · omega-share</title>",
    "</head><body>",
    r#"<main class="privacy"><h1>Page not found</h1><p>There is nothing at this address.</p><p><a href="/">Go to omega-share</a></p></main>"#,
    "</body></html>"
);

/// What the site needs once the server is bound: the real path of the root, and the generic share card.
#[derive(Debug)]
pub struct Site {
    pub root: PathBuf,
    pub card: String,
}

impl Site {
    /// `None` without `STATIC_DIR` (or when the directory can't be resolved).
    pub fn new(config: &crate::config::ServerConfig) -> Option<Self> {
        let root = std::fs::canonicalize(config.static_dir.as_deref()?).ok()?;
        // Absolute origin for the share card's image URL (PUBLIC_ORIGIN, else SITE_ORIGIN).
        let origin = config.public_origin.as_deref().unwrap_or(&config.site_origin);
        Some(Self {
            root,
            card: site_meta(origin, None),
        })
    }
}

fn with_cache(mut res: Response, cache: &'static str) -> Response {
    res.headers_mut().insert(CACHE_CONTROL, HeaderValue::from_static(cache));
    res
}

fn html(status: StatusCode, body: String) -> Response {
    with_cache(with_type(status, HTML, body), "no-cache")
}

/// The file at `rel` (a decoded request path) if `serveStatic` would serve it, resolved under `root`.
async fn find(root: &Path, rel: &str) -> Option<PathBuf> {
    // serveStatic: no `%` left after decoding, no dot segments, no doubled or backslash separators.
    if rel.contains('%') || rel.contains('\\') || rel.contains("//") || rel.split('/').any(|s| s == "." || s == "..") {
        return None;
    }
    let mut target = root.join(rel.trim_start_matches('/'));
    if tokio::fs::metadata(&target).await.ok()?.is_dir() {
        target.push("index.html");
    }
    let real = tokio::fs::canonicalize(&target).await.ok()?;
    // A symlink may point anywhere: only files that really live under the root are served.
    (real.starts_with(root) && tokio::fs::metadata(&real).await.ok()?.is_file()).then_some(real)
}

async fn read_text(root: &Path, name: &str) -> Option<String> {
    let file = find(root, &format!("/{name}")).await?;
    let bytes = tokio::fs::read(file).await.ok()?;
    Some(String::from_utf8_lossy(&bytes).into_owned())
}

fn first_title_tag(page: &str) -> Option<(usize, usize)> {
    // `<title>[^<]*<\/title>`
    let mut from = 0;
    while let Some(i) = page.get(from..)?.find("<title>") {
        let start = from + i;
        let body = start + "<title>".len();
        let rest = page.get(body..)?;
        let lt = rest.find('<')?;
        if rest.get(lt..)?.starts_with("</title>") {
            return Some((start, body + lt + "</title>".len()));
        }
        from = body;
    }
    None
}

fn main_block(page: &str) -> Option<(usize, usize)> {
    // `<main[^>]*>[\s\S]*<\/main>`, greedy: the first `<main` whose tag closes, through the last `</main>`.
    let start = page.find("<main")?;
    let tag_end = start + page.get(start..)?.find('>')? + 1;
    let end = page.rfind("</main>")? + "</main>".len();
    (end > tag_end).then_some((start, end))
}

/// The 404 page, in the privacy page's look when there is one.
async fn not_found_page(root: &Path) -> Response {
    let page = read_text(root, "privacy.html").await.and_then(|privacy| {
        let mut page = privacy;
        if let Some((a, b)) = first_title_tag(&page) {
            page.replace_range(a..b, NOT_FOUND_TITLE);
        }
        if let Some((a, b)) = main_block(&page) {
            page.replace_range(a..b, NOT_FOUND_MAIN);
        }
        page.contains(NOT_FOUND_MAIN).then_some(page)
    });
    html(StatusCode::NOT_FOUND, page.unwrap_or_else(|| BARE_NOT_FOUND.to_owned()))
}

/// A built page with the share card in its head; never cached, so a rename or takedown shows at once.
async fn page(root: &Path, name: &str, meta: &str) -> Response {
    match read_text(root, name).await {
        Some(text) => html(StatusCode::OK, with_meta(&text, meta)),
        None => not_found_page(root).await,
    }
}

async fn file_response(root: &Path, rel: &str, cache: Option<&'static str>) -> Option<Response> {
    let file = find(root, rel).await?;
    let bytes = tokio::fs::read(&file).await.ok()?;
    let mime = mime_type(&file.to_string_lossy()).unwrap_or("application/octet-stream");
    let res = with_type(StatusCode::OK, mime, bytes);
    Some(match cache {
        Some(cache) => with_cache(res, cache),
        None => res,
    })
}

/// `/r/<id>` with an optional trailing slash (`ROOM_ROUTE`), the id valid.
fn room_route(path: &str) -> Option<RoomId> {
    let id = path.strip_prefix("/r/")?;
    let id = id.strip_suffix('/').unwrap_or(id);
    if id.is_empty() || id.contains('/') {
        return None;
    }
    RoomId::parse(id)
}

/// `/:name{[A-Za-z0-9_-]+\.html}`
fn html_name(path: &str) -> Option<&str> {
    let name = path.strip_prefix('/')?;
    let stem = name.strip_suffix(".html")?;
    (!stem.is_empty() && stem.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')).then_some(name)
}

/// Everything no API route answered: the site when there is a built one, else a plain 404.
pub async fn serve(app: &App, method: &Method, path: &str) -> Response {
    let Some(site) = app.http.site() else {
        return not_found();
    };
    let root = site.root.as_path();
    // Bun.file throws on a NUL byte; answer 404 instead of a 500 and a logged stack.
    if path.contains('\0') || path.contains("%00") {
        return not_found();
    }
    // Vite content-hashes everything under /assets; a miss there is a 404, never the SPA shell. Any method, as the
    // TS middleware serves it.
    if path == "/assets" || path.starts_with("/assets/") {
        return file_response(root, path, Some(IMMUTABLE)).await.unwrap_or_else(not_found);
    }
    // Hono answers HEAD from the GET routes; every other method has no site route.
    if !matches!(method, &Method::GET | &Method::HEAD) {
        return not_found();
    }
    if let Some(name) = path.strip_prefix('/')
        && let Some((_, bytes)) = PUBLIC_FILES.iter().find(|(n, _)| *n == name)
    {
        let res = with_type(StatusCode::OK, mime_type(name).unwrap_or("application/octet-stream"), *bytes);
        return with_cache(res, DAY);
    }
    if path == "/.well-known/security.txt" {
        let origin = app.config.public_origin.as_deref().unwrap_or(&app.config.site_origin);
        return with_cache(with_type(StatusCode::OK, "text/plain; charset=utf-8", security_txt(origin)), DAY);
    }
    if path == "/" || path == "/index.html" {
        return page(root, "index.html", &site.card).await;
    }
    if let Some(id) = room_route(path) {
        // One lookup; unknown, private, hidden and taken-down rooms all get the generic card, byte for byte.
        return match preview_title(app, &id) {
            None => page(root, "index.html", &site.card).await,
            Some(title) => {
                let origin = app.config.public_origin.as_deref().unwrap_or(&app.config.site_origin);
                page(root, "index.html", &site_meta(origin, Some(&title))).await
            }
        };
    }
    if let Some(name) = html_name(path) {
        return page(root, name, &site.card).await;
    }
    if let Some(res) = file_response(root, path, None).await {
        return res;
    }
    not_found_page(root).await
}
