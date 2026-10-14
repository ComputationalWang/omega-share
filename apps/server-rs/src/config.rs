//! Validated startup config (ADR 0015 §3), mirroring `apps/server/src/config.ts`. A bad value is an
//! error naming the variable; the process exits before listening.

use crate::contract::generic_embed::normalize_hostname;
use crate::contract::js_compat::js_trim;
use crate::contract::session::RESUME_GRACE_MS;
use std::collections::HashMap;
use std::ffi::OsString;
use std::fmt;
use std::path::{Component, Path, PathBuf};
use url::Url;

/// Where the rooms database lives.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DbPath {
    /// `:memory:` (tests): nothing survives the process.
    Memory,
    File(PathBuf),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ServerConfig {
    pub port: u16,
    /// Listen address. Loopback by default: the tunnel agent is the only way in from outside.
    pub hostname: String,
    /// Where the dev site runs (Vite), e.g. `http://localhost:5173`.
    pub site_origin: String,
    /// The tunnel's public `https://` origin, or none when not tunnelled.
    pub public_origin: Option<String>,
    /// Trust the rightmost `X-Forwarded-For` entry from a loopback peer (`TRUST_PROXY=loopback`).
    pub trust_proxy: bool,
    /// Absolute path of the built site (`apps/web/dist`) to serve on the same origin.
    pub static_dir: Option<PathBuf>,
    /// Allowed Chromium extension ids, or none for any.
    pub extension_ids: Option<Vec<String>>,
    /// Never inside `static_dir` (research D5).
    pub db_path: DbPath,
    /// `GENERIC_EMBEDS=on|off` (default on): the generic embed tier's kill switch (ADR 0024 §5).
    pub generic_embeds: bool,
    /// `GENERIC_EMBED_DENYLIST`: normalised domains refused for generic embeds, with their subdomains (§6).
    pub generic_embed_denylist: Vec<String>,
    /// Our hostnames, normalised: `localhost` plus the site's and the public origin's DNS hosts (§1).
    pub own_hosts: Vec<String>,
    /// `ROOM_TITLE_BLOCKLIST`: terms a room title may not contain (ADR 0028, research S8).
    pub room_title_blocklist: Vec<String>,
    /// `METRICS_PORT`: Prometheus text on 127.0.0.1 only (OME-504), or none when unset or `off`.
    pub metrics_port: Option<u16>,
    /// `MAX_CONNECTIONS`: open WebSockets allowed in total (OME-573).
    pub max_connections: u32,
    /// `RESUME_GRACE_MS`: how long a dropped durable member is held (ADR 0043).
    pub resume_grace_ms: u32,
    /// `MAX_HTTP_IN_FLIGHT`: HTTP requests handled at once, whatever their clients; more get 503
    /// (`maxHttpInFlight` in server.ts, threat model section 10). Zero refuses every request.
    pub max_http_in_flight: usize,
}

/// A refused variable: `invalid KEY: why`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConfigError {
    pub key: &'static str,
    pub why: String,
}

impl fmt::Display for ConfigError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "invalid {}: {}", self.key, self.why)
    }
}

impl std::error::Error for ConfigError {}

/// The M6 hosted target (20 rooms × 25 people = 500 sockets) with 2× headroom (OME-573).
pub const DEFAULT_MAX_CONNECTIONS: u32 = 1024;

/// HTTP requests handled at once by default (`MAX_HTTP_IN_FLIGHT` in http.ts).
pub const DEFAULT_MAX_HTTP_IN_FLIGHT: usize = 256;

/// Dev default for `DB_PATH`: `apps/server-rs/data/omega.db` (git-ignored), never under a static dir.
pub fn default_db_path() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("data/omega.db")
}

pub type Env = HashMap<String, String>;

