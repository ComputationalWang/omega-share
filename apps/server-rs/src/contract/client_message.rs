//! Client → server frames, mirroring `ClientMessageSchema` / `parseClientMessage` in
//! `packages/shared/src/messages.ts`. The server's main untrusted-input boundary: every
//! WebSocket text frame comes through [`parse_client_message`].
//!
//! Shape (serde, strict, string-only tags) → field rules (validator) → [`ClientMessage`], whose
//! fields are all merged newtypes or the small ones below, so nothing downstream holds raw input.

use super::constants::{
    MAX_CLIENT_MESSAGE_BYTES, MAX_EMBED_URL_LENGTH, MAX_POSITION_S, MAX_URL_LENGTH, PING_ID_MAX, POLL_MAX_OPTIONS, POLL_MIN_OPTIONS,
};
use super::ids::{InviteKey, MemberId, OwnerToken, PollId, QueueItemId, ResumeToken, RoomId};
use super::js_compat::utf16_len;
use super::layout::{RoomLayout, RoomLayoutInput};
use super::room::{
    Accessory, Avatar, ControlPolicy, DiceSides, FloorCell, FloorCellInput, Hair, PollOptionIndex, QueueIndex, SeatIndex, Tint,
};
use super::state::{PairPose, ReactionKind};
use super::text::{ChatText, Nickname, PollOption, PollQuestion, RoomTitle};
use super::{Obj, parse_json};
use serde::{Deserialize, Deserializer, Serialize};
use validator::{Validate, ValidationError, ValidationErrors};

/// `EMOTE_KINDS`.
// shortcut: duplicate of the outbound slice's EmoteKind, replace on merge
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum EmoteKind {
    Clap,
    Exclaim,
    Heart,
    Laugh,
    Question,
    Wave,
    Cheer,
    Yawn,
    Dance,
}

/// Seconds into the video: finite, `0..=MAX_POSITION_S` (`PositionSchema`).
#[derive(Debug, Clone, Copy, PartialEq)]
#[cfg_attr(test, derive(Serialize))]
pub struct Position(f64);

impl Position {
    pub fn get(self) -> f64 {
        self.0
    }
}

/// Id a client picks for a `ping` (`PingIdSchema`): an integer in `0..=PING_ID_MAX`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[cfg_attr(test, derive(Serialize))]
pub struct PingId(u32);

impl PingId {
    pub fn get(self) -> u32 {
        self.0
    }
}

/// `control.url`: at most `MAX_EMBED_URL_LENGTH` UTF-16 units. Unparsed text: compared with the
/// current embed's url, never opened.
#[derive(Clone, PartialEq, Eq)]
#[cfg_attr(test, derive(Serialize))]
pub struct ControlUrl(String);

/// `queue-add.url`: at most `MAX_URL_LENGTH` UTF-16 units. Raw page URL for the share parser.
#[derive(Clone, PartialEq, Eq)]
#[cfg_attr(test, derive(Serialize))]
pub struct QueueUrl(String);

macro_rules! as_str {
    ($($t:ty),*) => {$(impl $t { pub fn as_str(&self) -> &str { &self.0 } })*};
}
as_str!(ControlUrl, QueueUrl);

