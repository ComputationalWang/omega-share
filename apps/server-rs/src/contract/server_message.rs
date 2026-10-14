//! Server → client messages: `ServerMessageSchema` in `packages/shared/src/messages.ts`.
//!
//! `Serialize` writes the key order of the object literals the TS server `JSON.stringify`s
//! (`apps/server/src/{ws,ws-sessions,ws-owner-edits,queue,http}.ts`), optional keys omitted. The
//! strict `Deserialize` (`parse_server_message`) is for tests and the load generator: unknown keys
//! are stripped like Valibot's `v.object`, every other rule is checked.

use super::Obj;
use super::constants::{ERROR_MESSAGE_MAX_LENGTH, MAX_SERVER_MESSAGE_BYTES, RETRY_AFTER_MAX_MS};
use super::generic_embed::AnyEmbed;
use super::ids::{MemberId, QueueItemId, ResumeToken, ShareToken};
use super::js_compat::utf16_len;
use super::layout::RoomLayout;
use super::room::{ControlPolicy, SeatIndex};
use super::state::{
    EmoteKind, Member, PingId, PlaybackState, QueueItem, RoomState, ServerTime, layout, nullable, playback_matches_embed, present,
    queue_is_valid,
};
use super::text::{ChatText, RoomTitle};
use serde::{Deserialize, Deserializer, Serialize};
use std::borrow::Cow;
use std::marker::PhantomData;

/// `ERROR_CODES`: the `code` of a WebSocket `error`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ErrorCode {
    BadMessage,
    NotJoined,
    AlreadyJoined,
    SeatTaken,
    RateLimited,
    NoEmbed,
    NicknameTaken,
    TooManyMembers,
    InviteRequired,
    NotOwner,
    Muted,
    ControlOwnerOnly,
    BadTarget,
    QueueFull,
    UnsupportedUrl,
    ResumeExpired,
}

/// `MEMBER_LEFT_REASONS`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MemberLeftReason {
    Left,
    Kicked,
}

/// A human-readable error text, at most `ERROR_MESSAGE_MAX_LENGTH` UTF-16 units.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(transparent)]
pub struct ErrorMessage(String);

impl ErrorMessage {
    pub fn new(s: impl Into<String>) -> Option<Self> {
        let s = s.into();
        (utf16_len(&s) <= ERROR_MESSAGE_MAX_LENGTH).then_some(Self(s))
    }
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl<'de> Deserialize<'de> for ErrorMessage {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        let raw = String::deserialize(d)?;
        Self::new(raw).ok_or_else(|| serde::de::Error::custom("invalid ErrorMessage"))
    }
}

/// How long to wait before retrying, ms: an integer in `0..=MAX`. [`RetryAfterMs`] is the usual cap;
/// room creation and reports may wait out a full 10 minute bucket refill.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize)]
#[serde(transparent)]
pub struct RetryAfter<const MAX: u64>(u64);

pub type RetryAfterMs = RetryAfter<RETRY_AFTER_MAX_MS>;

impl<const MAX: u64> RetryAfter<MAX> {
    pub fn new(ms: u64) -> Option<Self> {
        (ms <= MAX).then_some(Self(ms))
    }
    pub fn get(self) -> u64 {
        self.0
    }
}

impl<'de, const MAX: u64> Deserialize<'de> for RetryAfter<MAX> {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        Self::new(u64::deserialize(d)?).ok_or_else(|| serde::de::Error::custom("invalid retryAfterMs"))
    }
}

/// A string-only literal tag: serde's own tag matching also takes integer variant indexes, which
/// `v.literal` never does (same reason as `literal!` in `embed.rs`).
pub(crate) trait Lit {
    const TAG: &'static str;
}

pub(crate) struct Tag<L>(PhantomData<L>);

impl<'de, L: Lit> Deserialize<'de> for Tag<L> {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        let raw = <Cow<'de, str>>::deserialize(d)?;
        if raw == L::TAG {
            Ok(Self(PhantomData))
        } else {
            Err(serde::de::Error::custom("unexpected message type"))
        }
    }
}

