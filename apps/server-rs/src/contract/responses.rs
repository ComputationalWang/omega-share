//! HTTP response bodies the server writes: `share.ts` (`ShareResponse`, `QueueAddResponse`),
//! `room-ownership.ts` (`CreateRoomResponse`, `DeleteRoomResponse`), `report.ts` (`ReportResponse`)
//! and `rooms-list.ts` (`RoomListResponse`), with the literals of `apps/server/src/http.ts`.
//!
//! Every success body is `{"ok":true, ...}` and every failure `{"ok":false,"error":{code,message,
//! retryAfterMs?}}`; [`Response`] is both, generic over the success payload, the error codes and the
//! `retryAfterMs` cap. Like the messages, each also has a strict `Deserialize` (tests, load generator).

use super::Obj;
use super::constants::{MAX_LISTED_ROOMS, REPORT_KEY_REFILL_MS, RETRY_AFTER_MAX_MS, ROOM_CREATE_RETRY_AFTER_MAX_MS};
use super::generic_embed::AnyEmbed;
use super::ids::{InviteKey, OwnerToken, RoomId};
use super::room::RoomVisibility;
use super::server_message::{ErrorMessage, RetryAfter};
use super::state::{QueueItem, RoomSummary, present, wire_type};
use super::text::RoomTitle;
use serde::de::Error as _;
use serde::{Deserialize, Deserializer, Serialize, Serializer};

/// `SHARE_ERROR_CODES`: errors of `POST /rooms/:id/share` and `/queue`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ShareErrorCode {
    InvalidBody,
    UnsupportedUrl,
    RoomNotFound,
    RateLimited,
    PayloadTooLarge,
    Unauthorized,
    ControlOwnerOnly,
    QueueFull,
}

/// `CREATE_ROOM_ERROR_CODES`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CreateRoomErrorCode {
    InvalidBody,
    PayloadTooLarge,
    RateLimited,
    TooManyRooms,
    Unavailable,
}

/// `DELETE_ROOM_ERROR_CODES`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DeleteRoomErrorCode {
    RoomNotFound,
    Unauthorized,
    RateLimited,
    Unavailable,
}

/// `REPORT_ERROR_CODES`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReportErrorCode {
    InvalidBody,
    PayloadTooLarge,
    RoomNotFound,
    RateLimited,
    Unavailable,
}

/// `REPORT_STATUSES`: `received` is HTTP 202, `already_reported` HTTP 200.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReportStatus {
    Received,
    AlreadyReported,
}

/// The `error` object of a failure. Only read through an `Obj` (see [`Response`]).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ErrorBody<C, const MAX: u64> {
    pub code: C,
    pub message: ErrorMessage,
    /// With `rate_limited`; the server also sends `Retry-After` in seconds.
    #[serde(default, deserialize_with = "present", skip_serializing_if = "Option::is_none")]
    pub retry_after_ms: Option<RetryAfter<MAX>>,
}

/// A body whose `ok` is exactly `B`.
struct OkLit<const B: bool>;

impl<'de, const B: bool> Deserialize<'de> for OkLit<B> {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        if bool::deserialize(d)? == B {
            Ok(Self)
        } else {
            Err(D::Error::custom("wrong ok"))
        }
    }
}

/// `v.variant("ok", [success, failure])`. `T` is the success payload, flattened next to `ok`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Response<T, C, const MAX: u64> {
    Ok(T),
    Err(ErrorBody<C, MAX>),
}

impl<T: Serialize, C: Serialize, const MAX: u64> Serialize for Response<T, C, MAX> {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        #[derive(Serialize)]
        struct Success<'a, T> {
            ok: bool,
            #[serde(flatten)]
            data: &'a T,
        }
        #[derive(Serialize)]
        struct Failure<'a, E> {
            ok: bool,
            error: &'a E,
        }
        match self {
            Self::Ok(data) => Success { ok: true, data }.serialize(s),
            Self::Err(error) => Failure { ok: false, error }.serialize(s),
        }
    }
}

