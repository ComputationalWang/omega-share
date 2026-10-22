//! HTTP request bodies, mirroring `CreateRoomRequestSchema`, `ShareRequestSchema` and
//! `ReportRequestSchema`. The caller caps the body (`MAX_CREATE_BODY_BYTES`, `MAX_REPORT_BODY_BYTES`
//! and the share cap) while reading it; these parse the bytes.

use super::constants::{MAX_CREATE_BODY_BYTES, MAX_REPORT_BODY_BYTES, MAX_SHARE_BODY_BYTES, MAX_URL_LENGTH};
use super::js_compat::utf16_len;
use super::layout::RoomPresetId;
use super::room::RoomVisibility;
use super::state::StartSeconds;
use super::text::{ReportNote, RoomTitle};
use super::{Invalid, parse_json};
use serde::{Deserialize, Deserializer, Serialize};
use validator::{Validate, ValidationError};

/// `REPORT_REASONS`.
// shortcut: duplicate of the outbound slice's ReportReason, replace on merge
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ReportReason {
    Sexual,
    Violence,
    Hate,
    Spam,
    Danger,
    Other,
}

/// Absent is `None`; an explicit `null` is refused (`v.optional`).
fn present<'de, D: Deserializer<'de>, T: Deserialize<'de>>(d: D) -> Result<Option<T>, D::Error> {
    T::deserialize(d).map(Some)
}

/// Body of `POST /rooms`.
#[derive(Serialize, Deserialize, Validate)]
#[serde(deny_unknown_fields)]
pub struct CreateRoomRequest {
    pub title: RoomTitle,
    pub visibility: RoomVisibility,
    #[serde(default, deserialize_with = "present", skip_serializing_if = "Option::is_none")]
    pub preset: Option<RoomPresetId>,
}

fn url_len(s: &str) -> Result<(), ValidationError> {
    if utf16_len(s) <= MAX_URL_LENGTH {
        Ok(())
    } else {
        Err(ValidationError::new("url_length"))
    }
}

/// Body of `POST /rooms/:id/share` (and `/queue`): the raw page or embed URL, for the share parser, and where the
/// room starts the video (OME-1625; ignored for a live or generic embed).
#[derive(Serialize, Deserialize, Validate)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ShareRequest {
    #[validate(custom(function = "url_len"))]
    url: String,
    #[serde(default, deserialize_with = "present", skip_serializing_if = "Option::is_none")]
    start_seconds: Option<StartSeconds>,
}

impl ShareRequest {
    pub fn url(&self) -> &str {
        &self.url
    }
    pub fn start_seconds(&self) -> Option<StartSeconds> {
        self.start_seconds
    }
}

/// Body of `POST /rooms/:id/report`.
#[derive(Serialize, Deserialize, Validate)]
#[serde(deny_unknown_fields)]
pub struct ReportRequest {
    pub reason: ReportReason,
    #[serde(default, deserialize_with = "present", skip_serializing_if = "Option::is_none")]
    pub note: Option<ReportNote>,
}

// Debug prints no user text (title, URL, note): these reach logs and panic messages.
impl std::fmt::Debug for CreateRoomRequest {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "CreateRoomRequest {{ title: <redacted>, visibility: {:?}, preset: {:?} }}",
            self.visibility, self.preset
        )
    }
}

impl std::fmt::Debug for ShareRequest {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("ShareRequest { url: <redacted> }")
    }
}

impl std::fmt::Debug for ReportRequest {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let note = if self.note.is_some() { "<redacted>" } else { "None" };
        write!(f, "ReportRequest {{ reason: {:?}, note: {note} }}", self.reason)
    }
}

/// Oversized input is refused before it is read (the caller also caps while reading the socket).
fn capped(body: &[u8], max: usize) -> Result<(), Invalid> {
    if body.len() > max { Err(Invalid::new("too large")) } else { Ok(()) }
}

pub fn parse_create_room_request(body: &[u8]) -> Result<CreateRoomRequest, Invalid> {
    capped(body, MAX_CREATE_BODY_BYTES)?;
    parse_json(body)
}

pub fn parse_share_request(body: &[u8]) -> Result<ShareRequest, Invalid> {
    capped(body, MAX_SHARE_BODY_BYTES)?;
    parse_json(body)
}