/// Declares the enum (Serialize, tagged `type`), one private wire struct per variant (carrying its
/// literal tag) and the untagged enum that tries them in turn: the tags are disjoint, so this is
/// `v.variant`.
macro_rules! server_messages {
    ($( $(#[$vm:meta])* $tag:literal $Variant:ident $Wire:ident { $( $(#[$fm:meta])* $f:ident : $t:ty ),* $(,)? } )*) => {
        /// A frame the server sends. No `PartialEq`: snapshots carry secrets, which compare in constant time only.
        #[allow(clippy::large_enum_variant, reason = "a message is encoded and dropped, never stored in bulk")]
        #[derive(Debug, Clone, Serialize)]
        #[serde(tag = "type", rename_all_fields = "camelCase")]
        pub enum ServerMessage {
            $( $(#[$vm])* #[serde(rename = $tag)] $Variant { $( $(#[$fm])* $f : $t ),* } ),*
        }

        $(
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct $Wire {
                #[serde(rename = "type")]
                _tag: Tag<$Wire>,
                $( $(#[$fm])* $f : $t ),*
            }
            impl Lit for $Wire {
                const TAG: &'static str = $tag;
            }
        )*

        #[allow(clippy::large_enum_variant, reason = "parsed once, converted and dropped")]
        #[derive(Deserialize)]
        #[serde(untagged)]
        enum Wire { $( $Variant($Wire) ),* }

        impl From<Wire> for ServerMessage {
            fn from(w: Wire) -> Self {
                match w {
                    $( Wire::$Variant($Wire { $( $f, )* .. }) => ServerMessage::$Variant { $( $f ),* } ),*
                }
            }
        }
    };
}

server_messages! {
    /// First message after a successful join. `shareToken` and `resumeToken` go to that member only.
    "snapshot" Snapshot SnapshotWire {
        #[serde(rename = "self")]
        self_id: MemberId,
        room: RoomState,
        #[serde(default, deserialize_with = "present", skip_serializing_if = "Option::is_none")]
        share_token: Option<ShareToken>,
        #[serde(default, deserialize_with = "present", skip_serializing_if = "Option::is_none")]
        resume_token: Option<ResumeToken>,
        #[serde(default, deserialize_with = "present", skip_serializing_if = "Option::is_none")]
        resumed: Option<bool>,
        #[serde(default, deserialize_with = "present", skip_serializing_if = "Option::is_none")]
        owner: Option<bool>,
    }
    "member-joined" MemberJoined MemberJoinedWire { member: Member }
    "member-left" MemberLeft MemberLeftWire {
        member_id: MemberId,
        #[serde(default, deserialize_with = "present", skip_serializing_if = "Option::is_none")]
        reason: Option<MemberLeftReason>,
    }
    "seat-changed" SeatChanged SeatChangedWire {
        member_id: MemberId,
        #[serde(deserialize_with = "nullable")]
        seat: Option<SeatIndex>,
    }
    "chat" Chat ChatWire { member_id: MemberId, text: ChatText, at: ServerTime }
    "embed-changed" EmbedChanged EmbedChangedWire {
        #[serde(deserialize_with = "nullable")]
        embed: Option<AnyEmbed>,
        #[serde(deserialize_with = "nullable")]
        by: Option<MemberId>,
        /// `Some(None)` is `null`: the server always sends one of the two.
        #[serde(default, deserialize_with = "present", skip_serializing_if = "Option::is_none")]
        playback: Option<Option<PlaybackState>>,
        #[serde(default, deserialize_with = "present", skip_serializing_if = "Option::is_none")]
        item_id: Option<QueueItemId>,
    }
    "queue-changed" QueueChanged QueueChangedWire {
        queue: Vec<QueueItem>,
        #[serde(deserialize_with = "nullable")]
        by: Option<MemberId>,
    }
    "member-status" MemberStatus MemberStatusWire { member_id: MemberId, catching: bool }
    "member-presence" MemberPresence MemberPresenceWire { member_id: MemberId, away: bool }
    "pong" Pong PongWire { id: PingId, at: ServerTime }
    "playback" Playback PlaybackWire { playback: PlaybackState }
    "layout-changed" LayoutChanged LayoutChangedWire {
        #[serde(deserialize_with = "layout")]
        layout: RoomLayout,
        by: MemberId,
    }
    "title-changed" TitleChanged TitleChangedWire { title: RoomTitle, by: MemberId }
    "emoted" Emoted EmotedWire { member_id: MemberId, kind: EmoteKind }
    "member-muted" MemberMuted MemberMutedWire { member_id: MemberId, muted: bool }
    "control-policy-changed" ControlPolicyChanged ControlPolicyChangedWire { policy: ControlPolicy, by: MemberId }
    "room-full" RoomFull RoomFullWire {}
    "error" Error ErrorWire {
        code: ErrorCode,
        message: ErrorMessage,
        #[serde(default, deserialize_with = "present", skip_serializing_if = "Option::is_none")]
        retry_after_ms: Option<RetryAfterMs>,
    }
}

impl ServerMessage {
    /// The checks on top of the shape (`embed-changed`'s and `queue-changed`'s `v.check`s; the snapshot's
    /// are `RoomState`'s own).
    fn check(&self) -> Result<(), &'static str> {
        match self {
            Self::EmbedChanged {
                embed, playback, item_id, ..
            } => {
                if !playback_matches_embed(embed.as_ref(), playback.as_ref()) {
                    Err("playback without a synced embed")
                } else if item_id.is_some() && embed.is_none() {
                    Err("item id without an embed")
                } else {
                    Ok(())
                }
            }
            Self::QueueChanged { queue, .. } if !queue_is_valid(queue) => Err("invalid queue"),
            _ => Ok(()),
        }
    }
}

impl<'de> Deserialize<'de> for ServerMessage {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        let Obj(wire) = Obj::<Wire>::deserialize(d)?;
        let message = Self::from(wire);
        message.check().map_err(serde::de::Error::custom)?;
        Ok(message)
    }
}

/// What the server writes for `msg`: `JSON.stringify(msg)`'s bytes for the values the server builds.
pub fn encode(msg: &ServerMessage) -> String {
    let _ = msg; // red: stub
    String::new()
}

/// `parseServerMessage`: the frame is at most `MAX_SERVER_MESSAGE_BYTES` (UTF-8), JSON, and a valid message.
pub fn parse_server_message(frame: &str) -> Option<ServerMessage> {
    let _ = (frame, MAX_SERVER_MESSAGE_BYTES); // red: stub
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::contract::constants::SEAT_COUNT;
    use crate::contract::state::{PlaybackAction, Position, Rate, Rev};

    const YT: &str = r#"{"provider":"youtube","videoId":"dQw4w9WgXcQ","url":"https://www.youtube.com/embed/dQw4w9WgXcQ"}"#;
    const TOKEN: &str = "AbCdEfGhIjKlMnOpQrStUv";

    fn seats(occupied: &[(usize, &str)]) -> String {
        let cells: Vec<String> = (0..SEAT_COUNT)
            .map(|i| {
                occupied
                    .iter()
                    .find(|(s, _)| *s == i)
                    .map_or("null".to_owned(), |(_, id)| format!("\"{id}\""))
            })
            .collect();
        format!("[{}]", cells.join(","))
    }

    fn room(extra: &str) -> String {
        format!(
            r#"{{"id":"lobby","seats":{},"members":[{{"id":"m1","nickname":"alice","avatar":0}},{{"id":"m2","nickname":"Bob 2","avatar":3}}],"embed":{YT}{extra}}}"#,
            seats(&[(2, "m1")])
        )
    }

    fn snap(room: &str) -> String {
        format!(r#"{{"type":"snapshot","self":"m1","room":{room}}}"#)
    }

    /// The text parses and encodes back to the same bytes (so its key order is the server's).
    fn same(frame: &str) {
        let parsed = parse_server_message(frame).unwrap_or_else(|| panic!("refused: {frame}"));
        assert_eq!(encode(&parsed), frame);
    }

    fn refused(frame: &str) {
        assert!(parse_server_message(frame).is_none(), "accepted: {frame}");
    }

    // packages/shared/test/wire.test.ts:195 (ServerMessageSchema): every variant, in the TS server's key order
    #[test]
    fn every_variant_encodes_in_the_servers_key_order() {
        same(&snap(&room("")));
        same(&format!(
            r#"{{"type":"snapshot","self":"m1","room":{},"shareToken":"{TOKEN}","resumeToken":"{}","resumed":true,"owner":true}}"#,
            room(""),
            "A".repeat(43)
        ));
        same(
            r#"{"type":"member-joined","member":{"id":"m1","nickname":"alice","avatar":0,"standingSlot":0,"catching":true,"muted":true,"away":true}}"#,
        );
        same(r#"{"type":"member-left","memberId":"m1"}"#);
        same(r#"{"type":"member-left","memberId":"m1","reason":"kicked"}"#);
        same(r#"{"type":"seat-changed","memberId":"m1","seat":3}"#);
        same(r#"{"type":"seat-changed","memberId":"m1","seat":null}"#);
        same(r#"{"type":"chat","memberId":"m1","text":"hello","at":1790000000000}"#);
        same(&format!(
            r#"{{"type":"embed-changed","embed":{YT},"by":"m1","playback":{{"playing":true,"position":0,"rate":1,"at":5,"rev":1,"action":"load","by":"m1"}},"itemId":"i1"}}"#
        ));
        same(r#"{"type":"embed-changed","embed":null,"by":null,"playback":null}"#);
        same(&format!(
            r#"{{"type":"queue-changed","queue":[{{"id":"q1","embed":{YT},"by":null}}],"by":"m1"}}"#
        ));
        same(r#"{"type":"member-status","memberId":"m1","catching":false}"#);
        same(r#"{"type":"member-presence","memberId":"m1","away":true}"#);
        same(r#"{"type":"pong","id":7,"at":9}"#);
        same(r#"{"type":"playback","playback":{"playing":false,"position":12.5,"rate":0.5,"at":5,"rev":3,"action":"seek","by":null}}"#);
        same(r#"{"type":"title-changed","title":"Friday films","by":"m1"}"#);
        same(r#"{"type":"emoted","memberId":"m1","kind":"cheer"}"#);
        same(r#"{"type":"member-muted","memberId":"m1","muted":true}"#);
        same(r#"{"type":"control-policy-changed","policy":"owner","by":"m1"}"#);
        same(r#"{"type":"room-full"}"#);
        same(r#"{"type":"error","code":"rate_limited","message":"slow down","retryAfterMs":1500}"#);
        same(r#"{"type":"error","code":"bad_message","message":""}"#);
    }

    // apps/server/src/room.ts:488 snapshot(): id, seats, members, embed, playback, layout, controlPolicy, then title, itemId, queue
    #[test]
    fn a_room_state_keeps_the_snapshot_key_order() {
        let layout = crate::contract::layout::default_layout().to_json();
        let full = format!(
            r#"{{"id":"lobby","seats":{},"members":[],"embed":null,"playback":null,"layout":{layout},"controlPolicy":"owner","title":"Friday films"}}"#,
            seats(&[])
        );
        same(&snap(&full));
        let queued = format!(
            r#"{{"id":"lobby","seats":{},"members":[],"embed":{YT},"playback":null,"controlPolicy":"everyone","itemId":"i1","queue":[{{"id":"q1","embed":{YT},"by":null}}]}}"#,
            seats(&[])
        );
        same(&snap(&queued));
    }

    // packages/shared/test/wire.test.ts:93 (RoomStateSchema)
    #[test]
    fn room_state_rules() {
        assert!(parse_server_message(&snap(&room(""))).is_some());
        assert!(parse_server_message(&snap(&room(r#","playback":null"#))).is_some());
        let one = seats(&[(2, "m1")]);
        refused(&snap(&room("").replace(&one, &one.replacen(",null", "", 1)))); // 7 seats
        refused(&snap(&room("").replace(&one, &seats(&[(2, "ghost")])))); // not a member
        refused(&snap(&room("").replace(&one, &seats(&[(1, "m1"), (2, "m1")])))); // two seats
        refused(&snap(&room("").replace(r#""id":"m2""#, r#""id":"m1""#))); // duplicate member id
        refused(&snap(&room("").replace(r#""avatar":3"#, r#""avatar":4"#)));
        refused(&snap(&room("").replace(r#""avatar":3"#, r#""avatar":1.5"#)));
        refused(&snap(&room("").replace(r#""Bob 2""#, r#""""#)));
        refused(&snap(&room("").replace("youtube.com/embed", "evil.example/embed")));
        refused(&snap(&room("").replace(r#","embed":"#, r#","embed2":"#))); // embed is required
        refused(&snap(&room("").replace(r#""id":"lobby""#, r#""id":"../etc""#)));
        // ADR 0024: a synced embed's playback is a state, a generic embed's is null
        let generic = r#"{"provider":"generic","host":"player.example.com","url":"https://player.example.com/embed/42"}"#;
        let playback = r#"{"playing":true,"position":0,"rate":1,"at":1,"rev":1,"action":"load","by":null}"#;
        let base = |embed: &str, p: &str, extra: &str| {
            format!(
                r#"{{"id":"lobby","seats":{},"members":[],"embed":{embed},"playback":{p}{extra}}}"#,
                seats(&[])
            )
        };
        assert!(parse_server_message(&snap(&base(YT, playback, ""))).is_some());
        assert!(parse_server_message(&snap(&base(generic, "null", ""))).is_some());
        refused(&snap(&base(generic, playback, "")));
        refused(&snap(&base("null", playback, "")));
        refused(&snap(&base("null", "null", r#","itemId":"i1""#)));
        let queued = format!(r#","itemId":"q1","queue":[{{"id":"q1","embed":{YT},"by":null}}]"#);
        refused(&snap(&base(YT, "null", &queued)));
    }

    // packages/shared/test/session-contract.test.ts:42 (bounded unique standing slots, capacity)
    #[test]
    fn standing_slots_are_unique_and_the_room_is_bounded() {
        let member = |i: usize, slot: &str| format!(r#"{{"id":"m{i}","nickname":"User{i}","avatar":{},"standingSlot":{slot}}}"#, i % 4);
        let room_of = |members: &[String]| {
            format!(
                r#"{{"type":"snapshot","self":"m0","room":{{"id":"lobby","seats":{},"members":[{}],"embed":null}}}}"#,
                seats(&[]),
                members.join(",")
            )
        };
        let full: Vec<String> = (0..25).map(|i| member(i, &i.to_string())).collect();
        assert!(parse_server_message(&room_of(&full)).is_some());
        for slot in ["-1", "25", "0.5", "null", "\"0\""] {
            refused(&room_of(&[member(0, slot)]));
        }
        refused(&room_of(&(0..25).map(|i| member(i, "0")).collect::<Vec<_>>())); // duplicate slot
        refused(&room_of(&(0..26).map(|i| member(i, &(i % 25).to_string())).collect::<Vec<_>>())); // 26 members
        refused(&room_of(&[member(0, "0").replace(r#""avatar":0"#, r#""avatar":0,"away":"true""#)]));
    }

    // packages/shared/test/wire.test.ts:253 (worst-case snapshot fits MAX_SERVER_MESSAGE_BYTES), with every optional key set
    #[test]
    fn a_worst_case_full_room_snapshot_fits_the_frame_limit() {
        let x62 = "x".repeat(62);
        let members: Vec<String> = (0..25)
            .map(|i| {
                format!(
                    r#"{{"id":"{i:02}{x62}","nickname":"{}","avatar":3,"standingSlot":{i},"catching":true,"muted":true,"away":true}}"#,
                    "李".repeat(20)
                )
            })
            .collect();
        let seats: Vec<String> = (0..8).map(|i| format!("\"{i:02}{x62}\"")).collect();
        let layout = crate::contract::layout::default_layout().to_json();
        let queue: Vec<String> = (0..20)
            .map(|i| format!(r#"{{"id":"{i:02}{}","embed":{YT},"by":"00{x62}"}}"#, "x".repeat(30)))
            .collect();
        let frame = format!(
            r#"{{"type":"snapshot","self":"00{x62}","room":{{"id":"{}","seats":[{}],"members":[{}],"embed":{YT},"playback":null,"layout":{layout},"controlPolicy":"owner","title":"{}","itemId":"i1","queue":[{}]}},"shareToken":"{TOKEN}","resumeToken":"{}","resumed":true,"owner":true}}"#,
            "a".repeat(32),
            seats.join(","),
            members.join(","),
            "李".repeat(32),
            queue.join(","),
            "A".repeat(43),
        );
        assert!(frame.len() <= MAX_SERVER_MESSAGE_BYTES, "{} bytes", frame.len());
        same(&frame);
    }

    // packages/shared/test/wire.test.ts:264
    #[test]
    fn a_frame_over_the_server_limit_is_refused_unread() {
        let pad = "x".repeat(MAX_SERVER_MESSAGE_BYTES);
        refused(&format!(r#"{{"type":"room-full","pad":"{pad}"}}"#));
        // The limit is bytes, not UTF-16 units: 3-byte chars past the limit.
        refused(&format!(
            r#"{{"type":"room-full","pad":"{}"}}"#,
            "€".repeat(MAX_SERVER_MESSAGE_BYTES / 3)
        ));
        let fits = MAX_SERVER_MESSAGE_BYTES - r#"{"type":"room-full","pad":""}"#.len();
        assert!(parse_server_message(&format!(r#"{{"type":"room-full","pad":"{}"}}"#, "x".repeat(fits))).is_some());
        assert!(parse_server_message(&format!(r#"{{"type":"room-full","pad":"{}"}}"#, "x".repeat(fits + 1))).is_none());
    }

    #[test]
    fn garbage_is_refused() {
        for frame in ["null", "", "{}", "[]", "1", "\"room-full\"", "{nope", r#"{"type":"room-full"} x"#] {
            refused(frame);
        }
        assert!(parse_server_message(r#" {"type":"room-full"} "#).is_some());
    }

    // The tag is a string literal and a message an object: serde alone would take an index and an array.
    #[test]
    fn tags_are_strings_and_messages_are_objects() {
        for frame in [
            r#"{"type":0}"#,
            r#"{"type":17}"#,
            r#"{"type":null}"#,
            r#"{"type":["room-full"]}"#,
            r#"["room-full"]"#,
            r#"["pong",1,2]"#,
            r#"{"type":"member-joined","member":["m1","alice",0]}"#,
            r#"{"type":"playback","playback":[true,1,1,1,1,"play",null]}"#,
            r#"{"type":"ROOM-FULL"}"#,
            r#"{"type":"join","nickname":"alice","avatar":0}"#,
        ] {
            refused(frame);
        }
    }

    // PORTING.md "Deliberate differences": what Rust refuses and Valibot accepts
    #[test]
    fn duplicate_keys_odd_integers_and_lone_surrogates_are_refused() {
        refused(r#"{"type":"room-full","type":"room-full"}"#);
        refused(r#"{"type":"pong","id":1.0,"at":1}"#);
        refused(r#"{"type":"pong","id":1,"at":1e3}"#);
        refused(r#"{"type":"pong","id":-0,"at":1}"#);
        refused(r#"{"type":"chat","memberId":"m1","text":"\ud800","at":1}"#);
        refused(r#"{"type":"error","code":"bad_message","message":"\ud83d"}"#);
    }

    // packages/shared/test/rooms-contract.test.ts:323, wire.test.ts:195
    #[test]
    fn text_is_normalized_and_unknown_keys_stripped() {
        let m = parse_server_message(r#"{"type":"title-changed","title":" Ｆｒｉｄａｙ films ","by":"m1","extra":1}"#);
        assert_eq!(
            m.map(|m| encode(&m)).as_deref(),
            Some(r#"{"type":"title-changed","title":"Friday films","by":"m1"}"#)
        );
        let m = parse_server_message(r#"{"type":"chat","memberId":"m1","text":"  hi  ","at":1,"x":[]}"#);
        assert_eq!(
            m.map(|m| encode(&m)).as_deref(),
            Some(r#"{"type":"chat","memberId":"m1","text":"hi","at":1}"#)
        );
        refused(&format!(r#"{{"type":"chat","memberId":"m1","text":"{}","at":0}}"#, "x".repeat(281)));
        refused("{\"type\":\"chat\",\"memberId\":\"m1\",\"text\":\"a\u{200b}b\",\"at\":0}");
        refused(r#"{"type":"chat","memberId":"m1","text":"hi"}"#);
    }

    // packages/shared/test/emote-contract.test.ts:44, moderation-contract.test.ts:96..190
    #[test]
    fn picklists_accept_their_words_only() {
        for kind in ["clap", "exclaim", "heart", "laugh", "question", "wave", "cheer", "yawn"] {
            same(&format!(r#"{{"type":"emoted","memberId":"m1","kind":"{kind}"}}"#));
        }
        for frame in [
            r#"{"type":"emoted","memberId":"m1","kind":"dance"}"#,
            r#"{"type":"emoted","memberId":"","kind":"wave"}"#,
            r#"{"type":"emoted","kind":"wave"}"#,
            r#"{"type":"member-left","memberId":"m2","reason":"banned"}"#,
            r#"{"type":"control-policy-changed","policy":"nobody","by":"m1"}"#,
            r#"{"type":"error","code":"oops","message":""}"#,
            r#"{"type":"error","code":0,"message":""}"#,
        ] {
            refused(frame);
        }
        for code in [
            "bad_message",
            "not_joined",
            "already_joined",
            "seat_taken",
            "rate_limited",
            "no_embed",
            "nickname_taken",
            "too_many_members",
            "invite_required",
            "not_owner",
            "muted",
            "control_owner_only",
            "bad_target",
            "queue_full",
            "unsupported_url",
            "resume_expired",
        ] {
            same(&format!(r#"{{"type":"error","code":"{code}","message":"no"}}"#));
        }
    }

    // packages/shared/src/messages.ts ERROR_MESSAGE_MAX_LENGTH, share.ts RetryAfterMsSchema
    #[test]
    fn error_limits_count_utf16_units() {
        let err = |message: &str, retry: &str| format!(r#"{{"type":"error","code":"rate_limited","message":"{message}"{retry}}}"#);
        same(&err(&"x".repeat(200), ""));
        refused(&err(&"x".repeat(201), ""));
        same(&err(&"😀".repeat(100), "")); // 200 units
        refused(&err(&"😀".repeat(101), ""));
        same(&err("m", r#","retryAfterMs":60000"#));
        refused(&err("m", r#","retryAfterMs":60001"#));
        refused(&err("m", r#","retryAfterMs":-1"#));
        refused(&err("m", r#","retryAfterMs":1.5"#));
        refused(&err("m", r#","retryAfterMs":null"#));
    }

    // packages/shared/test/playback.test.ts (bounds of PlaybackStateSchema)
    #[test]
    fn playback_bounds() {
        let pb = |position: &str, rate: &str, rev: &str, action: &str| {
            format!(
                r#"{{"type":"playback","playback":{{"playing":true,"position":{position},"rate":{rate},"at":1,"rev":{rev},"action":"{action}","by":null}}}}"#
            )
        };
        same(&pb("0", "0.25", "0", "play"));
        same(&pb("43200", "2", "9", "seek"));
        refused(&pb("43200.5", "1", "0", "play"));
        refused(&pb("-0.5", "1", "0", "play"));
        refused(&pb("0", "0.2", "0", "play"));
        refused(&pb("0", "2.5", "0", "play"));
        refused(&pb("0", "1", "-1", "play"));
        refused(&pb("0", "1", "0", "stop"));
        refused(&pb("1e400", "1", "0", "play"));
        // `by` is nullable, not optional
        refused(r#"{"type":"playback","playback":{"playing":true,"position":0,"rate":1,"at":1,"rev":0,"action":"play"}}"#);
    }

    // The encoded bytes equal JSON.stringify's for the numbers the server produces.
    #[test]
    fn numbers_are_written_like_json_stringify() {
        let pb = |position: f64, rate: f64| {
            encode(&ServerMessage::Playback {
                playback: PlaybackState {
                    playing: true,
                    position: Position::new(position).unwrap(),
                    rate: Rate::new(rate).unwrap(),
                    at: ServerTime(1),
                    rev: Rev(2),
                    action: PlaybackAction::Play,
                    by: None,
                },
            })
        };
        assert!(pb(3.0, 1.0).contains(r#""position":3,"rate":1,"#));
        assert!(pb(-0.0, 2.0).contains(r#""position":0,"rate":2,"#));
        assert!(pb(12.5, 0.5).contains(r#""position":12.5,"rate":0.5,"#));
        assert!(pb(0.1 + 0.2, 0.25).contains(r#""position":0.30000000000000004,"#));
        assert!(pb(1234.5678, 1.5).contains(r#""position":1234.5678,"#));
        assert!(pb(0.00001, 1.0).contains(r#""position":0.00001,"#));
        assert!(pb(43200.0, 1.0).contains(r#""position":43200,"#));
        assert!(pb(1e-7, 1.0).contains(r#""position":1e-7,"#));
    }

    // Debug never prints a token (ids.rs secret newtypes).
    #[test]
    fn secrets_stay_out_of_debug() {
        let frame = format!(
            r#"{{"type":"snapshot","self":"m1","room":{},"shareToken":"{TOKEN}","resumeToken":"{}"}}"#,
            room(""),
            "B".repeat(43)
        );
        let parsed = parse_server_message(&frame).unwrap();
        let debug = format!("{parsed:?}");
        assert!(!debug.contains(TOKEN) && !debug.contains(&"B".repeat(43)), "{debug}");
    }

    // Built from values, not parsed: what the room logic (S4) does.
    #[test]
    fn a_message_built_from_values_encodes_like_the_ts_literal() {
        let id = |s: &str| MemberId::parse(s).unwrap();
        let msg = ServerMessage::SeatChanged {
            member_id: id("m1"),
            seat: None,
        };
        assert_eq!(encode(&msg), r#"{"type":"seat-changed","memberId":"m1","seat":null}"#);
        let msg = ServerMessage::Error {
            code: ErrorCode::RateLimited,
            message: ErrorMessage::new("slow").unwrap(),
            retry_after_ms: RetryAfterMs::new(1500),
        };
        assert_eq!(
            encode(&msg),
            r#"{"type":"error","code":"rate_limited","message":"slow","retryAfterMs":1500}"#
        );
        assert_eq!(encode(&ServerMessage::RoomFull {}), r#"{"type":"room-full"}"#);
        let msg = ServerMessage::MemberLeft {
            member_id: id("m1"),
            reason: Some(MemberLeftReason::Left),
        };
        assert_eq!(encode(&msg), r#"{"type":"member-left","memberId":"m1","reason":"left"}"#);
        assert!(ErrorMessage::new("x".repeat(201)).is_none());
    }
}