/// Every variable the server reads; a non-UTF-8 value in one of them is refused, never mangled.
pub const CONFIG_KEYS: [&str; 16] = [
    "PORT",
    "HOST",
    "SITE_ORIGIN",
    "PUBLIC_ORIGIN",
    "TRUST_PROXY",
    "STATIC_DIR",
    "EXTENSION_IDS",
    "DB_PATH",
    "METRICS_PORT",
    "MAX_CONNECTIONS",
    "RESUME_GRACE_MS",
    "MAX_HTTP_IN_FLIGHT",
    "GENERIC_EMBEDS",
    "GENERIC_EMBED_DENYLIST",
    "ROOM_TITLE_BLOCKLIST",
    "ADMIN_SOCKET",
];

/// The process environment as UTF-8. Variables we don't read are skipped whatever their bytes.
pub fn env_from_os(vars: impl IntoIterator<Item = (OsString, OsString)>) -> Result<Env, ConfigError> {
    let mut env = Env::new();
    for (key, value) in vars {
        let Ok(key) = key.into_string() else { continue };
        match value.into_string() {
            Ok(value) => {
                env.insert(key, value);
            }
            Err(_) => {
                if let Some(read) = CONFIG_KEYS.iter().find(|k| **k == key) {
                    return Err(fail(read, "must be UTF-8"));
                }
            }
        }
    }
    Ok(env)
}

/// Under the unit's `LimitNOFILE=4096`, so 1024 descriptors stay free for HTTP, SQLite and metrics.
const MAX_CONNECTIONS_CEILING: u32 = 3072;
/// Long enough for a phone tab switch, short enough that a seat isn't kept for a gone member (ADR 0043).
const RESUME_GRACE_MIN_MS: u32 = 5_000;
const RESUME_GRACE_MAX_MS: u32 = 600_000;
const LOOPBACK_HOSTS: [&str; 3] = ["localhost", "127.0.0.1", "[::1]"];

fn fail(key: &'static str, why: impl Into<String>) -> ConfigError {
    ConfigError { key, why: why.into() }
}

/// `/^\d{1,max_len}$/` as a number: ASCII digits only, so no sign, exponent or fraction.
fn digits(raw: &str, max_len: usize) -> Option<u32> {
    if raw.is_empty() || raw.len() > max_len || !raw.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    raw.parse().ok()
}

/// A bare origin: `https:` (or `http:` on loopback when allowed), no credentials, path, query or hash.
fn parse_origin(key: &'static str, raw: &str, http_on_loopback: bool) -> Result<String, ConfigError> {
    let url = Url::parse(raw).map_err(|_| fail(key, "not a URL"))?;
    if !url.username().is_empty() || url.password().is_some() {
        return Err(fail(key, "must not contain credentials"));
    }
    // The parser drops an empty "?" or "#", so check the raw string too.
    if url.path() != "/" || raw.contains(['?', '#']) {
        return Err(fail(key, "must be an origin, with no path or query"));
    }
    let http_ok = http_on_loopback && url.scheme() == "http" && url.host_str().is_some_and(|h| LOOPBACK_HOSTS.contains(&h));
    if url.scheme() != "https" && !http_ok {
        return Err(fail(
            key,
            if http_on_loopback {
                "must be https (http only on loopback)"
            } else {
                "must be https"
            },
        ));
    }
    Ok(url.origin().ascii_serialization())
}

/// Node's `path.resolve`: absolute and lexically normalised, symlinks untouched.
fn resolve(cwd: &Path, raw: &str) -> PathBuf {
    let mut out = PathBuf::new();
    for part in cwd.join(raw).components() {
        match part {
            Component::ParentDir => {
                out.pop();
            }
            Component::CurDir => {}
            other => out.push(other),
        }
    }
    out
}

/// `path` with symlinks resolved as far as it exists (the DB file itself may not yet).
fn realish(path: &Path) -> PathBuf {
    if let Ok(real) = std::fs::canonicalize(path) {
        return real;
    }
    match (path.parent(), path.file_name()) {
        (Some(parent), Some(name)) => realish(parent).join(name),
        _ => path.to_path_buf(),
    }
}

