//! The API routes of http.ts: `GET /healthz`, `GET /rooms`, `POST /rooms`, `DELETE /rooms/:id`,
//! `POST /rooms/:id/share|queue|report`. Rooms are entered only through `App::with_open_room`, and the registry is
//! never touched with a room lock held.

use super::Cx;
use super::body::{BodyError, declared_too_large, read_capped};
use super::respond::{self, TEXT, failure, json, with_type};
use crate::app::{App, lock};
use crate::contract::constants::{
    MAX_CREATE_BODY_BYTES, MAX_LISTED_ROOMS, MAX_REPORT_BODY_BYTES, MAX_SHARE_BODY_BYTES, RETRY_AFTER_MAX_MS,
    ROOM_CREATE_RETRY_AFTER_MAX_MS,
};
use crate::contract::ids::{RoomId, ShareToken, parse_bearer};
use crate::contract::layout::RoomPresetId;
use crate::contract::requests::{parse_create_room_request, parse_report_request, parse_share_request};
use crate::contract::responses::{
    CreateOk, CreateRoomErrorCode, CreateRoomResponse, CreatedRoom, DeleteOk, DeleteRoomErrorCode, DeleteRoomResponse, QueueAddOk,
    QueueAddResponse, ReportErrorCode, ReportOk, ReportResponse, ReportStatus, RoomListResponse, ShareErrorCode, ShareOk, ShareResponse,
};
use crate::contract::room::{ControlPolicy, RoomVisibility};
use crate::contract::server_message::ServerMessage;
use crate::contract::state::RoomSummary;
use crate::log::{LogEvent, log_error};
use crate::outbox::publish_msg;
use crate::presets::Presets;
use crate::queue::{QueueActor, QueueAddRefusal, QueueRefusal, add, admit};
use crate::registry::{RoomInner, ShareGrant};
use crate::reports::{FileResult, admit_key, count, file};
use crate::room::{Room, RoomInit};
use crate::secrets::{hash_secret, mint_invite_key, mint_item_id, mint_owner_token, new_room_id};
use crate::store::NewRoom;
use axum::http::header::{AUTHORIZATION, CACHE_CONTROL, CONTENT_TYPE};
use axum::http::{HeaderValue, StatusCode};
use axum::response::Response;
use serde::de::IgnoredAny;
use std::cmp::Ordering;
use std::sync::LazyLock;

/// Per client and per member: 5 shares at once, then one every 3 s (the member's own are in `ShareGrant`).
const SHARE_PER_SECOND: f64 = crate::registry::SHARE_PER_SECOND;
/// All shares together, whatever the key (ADR 0015 section 6): bounds many-address floods.
pub const GLOBAL_SHARE_BURST: f64 = 20.0;
pub const GLOBAL_SHARE_PER_SECOND: f64 = 2.0;
/// Per client: unauthorized share attempts (bad or missing token).
pub const FAILED_SHARE_BURST: f64 = 20.0;
pub const FAILED_SHARE_PER_SECOND: f64 = 1.0;
/// Per client: failed `DELETE /rooms/:id` attempts (bad or missing owner token), as for shares.
pub const FAILED_DELETE_BURST: f64 = 20.0;
pub const FAILED_DELETE_PER_SECOND: f64 = 1.0;

/// The judged room presets, parsed once.
static PRESETS: LazyLock<Option<Presets>> = LazyLock::new(|| Presets::load().ok());

type Created = CreateRoomResponse;

fn no_store(res: &mut Response) {
    res.headers_mut().insert(CACHE_CONTROL, HeaderValue::from_static("no-store"));
}

/// `application/json`, any case, with or without parameters (`JSON_TYPE`): any other type is a CORS simple request a
/// hostile page can send without a preflight, and so without our origin allowlist (OME-698).
fn is_json(cx: &Cx) -> bool {
    let Some(ct) = cx.headers.get(CONTENT_TYPE).and_then(|v| v.to_str().ok()) else {
        return false;
    };
    let Some(head) = ct.get(.."application/json".len()) else {
        return false;
    };
    head.eq_ignore_ascii_case("application/json") && {
        let rest = ct.get("application/json".len()..).unwrap_or("");
        // `\s*(?:;|$)`
        let rest = rest.trim_start_matches(crate::contract::js_compat::is_js_whitespace);
        rest.is_empty() || rest.starts_with(';')
    }
}