/// A frame the server accepts. `Debug` prints only the variant name, and `Serialize` exists only in
/// unit tests: both would otherwise expose tokens and chat text.
#[derive(Clone)]
#[cfg_attr(test, derive(Serialize))]
#[cfg_attr(test, serde(tag = "type", rename_all = "kebab-case", rename_all_fields = "camelCase"))]
pub enum ClientMessage {
    Join {
        nickname: Nickname,
        avatar: Avatar,
        #[cfg_attr(test, serde(skip_serializing_if = "Option::is_none"))]
        owner_token: Option<OwnerToken>,
        #[cfg_attr(test, serde(skip_serializing_if = "Option::is_none"))]
        invite_key: Option<InviteKey>,
        /// Present only as `true`.
        #[cfg_attr(test, serde(skip_serializing_if = "std::ops::Not::not"))]
        durable_session: bool,
        #[cfg_attr(test, serde(skip_serializing_if = "Option::is_none"))]
        resume_token: Option<ResumeToken>,
        #[cfg_attr(test, serde(skip_serializing_if = "Option::is_none"))]
        tint: Option<Tint>,
        #[cfg_attr(test, serde(skip_serializing_if = "Option::is_none"))]
        accessory: Option<Accessory>,
        #[cfg_attr(test, serde(skip_serializing_if = "Option::is_none"))]
        hair: Option<Hair>,
        #[cfg_attr(test, serde(skip_serializing_if = "Option::is_none"))]
        via: Option<RoomId>,
        /// Relay `batch` frames opt-in (OME-1624); absent means false.
        #[cfg_attr(test, serde(skip_serializing_if = "Option::is_none"))]
        batch: Option<bool>,
    },
    Leave {},
    Presence {
        away: bool,
    },
    Sit {
        seat: Option<SeatIndex>,
    },
    Walk {
        cell: FloorCell,
        #[cfg_attr(test, serde(skip_serializing_if = "Option::is_none"))]
        run: Option<bool>,
        #[cfg_attr(test, serde(skip_serializing_if = "Option::is_none"))]
        teleport: Option<bool>,
    },
    SetTint {
        tint: Tint,
    },
    SetAccessory {
        accessory: Accessory,
    },
    SetHair {
        hair: Hair,
    },
    FloorSit {
        on: bool,
    },
    Pair {
        pose: PairPose,
    },
    Typing {
        on: bool,
    },
    Chat {
        text: ChatText,
    },
    Roll {
        sides: DiceSides,
    },
    PollOpen {
        question: PollQuestion,
        options: Vec<PollOption>,
    },
    Vote {
        poll_id: PollId,
        option: PollOptionIndex,
    },
    PollClose {
        poll_id: PollId,
    },
    Ping {
        id: PingId,
    },
    Control {
        url: ControlUrl,
        playing: bool,
        position: Position,
        /// A shared 3-2-1 start (OME-1625, ADR 0056); absent means false.
        #[cfg_attr(test, serde(skip_serializing_if = "Option::is_none"))]
        countdown: Option<bool>,
    },
    Status {
        catching: bool,
    },
    LayoutSet {
        layout: RoomLayout,
    },
    TitleSet {
        title: RoomTitle,
    },
    Emote {
        kind: EmoteKind,
    },
    /// A timed reaction (OME-1625): no client time, the server stamps `mediaMs`.
    React {
        kind: ReactionKind,
    },
    Kick {
        member_id: MemberId,
    },
    Mute {
        member_id: MemberId,
        muted: bool,
    },
    ControlPolicy {
        policy: ControlPolicy,
    },
    QueueAdd {
        url: QueueUrl,
    },
    QueueRemove {
        item_id: QueueItemId,
    },
    QueueMove {
        item_id: QueueItemId,
        to_index: QueueIndex,
    },
    QueueAdvance {
        from_item_id: QueueItemId,
    },
    Ended {
        item_id: QueueItemId,
        position: Position,
    },
}

impl ClientMessage {
    /// The wire tag.
    pub fn kind(&self) -> &'static str {
        match self {
            Self::Join { .. } => "join",
            Self::Leave {} => "leave",
            Self::Presence { .. } => "presence",
            Self::Sit { .. } => "sit",
            Self::Walk { .. } => "walk",
            Self::SetTint { .. } => "set-tint",
            Self::SetAccessory { .. } => "set-accessory",
            Self::SetHair { .. } => "set-hair",
            Self::FloorSit { .. } => "floor-sit",
            Self::Pair { .. } => "pair",
            Self::Typing { .. } => "typing",
            Self::Chat { .. } => "chat",
            Self::Roll { .. } => "roll",
            Self::PollOpen { .. } => "poll-open",
            Self::Vote { .. } => "vote",
            Self::PollClose { .. } => "poll-close",
            Self::Ping { .. } => "ping",
            Self::Control { .. } => "control",
            Self::Status { .. } => "status",
            Self::LayoutSet { .. } => "layout-set",
            Self::TitleSet { .. } => "title-set",
            Self::Emote { .. } => "emote",
            Self::React { .. } => "react",
            Self::Kick { .. } => "kick",
            Self::Mute { .. } => "mute",
            Self::ControlPolicy { .. } => "control-policy",
            Self::QueueAdd { .. } => "queue-add",
            Self::QueueRemove { .. } => "queue-remove",
            Self::QueueMove { .. } => "queue-move",
            Self::QueueAdvance { .. } => "queue-advance",
            Self::Ended { .. } => "ended",
        }
    }
}