/// IP literals are never a generic embed's host, so they need no own-host entry.
fn is_ip_literal(host: &str) -> bool {
    let parts: Vec<&str> = host.split('.').collect();
    host.starts_with('[') || (parts.len() == 4 && parts.iter().all(|p| !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit())))
}

/// Our own hostnames for the generic tier's own-host rule, normalised.
pub fn own_hosts_for(site_origin: &str, public_origin: Option<&str>) -> Result<Vec<String>, ConfigError> {
    let mut hosts = vec![String::from("localhost")];
    for origin in std::iter::once(site_origin).chain(public_origin) {
        let url = Url::parse(origin).map_err(|_| fail("own host", format!("{origin:?} is not a URL")))?;
        let host = url.host_str().unwrap_or_default();
        if is_ip_literal(host) {
            continue;
        }
        let normal = normalize_hostname(host).ok_or_else(|| fail("own host", format!("{host:?} is not a hostname")))?;
        if !hosts.contains(&normal) {
            hosts.push(normal);
        }
    }
    Ok(hosts)
}

/// Parses the process environment; relative paths resolve against `cwd`.
pub fn parse_config(env: &Env, cwd: &Path) -> Result<ServerConfig, ConfigError> {
    parse_config_as(env, cwd, cfg!(debug_assertions))
}

