//! The operator's way in (threat model 4.2 E, ADR 0028 takedowns; port of `apps/server/src/admin.ts`): a tiny HTTP API
//! on an owner-only Unix socket, never on TCP, so only the service user (and root) can reach it. `cli.rs` is its one
//! client. It lives in the server process because a takedown must end the live room through `App::remove_room`
//! (sockets closed, grants revoked) and a pin must reach GC's memory.
//!
//!   GET    /rooms                       every room, private ones included, never a secret or a hash
//!   DELETE /rooms/:id                   remove the room, then the row
//!   POST   /rooms/:id/pin               GC never collects it
//!   POST   /rooms/:id/unpin             GC may collect it again
//!   POST   /rooms/:id/takedown          ends the room for good (ADR 0033 section 5): 4006, tombstone, reports actioned
//!   GET    /reports                     open abuse reports, grouped by room
//!   POST   /reports/:id/dismiss         dismisses one report
//!   POST   /rooms/:id/reports/dismiss   dismisses the room's open reports

use crate::app::App;
use crate::contract::ids::RoomId;
use crate::contract::room::RoomVisibility;
use crate::registry::RemoveReason;
use crate::reports;
use crate::store::{ReportId, StoreError};
use axum::Router;
use axum::body::Bytes;
use axum::extract::{DefaultBodyLimit, State};
use axum::http::{HeaderValue, Method, StatusCode, Uri, header};
use axum::response::{IntoResponse, Response};
use serde::Serialize;
use std::os::unix::fs::{DirBuilderExt, FileTypeExt, MetadataExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tokio::net::UnixListener;
use tokio::task::JoinHandle;

/// `maxRequestBodySize: 1024`: the CLI sends no body at all.
const MAX_BODY_BYTES: usize = 1024;

/// One answer: a status and a JSON body.
#[derive(Debug, PartialEq, Eq)]
pub struct Reply {
    pub status: u16,
    pub body: String,
}

/// Why the admin socket could not start.
#[derive(Debug)]
pub enum AdminError {
    /// The path is taken by something that is not a socket.
    NotSocket(PathBuf),
    /// It is a socket, but another user's: not ours to remove.
    NotOurs(PathBuf),
    Io(String),
}

impl std::fmt::Display for AdminError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NotSocket(p) => write!(f, "admin socket {}: exists and is not a socket", p.display()),
            Self::NotOurs(p) => write!(f, "admin socket {}: exists and belongs to another user", p.display()),
            Self::Io(e) => f.write_str(e),
        }
    }
}

impl std::error::Error for AdminError {}

impl From<std::io::Error> for AdminError {
    fn from(e: std::io::Error) -> Self {
        Self::Io(e.to_string())
    }
}

// ---- the routes

#[derive(Serialize)]
struct ErrorBody<'a> {
    error: &'a str,
}

/// One `GET /rooms` entry (`AdminRoomSchema`): never a secret or a hash, so the fields are listed here by hand.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AdminRoom {
    id: String,
    title: String,
    visibility: RoomVisibility,
    created_at: i64,
    last_active_at: Option<i64>,
    pinned: bool,
    members: usize,
}

#[derive(Serialize)]
struct RoomList {
    rooms: Vec<AdminRoom>,
}

#[derive(Serialize)]
struct ReportList {
    rooms: Vec<reports::AdminReportRoom>,
}

#[derive(Serialize)]
struct Deleted<'a> {
    deleted: &'a str,
}

#[derive(Serialize)]
struct Pinned<'a> {
    pinned: bool,
    id: &'a str,
}

#[derive(Serialize)]
struct Dismissed {
    dismissed: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TakenDown<'a> {
    taken_down: &'a str,
    live: bool,
}

