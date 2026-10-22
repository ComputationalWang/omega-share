//! Replays a `room-script` corpus case (corpus/room-corpora.ts) on the Rust `Room` and builds the same trace.

use omega_server::contract::confusables::nickname_key;
use omega_server::contract::generic_embed::AnyEmbed;
use omega_server::contract::ids::{MemberId, QueueItemId, RoomId};
use omega_server::contract::room::{Avatar, ControlPolicy, RoomVisibility, SeatIndex};
use omega_server::contract::state::{Member, QueueItem};
use omega_server::contract::text::{Nickname, RoomTitle};
use omega_server::playback::Control;
use omega_server::room::{EmbedSwitch, HeldSeat, JoinFailure, Room, RoomInit, SitResult};
use omega_server::secrets::hash_secret;
use serde::Deserialize;
use serde_json::{Value, json};

const T0: i64 = 1_700_000_000_000;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct InitQueue {
    id: QueueItemId,
    embed: AnyEmbed,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct Init {
    embed: Option<AnyEmbed>,
    title: Option<String>,
    visibility: Option<RoomVisibility>,
    pinned: Option<bool>,
    created_at: Option<i64>,
    owner_token: Option<String>,
    invite_key: Option<String>,
    last_active_at: Option<i64>,
    control_policy: Option<ControlPolicy>,
    item_id: Option<QueueItemId>,
    queue: Option<Vec<InitQueue>>,
    item_since: Option<f64>,
}

#[derive(Debug, Deserialize)]
struct WireControl {
    url: String,
    playing: bool,
    position: f64,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "op", rename_all = "camelCase", rename_all_fields = "camelCase")]
enum Op {
    Join {
        id: MemberId,
        nick: String,
        avatar: u64,
        client: Option<String>,
    },
    Leave {
        m: MemberId,
    },
    Sit {
        m: MemberId,
        seat: Option<u64>,
    },
    SetMuted {
        m: MemberId,
        muted: bool,
    },
    RestoreMute {
        m: MemberId,
    },
    IsMuted {
        m: MemberId,
    },
    CoolDown {
        client: String,
        until: i64,
    },
    IsCoolingDown {
        client: String,
    },
    MoveClient {
        m: MemberId,
        client: Option<String>,
    },
    SetAway {
        m: MemberId,
        away: bool,
    },
    SetCatching {
        m: MemberId,
        catching: bool,
    },
    IsCatching {
        m: MemberId,
    },
    TakeCatchingChange {
        m: MemberId,
    },
    HeldSeats,
    HoldNames {
        holds: Vec<(String, u64)>,
        until: i64,
    },
    ClaimHeldSeat {
        m: MemberId,
    },
    SetEmbed {
        embed: Option<AnyEmbed>,
        by: Option<MemberId>,
        item_id: Option<QueueItemId>,
        since: f64,
    },
    Enqueue {
        id: QueueItemId,
        embed: AnyEmbed,
        by: Option<MemberId>,
    },
    Dequeue {
        id: QueueItemId,
    },
    Advance {
        since: f64,
        by: Option<MemberId>,
    },
    Control {
        m: MemberId,
        control: WireControl,
    },
    SetTitle {
        title: Option<String>,
    },
    SetControlPolicy {
        policy: ControlPolicy,
    },
    IsOwner {
        token: String,
    },
    IsInvited {
        key: String,
    },
    View {
        m: MemberId,
    },
    HasOwner,
    ItemInfo,
}

#[derive(Debug, Deserialize)]
pub struct Line {
    #[serde(flatten)]
    op: Op,
    now: Option<i64>,
}

#[derive(Debug, Deserialize)]
pub struct Script {
    init: Init,
    ops: Vec<Line>,
}

fn val<T: serde::Serialize>(v: &T) -> Option<Value> {
    serde_json::to_value(v).ok()
}

/// A JS number as JSON: integral values without a fraction, as `JSON.stringify` writes them.
#[allow(clippy::cast_possible_truncation, reason = "a test harness: the values are small")]
fn num(n: f64) -> Value {
    if n.fract() == 0.0 && n.abs() < 9e15 {
        json!(n as i64)
    } else {
        json!(n)
    }
}

fn switch(s: &EmbedSwitch) -> Option<Value> {
    Some(json!({ "playback": val(&s.playback)?, "uncaught": val(&s.uncaught)? }))
}

fn hex(h: &[u8; 32]) -> String {
    h.iter().map(|b| format!("{b:02x}")).collect()
}