/// `dev_build`: a debug build may default `DB_PATH` to the checkout; a release binary runs where
/// that path means nothing, so it must be told.
fn parse_config_as(env: &Env, cwd: &Path, dev_build: bool) -> Result<ServerConfig, ConfigError> {
    let get = |key: &str| env.get(key).map(String::as_str);

    let port = digits(get("PORT").unwrap_or("8787"), 5)
        .and_then(|p| u16::try_from(p).ok())
        .ok_or_else(|| fail("PORT", "must be 0–65535"))?;

    let hostname = get("HOST").unwrap_or("127.0.0.1");
    if hostname.is_empty() {
        return Err(fail("HOST", "must not be empty"));
    }

    let site_origin = parse_origin("SITE_ORIGIN", get("SITE_ORIGIN").unwrap_or("http://localhost:5173"), true)?;
    let public_origin = get("PUBLIC_ORIGIN")
        .map(|raw| parse_origin("PUBLIC_ORIGIN", raw, false))
        .transpose()?;

    let trust_proxy = match get("TRUST_PROXY").unwrap_or("off") {
        "loopback" => true,
        "off" => false,
        _ => return Err(fail("TRUST_PROXY", "must be loopback or off")),
    };

    let static_dir = match get("STATIC_DIR") {
        None => None,
        Some(raw) => {
            let dir = resolve(cwd, raw);
            if !dir.join("index.html").exists() {
                return Err(fail("STATIC_DIR", "has no index.html (run the site build first)"));
            }
            Some(dir)
        }
    };

    let extension_ids = match get("EXTENSION_IDS") {
        None => None,
        Some(raw) => {
            let ids: Vec<String> = raw.split(',').map(|s| js_trim(s).to_owned()).collect();
            if !ids
                .iter()
                .all(|id| id.len() == 32 && id.bytes().all(|b| (b'a'..=b'p').contains(&b)))
            {
                return Err(fail("EXTENSION_IDS", "expected comma-separated extension ids"));
            }
            Some(ids)
        }
    };

    let db_path = match get("DB_PATH") {
        None if dev_build => DbPath::File(default_db_path()),
        None => return Err(fail("DB_PATH", "must be set (a release build has no default)")),
        Some("") => return Err(fail("DB_PATH", "must not be empty")),
        Some(":memory:") => DbPath::Memory,
        Some(raw) => DbPath::File(resolve(cwd, raw)),
    };
    // The static site must never be able to hand out the database.
    if let (Some(site), DbPath::File(db)) = (&static_dir, &db_path)
        && (db.starts_with(site) || realish(db).starts_with(realish(site)))
    {
        return Err(fail("DB_PATH", "must not be inside STATIC_DIR"));
    }

    let metrics_port = match get("METRICS_PORT").unwrap_or("off") {
        "off" => None,
        raw => Some(
            digits(raw, 5)
                .and_then(|p| u16::try_from(p).ok())
                .ok_or_else(|| fail("METRICS_PORT", "must be off or 0–65535"))?,
        ),
    };
    if metrics_port.is_some_and(|m| m != 0 && m == port) {
        return Err(fail("METRICS_PORT", "must differ from PORT"));
    }

    let max_connections = match get("MAX_CONNECTIONS") {
        None => DEFAULT_MAX_CONNECTIONS,
        Some(raw) => digits(raw, 4)
            .filter(|n| (1..=MAX_CONNECTIONS_CEILING).contains(n))
            .ok_or_else(|| fail("MAX_CONNECTIONS", format!("must be an integer from 1 to {MAX_CONNECTIONS_CEILING}")))?,
    };

    let resume_grace_ms = match get("RESUME_GRACE_MS") {
        None => RESUME_GRACE_MS,
        Some(raw) => digits(raw, 6)
            .filter(|n| (RESUME_GRACE_MIN_MS..=RESUME_GRACE_MAX_MS).contains(n))
            .ok_or_else(|| {
                fail(
                    "RESUME_GRACE_MS",
                    format!("must be an integer from {RESUME_GRACE_MIN_MS} to {RESUME_GRACE_MAX_MS} (ms)"),
                )
            })?,
    };

    let generic_embeds = match get("GENERIC_EMBEDS").unwrap_or("on") {
        "on" => true,
        "off" => false,
        _ => return Err(fail("GENERIC_EMBEDS", "must be on or off")),
    };

    let generic_embed_denylist = match get("GENERIC_EMBED_DENYLIST").unwrap_or("") {
        "" => vec![],
        raw => raw
            .split(',')
            .map(|d| normalize_hostname(d).ok_or_else(|| fail("GENERIC_EMBED_DENYLIST", "expected comma-separated domains")))
            .collect::<Result<_, _>>()?,
    };

    let own_hosts = own_hosts_for(&site_origin, public_origin.as_deref())?;
    let room_title_blocklist = get("ROOM_TITLE_BLOCKLIST")
        .unwrap_or("")
        .split(',')
        .map(js_trim)
        .filter(|t| !t.is_empty())
        .map(str::to_owned)
        .collect();

    Ok(ServerConfig {
        port,
        hostname: hostname.to_owned(),
        site_origin,
        public_origin,
        trust_proxy,
        static_dir,
        extension_ids,
        db_path,
        generic_embeds,
        generic_embed_denylist,
        own_hosts,
        room_title_blocklist,
        metrics_port,
        max_connections,
        resume_grace_ms,
        max_http_in_flight: DEFAULT_MAX_HTTP_IN_FLIGHT,
    })
}