pub fn parse_report_request(body: &[u8]) -> Result<ReportRequest, Invalid> {
    capped(body, MAX_REPORT_BODY_BYTES)?;
    parse_json(body)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::contract::constants::{MAX_CREATE_BODY_BYTES, MAX_REPORT_BODY_BYTES, MAX_SHARE_BODY_BYTES};

    #[test]
    fn create_room_bodies() {
        // packages/shared/test/rooms-contract.test.ts:169-173, preset-contract.test.ts
        assert!(parse_create_room_request(br#"{"title":"Friday films","visibility":"public"}"#).is_ok());
        let r = parse_create_room_request(br#"{"title":"Friday films","visibility":"private","preset":"cafe"}"#);
        assert_eq!(r.ok().and_then(|r| r.preset), Some(RoomPresetId::Cafe));
        for bad in [
            &br#"{"title":"Friday films","visibility":"secret"}"#[..],
            br#"{"title":"Friday films"}"#,
            br#"{"title":"Friday films","visibility":"public","id":"lobby"}"#,
            br#"{"title":"Friday films","visibility":"public","layout":{}}"#,
            br#"{"title":"Friday films","visibility":"public","preset":null}"#,
            br#"{"title":"Friday films","visibility":"public","preset":"nope"}"#,
        ] {
            assert!(parse_create_room_request(bad).is_err(), "{}", String::from_utf8_lossy(bad));
        }
    }

    #[test]
    fn bodies_over_their_cap_are_refused_unread() {
        // apps/server/src/http.ts:53 (share), constants.ts (create, report)
        let pad = |json: &str, total: usize| format!("{json}{}", " ".repeat(total - json.len()));
        let create = r#"{"title":"Films","visibility":"public"}"#;
        assert!(parse_create_room_request(pad(create, MAX_CREATE_BODY_BYTES).as_bytes()).is_ok());
        assert!(parse_create_room_request(pad(create, MAX_CREATE_BODY_BYTES + 1).as_bytes()).is_err());
        let share = r#"{"url":"x"}"#;
        assert!(parse_share_request(pad(share, MAX_SHARE_BODY_BYTES).as_bytes()).is_ok());
        assert!(parse_share_request(pad(share, MAX_SHARE_BODY_BYTES + 1).as_bytes()).is_err());
        let report = r#"{"reason":"spam"}"#;
        assert!(parse_report_request(pad(report, MAX_REPORT_BODY_BYTES).as_bytes()).is_ok());
        assert!(parse_report_request(pad(report, MAX_REPORT_BODY_BYTES + 1).as_bytes()).is_err());
        // Not even JSON, and huge: refused without being read.
        assert!(parse_share_request(&vec![b'{'; 1 << 20]).is_err());
    }

    #[test]
    fn invalid_utf8_is_refused_where_ts_decodes_lossily() {
        // apps/server/src/rate-limit.ts:152 (deliberate difference, PORTING.md)
        assert!(parse_share_request(b"{\"url\":\"\xff\"}").is_err());
        assert!(parse_report_request(b"{\"reason\":\"spam\",\"note\":\"a\xc3\"}").is_err());
    }

    #[test]
    fn debug_never_prints_user_text() {
        let share = parse_share_request(br#"{"url":"https://SECRETMARK.example/"}"#).unwrap();
        let report = parse_report_request(br#"{"reason":"spam","note":"SECRETMARK words"}"#).unwrap();
        let create = parse_create_room_request(br#"{"title":"SECRETMARK","visibility":"public"}"#).unwrap();
        for shown in [format!("{share:?}"), format!("{report:?}"), format!("{create:?}")] {
            assert!(!shown.contains("SECRETMARK"), "{shown}");
        }
        assert!(format!("{report:?}").contains("Spam"));
    }

    #[test]
    fn share_bodies() {
        // packages/shared/test/wire.test.ts:117
        assert_eq!(
            parse_share_request(br#"{"url":"anything"}"#)
                .ok()
                .map(|r| r.url().to_owned())
                .as_deref(),
            Some("anything")
        );
        assert!(parse_share_request(br#"{"url":"x","extra":1}"#).is_err());
        assert!(parse_share_request(br"{}").is_err());
        let url = |tail: usize| format!(r#"{{"url":"{}{}"}}"#, "😀".repeat(512), "a".repeat(tail));
        assert!(parse_share_request(url(1024).as_bytes()).is_ok());
        assert!(parse_share_request(url(1025).as_bytes()).is_err());
    }

    #[test]
    fn report_bodies() {
        // packages/shared/test/report-contract.test.ts:27-88
        for reason in ["sexual", "violence", "hate", "spam", "danger", "other"] {
            assert!(parse_report_request(format!(r#"{{"reason":"{reason}"}}"#).as_bytes()).is_ok());
            assert!(parse_report_request(format!(r#"{{"reason":"{reason}","note":"the chat posts slurs"}}"#).as_bytes()).is_ok());
        }
        for bad in [
            &br#"{"reason":"illegal"}"#[..],
            br#"{"reason":"SPAM"}"#,
            br"{}",
            br#"{"note":"no reason"}"#,
            br#"{"reason":"spam","roomId":"lobby"}"#,
            br#"["spam"]"#,
            br#"{"reason":"spam","note":null}"#,
        ] {
            assert!(parse_report_request(bad).is_err(), "{}", String::from_utf8_lossy(bad));
        }
        let long = format!(r#"{{"reason":"other","note":"{}"}}"#, "a".repeat(301));
        assert!(parse_report_request(long.as_bytes()).is_err());
    }
}