impl std::fmt::Debug for ClientMessage {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "ClientMessage::{}(…)", self.kind())
    }
}

// ---- wire ----------------------------------------------------------------------------------

/// Absent is `None`; an explicit `null` is refused (`v.optional` is not nullable).
fn present<'de, D: Deserializer<'de>, T: Deserialize<'de>>(d: D) -> Result<Option<T>, D::Error> {
    T::deserialize(d).map(Some)
}

/// `v.literal(true)`.
#[derive(Debug)]
struct True;

impl<'de> Deserialize<'de> for True {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        if bool::deserialize(d)? {
            Ok(Self)
        } else {
            Err(serde::de::Error::custom("expected true"))
        }
    }
}

fn poll_option_count(options: &[PollOption]) -> Result<(), ValidationError> {
    if (POLL_MIN_OPTIONS..=POLL_MAX_OPTIONS).contains(&options.len()) {
        Ok(())
    } else {
        Err(ValidationError::new("poll_option_count"))
    }
}

fn control_url_len(s: &str) -> Result<(), ValidationError> {
    if utf16_len(s) <= MAX_EMBED_URL_LENGTH {
        Ok(())
    } else {
        Err(ValidationError::new("control_url_length"))
    }
}

fn queue_url_len(s: &str) -> Result<(), ValidationError> {
    if utf16_len(s) <= MAX_URL_LENGTH {
        Ok(())
    } else {
        Err(ValidationError::new("queue_url_length"))
    }
}

#[derive(Deserialize, Validate)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct JoinW {
    nickname: Nickname,
    avatar: Avatar,
    #[serde(default, deserialize_with = "present")]
    owner_token: Option<OwnerToken>,
    #[serde(default, deserialize_with = "present")]
    invite_key: Option<InviteKey>,
    #[serde(default, deserialize_with = "present")]
    durable_session: Option<True>,
    #[serde(default, deserialize_with = "present")]
    resume_token: Option<ResumeToken>,
    #[serde(default, deserialize_with = "present")]
    tint: Option<Tint>,
    #[serde(default, deserialize_with = "present")]
    accessory: Option<Accessory>,
    #[serde(default, deserialize_with = "present")]
    hair: Option<Hair>,
    #[serde(default, deserialize_with = "present")]
    via: Option<RoomId>,
    #[serde(default, deserialize_with = "present")]
    batch: Option<bool>,
}

#[derive(Deserialize, Validate)]
#[serde(deny_unknown_fields)]
struct LeaveW {}

#[derive(Deserialize, Validate)]
#[serde(deny_unknown_fields)]
struct PresenceW {
    away: bool,
}

#[derive(Deserialize, Validate)]
#[serde(deny_unknown_fields)]
struct SitW {
    /// Required; `null` stands up.
    #[serde(deserialize_with = "Option::deserialize")]
    seat: Option<SeatIndex>,
}

#[derive(Deserialize, Validate)]
#[serde(deny_unknown_fields)]
struct WalkW {
    cell: Obj<FloorCellInput>,
    #[serde(default, deserialize_with = "present")]
    run: Option<bool>,
    #[serde(default, deserialize_with = "present")]
    teleport: Option<bool>,
}

#[derive(Deserialize, Validate)]
#[serde(deny_unknown_fields)]
struct SetTintW {
    tint: Tint,
}

#[derive(Deserialize, Validate)]
#[serde(deny_unknown_fields)]
struct SetAccessoryW {
    accessory: Accessory,
}

#[derive(Deserialize, Validate)]
#[serde(deny_unknown_fields)]
struct SetHairW {
    hair: Hair,
}

#[derive(Deserialize, Validate)]
#[serde(deny_unknown_fields)]
struct TypingW {
    on: bool,
}

#[derive(Deserialize, Validate)]
#[serde(deny_unknown_fields)]
struct FloorSitW {
    on: bool,
}