impl<'de, T: Deserialize<'de>, C: Deserialize<'de>, const MAX: u64> Deserialize<'de> for Response<T, C, MAX> {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        #[derive(Deserialize)]
        struct Success<T> {
            #[allow(dead_code, reason = "only the literal is checked")]
            ok: OkLit<true>,
            #[serde(flatten)]
            data: T,
        }
        #[derive(Deserialize)]
        struct Failure<C, const MAX: u64> {
            #[allow(dead_code, reason = "only the literal is checked")]
            ok: OkLit<false>,
            error: Obj<ErrorBody<C, MAX>>,
        }
        #[derive(Deserialize)]
        #[serde(untagged)]
        enum Wire<T, C, const MAX: u64> {
            Success(Success<T>),
            Failure(Failure<C, MAX>),
        }
        let Obj(wire) = Obj::<Wire<T, C, MAX>>::deserialize(d)?;
        Ok(match wire {
            Wire::Success(s) => Self::Ok(s.data),
            Wire::Failure(f) => Self::Err(f.error.0),
        })
    }
}

/// Cap of `retryAfterMs` for share, queue and delete (`RETRY_AFTER_MAX_MS`).
const SHORT: u64 = RETRY_AFTER_MAX_MS;
/// A creation 429 may wait out the key bucket's full refill.
const CREATE: u64 = ROOM_CREATE_RETRY_AFTER_MAX_MS;
/// A report 429 may wait out the key bucket's full refill.
const REPORT: u64 = REPORT_KEY_REFILL_MS;

/// `POST /rooms/:id/share` success: `{"ok":true,"embed":...}`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ShareOk {
    pub embed: AnyEmbed,
}
pub type ShareResponse = Response<ShareOk, ShareErrorCode, SHORT>;

/// `POST /rooms/:id/queue` success: `{"ok":true,"item":{id,embed,by}}`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct QueueAddOk {
    pub item: QueueItem,
}
pub type QueueAddResponse = Response<QueueAddOk, ShareErrorCode, SHORT>;

/// The room a `POST /rooms` created. Only read through an `Obj`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CreatedRoom {
    pub id: RoomId,
    pub title: RoomTitle,
    pub visibility: RoomVisibility,
}

/// `POST /rooms` 201: `{"ok":true,"room":{id,title,visibility},"ownerToken":...,"inviteKey"?:...}`;
/// `inviteKey` iff the room is private. No `PartialEq`: it carries secrets.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", try_from = "CreateOkWire")]
pub struct CreateOk {
    pub room: CreatedRoom,
    pub owner_token: OwnerToken,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub invite_key: Option<InviteKey>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateOkWire {
    room: Obj<CreatedRoom>,
    owner_token: OwnerToken,
    #[serde(default, deserialize_with = "present")]
    invite_key: Option<InviteKey>,
}

impl TryFrom<CreateOkWire> for CreateOk {
    type Error = &'static str;

    fn try_from(w: CreateOkWire) -> Result<Self, Self::Error> {
        if w.invite_key.is_some() != (w.room.0.visibility == RoomVisibility::Private) {
            return Err("invite key iff private");
        }
        Ok(Self {
            room: w.room.0,
            owner_token: w.owner_token,
            invite_key: w.invite_key,
        })
    }
}
pub type CreateRoomResponse = Response<CreateOk, CreateRoomErrorCode, CREATE>;

/// `DELETE /rooms/:id` success: `{"ok":true}`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct DeleteOk {}
pub type DeleteRoomResponse = Response<DeleteOk, DeleteRoomErrorCode, SHORT>;

/// `POST /rooms/:id/report` success: `{"ok":true,"status":...}`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct ReportOk {
    pub status: ReportStatus,
}
pub type ReportResponse = Response<ReportOk, ReportErrorCode, REPORT>;

wire_type!(
    /// Body of `GET /rooms`: at most `MAX_LISTED_ROOMS` rooms.
    RoomListResponse, RoomListResponseWire, check = check_room_list,
    {
        rooms: Vec<RoomSummary>,
    }
);

fn check_room_list(r: &RoomListResponse) -> Result<(), &'static str> {
    if r.rooms.len() <= MAX_LISTED_ROOMS {
        Ok(())
    } else {
        Err("too many rooms")
    }
}