fn apply(room: &mut Room, op: &Op, op_now: Option<i64>, now: i64) -> Option<Value> {
    Some(match op {
        Op::Join { id, nick, avatar, client } => {
            match room.join_with_id(id.clone(), &Nickname::parse(nick)?, Avatar::new(*avatar)?, client.as_deref()) {
                Ok(member) => json!({ "ok": true, "member": val::<Member>(&member)? }),
                Err(JoinFailure::RoomFull) => json!({ "ok": false, "reason": "room_full" }),
                Err(JoinFailure::TooManyMembers) => json!({ "ok": false, "reason": "too_many_members" }),
                Err(JoinFailure::NicknameTaken) => json!({ "ok": false, "reason": "nickname_taken" }),
            }
        }
        Op::Leave { m } => {
            room.leave(m, op_now?);
            Value::Null
        }
        Op::Sit { m, seat } => {
            let seat = match seat {
                Some(s) => Some(SeatIndex::new(*s)?),
                None => None,
            };
            match room.sit(m, seat) {
                SitResult::Ok => json!("ok"),
                SitResult::SeatTaken => json!("seat_taken"),
                SitResult::NotMember => json!("not_member"),
            }
        }
        Op::SetMuted { m, muted } => json!(room.set_muted(m, *muted)),
        Op::RestoreMute { m } => json!(room.restore_mute(m, op_now?)),
        Op::IsMuted { m } => json!(room.is_muted(m)),
        Op::CoolDown { client, until } => {
            room.cool_down(client, *until, op_now?);
            Value::Null
        }
        Op::IsCoolingDown { client } => json!(room.is_cooling_down(client, op_now?)),
        Op::MoveClient { m, client } => json!(room.move_client(m, client.as_deref())),
        Op::SetAway { m, away } => json!(room.set_away(m, *away)),
        Op::SetCatching { m, catching } => {
            room.set_catching(m, *catching);
            Value::Null
        }
        Op::IsCatching { m } => json!(room.is_catching(m)),
        Op::TakeCatchingChange { m } => json!(room.take_catching_change(m)),
        Op::HeldSeats => Value::Array(
            room.held_seats()
                .iter()
                .map(|h| json!({ "nameHash": hex(&h.name_hash), "seat": h.seat.get() }))
                .collect(),
        ),
        Op::HoldNames { holds, until } => {
            let mut held = Vec::new();
            for (name, seat) in holds {
                let key = nickname_key(Nickname::parse(name)?.as_str());
                held.push(HeldSeat {
                    name_hash: hash_secret(&key),
                    seat: SeatIndex::new(*seat)?,
                });
            }
            room.hold_seats(&held, *until);
            Value::Null
        }
        Op::ClaimHeldSeat { m } => json!(room.claim_held_seat(m, op_now?).map(SeatIndex::get)),
        Op::SetEmbed { embed, by, item_id, since } => {
            // The corpus always names the item id; a null one would mint a random id TS cannot pin.
            if embed.is_some() && item_id.is_none() {
                return None;
            }
            switch(&room.set_embed(embed.clone(), by.clone(), item_id.clone(), *since, now).ok()?)?
        }
        Op::Enqueue { id, embed, by } => {
            room.enqueue(QueueItem {
                id: id.clone(),
                embed: embed.clone(),
                by: by.clone(),
                start_seconds: None,
            });
            Value::Null
        }
        Op::Dequeue { id } => json!(room.dequeue(id)),
        Op::Advance { since, by } => match room.advance(*since, by.clone(), now) {
            None => Value::Null,
            Some(a) => json!({ "item": val(&a.item)?, "embedSwitch": switch(&a.embed_switch)? }),
        },
        Op::Control { m, control } => {
            let c = Control {
                url: &control.url,
                playing: control.playing,
                position: control.position,
                // The TS reference has no countdown (ADR 0056: Rust only).
                countdown: false,
            };
            val(&room.control(m, &c, now))?
        }
        Op::SetTitle { title } => {
            room.set_title(match title {
                Some(t) => Some(RoomTitle::parse(t)?),
                None => None,
            });
            Value::Null
        }
        Op::SetControlPolicy { policy } => {
            room.set_control_policy(*policy);
            Value::Null
        }
        Op::IsOwner { token } => json!(room.is_owner(token)),
        Op::IsInvited { key } => json!(room.is_invited(key)),
        Op::View { m } => room
            .snapshot()
            .members
            .iter()
            .find(|x| x.id.as_str() == m.as_str())
            .map_or(Value::Null, |x| val(x).unwrap_or(Value::Null)),
        Op::HasOwner => json!(room.has_owner()),
        Op::ItemInfo => json!({
            "itemId": val(&room.item_id())?,
            "itemSince": if room.item_since() == f64::NEG_INFINITY { json!("-inf") } else { num(room.item_since()) },
            "hasGeneric": room.has_generic_embed(),
            "count": room.member_count(),
        }),
    })
}

/// The trace of the script, or `None` if it could not be replayed at all (a corpus bug the test reports).
pub fn run(script: &Script) -> Option<Vec<Value>> {
    let init = &script.init;
    let init = RoomInit {
        layout: None,
        embed: init.embed.clone(),
        title: match &init.title {
            Some(t) => Some(RoomTitle::parse(t)?),
            None => None,
        },
        visibility: init.visibility,
        pinned: init.pinned,
        created_at: init.created_at,
        owner_hash: init.owner_token.as_deref().map(hash_secret),
        invite_hash: init.invite_key.as_deref().map(hash_secret),
        last_active_at: init.last_active_at,
        control_policy: init.control_policy,
        item_id: init.item_id.clone(),
        queue: init.queue.iter().flatten().map(|q| (q.id.clone(), q.embed.clone())).collect(),
        item_since: init.item_since,
    };
    let mut room = Room::new(RoomId::parse("film-club")?, init, T0).ok()?;
    let mut now = T0;
    let mut trace = Vec::new();
    for line in &script.ops {
        now = line.now.unwrap_or(now);
        let result = apply(&mut room, &line.op, line.now, now)?;
        let mut snapshot = val(&room.snapshot())?;
        snapshot.as_object_mut()?.remove("layout");
        // The bytes the server sends: key order, number text and the layout included.
        let snapshot_json = serde_json::to_string(&room.snapshot()).ok()?;
        trace.push(json!({ "result": result, "snapshot": snapshot, "snapshotJson": snapshot_json, "summary": val(&room.summary())? }));
    }
    Some(trace)
}