fn json<T: Serialize>(status: u16, body: &T) -> Reply {
    Reply {
        status,
        body: serde_json::to_string(body).unwrap_or_else(|_| r#"{"error":"encode"}"#.to_owned()),
    }
}

fn error(status: u16, message: &str) -> Reply {
    json(status, &ErrorBody { error: message })
}

fn store_failed(err: &StoreError) -> Reply {
    error(500, &err.to_string())
}

fn not_allowed() -> Reply {
    error(405, "method not allowed")
}

fn no_room(id: &RoomId) -> Reply {
    error(404, &format!("no room {}", id.as_str()))
}

/// Every room, oldest first, ties by id.
fn list_rooms(app: &App) -> Reply {
    let mut rooms: Vec<AdminRoom> = app
        .registry
        .values()
        .iter()
        .filter_map(|cell| {
            let inner = cell.lock_open()?;
            Some(AdminRoom {
                id: cell.id.as_str().to_owned(),
                title: inner.room.title().map_or_else(String::new, |t| t.as_str().to_owned()),
                visibility: inner.room.visibility,
                created_at: inner.room.created_at,
                last_active_at: inner.room.last_active_at,
                pinned: inner.room.pinned,
                members: inner.room.member_count(),
            })
        })
        .collect();
    rooms.sort_by(|a, b| a.created_at.cmp(&b.created_at).then_with(|| a.id.cmp(&b.id)));
    json(200, &RoomList { rooms })
}

fn pin(app: &App, id: &RoomId, pinned: bool) -> Reply {
    let Some(cell) = app.registry.get(id) else { return no_room(id) };
    let Some(mut inner) = cell.lock_open() else { return no_room(id) };
    // A seeded room has no owner to delete it; unpinned, GC would end it and only a restart re-seeds it.
    if !pinned && !inner.room.has_owner() {
        return error(
            409,
            &format!(
                "{} is a seeded room with no owner: it stays pinned (delete it instead)",
                id.as_str()
            ),
        );
    }
    // Store first: if the write fails, memory still matches the row.
    if let Err(err) = app.store().rooms().set_pinned(id, pinned) {
        return store_failed(&err);
    }
    inner.room.pinned = pinned;
    json(200, &Pinned { pinned, id: id.as_str() })
}

fn delete(app: &App, id: &RoomId) -> Reply {
    let live = app.remove_room(id, RemoveReason::Closed);
    // The removal already deleted the row; this catches one a failed earlier delete left behind.
    let stored = match app.store().rooms().delete_room(id) {
        Ok(stored) => stored,
        Err(err) => return store_failed(&err),
    };
    if live || stored {
        json(200, &Deleted { deleted: id.as_str() })
    } else {
        no_room(id)
    }
}

fn report_route(app: &App, method: &str, raw: &str) -> Reply {
    let Some(id) = ReportId::parse(raw) else {
        return error(404, "not found");
    };
    if method != "POST" {
        return not_allowed();
    }
    match reports::dismiss(app, &id) {
        Ok(0) => error(404, &format!("no open report {}", id.as_str())),
        Ok(n) => json(200, &Dismissed { dismissed: n }),
        Err(err) => store_failed(&err),
    }
}

fn room_route(app: &App, method: &str, raw: &str, verb: Option<&str>) -> Reply {
    let Some(id) = RoomId::parse(raw) else {
        return error(404, "not found");
    };
    let Some(verb) = verb else {
        return if method == "DELETE" { delete(app, &id) } else { not_allowed() };
    };
    if method != "POST" {
        return not_allowed();
    }
    match verb {
        // A room that is no longer live may still be reported, and taken down.
        "reports/dismiss" => match reports::dismiss_room(app, &id) {
            Ok(n) => json(200, &Dismissed { dismissed: n }),
            Err(err) => store_failed(&err),
        },
        "takedown" => match reports::takedown(app, &id) {
            Ok(done) => json(
                200,
                &TakenDown {
                    taken_down: id.as_str(),
                    live: done.live,
                },
            ),
            Err(err) => store_failed(&err),
        },
        "pin" => pin(app, &id, true),
        "unpin" => pin(app, &id, false),
        _ => error(404, "not found"),
    }
}

/// `handle`: one request against the app. Never panics; a failing store answers 500 with its message.
pub fn handle(app: &App, method: &str, path: &str) -> Reply {
    if path == "/rooms" {
        return if method == "GET" { list_rooms(app) } else { not_allowed() };
    }
    if path == "/reports" {
        if method != "GET" {
            return not_allowed();
        }
        return match reports::list(app) {
            Ok(rooms) => json(200, &ReportList { rooms }),
            Err(err) => store_failed(&err),
        };
    }
    if let Some(raw) = path.strip_prefix("/reports/").and_then(|rest| rest.strip_suffix("/dismiss")) {
        return report_route(app, method, raw);
    }
    let Some(rest) = path.strip_prefix("/rooms/") else {
        return error(404, "not found");
    };
    let (raw, verb) = match rest.split_once('/') {
        None => (rest, None),
        Some((raw, verb)) => (raw, Some(verb)),
    };
    if verb.is_some_and(|v| !["pin", "unpin", "takedown", "reports/dismiss"].contains(&v)) {
        return error(404, "not found");
    }
    room_route(app, method, raw, verb)
}

async fn serve_request(State(app): State<Arc<App>>, method: Method, uri: Uri, _body: Bytes) -> Response {
    let reply = handle(&app, method.as_str(), uri.path());
    let status = StatusCode::from_u16(reply.status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
    let mut response = (status, reply.body).into_response();
    response
        .headers_mut()
        .insert(header::CONTENT_TYPE, HeaderValue::from_static("application/json"));
    response
}

// ---- the socket

/// Removes a socket file a crashed server left behind; refuses anything else at that path: a regular file, a
/// symlink (even to a socket), a directory, or a socket another user owns. `uid` is ours.
pub fn clear_stale_socket(path: &Path, uid: u32) -> Result<(), AdminError> {
    let meta = match std::fs::symlink_metadata(path) {
        Ok(meta) => meta,
        Err(_) => return Ok(()),
    };
    if !meta.file_type().is_socket() {
        return Err(AdminError::NotSocket(path.to_path_buf()));
    }
    if meta.uid() != uid {
        return Err(AdminError::NotOurs(path.to_path_buf()));
    }
    std::fs::remove_file(path)?;
    Ok(())
}

/// The running admin listener.
pub struct AdminServer {
    task: JoinHandle<()>,
    path: PathBuf,
}

/// A private (0700) directory beside `socket` to bind in, so the socket never exists with a mode someone else can
/// use (the TS server binds under umask 0177 for the same reason; a process-wide umask change is not thread-safe).
fn private_dir(socket: &Path) -> Result<PathBuf, AdminError> {
    let parent = socket
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .map_or_else(|| PathBuf::from("."), Path::to_path_buf);
    let mut random = [0u8; 8];
    getrandom::fill(&mut random).map_err(|_| AdminError::Io("no entropy".to_owned()))?;
    let name: String = random.iter().map(|b| format!("{b:02x}")).collect();
    let dir = parent.join(format!(".omega-admin-{name}"));
    std::fs::DirBuilder::new().mode(0o700).create(&dir)?;
    Ok(dir)
}

fn bind_secured(app: Arc<App>, socket: &Path, dir: &Path) -> Result<AdminServer, AdminError> {
    clear_stale_socket(socket, std::fs::metadata(dir)?.uid())?;
    let staged = dir.join("s");
    let listener = UnixListener::bind(&staged)?;
    std::fs::set_permissions(&staged, std::fs::Permissions::from_mode(0o600))?;
    std::fs::rename(&staged, socket)?;
    let router = Router::new()
        .fallback(serve_request)
        .layer(DefaultBodyLimit::max(MAX_BODY_BYTES))
        .with_state(app);
    let task = tokio::spawn(async move {
        // The listener ends only when the task is aborted at shutdown; an accept error is retried by axum.
        let _ = axum::serve(listener, router).await;
    });
    Ok(AdminServer {
        task,
        path: socket.to_path_buf(),
    })
}

/// Listens on `socket`, mode 0600 from the moment it exists. Fails if the path is taken by something that is not
/// a socket of ours, or if the socket can't be secured; then nothing is left listening.
pub fn start_admin(app: Arc<App>, socket: &Path) -> Result<AdminServer, AdminError> {
    let dir = private_dir(socket)?;
    let started = bind_secured(app, socket, &dir);
    // Whatever happened, the staging directory and anything left in it go.
    let _ = std::fs::remove_dir_all(&dir);
    started
}

impl AdminServer {
    /// Stops listening and removes the socket file.
    pub async fn stop(self) {
        self.task.abort();
        let _ = self.task.await;
        let _ = std::fs::remove_file(&self.path);
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::indexing_slicing, reason = "tests")]
mod tests {
    use super::*;
    use crate::app::testing::{T0, add_room, app, rid};
    use crate::contract::constants::close;
    use crate::outbox::{ConnId, Outbound, channel};
    use crate::room::RoomInit;
    use crate::store::{NewReport, ReportId};
    use serde_json::{Value, json};
    use std::io::{Read, Write};
    use std::os::unix::fs::{FileTypeExt, PermissionsExt};
    use std::os::unix::net::UnixStream;

    const A: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaa";
    const B: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbb";
    const REPORT: &str = "AAAAAAAAAAAAAAAAAAAAAA";

    fn owned(created_at: i64, title: &str) -> RoomInit {
        RoomInit {
            pinned: Some(false),
            owner_hash: Some([7; 32]),
            created_at: Some(created_at),
            title: crate::contract::text::RoomTitle::parse(title),
            ..RoomInit::default()
        }
    }

    fn call(app: &App, method: &str, path: &str) -> (u16, Value) {
        let reply = handle(app, method, path);
        (reply.status, serde_json::from_str(&reply.body).unwrap_or(Value::Null))
    }

    fn stored_ids(app: &App) -> Vec<String> {
        app.store()
            .rooms()
            .list_rooms()
            .unwrap()
            .into_iter()
            .map(|r| r.id.as_str().to_owned())
            .collect()
    }

    // apps/server/test/cli.test.ts:60
    #[test]
    fn the_list_has_every_field_oldest_first_then_by_id() {
        let (app, _) = app();
        add_room(&app, B, owned(T0 - 1000, "Film club"));
        add_room(&app, A, owned(T0, ""));
        add_room(&app, "lobby", RoomInit::default());
        let reply = handle(&app, "GET", "/rooms");
        assert_eq!(reply.status, 200);
        assert_eq!(
            reply.body,
            format!(
                r#"{{"rooms":[{{"id":"{B}","title":"Film club","visibility":"public","createdAt":{},"lastActiveAt":null,"pinned":false,"members":0}},{{"id":"{A}","title":"","visibility":"public","createdAt":{T0},"lastActiveAt":null,"pinned":false,"members":0}},{{"id":"lobby","title":"","visibility":"public","createdAt":{T0},"lastActiveAt":null,"pinned":true,"members":0}}]}}"#,
                T0 - 1000
            )
        );
    }

    // apps/server/test/cli.test.ts:80
    #[test]
    fn private_rooms_are_listed_and_no_secret_or_hash_is() {
        let (app, _) = app();
        let mut init = owned(T0, "Secret club");
        init.visibility = Some(crate::contract::room::RoomVisibility::Private);
        init.invite_hash = Some([9; 32]);
        add_room(&app, A, init);
        let reply = handle(&app, "GET", "/rooms");
        assert!(reply.body.contains(r#""visibility":"private""#), "{}", reply.body);
        let lower = reply.body.to_lowercase();
        for word in ["hash", "owner", "invite", "token", "0707"] {
            assert!(!lower.contains(word), "{word} in {lower}");
        }
    }

    // apps/server/test/cli.test.ts:116
    #[test]
    fn delete_ends_the_room_closes_its_sockets_and_removes_the_row() {
        let (app, _) = app();
        let cell = add_room(&app, A, owned(T0, "Takedown me"));
        let (outbox, mut rx) = channel();
        cell.lock().attach_socket(ConnId::next(), outbox).unwrap();
        let (status, body) = call(&app, "DELETE", &format!("/rooms/{A}"));
        assert_eq!((status, body), (200, json!({"deleted": A})));
        assert!(matches!(rx.try_recv(), Some(Outbound::Close(c, _)) if c == close::ROOM_CLOSED));
        assert!(app.registry.get(&rid(A)).is_none());
        assert!(!stored_ids(&app).contains(&A.to_owned()));
    }

    // apps/server/test/cli.test.ts:140
    #[test]
    fn delete_of_an_unknown_room_is_404_and_changes_nothing() {
        let (app, _) = app();
        add_room(&app, "lobby", RoomInit::default());
        let (status, body) = call(&app, "DELETE", &format!("/rooms/{B}"));
        assert_eq!((status, body), (404, json!({"error": format!("no room {B}")})));
        assert!(app.registry.get(&rid("lobby")).is_some());
    }

    // apps/server/test/cli.test.ts:158
    #[test]
    fn delete_removes_a_row_the_live_server_no_longer_has() {
        let (app, _) = app();
        add_room(&app, A, owned(T0, "Leftover"));
        // In the store, not in memory: what a removal whose row delete failed leaves behind.
        app.registry.remove(&rid(A)).unwrap();
        assert!(stored_ids(&app).contains(&A.to_owned()));
        let (status, body) = call(&app, "DELETE", &format!("/rooms/{A}"));
        assert_eq!((status, body), (200, json!({"deleted": A})));
        assert!(!stored_ids(&app).contains(&A.to_owned()));
    }

    // apps/server/test/cli.test.ts:171
    #[test]
    fn pin_and_unpin_change_memory_and_store() {
        let (app, _) = app();
        let cell = add_room(&app, A, owned(T0, "Keep me"));
        let (status, body) = call(&app, "POST", &format!("/rooms/{A}/pin"));
        assert_eq!((status, body), (200, json!({"pinned": true, "id": A})));
        assert!(cell.lock().room.pinned);
        assert!(
            app.store()
                .rooms()
                .list_rooms()
                .unwrap()
                .iter()
                .any(|r| r.id.as_str() == A && r.pinned)
        );
        let (status, body) = call(&app, "POST", &format!("/rooms/{A}/unpin"));
        assert_eq!((status, body), (200, json!({"pinned": false, "id": A})));
        assert!(!cell.lock().room.pinned);
        assert!(
            app.store()
                .rooms()
                .list_rooms()
                .unwrap()
                .iter()
                .any(|r| r.id.as_str() == A && !r.pinned)
        );
    }

    // apps/server/test/cli.test.ts:200
    #[test]
    fn unpin_refuses_a_seeded_room_with_no_owner() {
        let (app, _) = app();
        let cell = add_room(&app, "lobby", RoomInit::default());
        let (status, body) = call(&app, "POST", "/rooms/lobby/unpin");
        assert_eq!(
            (status, body),
            (
                409,
                json!({"error": "lobby is a seeded room with no owner: it stays pinned (delete it instead)"})
            )
        );
        assert!(cell.lock().room.pinned);
        assert!(
            app.store()
                .rooms()
                .list_rooms()
                .unwrap()
                .iter()
                .any(|r| r.id.as_str() == "lobby" && r.pinned)
        );
    }

    // apps/server/test/cli.test.ts:210
    #[test]
    fn pinning_an_unknown_room_is_404() {
        let (app, _) = app();
        for verb in ["pin", "unpin"] {
            let (status, body) = call(&app, "POST", &format!("/rooms/{B}/{verb}"));
            assert_eq!((status, body), (404, json!({"error": format!("no room {B}")})), "{verb}");
        }
    }

    // apps/server/test/cli.test.ts:292
    #[test]
    fn only_its_routes_answer_other_methods_405_other_paths_404() {
        let (app, _) = app();
        let cell = add_room(&app, "lobby", RoomInit::default());
        for (method, path, status) in [
            ("PUT", "/rooms", 405),
            ("GET", "/rooms/lobby", 405),
            ("GET", "/rooms/lobby/pin", 405),
            ("POST", "/rooms/lobby/frob", 404),
            ("DELETE", "/rooms/LOBBY", 404),
            ("GET", "/", 404),
            ("POST", "/reports", 405),
            ("GET", "/reports/AAAAAAAAAAAAAAAAAAAAAA/dismiss", 405),
            ("POST", "/reports/short/dismiss", 404),
            ("POST", "/rooms/lobby/reports", 404),
            ("GET", "/rooms/lobby/takedown", 405),
            ("GET", "/rooms/", 404),
            ("GET", "/rooms/lobby/pin/extra", 404),
        ] {
            assert_eq!(handle(&app, method, path).status, status, "{method} {path}");
        }
        assert!(cell.lock().room.pinned);
        assert_eq!(handle(&app, "GET", "/").body, r#"{"error":"not found"}"#);
        assert_eq!(handle(&app, "PUT", "/rooms").body, r#"{"error":"method not allowed"}"#);
    }

    // apps/server/test/takedown.test.ts:107
    #[test]
    fn takedown_closes_members_with_4006_tombstones_the_id_and_counts_once() {
        let (app, _) = app();
        let cell = add_room(&app, A, owned(T0, "Bad"));
        let (outbox, mut rx) = channel();
        cell.lock().attach_socket(ConnId::next(), outbox).unwrap();
        let (status, body) = call(&app, "POST", &format!("/rooms/{A}/takedown"));
        assert_eq!((status, body), (200, json!({"takenDown": A, "live": true})));
        assert!(matches!(rx.try_recv(), Some(Outbound::Close(c, _)) if c == close::TAKEN_DOWN));
        assert!(app.registry.get(&rid(A)).is_none());
        assert!(app.reports.is_taken_down(&rid(A)));
        assert!(!stored_ids(&app).contains(&A.to_owned()));
        // A re-run is still 200, no longer live, and doesn't count again.
        let (status, body) = call(&app, "POST", &format!("/rooms/{A}/takedown"));
        assert_eq!((status, body), (200, json!({"takenDown": A, "live": false})));
        let text = app.metrics.render(&crate::metrics::Gauges::default());
        assert!(text.contains("omega_takedowns_total 1\n"), "{text}");
    }

    // apps/server/test/takedown.test.ts:235
    #[test]
    fn a_room_that_is_no_longer_live_is_still_tombstoned() {
        let (app, _) = app();
        let (status, body) = call(&app, "POST", &format!("/rooms/{B}/takedown"));
        assert_eq!((status, body), (200, json!({"takenDown": B, "live": false})));
        assert!(app.reports.is_taken_down(&rid(B)));
    }

    fn file_report(app: &App, id: &str, room: &str) {
        app.store()
            .reports()
            .add(&NewReport {
                id: ReportId::parse(id).unwrap(),
                room_id: rid(room),
                reason: "spam".into(),
                note: Some("buy now".into()),
                room_title: Some("Film club".into()),
                embed_url: None,
                created_at: T0,
            })
            .unwrap();
    }

    // apps/server/test/takedown.test.ts:262
    #[test]
    fn reports_list_dismiss_one_and_dismiss_a_room() {
        let (app, _) = app();
        add_room(&app, A, owned(T0, "Film club"));
        assert_eq!(handle(&app, "GET", "/reports").body, r#"{"rooms":[]}"#);
        file_report(&app, REPORT, A);
        let (status, body) = call(&app, "GET", "/reports");
        assert_eq!(status, 200);
        assert_eq!(
            body,
            json!({"rooms": [{"id": A, "state": "live", "title": "Film club", "visibility": "public", "members": 0, "reports": [
                {"id": REPORT, "createdAt": T0, "reason": "spam", "note": "buy now", "title": "Film club", "embedUrl": null}
            ]}]})
        );
        // apps/server/test/takedown.test.ts:313
        let (status, body) = call(&app, "POST", &format!("/reports/{REPORT}/dismiss"));
        assert_eq!((status, body), (200, json!({"dismissed": 1})));
        let (status, body) = call(&app, "POST", &format!("/reports/{REPORT}/dismiss"));
        assert_eq!((status, body), (404, json!({"error": format!("no open report {REPORT}")})));
        // apps/server/test/takedown.test.ts:326
        file_report(&app, "BBBBBBBBBBBBBBBBBBBBBB", A);
        file_report(&app, "CCCCCCCCCCCCCCCCCCCCCC", A);
        let (status, body) = call(&app, "POST", &format!("/rooms/{A}/reports/dismiss"));
        assert_eq!((status, body), (200, json!({"dismissed": 2})));
        assert_eq!(handle(&app, "GET", "/reports").body, r#"{"rooms":[]}"#);
    }

    fn tmp() -> (tempfile::TempDir, PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("admin.sock");
        (dir, path)
    }

    /// One request over the socket, as the CLI sends it.
    fn over_socket(path: &Path, request: &str) -> String {
        let mut stream = UnixStream::connect(path).unwrap();
        stream.write_all(request.as_bytes()).unwrap();
        let mut out = String::new();
        stream.read_to_string(&mut out).unwrap();
        out
    }

    // apps/server/test/cli.test.ts:244
    #[tokio::test(flavor = "multi_thread")]
    async fn the_socket_is_owner_only_serves_and_goes_away_on_stop() {
        let (app, _) = app();
        add_room(&app, "lobby", RoomInit::default());
        let (_dir, path) = tmp();
        let server = start_admin(app, &path).unwrap();
        assert_eq!(std::fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
        let answer = over_socket(&path, "GET /rooms HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n");
        assert!(answer.starts_with("HTTP/1.1 200"), "{answer}");
        assert!(answer.to_lowercase().contains("content-type: application/json"), "{answer}");
        assert!(answer.contains(r#""id":"lobby""#), "{answer}");
        server.stop().await;
        assert!(!path.exists());
    }

    // apps/server/test/cli.test.ts:244
    #[tokio::test(flavor = "multi_thread")]
    async fn a_stale_socket_from_a_crash_is_replaced() {
        let (app, _) = app();
        let (_dir, path) = tmp();
        drop(std::os::unix::net::UnixListener::bind(&path).unwrap());
        assert!(std::fs::symlink_metadata(&path).unwrap().file_type().is_socket());
        let server = start_admin(app, &path).unwrap();
        let answer = over_socket(&path, "GET /rooms HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n");
        assert!(answer.starts_with("HTTP/1.1 200"), "{answer}");
        server.stop().await;
    }

    // apps/server/test/cli.test.ts:310
    #[tokio::test(flavor = "multi_thread")]
    async fn a_path_that_is_not_a_socket_is_refused_and_left_alone() {
        let (app, _) = app();
        let (dir, path) = tmp();
        std::fs::write(&path, "not a socket").unwrap();
        let err = start_admin(app.clone(), &path).err().unwrap();
        assert!(err.to_string().contains("not a socket"), "{err}");
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "not a socket");
        // A symlink is not "really a socket we own" either, even one that points at a socket.
        let real = dir.path().join("real.sock");
        drop(std::os::unix::net::UnixListener::bind(&real).unwrap());
        let link = dir.path().join("link.sock");
        std::os::unix::fs::symlink(&real, &link).unwrap();
        assert!(start_admin(app, &link).is_err());
        assert!(std::fs::symlink_metadata(&link).unwrap().file_type().is_symlink());
        assert!(real.exists());
    }

    // apps/server/test/cli.test.ts:292
    #[tokio::test(flavor = "multi_thread")]
    async fn a_body_over_1_kb_is_refused() {
        let (app, _) = app();
        add_room(&app, "lobby", RoomInit::default());
        let (_dir, path) = tmp();
        let server = start_admin(app.clone(), &path).unwrap();
        let body = "x".repeat(2048);
        let request =
            format!("POST /rooms/lobby/pin HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\nContent-Length: 2048\r\n\r\n{body}");
        let answer = over_socket(&path, &request);
        assert!(answer.starts_with("HTTP/1.1 413"), "{answer}");
        server.stop().await;
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, reason = "tests")]
mod long_path_tests {
    use super::*;
    use crate::app::testing::app;
    use std::os::unix::fs::PermissionsExt;

    // sun_path holds 107 bytes: a final path that fits must start even when a staging path beside it would not.
    #[tokio::test(flavor = "multi_thread")]
    async fn a_socket_path_near_the_unix_limit_still_binds_owner_only() {
        let (app, _) = app();
        let dir = tempfile::tempdir().unwrap();
        let mut parent = dir.path().to_path_buf();
        while parent.as_os_str().len() < 85 {
            parent.push("deeper-dir");
        }
        std::fs::create_dir_all(&parent).unwrap();
        let path = parent.join("a.sock");
        assert!(path.as_os_str().len() < 107 && path.as_os_str().len() > 90);
        let server = start_admin(app, &path).unwrap();
        assert_eq!(std::fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
        server.stop().await;
        assert!(!path.exists());
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn nothing_is_left_beside_the_socket() {
        let (app, _) = app();
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("admin.sock");
        let server = start_admin(app, &path).unwrap();
        let names: Vec<_> = std::fs::read_dir(dir.path()).unwrap().map(|e| e.unwrap().file_name()).collect();
        assert_eq!(names, ["admin.sock"]);
        server.stop().await;
    }
}