/// What the server writes for any response body.
pub fn to_body<T: Serialize>(body: &T) -> String {
    let _ = body; // red: stub
    String::new()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::de::DeserializeOwned;

    const YT: &str = r#"{"provider":"youtube","videoId":"dQw4w9WgXcQ","url":"https://www.youtube.com/embed/dQw4w9WgXcQ"}"#;
    const T1: &str = "AbCdEfGhIjKlMnOpQrStUv";
    const T2: &str = "zYxWvUtSrQpOnMlKjIhGfE";

    /// Parses `body` as `T` and writes it back: the same bytes when `body` is in the server's key order.
    fn same<T: DeserializeOwned + Serialize>(body: &str) {
        let parsed: T = serde_json::from_str(body).unwrap_or_else(|e| panic!("refused {body}: {e}"));
        assert_eq!(to_body(&parsed), body);
    }

    fn refused<T: DeserializeOwned>(body: &str) {
        assert!(serde_json::from_str::<T>(body).is_err(), "accepted: {body}");
    }

    // packages/shared/test/wire.test.ts:127 (ShareResponseSchema)
    #[test]
    fn share_response() {
        same::<ShareResponse>(&format!(r#"{{"ok":true,"embed":{YT}}}"#));
        same::<ShareResponse>(r#"{"ok":false,"error":{"code":"unsupported_url","message":"not a supported video URL"}}"#);
        same::<ShareResponse>(r#"{"ok":false,"error":{"code":"rate_limited","message":"slow down","retryAfterMs":1500}}"#);
        for code in [
            "invalid_body",
            "room_not_found",
            "payload_too_large",
            "unauthorized",
            "control_owner_only",
            "queue_full",
        ] {
            same::<ShareResponse>(&format!(r#"{{"ok":false,"error":{{"code":"{code}","message":""}}}}"#));
        }
        refused::<ShareResponse>(r#"{"ok":true}"#);
        refused::<ShareResponse>(r#"{"ok":true,"embed":{"provider":"youtube","videoId":"x","url":"https://www.youtube.com/embed/x"}}"#);
        refused::<ShareResponse>(r#"{"ok":false,"error":{"code":"teapot","message":""}}"#);
        refused::<ShareResponse>(r#"{"ok":false,"error":{"code":"invalid_body"}}"#);
        refused::<ShareResponse>(&format!(r#"{{"embed":{YT}}}"#));
        refused::<ShareResponse>(r#"{"ok":false,"error":["invalid_body","m"]}"#);
        refused::<ShareResponse>(r#"["ok"]"#);
        // retryAfterMs is capped at RETRY_AFTER_MAX_MS here (packages/shared/test/rooms-contract.test.ts:217)
        refused::<ShareResponse>(r#"{"ok":false,"error":{"code":"rate_limited","message":"m","retryAfterMs":60001}}"#);
    }

    // packages/shared/test/queue-contract.test.ts (QueueAddResponseSchema)
    #[test]
    fn queue_add_response() {
        same::<QueueAddResponse>(&format!(r#"{{"ok":true,"item":{{"id":"q1","embed":{YT},"by":"m1"}}}}"#));
        same::<QueueAddResponse>(&format!(r#"{{"ok":true,"item":{{"id":"q1","embed":{YT},"by":null}}}}"#));
        same::<QueueAddResponse>(r#"{"ok":false,"error":{"code":"queue_full","message":"the queue is full"}}"#);
        refused::<QueueAddResponse>(&format!(r#"{{"ok":true,"item":{{"id":"q1","embed":{YT}}}}}"#));
        refused::<QueueAddResponse>(r#"{"ok":true,"item":[]}"#);
    }

    // packages/shared/test/rooms-contract.test.ts:177..220
    #[test]
    fn create_room_response() {
        let room = |visibility: &str| format!(r#"{{"id":"film-club","title":"Friday films","visibility":"{visibility}"}}"#);
        same::<CreateRoomResponse>(&format!(r#"{{"ok":true,"room":{},"ownerToken":"{T1}"}}"#, room("public")));
        same::<CreateRoomResponse>(&format!(
            r#"{{"ok":true,"room":{},"ownerToken":"{T1}","inviteKey":"{T2}"}}"#,
            room("private")
        ));
        refused::<CreateRoomResponse>(&format!(r#"{{"ok":true,"room":{},"ownerToken":"{T1}"}}"#, room("private")));
        refused::<CreateRoomResponse>(&format!(
            r#"{{"ok":true,"room":{},"ownerToken":"{T1}","inviteKey":"{T2}"}}"#,
            room("public")
        ));
        refused::<CreateRoomResponse>(&format!(r#"{{"ok":true,"room":{}}}"#, room("public")));
        for code in ["invalid_body", "payload_too_large", "rate_limited", "too_many_rooms", "unavailable"] {
            same::<CreateRoomResponse>(&format!(r#"{{"ok":false,"error":{{"code":"{code}","message":"no"}}}}"#));
        }
        refused::<CreateRoomResponse>(r#"{"ok":false,"error":{"code":"room_not_found","message":"no"}}"#);
        // a creation 429 may wait out the key bucket's whole refill (10 min), nothing more
        let limited = |ms: &str| format!(r#"{{"ok":false,"error":{{"code":"rate_limited","message":"slow","retryAfterMs":{ms}}}}}"#);
        same::<CreateRoomResponse>(&limited("600000"));
        refused::<CreateRoomResponse>(&limited("600001"));
        refused::<CreateRoomResponse>(&limited("-1"));
        refused::<CreateRoomResponse>(&limited("1.5"));
    }

    // The secrets of a created room never reach Debug.
    #[test]
    fn owner_token_and_invite_key_stay_out_of_debug() {
        let body = format!(
            r#"{{"ok":true,"room":{{"id":"a","title":"Friday films","visibility":"private"}},"ownerToken":"{T1}","inviteKey":"{T2}"}}"#
        );
        let parsed: CreateRoomResponse = serde_json::from_str(&body).unwrap();
        let debug = format!("{parsed:?}");
        assert!(!debug.contains(T1) && !debug.contains(T2), "{debug}");
    }

    #[test]
    fn delete_and_report_responses() {
        same::<DeleteRoomResponse>(r#"{"ok":true}"#);
        for code in ["room_not_found", "unauthorized", "rate_limited", "unavailable"] {
            same::<DeleteRoomResponse>(&format!(r#"{{"ok":false,"error":{{"code":"{code}","message":"no"}}}}"#));
        }
        refused::<DeleteRoomResponse>(r#"{"ok":false,"error":{"code":"too_many_rooms","message":"no"}}"#);
        refused::<DeleteRoomResponse>(r#"{"ok":false,"error":{"code":"rate_limited","message":"x","retryAfterMs":60001}}"#);
        same::<ReportResponse>(r#"{"ok":true,"status":"received"}"#);
        same::<ReportResponse>(r#"{"ok":true,"status":"already_reported"}"#);
        same::<ReportResponse>(r#"{"ok":false,"error":{"code":"rate_limited","message":"x","retryAfterMs":600000}}"#);
        refused::<ReportResponse>(r#"{"ok":false,"error":{"code":"rate_limited","message":"x","retryAfterMs":600001}}"#);
        refused::<ReportResponse>(r#"{"ok":true,"status":"done"}"#);
        refused::<ReportResponse>(r#"{"ok":false,"error":{"code":"too_many_rooms","message":"no"}}"#);
        // message cap: 200 UTF-16 units
        same::<ReportResponse>(&format!(
            r#"{{"ok":false,"error":{{"code":"unavailable","message":"{}"}}}}"#,
            "😀".repeat(100)
        ));
        refused::<ReportResponse>(&format!(
            r#"{{"ok":false,"error":{{"code":"unavailable","message":"{}"}}}}"#,
            "😀".repeat(101)
        ));
    }

    // packages/shared/test/rooms-list.test.ts
    #[test]
    fn room_list_response() {
        same::<RoomListResponse>(r#"{"rooms":[]}"#);
        same::<RoomListResponse>(
            r#"{"rooms":[{"id":"lobby","memberCount":3,"seatedCount":2},{"id":"film-club","memberCount":25,"seatedCount":8,"title":"Friday films"}]}"#,
        );
        // unknown keys are stripped so the server can add fields
        let stripped: RoomListResponse =
            serde_json::from_str(r#"{"rooms":[{"id":"lobby","memberCount":0,"seatedCount":0,"name":"Lobby"}],"next":null}"#).unwrap();
        assert_eq!(to_body(&stripped), r#"{"rooms":[{"id":"lobby","memberCount":0,"seatedCount":0}]}"#);
        for bad in [
            r#"{"id":"lobby","memberCount":26,"seatedCount":0}"#,
            r#"{"id":"lobby","memberCount":-1,"seatedCount":0}"#,
            r#"{"id":"lobby","memberCount":1.5,"seatedCount":0}"#,
            r#"{"id":"lobby","memberCount":10,"seatedCount":9}"#,
            r#"{"id":"lobby","memberCount":1,"seatedCount":2}"#,
            r#"{"id":"Lobby!","memberCount":0,"seatedCount":0}"#,
            r#"{"id":"lobby","memberCount":0,"seatedCount":0,"title":null}"#,
        ] {
            refused::<RoomListResponse>(&format!(r#"{{"rooms":[{bad}]}}"#));
        }
        let room = |i: usize| format!(r#"{{"id":"room-{i}","memberCount":0,"seatedCount":0}}"#);
        let list = |n: usize| format!(r#"{{"rooms":[{}]}}"#, (0..n).map(room).collect::<Vec<_>>().join(","));
        same::<RoomListResponse>(&list(100));
        refused::<RoomListResponse>(&list(101));
    }
}