/// The operator CLI's Unix socket: `ADMIN_SOCKET`, else `admin.sock` beside `DB_PATH`, so it shares
/// the DB's owner-only directory. None when `ADMIN_SOCKET=off` or the DB is `:memory:`.
pub fn admin_socket_for(env: &Env, cwd: &Path) -> Result<Option<PathBuf>, ConfigError> {
    match env.get("ADMIN_SOCKET").map(String::as_str) {
        Some("off") => Ok(None),
        Some("") => Err(fail("ADMIN_SOCKET", "must not be empty")),
        Some(raw) => Ok(Some(resolve(cwd, raw))),
        None => match env.get("DB_PATH").map(String::as_str) {
            Some(":memory:") => Ok(None),
            Some(raw) => Ok(Some(resolve(cwd, raw).with_file_name("admin.sock"))),
            None => Ok(Some(default_db_path().with_file_name("admin.sock"))),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn env(pairs: &[(&str, &str)]) -> Env {
        pairs.iter().map(|(k, v)| ((*k).to_owned(), (*v).to_owned())).collect()
    }

    fn cwd() -> PathBuf {
        PathBuf::from("/srv/omega")
    }

    fn parse(pairs: &[(&str, &str)]) -> Result<ServerConfig, ConfigError> {
        parse_config(&env(pairs), &cwd())
    }

    fn ok(pairs: &[(&str, &str)]) -> ServerConfig {
        parse(pairs).unwrap_or_else(|e| panic!("{pairs:?} refused: {e}"))
    }

    /// A built site: a temp dir with an index.html.
    fn dist() -> tempfile::TempDir {
        let dir = tempfile::Builder::new().prefix("omega-dist-").tempdir().unwrap();
        fs::write(dir.path().join("index.html"), "<!doctype html>").unwrap();
        dir
    }

    fn refuses(pairs: &[(&str, &str)], key: &str) {
        match parse(pairs) {
            Ok(cfg) => panic!("{pairs:?} accepted: {cfg:?}"),
            Err(e) => assert!(e.to_string().contains(key), "{pairs:?}: {e} does not name {key}"),
        }
    }

    #[test]
    fn defaults_to_local_dev() {
        assert_eq!(
            ok(&[]),
            ServerConfig {
                port: 8787,
                hostname: "127.0.0.1".into(),
                site_origin: "http://localhost:5173".into(),
                public_origin: None,
                trust_proxy: false,
                static_dir: None,
                extension_ids: None,
                db_path: DbPath::File(default_db_path()),
                generic_embeds: true,
                generic_embed_denylist: vec![],
                own_hosts: vec!["localhost".into()],
                room_title_blocklist: vec![],
                metrics_port: None,
                max_connections: 1024,
                resume_grace_ms: 120_000,
                max_http_in_flight: 256,
            }
        );
    }

    #[test]
    fn reads_tunnel_mode() {
        let site = dist();
        let static_dir = site.path().to_str().unwrap();
        assert_eq!(
            ok(&[
                ("PORT", "9000"),
                ("HOST", "::1"),
                ("PUBLIC_ORIGIN", "https://quiet-otter.ngrok-free.app"),
                ("TRUST_PROXY", "loopback"),
                ("STATIC_DIR", static_dir),
                (
                    "EXTENSION_IDS",
                    "abcdefghijklmnopabcdefghijklmnop, ponmlkjihgfedcbaponmlkjihgfedcba"
                ),
            ]),
            ServerConfig {
                port: 9000,
                hostname: "::1".into(),
                site_origin: "http://localhost:5173".into(),
                public_origin: Some("https://quiet-otter.ngrok-free.app".into()),
                trust_proxy: true,
                static_dir: Some(site.path().to_path_buf()),
                extension_ids: Some(vec![
                    "abcdefghijklmnopabcdefghijklmnop".into(),
                    "ponmlkjihgfedcbaponmlkjihgfedcba".into()
                ]),
                db_path: DbPath::File(default_db_path()),
                generic_embeds: true,
                generic_embed_denylist: vec![],
                own_hosts: vec!["localhost".into(), "quiet-otter.ngrok-free.app".into()],
                room_title_blocklist: vec![],
                metrics_port: None,
                max_connections: 1024,
                resume_grace_ms: 120_000,
                max_http_in_flight: 256,
            }
        );
    }

    #[test]
    fn normalizes_a_public_origins_case_and_trailing_slash() {
        assert_eq!(
            ok(&[("PUBLIC_ORIGIN", "https://Quiet-Otter.ngrok-free.app/")])
                .public_origin
                .as_deref(),
            Some("https://quiet-otter.ngrok-free.app")
        );
    }

    #[test]
    fn trust_proxy_off_is_the_same_as_unset() {
        assert!(!ok(&[("TRUST_PROXY", "off")]).trust_proxy);
    }

    #[test]
    fn refuses_bad_values_naming_the_variable() {
        for (key, value) in [
            ("PORT", "80000"),
            ("PORT", "eighty"),
            ("PORT", ""),
            ("PORT", "+80"),
            ("PUBLIC_ORIGIN", "http://quiet-otter.ngrok-free.app"),
            ("PUBLIC_ORIGIN", "https://quiet-otter.ngrok-free.app/room"),
            ("PUBLIC_ORIGIN", "https://quiet-otter.ngrok-free.app?x=1"),
            ("PUBLIC_ORIGIN", "https://quiet-otter.ngrok-free.app?"),
            ("PUBLIC_ORIGIN", "https://quiet-otter.ngrok-free.app#"),
            ("SITE_ORIGIN", "http://localhost:5173?"),
            ("PUBLIC_ORIGIN", "https://user:pw@quiet-otter.ngrok-free.app"),
            ("PUBLIC_ORIGIN", "not a url"),
            ("SITE_ORIGIN", "http://example.com"),
            ("SITE_ORIGIN", "http://localhost:5173/app"),
            ("TRUST_PROXY", "true"),
            ("TRUST_PROXY", "all"),
            ("STATIC_DIR", "/nonexistent/omega-dist"),
            ("EXTENSION_IDS", "not-an-id"),
            ("HOST", ""),
            ("DB_PATH", ""),
        ] {
            refuses(&[(key, value)], key);
        }
    }

    #[test]
    fn a_static_dir_without_index_html_is_refused() {
        let empty = tempfile::Builder::new().prefix("omega-empty-").tempdir().unwrap();
        refuses(&[("STATIC_DIR", empty.path().to_str().unwrap())], "STATIC_DIR");
    }

    #[test]
    fn an_http_site_origin_is_fine_on_loopback_https_anywhere() {
        for o in ["http://127.0.0.1:5173", "http://[::1]:5173", "https://omega.example"] {
            assert_eq!(ok(&[("SITE_ORIGIN", o)]).site_origin, o);
        }
    }

    #[test]
    fn generic_embeds_is_on_unless_off() {
        assert!(ok(&[("GENERIC_EMBEDS", "on")]).generic_embeds);
        assert!(!ok(&[("GENERIC_EMBEDS", "off")]).generic_embeds);
        for bad in ["", "true", "1", "OFF", "yes"] {
            refuses(&[("GENERIC_EMBEDS", bad)], "GENERIC_EMBEDS");
        }
    }

    #[test]
    fn generic_embed_denylist_is_comma_separated_normalised_domains() {
        assert_eq!(ok(&[("GENERIC_EMBED_DENYLIST", "")]).generic_embed_denylist, Vec::<String>::new());
        assert_eq!(
            ok(&[("GENERIC_EMBED_DENYLIST", " Bad.Video.net. , evil.tv")]).generic_embed_denylist,
            vec!["bad.video.net", "evil.tv"]
        );
        for raw in ["evil.tv/path", "evil.tv:443", "user@evil.tv", "evil.tv,,", "https://evil.tv"] {
            refuses(&[("GENERIC_EMBED_DENYLIST", raw)], "GENERIC_EMBED_DENYLIST");
        }
    }

    #[test]
    fn own_hosts_are_localhost_site_and_public_hosts_without_ip_literals() {
        assert_eq!(
            ok(&[
                ("SITE_ORIGIN", "https://Watch.Example.org"),
                ("PUBLIC_ORIGIN", "https://quiet-otter.ngrok-free.app")
            ])
            .own_hosts,
            vec!["localhost", "watch.example.org", "quiet-otter.ngrok-free.app"]
        );
        assert_eq!(ok(&[("SITE_ORIGIN", "http://127.0.0.1:5173")]).own_hosts, vec!["localhost"]);
        assert_eq!(ok(&[("SITE_ORIGIN", "http://[::1]:5173")]).own_hosts, vec!["localhost"]);
        // The same host twice is listed once.
        assert_eq!(
            ok(&[("SITE_ORIGIN", "https://omega.example"), ("PUBLIC_ORIGIN", "https://omega.example")]).own_hosts,
            vec!["localhost", "omega.example"]
        );
    }

    #[test]
    fn room_title_blocklist_is_trimmed_terms_without_empties() {
        assert_eq!(ok(&[]).room_title_blocklist, Vec::<String>::new());
        assert_eq!(ok(&[("ROOM_TITLE_BLOCKLIST", "")]).room_title_blocklist, Vec::<String>::new());
        assert_eq!(
            ok(&[("ROOM_TITLE_BLOCKLIST", " spam , Scam,,")]).room_title_blocklist,
            vec!["spam", "Scam"]
        );
    }

    #[test]
    fn db_path_takes_memory_as_is_and_resolves_a_relative_path() {
        assert_eq!(ok(&[("DB_PATH", ":memory:")]).db_path, DbPath::Memory);
        assert_eq!(
            ok(&[("DB_PATH", "omega.db")]).db_path,
            DbPath::File(PathBuf::from("/srv/omega/omega.db"))
        );
        assert_eq!(
            ok(&[("DB_PATH", "data/../x/./omega.db")]).db_path,
            DbPath::File(PathBuf::from("/srv/omega/x/omega.db"))
        );
    }

    #[test]
    fn refuses_a_db_path_inside_static_dir_however_spelled() {
        let site = dist();
        let s = site.path().to_str().unwrap();
        for p in [
            format!("{s}/omega.db"),
            format!("{s}/assets/omega.db"),
            format!("{s}/./x/../omega.db"),
        ] {
            refuses(&[("STATIC_DIR", s), ("DB_PATH", &p)], "DB_PATH");
        }
    }

    #[test]
    fn refuses_a_db_path_reached_through_a_symlink_into_static_dir() {
        let site = dist();
        let links = tempfile::Builder::new().prefix("omega-link-").tempdir().unwrap();
        let link = links.path().join("site");
        std::os::unix::fs::symlink(site.path(), &link).unwrap();
        let db = link.join("omega.db");
        refuses(
            &[("STATIC_DIR", site.path().to_str().unwrap()), ("DB_PATH", db.to_str().unwrap())],
            "DB_PATH",
        );
    }

    #[test]
    fn a_sibling_directory_that_only_shares_the_prefix_is_fine() {
        let site = dist();
        let s = site.path().to_str().unwrap();
        let p = format!("{s}-data/omega.db");
        assert_eq!(ok(&[("STATIC_DIR", s), ("DB_PATH", &p)]).db_path, DbPath::File(PathBuf::from(p)));
    }

    #[test]
    fn metrics_port_off_or_unset_means_none() {
        assert_eq!(ok(&[]).metrics_port, None);
        assert_eq!(ok(&[("METRICS_PORT", "off")]).metrics_port, None);
        assert_eq!(ok(&[("METRICS_PORT", "9464")]).metrics_port, Some(9464));
        for bad in ["", "abc", "70000", "-1"] {
            refuses(&[("METRICS_PORT", bad)], "METRICS_PORT");
        }
        refuses(&[("PORT", "9000"), ("METRICS_PORT", "9000")], "METRICS_PORT");
        // Two ephemeral ports never collide.
        assert_eq!(ok(&[("PORT", "0"), ("METRICS_PORT", "0")]).metrics_port, Some(0));
    }

    #[test]
    fn max_connections_is_1_to_3072() {
        assert_eq!(ok(&[]).max_connections, 1024);
        for (raw, want) in [("1", 1), ("600", 600), ("3072", 3072)] {
            assert_eq!(ok(&[("MAX_CONNECTIONS", raw)]).max_connections, want);
        }
        for bad in ["", "0", "-1", "1.5", "abc", "1e3", "3073", "99999999"] {
            refuses(&[("MAX_CONNECTIONS", bad)], "MAX_CONNECTIONS");
        }
    }

    #[test]
    fn resume_grace_ms_is_5000_to_600000() {
        assert_eq!(ok(&[]).resume_grace_ms, crate::contract::session::RESUME_GRACE_MS);
        for (raw, want) in [("40000", 40_000), ("5000", 5_000), ("600000", 600_000)] {
            assert_eq!(ok(&[("RESUME_GRACE_MS", raw)]).resume_grace_ms, want);
        }
        for bad in ["", "4999", "600001", "1.5", "abc", "-40000", "4e4", "99999999"] {
            refuses(&[("RESUME_GRACE_MS", bad)], "RESUME_GRACE_MS");
        }
    }

    // apps/server/test/http-limits.test.ts:132,161 (`maxHttpInFlight`); zero is legal and refuses everything
    #[test]
    fn max_http_in_flight_defaults_to_256_and_may_be_zero() {
        assert_eq!(ok(&[]).max_http_in_flight, 256);
        for (raw, want) in [("1", 1), ("0", 0), ("256", 256), ("99999", 99_999)] {
            assert_eq!(ok(&[("MAX_HTTP_IN_FLIGHT", raw)]).max_http_in_flight, want);
        }
        for bad in ["", "-1", "1.5", "abc", "1e3", "1000000"] {
            refuses(&[("MAX_HTTP_IN_FLIGHT", bad)], "MAX_HTTP_IN_FLIGHT");
        }
    }

    #[test]
    fn admin_socket_defaults_beside_the_db() {
        let cwd = cwd();
        assert_eq!(admin_socket_for(&env(&[("ADMIN_SOCKET", "off")]), &cwd), Ok(None));
        assert_eq!(admin_socket_for(&env(&[("DB_PATH", ":memory:")]), &cwd), Ok(None));
        assert_eq!(
            admin_socket_for(&env(&[("DB_PATH", "/var/lib/omega-share/omega.db")]), &cwd),
            Ok(Some(PathBuf::from("/var/lib/omega-share/admin.sock")))
        );
        assert_eq!(
            admin_socket_for(&env(&[("ADMIN_SOCKET", "run/a.sock")]), &cwd),
            Ok(Some(PathBuf::from("/srv/omega/run/a.sock")))
        );
        assert!(admin_socket_for(&env(&[("ADMIN_SOCKET", "")]), &cwd).is_err());
        assert_eq!(
            admin_socket_for(&env(&[]), &cwd),
            Ok(Some(default_db_path().with_file_name("admin.sock")))
        );
    }

    #[test]
    fn a_release_build_requires_db_path() {
        match parse_config_as(&env(&[]), &cwd(), false) {
            Ok(cfg) => panic!("accepted without DB_PATH: {cfg:?}"),
            Err(e) => assert!(e.to_string().contains("DB_PATH"), "{e}"),
        }
        let cfg = parse_config_as(&env(&[("DB_PATH", "/var/lib/omega-share/omega.db")]), &cwd(), false).unwrap();
        assert_eq!(cfg.db_path, DbPath::File(PathBuf::from("/var/lib/omega-share/omega.db")));
        assert_eq!(
            parse_config_as(&env(&[("DB_PATH", ":memory:")]), &cwd(), false).unwrap().db_path,
            DbPath::Memory
        );
    }

    #[test]
    fn env_refuses_non_utf8_in_a_variable_we_read() {
        use std::os::unix::ffi::OsStringExt;
        let bad = || OsString::from_vec(b"/tmp/\xff.db".to_vec());
        let os = |k: &str, v: OsString| (OsString::from(k), v);
        match env_from_os([os("PORT", "9000".into()), os("DB_PATH", bad())]) {
            Ok(env) => panic!("accepted: {env:?}"),
            Err(e) => assert_eq!(e.key, "DB_PATH"),
        }
        // Variables we don't read, and non-UTF-8 names, are skipped.
        let env = env_from_os([
            os("PORT", "9000".into()),
            os("LS_COLORS", bad()),
            (OsString::from_vec(b"\xff".to_vec()), "x".into()),
        ])
        .unwrap();
        assert_eq!(env, Env::from([("PORT".to_owned(), "9000".to_owned())]));
    }
}