fn bearer(cx: &Cx) -> Option<ShareToken> {
    cx.headers.get(AUTHORIZATION).and_then(|v| v.to_str().ok()).and_then(parse_bearer)
}

/// `JSON.parse` of a body read as UTF-8 text (invalid bytes become U+FFFD, as `Buffer.toString` does): whether it
/// is JSON at all. The shape is the schema's business.
fn is_json_text(text: &str) -> bool {
    serde_json::from_str::<IgnoredAny>(text).is_ok()
}

/// A request body as the TS handler reads it: refused while reading past `max`.
async fn read_body(cx: &mut Cx, max: usize) -> Result<String, BodyError> {
    let body = std::mem::take(&mut cx.body);
    let bytes = read_capped(body, max, cx.app.http.body_total()).await?;
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

// ---- GET /healthz

/// Readiness probe (supervisors, deploy.sh, the off-box monitor): 503 when the database can't be read.
pub fn healthz(app: &App) -> Response {
    let ok = app.store().reports().ping();
    let mut res = match ok {
        Ok(()) => with_type(StatusCode::OK, TEXT, "ok"),
        Err(err) => {
            log_error(LogEvent::StoreHealth, Some(&err));
            with_type(StatusCode::SERVICE_UNAVAILABLE, TEXT, "database unavailable")
        }
    };
    no_store(&mut res);
    res
}

// ---- GET /rooms

struct Listed {
    pinned: bool,
    created_at: i64,
    summary: RoomSummary,
}

/// Pinned rooms first, in seed order (the lobby leads), so a flood of new rooms can't push them out; then created
/// rooms, the busiest first, then the newest (research section 3.5).
fn list_order(a: &Listed, b: &Listed) -> Ordering {
    if a.pinned != b.pinned {
        return if a.pinned { Ordering::Less } else { Ordering::Greater };
    }
    if a.pinned {
        return a.created_at.cmp(&b.created_at);
    }
    b.summary
        .member_count
        .cmp(&a.summary.member_count)
        .then(b.created_at.cmp(&a.created_at))
}

/// Folding a title is about 10 us, so the verdict is kept per room (OME-439): keyed by the title it was made
/// for, so a title-set re-checks on the next list.
pub fn listable(app: &App, inner: &mut RoomInner) -> bool {
    if inner.room.visibility != RoomVisibility::Public {
        return false;
    }
    let title = inner.room.title().map_or("", |t| t.as_str());
    if inner.title_verdict.title.as_deref() != Some(title) {
        inner.title_verdict.blocked = app.title_blocked(title);
        inner.title_verdict.title = Some(title.to_owned());
    }
    !inner.title_verdict.blocked
}

pub fn list(app: &App) -> Response {
    // At most MAX_ROOMS (500) rooms: filtering and sorting them per request is microseconds (research P2).
    let mut listed = Vec::new();
    for cell in app.registry.values() {
        let mut inner = cell.lock();
        if listable(app, &mut inner) {
            listed.push(Listed {
                pinned: inner.room.pinned,
                created_at: inner.room.created_at,
                summary: inner.room.summary(),
            });
        }
    }
    listed.sort_by(list_order);
    let rooms = listed.into_iter().take(MAX_LISTED_ROOMS).map(|l| l.summary).collect();
    json(StatusCode::OK, &RoomListResponse { rooms })
}

/// A link preview shows a room's title only where the lobby would list it, and never a taken-down room's.
pub fn preview_title(app: &App, id: &RoomId) -> Option<String> {
    if app.reports.is_taken_down(id) {
        return None;
    }
    app.with_open_room(id, |inner| {
        listable(app, inner)
            .then(|| inner.room.title().map(|t| t.as_str().to_owned()))
            .flatten()
    })
    .flatten()
}

// ---- POST /rooms

pub async fn create(mut cx: Cx) -> Response {
    let app = cx.app.clone();
    let invalid = |status: StatusCode, code: CreateRoomErrorCode, message: &str| {
        let mut res = failure::<CreateOk, _, ROOM_CREATE_RETRY_AFTER_MAX_MS>(status, code, message, None);
        no_store(&mut res);
        res
    };
    let limited = |retry_ms: u64| {
        // Not RETRY_AFTER_MAX_MS: the per-key bucket refills in 10 min, and a shorter answer only earns more refusals.
        let ms = retry_ms.clamp(1000, ROOM_CREATE_RETRY_AFTER_MAX_MS);
        let mut res = failure::<CreateOk, _, ROOM_CREATE_RETRY_AFTER_MAX_MS>(
            StatusCode::TOO_MANY_REQUESTS,
            CreateRoomErrorCode::RateLimited,
            "too many new rooms, try again later",
            Some(ms),
        );
        no_store(&mut res);
        res
    };
    // Before any bucket: a cross-site simple POST is refused for free (OME-698).
    if !is_json(&cx) {
        return invalid(
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
            CreateRoomErrorCode::InvalidBody,
            "expected application/json",
        );
    }
    let key = cx.key.clone();
    // Before reading the body: malformed spam costs a creation too (ADR 0028 section 1).
    {
        let now = app.mono();
        let mut api = lock(&app.http.api);
        if !api.creates.take(&key, now) {
            let wait = api.creates.retry_after_ms_capped(&key, now, ROOM_CREATE_RETRY_AFTER_MAX_MS as f64);
            return limited(wait as u64);
        }
    }
    let too_large = || {
        invalid(
            StatusCode::PAYLOAD_TOO_LARGE,
            CreateRoomErrorCode::PayloadTooLarge,
            "body too large",
        )
    };
    if declared_too_large(&cx.headers, MAX_CREATE_BODY_BYTES) {
        return too_large();
    }
    let text = match read_body(&mut cx, MAX_CREATE_BODY_BYTES).await {
        Ok(text) => text,
        Err(BodyError::TooLarge) => return too_large(),
        Err(BodyError::Failed) => return invalid(StatusCode::BAD_REQUEST, CreateRoomErrorCode::InvalidBody, "body is not JSON"),
    };
    if !is_json_text(&text) {
        return invalid(StatusCode::BAD_REQUEST, CreateRoomErrorCode::InvalidBody, "body is not JSON");
    }
    let Ok(request) = parse_create_room_request(text.as_bytes()) else {
        return invalid(
            StatusCode::BAD_REQUEST,
            CreateRoomErrorCode::InvalidBody,
            "expected { title, visibility, preset? }",
        );
    };
    let preset = request.preset.unwrap_or(RoomPresetId::Classic);
    let (title, visibility) = (request.title, request.visibility);
    if app.title_blocked(title.as_str()) {
        return invalid(
            StatusCode::BAD_REQUEST,
            CreateRoomErrorCode::InvalidBody,
            "that title isn't allowed",
        );
    }
    // Refuse, never evict: evicting would let anyone delete other people's rooms by creating new ones.
    if app.registry.len() >= app.config.max_rooms {
        return invalid(
            StatusCode::SERVICE_UNAVAILABLE,
            CreateRoomErrorCode::TooManyRooms,
            "too many rooms right now, try again later",
        );
    }
    {
        let now = app.mono();
        let mut api = lock(&app.http.api);
        if !api.global_creates.take(now) {
            let wait = api.global_creates.retry_after_ms_capped(now, ROOM_CREATE_RETRY_AFTER_MAX_MS as f64);
            return limited(wait as u64);
        }
    }
    let unavailable = || {
        // The server's failure, not the client's: it keeps its creations.
        let now = app.mono();
        let mut api = lock(&app.http.api);
        api.creates.refund(&key, now);
        api.global_creates.refund(now);
        drop(api);
        invalid(
            StatusCode::SERVICE_UNAVAILABLE,
            CreateRoomErrorCode::Unavailable,
            "can't create rooms right now, try again later",
        )
    };
    let (Some(presets), Ok(owner_token)) = (PRESETS.as_ref(), mint_owner_token()) else {
        return unavailable();
    };
    // 128 random bits: a clash with a live or taken-down room is never expected, but never reuse an id.
    let mut id = new_room_id();
    let id = loop {
        match id {
            Ok(candidate) if app.registry.get(&candidate).is_none() && !app.reports.is_taken_down(&candidate) => break candidate,
            Ok(_) => id = new_room_id(),
            Err(_) => return unavailable(),
        }
    };
    let invite_key = if visibility == RoomVisibility::Private {
        match mint_invite_key() {
            Ok(k) => Some(k),
            Err(_) => return unavailable(),
        }
    } else {
        None
    };
    let layout = presets.preset_layout(preset).clone();
    let created_at = app.wall();
    let new_room = NewRoom {
        id: id.clone(),
        title: Some(title.clone()),
        created_at,
        layout: layout.clone(),
        visibility,
        pinned: false,
        owner_hash: Some(hash_secret(owner_token.as_str())),
        invite_hash: invite_key.as_ref().map(|k| hash_secret(k.as_str())),
    };
    // Store first: if the write fails the creation fails, and memory never runs ahead of the DB.
    let written = app.store().rooms().create_room(&new_room);
    if let Err(err) = written {
        log_error(LogEvent::StoreNewRoom, Some(&err));
        return unavailable();
    }
    let init = RoomInit {
        layout: Some(layout),
        title: Some(title.clone()),
        visibility: Some(visibility),
        pinned: Some(false),
        created_at: Some(created_at),
        owner_hash: new_room.owner_hash,
        invite_hash: new_room.invite_hash,
        ..RoomInit::default()
    };
    let inserted = Room::new(id.clone(), init, created_at)
        .ok()
        .and_then(|room| app.insert_room(room).ok());
    if inserted.is_none() {
        return respond::internal_error();
    }
    let body: Created = Created::Ok(CreateOk {
        room: CreatedRoom { id, title, visibility },
        owner_token,
        invite_key,
    });
    let mut res = json(StatusCode::CREATED, &body);
    no_store(&mut res);
    res
}

// ---- DELETE /rooms/:id

pub fn delete(cx: &Cx, id: &str) -> Response {
    let app = &cx.app;
    let fail = |status: StatusCode, code: DeleteRoomErrorCode, message: &str, retry: Option<u64>| {
        failure::<DeleteOk, _, RETRY_AFTER_MAX_MS>(status, code, message, retry)
    };
    let not_found = || fail(StatusCode::NOT_FOUND, DeleteRoomErrorCode::RoomNotFound, "unknown room", None);
    let Some(room_id) = RoomId::parse(id) else {
        return not_found();
    };
    let token = bearer(cx);
    let Some(is_owner) = app.with_open_room(&room_id, |inner| token.as_ref().is_some_and(|t| inner.room.is_owner(t.as_str()))) else {
        return not_found();
    };
    if !is_owner {
        let now = app.mono();
        let mut api = lock(&app.http.api);
        if !api.failed_deletes.take(&cx.key, now) {
            let wait = (api.failed_deletes.retry_after_ms(&cx.key, now) as u64).max(1000);
            return fail(
                StatusCode::TOO_MANY_REQUESTS,
                DeleteRoomErrorCode::RateLimited,
                "too many attempts, slow down",
                Some(wait),
            );
        }
        return fail(
            StatusCode::UNAUTHORIZED,
            DeleteRoomErrorCode::Unauthorized,
            "only the room's owner can delete it",
            None,
        );
    }
    // The row first: "deleted" must mean the owner hash is gone from disk, not that it comes back at the next boot.
    let deleted = app.store().rooms().delete_room(&room_id);
    if let Err(err) = deleted {
        log_error(LogEvent::StoreDeleteRoom, Some(&err));
        return fail(
            StatusCode::SERVICE_UNAVAILABLE,
            DeleteRoomErrorCode::Unavailable,
            "couldn't delete the room right now, try again later",
            None,
        );
    }
    // Then the one path with GC and the operator: sockets close with ROOM_CLOSED, revoking their share grants.
    app.remove_room(&room_id, crate::registry::RemoveReason::Closed);
    json(StatusCode::OK, &DeleteRoomResponse::Ok(DeleteOk {}))
}

// ---- POST /rooms/:id/share

/// 429 for a bucket refilling at `per_second`. The wait is its refill period, an upper bound on the time to the
/// next token (TokenBucket doesn't expose its level).
fn limited_share(per_second: f64, message: &str) -> Response {
    let wait = (RETRY_AFTER_MAX_MS as f64).min((1000.0 / per_second).ceil()) as u64;
    failure::<ShareOk, _, RETRY_AFTER_MAX_MS>(StatusCode::TOO_MANY_REQUESTS, ShareErrorCode::RateLimited, message, Some(wait))
}

/// What a share token holds, copied out of the room's lock.
struct Held {
    member: crate::contract::ids::MemberId,
    owner: bool,
}

fn held(inner: &RoomInner, token: Option<&ShareToken>) -> Option<Held> {
    let grant = inner.grant(token?)?;
    Some(Held {
        member: grant.member_id.clone(),
        owner: grant.owner,
    })
}

pub async fn share(mut cx: Cx, id: &str) -> Response {
    let app = cx.app.clone();
    let fail =
        |status: StatusCode, code: ShareErrorCode, message: &str| failure::<ShareOk, _, RETRY_AFTER_MAX_MS>(status, code, message, None);
    let not_found = || fail(StatusCode::NOT_FOUND, ShareErrorCode::RoomNotFound, "unknown room");
    let Some(room_id) = RoomId::parse(id) else {
        return not_found();
    };
    let token = bearer(&cx);
    let Some((grant, owner_only)) = app.with_open_room(&room_id, |inner| {
        (held(inner, token.as_ref()), inner.room.control_policy() == ControlPolicy::Owner)
    }) else {
        return not_found();
    };
    // Failures have their own bucket, so guessing is bounded without locking out members on the same address.
    let Some(grant) = grant else {
        let now = app.mono();
        if !lock(&app.http.api).failed_shares.take(&cx.key, now) {
            return limited_share(FAILED_SHARE_PER_SECOND, "too many shares, slow down");
        }
        return fail(
            StatusCode::UNAUTHORIZED,
            ShareErrorCode::Unauthorized,
            "join the room to share into it",
        );
    };
    // Before any limiter: a refused share never uses up the sender's or the room's shares.
    if owner_only && !grant.owner {
        return fail(
            StatusCode::FORBIDDEN,
            ShareErrorCode::ControlOwnerOnly,
            "only the room's owner can change the video here",
        );
    }
    let now = app.mono();
    let per_ip = lock(&app.http.api).shares.take(&cx.key, now);
    let per_member = per_ip
        && app
            .with_open_room(&room_id, |inner| {
                token
                    .as_ref()
                    .and_then(|t| inner.grant_mut(t))
                    .is_some_and(|g: &mut ShareGrant| g.bucket.take(now))
            })
            .unwrap_or(false);
    if !per_member {
        return limited_share(SHARE_PER_SECOND, "too many shares, slow down");
    }
    if !lock(&app.http.api).global_shares.take(now) {
        return limited_share(GLOBAL_SHARE_PER_SECOND, "too many shares, slow down");
    }
    let too_large = || fail(StatusCode::PAYLOAD_TOO_LARGE, ShareErrorCode::PayloadTooLarge, "body too large");
    if declared_too_large(&cx.headers, MAX_SHARE_BODY_BYTES) {
        return too_large();
    }
    let text = match read_body(&mut cx, MAX_SHARE_BODY_BYTES).await {
        Ok(text) => text,
        Err(BodyError::TooLarge) => return too_large(),
        Err(BodyError::Failed) => return fail(StatusCode::BAD_REQUEST, ShareErrorCode::InvalidBody, "body is not JSON"),
    };
    // The room may have gone while the body arrived: never store or publish into it.
    if app.with_open_room(&room_id, |_| ()).is_none() {
        return not_found();
    }
    if !is_json_text(&text) {
        return fail(StatusCode::BAD_REQUEST, ShareErrorCode::InvalidBody, "body is not JSON");
    }
    let Ok(request) = parse_share_request(text.as_bytes()) else {
        return fail(StatusCode::BAD_REQUEST, ShareErrorCode::InvalidBody, "expected { url: string }");
    };
    // A denied host gets the same answer as any other refused URL (ADR 0024 section 6).
    let Some(embed) = app.embeds.accept(request.url()) else {
        return fail(StatusCode::BAD_REQUEST, ShareErrorCode::UnsupportedUrl, "not a supported video URL");
    };
    enum Done {
        Shared,
        Limited,
        Failed,
    }
    // Everything from here is synchronous under the room's lock: the bucket, the store, the embed, the frames.
    let done = app.with_open_room(&room_id, |inner| {
        // Last, so a refused request never uses up the room's switches.
        let now = app.mono();
        if !inner.share_bucket.take(now) {
            return Done::Limited;
        }
        // Store first: if the write fails the share fails, and memory never runs ahead of the DB.
        // A share replaces only the current item, under a fresh id (ADR 0031 section 1, section 5).
        let Ok(item_id) = mint_item_id() else {
            return Done::Failed;
        };
        let stored = app.store().rooms().set_embed(&room_id, Some(&embed), Some(&item_id));
        if let Err(err) = stored {
            log_error(LogEvent::StoreQueue, Some(&err));
            return Done::Failed;
        }
        let Ok(switch) = inner.room.set_embed(
            Some(embed.clone()),
            Some(grant.member.clone()),
            Some(item_id.clone()),
            request.start_seconds(),
            now,
            app.wall(),
        ) else {
            return Done::Failed;
        };
        publish_msg(
            inner,
            &ServerMessage::embed_changed(Some(embed.clone()), Some(grant.member.clone()), switch.playback, Some(item_id)),
        );
        for member_id in switch.uncaught {
            publish_msg(
                inner,
                &ServerMessage::MemberStatus {
                    member_id,
                    catching: false,
                },
            );
        }
        Done::Shared
    });
    match done {
        None => not_found(),
        Some(Done::Limited) => limited_share(crate::registry::ROOM_SHARE_PER_SECOND, "too many shares, slow down"),
        Some(Done::Failed) => respond::internal_error(),
        Some(Done::Shared) => json(StatusCode::OK, &ShareResponse::Ok(ShareOk { embed })),
    }
}

// ---- POST /rooms/:id/queue

/// The extension's "Add to queue" (ADR 0031 section 2): a share's token, body and parser, the WebSocket
/// `queue-add`'s checks and buckets.
pub async fn queue(mut cx: Cx, id: &str) -> Response {
    let app = cx.app.clone();
    let fail =
        |status: StatusCode, code: ShareErrorCode, message: &str| failure::<QueueAddOk, _, RETRY_AFTER_MAX_MS>(status, code, message, None);
    let not_found = || fail(StatusCode::NOT_FOUND, ShareErrorCode::RoomNotFound, "unknown room");
    let Some(room_id) = RoomId::parse(id) else {
        return not_found();
    };
    let token = bearer(&cx);
    let Some(grant) = app.with_open_room(&room_id, |inner| held(inner, token.as_ref())) else {
        return not_found();
    };
    let Some(grant) = grant else {
        let now = app.mono();
        if !lock(&app.http.api).failed_shares.take(&cx.key, now) {
            let wait = (RETRY_AFTER_MAX_MS as f64).min((1000.0 / FAILED_SHARE_PER_SECOND).ceil()) as u64;
            return failure::<QueueAddOk, _, RETRY_AFTER_MAX_MS>(
                StatusCode::TOO_MANY_REQUESTS,
                ShareErrorCode::RateLimited,
                "too many attempts, slow down",
                Some(wait),
            );
        }
        return fail(
            StatusCode::UNAUTHORIZED,
            ShareErrorCode::Unauthorized,
            "join the room to queue into it",
        );
    };
    let actor = QueueActor {
        member_id: grant.member.clone(),
        owner: grant.owner,
    };
    // Before the body is read: a flood can't buy URL parsing (ADR 0031 section 3).
    let admitted = app.with_open_room(&room_id, |inner| admit(&app, inner, &actor));
    match admitted {
        None | Some(Err(QueueRefusal::RoomClosed)) => return not_found(),
        Some(Err(QueueRefusal::ControlOwnerOnly)) => {
            return fail(
                StatusCode::FORBIDDEN,
                ShareErrorCode::ControlOwnerOnly,
                "only the room's owner changes the queue here",
            );
        }
        Some(Err(QueueRefusal::RateLimited { retry_after_ms })) => {
            return failure::<QueueAddOk, _, RETRY_AFTER_MAX_MS>(
                StatusCode::TOO_MANY_REQUESTS,
                ShareErrorCode::RateLimited,
                "too many videos queued, slow down",
                Some(retry_after_ms.max(1000)),
            );
        }
        Some(Ok(())) => {}
    }
    let too_large = || fail(StatusCode::PAYLOAD_TOO_LARGE, ShareErrorCode::PayloadTooLarge, "body too large");
    if declared_too_large(&cx.headers, MAX_SHARE_BODY_BYTES) {
        return too_large();
    }
    let text = match read_body(&mut cx, MAX_SHARE_BODY_BYTES).await {
        Ok(text) => text,
        Err(BodyError::TooLarge) => return too_large(),
        Err(BodyError::Failed) => return fail(StatusCode::BAD_REQUEST, ShareErrorCode::InvalidBody, "body is not JSON"),
    };
    // The room may have gone, or the member left, while the body arrived; or the owner closed the queue to guests.
    let still = app.with_open_room(&room_id, |inner| {
        held(inner, token.as_ref())
            .filter(|g| g.member == grant.member)
            .map(|_| inner.room.control_policy() == ControlPolicy::Owner && !grant.owner)
    });
    match still.flatten() {
        None => return not_found(),
        Some(true) => {
            return fail(
                StatusCode::FORBIDDEN,
                ShareErrorCode::ControlOwnerOnly,
                "only the room's owner changes the queue here",
            );
        }
        Some(false) => {}
    }
    if !is_json_text(&text) {
        return fail(StatusCode::BAD_REQUEST, ShareErrorCode::InvalidBody, "body is not JSON");
    }
    let Ok(request) = parse_share_request(text.as_bytes()) else {
        return fail(StatusCode::BAD_REQUEST, ShareErrorCode::InvalidBody, "expected { url: string }");
    };
    let added = app.with_open_room(&room_id, |inner| add(&app, inner, &actor, request.url(), request.start_seconds()));
    match added {
        None | Some(Err(QueueAddRefusal::RoomClosed)) => not_found(),
        Some(Ok(item)) => json(StatusCode::OK, &QueueAddResponse::Ok(QueueAddOk { item })),
        Some(Err(QueueAddRefusal::UnsupportedUrl)) => {
            fail(StatusCode::BAD_REQUEST, ShareErrorCode::UnsupportedUrl, "not a supported video URL")
        }
        Some(Err(QueueAddRefusal::QueueFull)) => fail(StatusCode::CONFLICT, ShareErrorCode::QueueFull, "the queue is full"),
        Some(Err(QueueAddRefusal::Unavailable)) => {
            respond::plain(StatusCode::SERVICE_UNAVAILABLE, "can't queue right now, try again later")
        }
    }
}

// ---- POST /rooms/:id/report

/// "Report this room" (ADR 0033): no token, no seat. Check order: content type, body size, room exists, key bucket,
/// parse, room bucket, duplicate, open cap, store, so an unknown id or a malformed body never drains the room's
/// bucket. Nothing about the request is logged or kept.
pub async fn report(mut cx: Cx, id: &str) -> Response {
    let app = cx.app.clone();
    let fail = |status: StatusCode, code: ReportErrorCode, message: &str| {
        count(&app, report_code(code));
        let mut res = failure::<ReportOk, _, { crate::contract::constants::REPORT_KEY_REFILL_MS }>(status, code, message, None);
        no_store(&mut res);
        res
    };
    let limited = |retry_ms: u64| {
        let mut res = failure::<ReportOk, _, { crate::contract::constants::REPORT_KEY_REFILL_MS }>(
            StatusCode::TOO_MANY_REQUESTS,
            ReportErrorCode::RateLimited,
            "too many reports, try again later",
            Some(retry_ms),
        );
        no_store(&mut res);
        res
    };
    // First: a cross-site simple POST is refused before it costs a bucket or a body read (OME-698).
    if !is_json(&cx) {
        return fail(
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
            ReportErrorCode::InvalidBody,
            "expected application/json",
        );
    }
    if declared_too_large(&cx.headers, MAX_REPORT_BODY_BYTES) {
        return fail(StatusCode::PAYLOAD_TOO_LARGE, ReportErrorCode::PayloadTooLarge, "body too large");
    }
    // A taken-down room is not in the registry: the same answer as an id that never existed.
    let room_id = RoomId::parse(id).filter(|r| app.with_open_room(r, |_| ()).is_some());
    let Some(room_id) = room_id else {
        return fail(StatusCode::NOT_FOUND, ReportErrorCode::RoomNotFound, "unknown room");
    };
    let wait = admit_key(&app, &cx.key);
    if wait > 0 {
        count(&app, "rate_limited");
        return limited(wait);
    }
    // Only now the body: a client that never sends it must have paid for the lookup and a token first (HTTP-2).
    let text = match read_body(&mut cx, MAX_REPORT_BODY_BYTES).await {
        Ok(text) => Some(text),
        Err(BodyError::TooLarge) => return fail(StatusCode::PAYLOAD_TOO_LARGE, ReportErrorCode::PayloadTooLarge, "body too large"),
        Err(BodyError::Failed) => None,
    };
    let Some(text) = text.filter(|t| is_json_text(t)) else {
        return fail(StatusCode::BAD_REQUEST, ReportErrorCode::InvalidBody, "body is not JSON");
    };
    let Ok(request) = parse_report_request(text.as_bytes()) else {
        return fail(StatusCode::BAD_REQUEST, ReportErrorCode::InvalidBody, "expected { reason, note? }");
    };
    let filed = app.with_open_room(&room_id, |inner| file(&app, inner, &cx.key, &request));
    match filed {
        None | Some(FileResult::RoomGone) => fail(StatusCode::NOT_FOUND, ReportErrorCode::RoomNotFound, "unknown room"),
        Some(FileResult::Received) => report_ok(StatusCode::ACCEPTED, ReportStatus::Received),
        Some(FileResult::AlreadyReported) => report_ok(StatusCode::OK, ReportStatus::AlreadyReported),
        Some(FileResult::RateLimited { retry_after_ms }) => limited(retry_after_ms),
        Some(FileResult::Unavailable) => {
            let mut res = failure::<ReportOk, _, { crate::contract::constants::REPORT_KEY_REFILL_MS }>(
                StatusCode::SERVICE_UNAVAILABLE,
                ReportErrorCode::Unavailable,
                "can't take reports right now, try again later",
                None,
            );
            no_store(&mut res);
            res
        }
    }
}

fn report_ok(status: StatusCode, report: ReportStatus) -> Response {
    let mut res = json(status, &ReportResponse::Ok(ReportOk { status: report }));
    no_store(&mut res);
    res
}

/// The metrics outcome name of a typed code.
const fn report_code(code: ReportErrorCode) -> &'static str {
    match code {
        ReportErrorCode::InvalidBody => "invalid_body",
        ReportErrorCode::PayloadTooLarge => "payload_too_large",
        ReportErrorCode::RoomNotFound => "room_not_found",
        ReportErrorCode::RateLimited => "rate_limited",
        ReportErrorCode::Unavailable => "unavailable",
    }
}