#[derive(Deserialize, Validate)]
#[serde(deny_unknown_fields)]
struct PairW {
    pose: PairPose,
}

#[derive(Deserialize, Validate)]
#[serde(deny_unknown_fields)]
struct ChatW {
    text: ChatText,
}

#[derive(Deserialize, Validate)]
#[serde(deny_unknown_fields)]
struct RollW {
    sides: DiceSides,
}

#[derive(Deserialize, Validate)]
#[serde(deny_unknown_fields)]
struct PollOpenW {
    question: PollQuestion,
    #[validate(custom(function = "poll_option_count"))]
    options: Vec<PollOption>,
}

#[derive(Deserialize, Validate)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct VoteW {
    poll_id: PollId,
    option: PollOptionIndex,
}

#[derive(Deserialize, Validate)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct PollCloseW {
    poll_id: PollId,
}

#[derive(Deserialize, Validate)]
#[serde(deny_unknown_fields)]
struct PingW {
    #[validate(range(min = 0, max = PING_ID_MAX))]
    id: u32,
}

#[derive(Deserialize, Validate)]
#[serde(deny_unknown_fields)]
struct ControlW {
    #[validate(custom(function = "control_url_len"))]
    url: String,
    playing: bool,
    #[validate(range(min = 0.0, max = MAX_POSITION_S))]
    position: f64,
    #[serde(default, deserialize_with = "present")]
    countdown: Option<bool>,
}

#[derive(Deserialize, Validate)]
#[serde(deny_unknown_fields)]
struct StatusW {
    catching: bool,
}

#[derive(Deserialize, Validate)]
#[serde(deny_unknown_fields)]
struct LayoutSetW {
    #[validate(nested)]
    layout: Obj<RoomLayoutInput>,
}

#[derive(Deserialize, Validate)]
#[serde(deny_unknown_fields)]
struct TitleSetW {
    title: RoomTitle,
}

#[derive(Deserialize, Validate)]
#[serde(deny_unknown_fields)]
struct EmoteW {
    kind: EmoteKind,
}

#[derive(Deserialize, Validate)]
#[serde(deny_unknown_fields)]
struct ReactW {
    kind: ReactionKind,
}

#[derive(Deserialize, Validate)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct KickW {
    member_id: MemberId,
}

#[derive(Deserialize, Validate)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct MuteW {
    member_id: MemberId,
    muted: bool,
}

#[derive(Deserialize, Validate)]
#[serde(deny_unknown_fields)]
struct ControlPolicyW {
    policy: ControlPolicy,
}

#[derive(Deserialize, Validate)]
#[serde(deny_unknown_fields)]
struct QueueAddW {
    #[validate(custom(function = "queue_url_len"))]
    url: String,
}

#[derive(Deserialize, Validate)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct QueueRemoveW {
    item_id: QueueItemId,
}

#[derive(Deserialize, Validate)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct QueueMoveW {
    item_id: QueueItemId,
    to_index: QueueIndex,
}

#[derive(Deserialize, Validate)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct QueueAdvanceW {
    from_item_id: QueueItemId,
}

#[derive(Deserialize, Validate)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct EndedW {
    item_id: QueueItemId,
    #[validate(range(min = 0.0, max = MAX_POSITION_S))]
    position: f64,
}

