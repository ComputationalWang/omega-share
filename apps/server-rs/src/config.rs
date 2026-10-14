//! Validated startup config (ADR 0015 §3), mirroring `apps/server/src/config.ts`. A bad value is an
//! error naming the variable; the process exits before listening.

use std::collections::HashMap;
use std::fmt;
use std::path::{Path, PathBuf};

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

/// Dev default for `DB_PATH`: `apps/server-rs/data/omega.db` (git-ignored), never under a static dir.
pub fn default_db_path() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("data/omega.db")
}

pub type Env = HashMap<String, String>;

/// Parses the process environment; relative paths resolve against `cwd`.
pub fn parse_config(env: &Env, cwd: &Path) -> Result<ServerConfig, ConfigError> {
    Err(ConfigError { key: "PORT", why: String::from("not yet parsed") })
}

/// The operator CLI's Unix socket: `ADMIN_SOCKET`, else `admin.sock` beside `DB_PATH`, so it shares
/// the DB's owner-only directory. None when `ADMIN_SOCKET=off` or the DB is `:memory:`.
pub fn admin_socket_for(env: &Env, cwd: &Path) -> Result<Option<PathBuf>, ConfigError> {
    Ok(None)
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
                ("EXTENSION_IDS", "abcdefghijklmnopabcdefghijklmnop, ponmlkjihgfedcbaponmlkjihgfedcba"),
            ]),
            ServerConfig {
                port: 9000,
                hostname: "::1".into(),
                site_origin: "http://localhost:5173".into(),
                public_origin: Some("https://quiet-otter.ngrok-free.app".into()),
                trust_proxy: true,
                static_dir: Some(site.path().to_path_buf()),
                extension_ids: Some(vec!["abcdefghijklmnopabcdefghijklmnop".into(), "ponmlkjihgfedcbaponmlkjihgfedcba".into()]),
                db_path: DbPath::File(default_db_path()),
                generic_embeds: true,
                generic_embed_denylist: vec![],
                own_hosts: vec!["localhost".into(), "quiet-otter.ngrok-free.app".into()],
                room_title_blocklist: vec![],
                metrics_port: None,
                max_connections: 1024,
                resume_grace_ms: 120_000,
            }
        );
    }

    #[test]
    fn normalizes_a_public_origins_case_and_trailing_slash() {
        assert_eq!(
            ok(&[("PUBLIC_ORIGIN", "https://Quiet-Otter.ngrok-free.app/")]).public_origin.as_deref(),
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
            ok(&[("SITE_ORIGIN", "https://Watch.Example.org"), ("PUBLIC_ORIGIN", "https://quiet-otter.ngrok-free.app")]).own_hosts,
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
        assert_eq!(ok(&[("ROOM_TITLE_BLOCKLIST", " spam , Scam,,")]).room_title_blocklist, vec!["spam", "Scam"]);
    }

    #[test]
    fn db_path_takes_memory_as_is_and_resolves_a_relative_path() {
        assert_eq!(ok(&[("DB_PATH", ":memory:")]).db_path, DbPath::Memory);
        assert_eq!(ok(&[("DB_PATH", "omega.db")]).db_path, DbPath::File(PathBuf::from("/srv/omega/omega.db")));
        assert_eq!(ok(&[("DB_PATH", "data/../x/./omega.db")]).db_path, DbPath::File(PathBuf::from("/srv/omega/x/omega.db")));
    }

    #[test]
    fn refuses_a_db_path_inside_static_dir_however_spelled() {
        let site = dist();
        let s = site.path().to_str().unwrap();
        for p in [format!("{s}/omega.db"), format!("{s}/assets/omega.db"), format!("{s}/./x/../omega.db")] {
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
        refuses(&[("STATIC_DIR", site.path().to_str().unwrap()), ("DB_PATH", db.to_str().unwrap())], "DB_PATH");
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

    #[test]
    fn admin_socket_defaults_beside_the_db() {
        let cwd = cwd();
        assert_eq!(admin_socket_for(&env(&[("ADMIN_SOCKET", "off")]), &cwd), Ok(None));
        assert_eq!(admin_socket_for(&env(&[("DB_PATH", ":memory:")]), &cwd), Ok(None));
        assert_eq!(
            admin_socket_for(&env(&[("DB_PATH", "/var/lib/omega-share/omega.db")]), &cwd),
            Ok(Some(PathBuf::from("/var/lib/omega-share/admin.sock")))
        );
        assert_eq!(admin_socket_for(&env(&[("ADMIN_SOCKET", "run/a.sock")]), &cwd), Ok(Some(PathBuf::from("/srv/omega/run/a.sock"))));
        assert!(admin_socket_for(&env(&[("ADMIN_SOCKET", "")]), &cwd).is_err());
        assert_eq!(admin_socket_for(&env(&[]), &cwd), Ok(Some(default_db_path().with_file_name("admin.sock"))));
    }
}