/// Internally tagged by a string `type`; the top level is read through `Obj` (no array form).
#[derive(Deserialize)]
#[serde(tag = "type")]
enum Wire {
    #[serde(rename = "join")]
    Join(JoinW),
    #[serde(rename = "leave")]
    Leave(LeaveW),
    #[serde(rename = "presence")]
    Presence(PresenceW),
    #[serde(rename = "sit")]
    Sit(SitW),
    #[serde(rename = "walk")]
    Walk(WalkW),
    #[serde(rename = "set-tint")]
    SetTint(SetTintW),
    #[serde(rename = "set-accessory")]
    SetAccessory(SetAccessoryW),
    #[serde(rename = "set-hair")]
    SetHair(SetHairW),
    #[serde(rename = "floor-sit")]
    FloorSit(FloorSitW),
    #[serde(rename = "pair")]
    Pair(PairW),
    #[serde(rename = "typing")]
    Typing(TypingW),
    #[serde(rename = "chat")]
    Chat(ChatW),
    #[serde(rename = "roll")]
    Roll(RollW),
    #[serde(rename = "poll-open")]
    PollOpen(PollOpenW),
    #[serde(rename = "vote")]
    Vote(VoteW),
    #[serde(rename = "poll-close")]
    PollClose(PollCloseW),
    #[serde(rename = "ping")]
    Ping(PingW),
    #[serde(rename = "control")]
    Control(ControlW),
    #[serde(rename = "status")]
    Status(StatusW),
    #[serde(rename = "layout-set")]
    LayoutSet(LayoutSetW),
    #[serde(rename = "title-set")]
    TitleSet(TitleSetW),
    #[serde(rename = "emote")]
    Emote(EmoteW),
    #[serde(rename = "react")]
    React(ReactW),
    #[serde(rename = "kick")]
    Kick(KickW),
    #[serde(rename = "mute")]
    Mute(MuteW),
    #[serde(rename = "control-policy")]
    ControlPolicy(ControlPolicyW),
    #[serde(rename = "queue-add")]
    QueueAdd(QueueAddW),
    #[serde(rename = "queue-remove")]
    QueueRemove(QueueRemoveW),
    #[serde(rename = "queue-move")]
    QueueMove(QueueMoveW),
    #[serde(rename = "queue-advance")]
    QueueAdvance(QueueAdvanceW),
    #[serde(rename = "ended")]
    Ended(EndedW),
}

impl Validate for Wire {
    fn validate(&self) -> Result<(), ValidationErrors> {
        match self {
            Self::Join(m) => m.validate(),
            Self::Leave(m) => m.validate(),
            Self::Presence(m) => m.validate(),
            Self::Sit(m) => m.validate(),
            Self::Walk(m) => m.validate(),
            Self::SetTint(m) => m.validate(),
            Self::SetAccessory(m) => m.validate(),
            Self::SetHair(m) => m.validate(),
            Self::FloorSit(m) => m.validate(),
            Self::Pair(m) => m.validate(),
            Self::Typing(m) => m.validate(),
            Self::Chat(m) => m.validate(),
            Self::Roll(m) => m.validate(),
            Self::PollOpen(m) => m.validate(),
            Self::Vote(m) => m.validate(),
            Self::PollClose(m) => m.validate(),
            Self::Ping(m) => m.validate(),
            Self::Control(m) => m.validate(),
            Self::Status(m) => m.validate(),
            Self::LayoutSet(m) => m.validate(),
            Self::TitleSet(m) => m.validate(),
            Self::Emote(m) => m.validate(),
            Self::React(m) => m.validate(),
            Self::Kick(m) => m.validate(),
            Self::Mute(m) => m.validate(),
            Self::ControlPolicy(m) => m.validate(),
            Self::QueueAdd(m) => m.validate(),
            Self::QueueRemove(m) => m.validate(),
            Self::QueueMove(m) => m.validate(),
            Self::QueueAdvance(m) => m.validate(),
            Self::Ended(m) => m.validate(),
        }
    }
}

/// Fields are already validated, so this only wraps them.
fn convert(wire: Wire) -> ClientMessage {
    match wire {
        Wire::Join(m) => ClientMessage::Join {
            nickname: m.nickname,
            avatar: m.avatar,
            owner_token: m.owner_token,
            invite_key: m.invite_key,
            durable_session: m.durable_session.is_some(),
            resume_token: m.resume_token,
            tint: m.tint,
            accessory: m.accessory,
            hair: m.hair,
            via: m.via,
            batch: m.batch,
        },
        Wire::Leave(_) => ClientMessage::Leave {},
        Wire::Presence(m) => ClientMessage::Presence { away: m.away },
        Wire::Sit(m) => ClientMessage::Sit { seat: m.seat },
        Wire::Walk(m) => ClientMessage::Walk {
            cell: m.cell.0.into(),
            run: m.run,
            teleport: m.teleport,
        },
        Wire::SetTint(m) => ClientMessage::SetTint { tint: m.tint },
        Wire::SetAccessory(m) => ClientMessage::SetAccessory { accessory: m.accessory },
        Wire::SetHair(m) => ClientMessage::SetHair { hair: m.hair },
        Wire::FloorSit(m) => ClientMessage::FloorSit { on: m.on },
        Wire::Pair(m) => ClientMessage::Pair { pose: m.pose },
        Wire::Typing(m) => ClientMessage::Typing { on: m.on },
        Wire::Chat(m) => ClientMessage::Chat { text: m.text },
        Wire::Roll(m) => ClientMessage::Roll { sides: m.sides },
        Wire::PollOpen(m) => ClientMessage::PollOpen {
            question: m.question,
            options: m.options,
        },
        Wire::Vote(m) => ClientMessage::Vote {
            poll_id: m.poll_id,
            option: m.option,
        },
        Wire::PollClose(m) => ClientMessage::PollClose { poll_id: m.poll_id },
        Wire::Ping(m) => ClientMessage::Ping { id: PingId(m.id) },
        Wire::Control(m) => ClientMessage::Control {
            url: ControlUrl(m.url),
            playing: m.playing,
            position: Position(m.position),
            countdown: m.countdown,
        },
        Wire::Status(m) => ClientMessage::Status { catching: m.catching },
        Wire::LayoutSet(m) => ClientMessage::LayoutSet { layout: m.layout.0.into() },
        Wire::TitleSet(m) => ClientMessage::TitleSet { title: m.title },
        Wire::Emote(m) => ClientMessage::Emote { kind: m.kind },
        Wire::React(m) => ClientMessage::React { kind: m.kind },
        Wire::Kick(m) => ClientMessage::Kick { member_id: m.member_id },
        Wire::Mute(m) => ClientMessage::Mute {
            member_id: m.member_id,
            muted: m.muted,
        },
        Wire::ControlPolicy(m) => ClientMessage::ControlPolicy { policy: m.policy },
        Wire::QueueAdd(m) => ClientMessage::QueueAdd { url: QueueUrl(m.url) },
        Wire::QueueRemove(m) => ClientMessage::QueueRemove { item_id: m.item_id },
        Wire::QueueMove(m) => ClientMessage::QueueMove {
            item_id: m.item_id,
            to_index: m.to_index,
        },
        Wire::QueueAdvance(m) => ClientMessage::QueueAdvance {
            from_item_id: m.from_item_id,
        },
        Wire::Ended(m) => ClientMessage::Ended {
            item_id: m.item_id,
            position: Position(m.position),
        },
    }
}

/// `parseClientMessage`: `None` for anything the contract refuses. Never panics. The size check
/// (UTF-8 bytes, `MAX_CLIENT_MESSAGE_BYTES`) comes before any JSON is read.
pub fn parse_client_message(frame: &str) -> Option<ClientMessage> {
    if frame.len() > MAX_CLIENT_MESSAGE_BYTES {
        return None;
    }
    parse_json::<Wire>(frame.as_bytes()).ok().map(convert)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{Value, json};

    fn parse(v: &Value) -> Option<ClientMessage> {
        parse_client_message(&v.to_string())
    }

    fn echo(v: Value) {
        let got = parse(&v).and_then(|m| serde_json::to_value(m).ok());
        assert_eq!(got, Some(v));
    }

    /// The recorded TS decisions (`corpus/out/client-message-raw.json`), frame by frame. Here and not in
    /// `tests/corpus.rs` because `ClientMessage` serializes only under `cfg(test)`.
    #[test]
    fn corpus_agrees_with_ts() {
        fn numeric(v: Value) -> Value {
            match v {
                Value::Number(n) => n.as_f64().map_or(Value::Number(n), |f| json!(f)),
                Value::Array(a) => Value::Array(a.into_iter().map(numeric).collect()),
                Value::Object(o) => Value::Object(o.into_iter().map(|(k, v)| (k, numeric(v))).collect()),
                other => other,
            }
        }
        let cases: Vec<Value> = serde_json::from_str(include_str!("../../corpus/out/client-message-raw.json")).unwrap();
        assert!(cases.len() > 700);
        let mut wrong = Vec::new();
        for case in cases {
            let input = case["input"].as_str().unwrap();
            let want = (case["ok"] == true && case.get("rust").is_none()).then(|| numeric(case["output"].clone()));
            let got = parse_client_message(input).and_then(|m| serde_json::to_value(m).ok()).map(numeric);
            if got != want {
                wrong.push(format!("{input:?}: want {want:?}, Rust {got:?}"));
            }
        }
        assert!(wrong.is_empty(), "{} disagreement(s):\n{}", wrong.len(), wrong.join("\n"));
    }

    #[test]
    fn every_variant_parses_back_to_itself() {
        // packages/shared/test/{queue,moderation,catching,emote,session}-contract.test.ts
        let token = "A".repeat(22);
        for v in [
            json!({"type":"join","nickname":"Alice","avatar":1}),
            json!({"type":"join","nickname":"Alice","avatar":1,"ownerToken":token,"inviteKey":token,"durableSession":true,"resumeToken":"B".repeat(43)}),
            json!({"type":"leave"}),
            json!({"type":"presence","away":true}),
            json!({"type":"sit","seat":4}),
            json!({"type":"sit","seat":null}),
            json!({"type":"chat","text":"hello"}),
            json!({"type":"ping","id":7}),
            json!({"type":"control","url":"https://youtu.be/x","playing":true,"position":12.5}),
            json!({"type":"status","catching":true}),
            json!({"type":"title-set","title":"Films"}),
            json!({"type":"emote","kind":"cheer"}),
            json!({"type":"emote","kind":"dance"}),
            json!({"type":"pair","pose":"thrust"}),
            json!({"type":"pair","pose":"bendover"}),
            json!({"type":"lie","piece":31}),
            json!({"type":"lie","piece":null}),
            json!({"type":"kick","memberId":"m2"}),
            json!({"type":"mute","memberId":"m2","muted":false}),
            json!({"type":"control-policy","policy":"owner"}),
            json!({"type":"queue-add","url":"https://youtu.be/dQw4w9WgXcQ"}),
            json!({"type":"queue-remove","itemId":"q1"}),
            json!({"type":"queue-move","itemId":"q1","toIndex":0}),
            json!({"type":"queue-move","itemId":"q1","toIndex":19}),
            json!({"type":"queue-advance","fromItemId":"q1"}),
            json!({"type":"ended","itemId":"q1","position":212.5}),
        ] {
            echo(v);
        }
    }

    #[test]
    fn queue_move_to_index_is_an_integer_below_queue_max() {
        // packages/shared/test/queue-contract.test.ts (client queue-move)
        for bad in [
            json!({"type":"queue-move","itemId":"q1","toIndex":20}),
            json!({"type":"queue-move","itemId":"q1","toIndex":-1}),
            json!({"type":"queue-move","itemId":"q1","toIndex":1.5}),
            json!({"type":"queue-move","itemId":"q1","toIndex":"1"}),
            json!({"type":"queue-move","itemId":"q1","toIndex":null}),
            json!({"type":"queue-move","itemId":"q1"}),
            json!({"type":"queue-move","toIndex":0}),
            json!({"type":"queue-move","itemId":"q1","toIndex":0,"by":1}),
        ] {
            assert!(parse(&bad).is_none(), "{bad}");
        }
    }

    #[test]
    fn rejects_garbage_and_bad_fields() {
        // packages/shared/test/wire.test.ts:228-248
        assert!(parse_client_message("{nope").is_none());
        assert!(parse_client_message(r#"{"type":"sit","seat":99}"#).is_none());
        assert!(
            parse_client_message(r#"{"type":"sit"}"#).is_none(),
            "seat is required, null stands up"
        );
        assert!(parse_client_message(r#"{"type":"join","nickname":"A","avatar":0,"durableSession":false}"#).is_none());
        assert!(parse_client_message(r#"{"type":"join","nickname":"A","avatar":0,"shareToken":"x"}"#).is_none());
        // packages/shared/test/queue-contract.test.ts:135, playback.test.ts:135
        assert!(parse_client_message(r#"{"type":"ended","itemId":"q1","position":Infinity}"#).is_none());
        assert!(parse_client_message(r#"{"type":"control","url":"u","playing":true,"position":1e999}"#).is_none());
        // the array form of a tagged object, and a numeric tag
        assert!(parse_client_message(r#"["leave"]"#).is_none());
        assert!(parse_client_message(r#"{"type":1}"#).is_none());
    }

    #[test]
    fn frame_cap_is_in_utf8_bytes_and_checked_first() {
        // packages/shared/test/wire.test.ts:243-248
        let pad = |n: usize| format!(r#"{{"type":"leave"}}{}"#, " ".repeat(n));
        assert!(parse_client_message(&pad(4096 - 16)).is_some());
        assert!(parse_client_message(&pad(4096 - 15)).is_none());
        let euros = json!({"type":"chat","text":"€".repeat(1400)}).to_string();
        assert!(euros.len() > 4096 && euros.chars().count() < 4096);
        assert!(parse_client_message(&euros).is_none());
        // Oversize and not even JSON: refused without being read.
        assert!(parse_client_message(&"{".repeat(100_000)).is_none());
    }

    #[test]
    fn layout_set_uses_the_strict_layout_rules() {
        // packages/shared/test/rooms-contract.test.ts:300-305
        let one_tv = json!({"furniture":[{"kind":"tv","col":0,"row":0,"facing":"se"}]});
        assert!(
            parse(&json!({"type":"layout-set","layout":one_tv})).is_none(),
            "seat count is part of the layout rules"
        );
        assert!(parse(&json!({"type":"layout-set","layout":{"furniture":[]}})).is_none());
        assert!(parse(&json!({"type":"layout-set","layout":[]})).is_none());
        assert!(parse(&json!({"type":"layout-set"})).is_none());
    }

    #[test]
    fn debug_never_prints_tokens_or_user_text() {
        let token = "SecretTokenAAAAAAAAAAA";
        let join = json!({"type":"join","nickname":"Alice","avatar":1,"ownerToken":token,"inviteKey":token,"resumeToken":"B".repeat(43)});
        let chat = json!({"type":"chat","text":"private words"});
        let queue = json!({"type":"queue-add","url":"https://private.example/x"});
        for v in [join, chat, queue] {
            let shown = format!("{:?}", parse(&v).unwrap());
            for secret in [token, "BBBBBBBB", "private", "Alice"] {
                assert!(!shown.contains(secret), "{shown}");
            }
        }
    }

    #[test]
    fn layout_set_refuses_duplicate_keys_inside_the_layout() {
        let layout = serde_json::to_string(&json!({"furniture":[
            {"kind":"tv","col":0,"row":0,"facing":"se"},
            {"kind":"armchair","col":1,"row":5,"facing":"ne"},{"kind":"armchair","col":2,"row":4,"facing":"ne"},
            {"kind":"armchair","col":4,"row":2,"facing":"ne"},{"kind":"armchair","col":5,"row":1,"facing":"ne"},
            {"kind":"armchair","col":3,"row":7,"facing":"nw"},{"kind":"armchair","col":4,"row":6,"facing":"nw"},
            {"kind":"armchair","col":6,"row":4,"facing":"nw"},{"kind":"armchair","col":7,"row":3,"facing":"nw"},
        ]}))
        .unwrap();
        assert!(parse_client_message(&format!(r#"{{"type":"layout-set","layout":{layout}}}"#)).is_some());
        let dup_piece = layout.replacen(r#""kind":"tv""#, r#""kind":"tv","kind":"tv""#, 1);
        assert_ne!(dup_piece, layout);
        assert!(parse_client_message(&format!(r#"{{"type":"layout-set","layout":{dup_piece}}}"#)).is_none());
        let dup_key = layout.replacen('{', r#"{"furniture":[],"#, 1);
        assert!(parse_client_message(&format!(r#"{{"type":"layout-set","layout":{dup_key}}}"#)).is_none());
    }

    #[test]
    fn urls_are_capped_in_utf16_units() {
        let control = |u: String| json!({"type":"control","url":u,"playing":true,"position":0});
        assert!(parse(&control("😀".repeat(64))).is_some());
        assert!(parse(&control("😀".repeat(65))).is_none());
        assert!(parse(&json!({"type":"queue-add","url":"a".repeat(2048)})).is_some());
        assert!(parse(&json!({"type":"queue-add","url":"a".repeat(2049)})).is_none());
    }
}
