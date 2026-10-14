//! Port of `apps/server/src/reports.ts`: abuse reports (ADR 0033), the limits, the in-memory duplicate set,
//! what a report stores, and the operator's side (queue, dismiss, takedown). Reports are never logged and never
//! reach a room.
//!
//! State that outlives a request is [`ReportsState`] (`app.reports`); everything else is a function over the
//! `&App`, the room's locked [`RoomInner`] where a room is involved, and the store.

use crate::app::{App, lock};
use crate::contract::constants::{REPORT_KEY_BURST, REPORT_KEY_REFILL_MS, REPORT_MAX_OPEN, REPORT_RETENTION_MS, REPORT_ROOM_REFILL_MS};
use crate::contract::ids::RoomId;
use crate::contract::requests::{ReportReason, ReportRequest};
use crate::contract::room::RoomVisibility;
use crate::log::{LogEvent, log_error, redact_addresses};
use crate::rate_limit::{DEFAULT_MAX_KEYS, KeyedLimiter, is_loopback_key};
use crate::registry::RemoveReason;
use crate::registry::RoomInner;
use crate::secrets::mint_report_id;
use crate::store::{NewReport, REPORT_MAX_ROWS, ReportId, StoreError};
use serde::Serialize;
use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::{Mutex, PoisonError, RwLock};

/// Most duplicate marks held: one per stored report at most, so no more than the table's rows.
pub const MAX_DEDUP_ENTRIES: usize = REPORT_MAX_ROWS;

/// A note as stored (ADR 0033 section 3): emails, IP addresses and phone numbers redacted.
/// Phone-like: 7 or more digits with single spaces, dots or dashes between them and an optional leading `+`,
/// not inside a word or a URL path or query (`/76979871`), so links stay usable as evidence.
pub fn redact_note(note: &str) -> String {
    replace_phones(&redact_addresses(note))
}

/// JS `\w` (no `u` flag): ASCII only.
fn is_word(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_'
}

/// The end of the phone-like run starting at `start`, if one does:
/// `(?<![\w/.=?&#%+:-])\+?\d(?:[ .-]?\d){6,}(?!\w)`, with the regex's backtracking (a run followed by a word
/// character gives digits back until what follows is a separator).
fn phone_at(c: &[char], start: usize) -> Option<usize> {
    if start > 0 && c.get(start - 1).is_some_and(|&p| is_word(p) || "/.=?&#%+:-".contains(p)) {
        return None;
    }
    let digit = |i: usize| c.get(i).is_some_and(char::is_ascii_digit);
    let mut i = start + usize::from(c.get(start) == Some(&'+'));
    if !digit(i) {
        return None;
    }
    i += 1;
    // `ends[k]` is where the run stands after k + 1 repetitions of `[ .-]?\d`.
    let mut ends = Vec::new();
    loop {
        let j = i + usize::from(matches!(c.get(i), Some(' ' | '.' | '-')));
        if !digit(j) {
            break;
        }
        i = j + 1;
        ends.push(i);
    }
    ends.iter()
        .skip(5)
        .rev()
        .find(|&&end| !c.get(end).is_some_and(|&n| is_word(n)))
        .copied()
}

fn replace_phones(s: &str) -> String {
    let chars: Vec<char> = s.chars().collect();
    let mut out = String::with_capacity(s.len());
    let mut i = 0;
    while let Some(&ch) = chars.get(i) {
        match phone_at(&chars, i) {
            Some(end) => {
                out.push_str("<phone>");
                i = end;
            }
            None => {
                out.push(ch);
                i += 1;
            }
        }
    }
    out
}

/// Which client keys reported which room, for `already_reported` (ADR 0033 section 3). Memory only, never
/// written, logged or counted. Insertion order is report order, so the oldest mark is evicted first at the cap.
#[derive(Debug, Default)]
pub struct ReportDedup {
    marks: HashMap<String, Mark>,
    order: BTreeMap<u64, String>,
    seq: u64,
}

#[derive(Debug)]
struct Mark {
    seq: u64,
    room: RoomId,
    at: i64,
}

impl ReportDedup {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn size(&self) -> usize {
        self.marks.len()
    }

    /// `"<room> <key>"`, as the TS map key (a room id has no space, so it can't collide).
    fn mark(room: &RoomId, key: &str) -> String {
        format!("{} {key}", room.as_str())
    }

    pub fn has(&self, room: &RoomId, key: &str) -> bool {
        self.marks.contains_key(&Self::mark(room, key))
    }

    pub fn add(&mut self, room: &RoomId, key: &str, at: i64) {
        let mark = Self::mark(room, key);
        if let Some(old) = self.marks.remove(&mark) {
            self.order.remove(&old.seq);
        }
        let seq = self.seq;
        self.seq = seq.saturating_add(1);
        self.order.insert(seq, mark.clone());
        self.marks.insert(
            mark,
            Mark {
                seq,
                room: room.clone(),
                at,
            },
        );
        if self.marks.len() > MAX_DEDUP_ENTRIES
            && let Some((_, oldest)) = self.order.pop_first()
        {
            self.marks.remove(&oldest);
        }
    }

    /// Drops marks made at or before `cutoff` (their rows are purged with them).
    pub fn expire(&mut self, cutoff: i64) {
        self.retain(|m| m.at > cutoff);
    }

    /// The room is gone, taken down, or its reports were dismissed: it may be reported afresh.
    pub fn drop_room(&mut self, room: &RoomId) {
        self.retain(|m| m.room != *room);
    }

    fn retain(&mut self, keep: impl Fn(&Mark) -> bool) {
        let order = &mut self.order;
        self.marks.retain(|_, m| {
            let kept = keep(m);
            if !kept {
                order.remove(&m.seq);
            }
            kept
        });
    }
}

/// What `file` decided after the room bucket (the key bucket and the body parse come before: `admit_key`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FileResult {
    Received,
    AlreadyReported,
    RateLimited { retry_after_ms: u64 },
    Unavailable,
}

/// The process-wide report state: the per-key limiter, the duplicate marks, the taken-down ids.
#[derive(Debug)]
pub struct ReportsState {
    keys: Mutex<KeyedLimiter>,
    dedup: Mutex<ReportDedup>,
    taken_down: RwLock<HashSet<RoomId>>,
}

impl ReportsState {
    /// `taken_down`: the tombstones the store holds.
    pub fn new(taken_down: Vec<RoomId>) -> Self {
        Self {
            keys: Mutex::new(KeyedLimiter::new(
                f64::from(REPORT_KEY_BURST),
                1000.0 / REPORT_KEY_REFILL_MS as f64,
                DEFAULT_MAX_KEYS,
            )),
            dedup: Mutex::new(ReportDedup::new()),
            taken_down: RwLock::new(taken_down.into_iter().collect()),
        }
    }

    /// `isTakenDown`: the id was taken down (a tombstone), live or not.
    pub fn is_taken_down(&self, id: &RoomId) -> bool {
        self.taken_down.read().unwrap_or_else(PoisonError::into_inner).contains(id)
    }

    pub fn dedup_size(&self) -> usize {
        lock(&self.dedup).size()
    }

    /// A tombstone written elsewhere (tests, the store).
    pub fn mark_taken_down(&self, id: &RoomId) {
        self.taken_down.write().unwrap_or_else(PoisonError::into_inner).insert(id.clone());
    }

    /// For tests and the removal hook.
    pub fn dedup_add(&self, room: &RoomId, key: &str, at: i64) {
        lock(&self.dedup).add(room, key, at);
    }

    /// The removal hook of a room: its duplicate marks go.
    pub fn drop_room(&self, room: &RoomId) {
        lock(&self.dedup).drop_room(room);
    }
}

/// The key bucket, before the body is parsed: 0 if a report may go ahead, else the wait in ms. Loopback skips it.
pub fn admit_key(app: &App, key: &str) -> u64 {
    if is_loopback_key(key) {
        return 0;
    }
    let now = app.mono();
    let mut keys = lock(&app.reports.keys);
    if keys.take(key, now) {
        return 0;
    }
    keys.retry_after_ms_capped(key, now, REPORT_KEY_REFILL_MS as f64).max(1000.0) as u64
}

/// A key a duplicate can be pinned on: not loopback (dev, tests), not the shared `proxy:unknown` or an unknown peer.
fn usable_key(key: &str) -> bool {
    !is_loopback_key(key) && key != "proxy:unknown" && key != "unknown"
}

fn reason_str(reason: ReportReason) -> &'static str {
    match reason {
        ReportReason::Sexual => "sexual",
        ReportReason::Violence => "violence",
        ReportReason::Hate => "hate",
        ReportReason::Spam => "spam",
        ReportReason::Danger => "danger",
        ReportReason::Other => "other",
    }
}

/// Why a store write did not happen.
enum Unwritten {
    Capped,
    Failed(Box<dyn std::error::Error>),
}

/// The rest of the check order: room bucket, duplicate, open cap, store.
pub fn file(app: &App, inner: &mut RoomInner, key: &str, request: &ReportRequest) -> FileResult {
    let now = app.mono();
    let metrics = &app.metrics;
    if !inner.report_bucket.take(now) {
        metrics.count_report("rate_limited", None);
        let wait = inner.report_bucket.retry_after_ms_capped(now, REPORT_ROOM_REFILL_MS as f64);
        return FileResult::RateLimited {
            retry_after_ms: wait.max(1000.0) as u64,
        };
    }
    let keyed = usable_key(key);
    if keyed && lock(&app.reports.dedup).has(&inner.room.id, key) {
        metrics.count_report("already_reported", None);
        return FileResult::AlreadyReported;
    }
    let written = (|| {
        let id = mint_report_id().map_err(|e| Unwritten::Failed(Box::new(e)))?;
        let report = NewReport {
            id,
            room_id: inner.room.id.clone(),
            reason: reason_str(request.reason).to_owned(),
            note: request.note.as_ref().map(|n| redact_note(n.as_str())),
            room_title: inner.room.title().map(|t| t.as_str().to_owned()),
            embed_url: inner.room.current_embed().map(|e| e.url().to_owned()),
            created_at: app.wall(),
        };
        let store = app.store();
        let reports = store.reports();
        let open = reports.open_count().map_err(|e| Unwritten::Failed(Box::new(e)))?;
        if open >= REPORT_MAX_OPEN {
            return Err(Unwritten::Capped);
        }
        reports.add(&report).map_err(|e| Unwritten::Failed(Box::new(e)))
    })();
    match written {
        Ok(()) => {}
        Err(Unwritten::Capped) => {
            metrics.count_report("unavailable", None);
            return FileResult::Unavailable;
        }
        Err(Unwritten::Failed(err)) => {
            // The event and the error class only: the message is cut at its first quote and scrubbed (log.rs).
            log_error(LogEvent::StoreReport, Some(err.as_ref()));
            inner.report_bucket.refund(now);
            if !is_loopback_key(key) {
                lock(&app.reports.keys).refund(key, now);
            }
            metrics.count_report("unavailable", None);
            return FileResult::Unavailable;
        }
    }
    if keyed {
        lock(&app.reports.dedup).add(&inner.room.id, key, app.wall());
    }
    metrics.count_report("received", Some(reason_str(request.reason)));
    FileResult::Received
}

/// An answer decided before `file` (bad body, unknown room, key bucket), for `/metrics`:
/// `invalid_body`, `payload_too_large`, `room_not_found`, `rate_limited`, `unavailable`.
pub fn count(app: &App, outcome: &str) {
    app.metrics.count_report(outcome, None);
}

/// Whether the id has been taken down.
pub fn is_taken_down(app: &App, id: &RoomId) -> bool {
    app.reports.is_taken_down(id)
}

/// Open reports (`GET /metrics`' gauge).
pub fn open_count(app: &App) -> Result<usize, StoreError> {
    app.store().reports().open_count()
}

/// A reported room's state now.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ReportedState {
    Live,
    TakenDown,
    Gone,
}

/// One open report as the operator sees it (admin.ts `AdminReportSchema`): what the table holds, nothing more.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AdminReport {
    pub id: ReportId,
    pub created_at: i64,
    pub reason: String,
    pub note: Option<String>,
    /// The room's title at report time.
    pub title: Option<String>,
    /// What was playing at report time.
    pub embed_url: Option<String>,
}

/// A reported room: its state now and its open reports, newest first (admin.ts `AdminReportRoomSchema`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct AdminReportRoom {
    pub id: RoomId,
    pub state: ReportedState,
    /// Now; `None` unless live (a live room without a title says `""`, as TS does).
    pub title: Option<String>,
    pub visibility: Option<RoomVisibility>,
    pub members: Option<usize>,
    pub reports: Vec<AdminReport>,
}

/// Open reports grouped by room, most reported first.
pub fn list(app: &App) -> Result<Vec<AdminReportRoom>, StoreError> {
    // Newest first, so each room's reports stay newest first. The store lock is released before any room's.
    let open = app.store().reports().list_open()?;
    let mut rooms: Vec<AdminReportRoom> = Vec::new();
    let mut index: HashMap<RoomId, usize> = HashMap::new();
    for r in open {
        let at = match index.get(&r.room_id) {
            Some(&at) => at,
            None => {
                let entry = match app.registry.get(&r.room_id) {
                    Some(cell) => {
                        let inner = cell.lock();
                        AdminReportRoom {
                            id: r.room_id.clone(),
                            state: ReportedState::Live,
                            title: Some(inner.room.title().map_or_else(String::new, |t| t.as_str().to_owned())),
                            visibility: Some(inner.room.visibility),
                            members: Some(inner.room.member_count()),
                            reports: Vec::new(),
                        }
                    }
                    None => AdminReportRoom {
                        id: r.room_id.clone(),
                        state: if app.reports.is_taken_down(&r.room_id) {
                            ReportedState::TakenDown
                        } else {
                            ReportedState::Gone
                        },
                        title: None,
                        visibility: None,
                        members: None,
                        reports: Vec::new(),
                    },
                };
                rooms.push(entry);
                index.insert(r.room_id.clone(), rooms.len() - 1);
                rooms.len() - 1
            }
        };
        if let Some(entry) = rooms.get_mut(at) {
            entry.reports.push(AdminReport {
                id: r.id,
                created_at: r.created_at,
                reason: r.reason,
                note: r.note,
                title: r.room_title,
                embed_url: r.embed_url,
            });
        }
    }
    let newest = |e: &AdminReportRoom| e.reports.first().map_or(0, |r| r.created_at);
    rooms.sort_by(|a, b| {
        b.reports
            .len()
            .cmp(&a.reports.len())
            .then_with(|| newest(b).cmp(&newest(a)))
            .then_with(|| a.id.as_str().cmp(b.id.as_str()))
    });
    Ok(rooms)
}

/// 1 if the report was open, else 0.
pub fn dismiss(app: &App, id: &ReportId) -> Result<usize, StoreError> {
    Ok(usize::from(app.store().reports().dismiss(id)?))
}

pub fn dismiss_room(app: &App, room: &RoomId) -> Result<usize, StoreError> {
    let n = app.store().reports().dismiss_room(room)?;
    app.reports.drop_room(room);
    Ok(n)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Takedown {
    /// The room was live and has been ended.
    pub live: bool,
}

/// Ends the room for good (ADR 0033 section 5). `Err`, changing nothing, if the tombstone can't be written.
pub fn takedown(app: &App, id: &RoomId) -> Result<Takedown, StoreError> {
    // The tombstone first: if it can't be written, the room is left as it was.
    let added = app.store().reports().add_takedown(id, app.wall())?;
    app.reports.mark_taken_down(id);
    let live = app.remove_room(id, RemoveReason::TakenDown);
    // The removal hook deleted the row already; this catches one a failed earlier delete left behind.
    let deleted = app.store().rooms().delete_room(id);
    if let Err(err) = deleted {
        log_error(LogEvent::StoreDeleteRoom, Some(&err));
    }
    app.store().reports().action_room(id)?;
    app.reports.drop_room(id);
    if added {
        app.metrics.count_takedown();
    }
    Ok(Takedown { live })
}

/// Retention: the GC sweep runs it.
pub fn purge(app: &App) -> Result<(), StoreError> {
    let now = app.wall();
    let retention = i64::try_from(REPORT_RETENTION_MS).unwrap_or(i64::MAX);
    app.store().reports().purge(now.saturating_sub(retention).saturating_add(1))?;
    lock(&app.reports.dedup).expire(now.saturating_sub(retention));
    Ok(())
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::indexing_slicing, reason = "tests")]
mod tests {
    use super::*;
    use crate::app::testing::*;
    use crate::contract::constants::{REPORT_KEY_BURST, REPORT_KEY_REFILL_MS, REPORT_ROOM_BURST, REPORT_ROOM_REFILL_MS};
    use crate::contract::requests::parse_report_request;
    use crate::contract::text::RoomTitle;
    use crate::outbox::{ConnId, Outbound, channel};
    use crate::room::RoomInit;
    use crate::store::NewReport;

    const ROOM: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaa";
    const OTHER: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbb";
    const KEY: &str = "198.51.100.7";

    fn req(json: &str) -> ReportRequest {
        parse_report_request(json.as_bytes()).unwrap()
    }

    fn spam() -> ReportRequest {
        req(r#"{"reason":"spam"}"#)
    }

    fn stored(app: &App) -> Vec<NewReport> {
        app.store().reports().list_open().unwrap()
    }

    fn text(app: &App) -> String {
        app.metrics.render(&Default::default())
    }

    fn do_file(app: &App, room: &str, key: &str, r: &ReportRequest) -> FileResult {
        let cell = app.registry.get(&rid(room)).unwrap();
        let mut inner = cell.lock();
        file(app, &mut inner, key, r)
    }

    // apps/server/test/reports.test.ts:369
    #[test]
    fn redact_note_replaces_emails_ips_and_phone_like_runs_and_keeps_links() {
        assert_eq!(redact_note("mail ada.l@example.org now"), "mail <email> now");
        assert_eq!(redact_note("from 203.0.113.9 and 2001:db8::1"), "from <ip> and <ip>");
        assert_eq!(
            redact_note("call +44 20 7946 0958 or 555-123-4567 or 555.123.4567"),
            "call <phone> or <phone> or <phone>"
        );
        assert_eq!(
            redact_note("see https://vimeo.com/76979871 at 12:30, 3 people, 123456"),
            "see https://vimeo.com/76979871 at 12:30, 3 people, 123456"
        );
    }

    #[test]
    fn redact_note_phone_edges_follow_the_js_lookarounds() {
        // 6 digits are not a phone, 7 are.
        assert_eq!(redact_note("1234567"), "<phone>");
        assert_eq!(redact_note("123456"), "123456");
        // Not inside a word or after a digit/underscore/slash/dot/equals/question/amp/hash/percent/plus/colon/dash.
        assert_eq!(redact_note("a1234567"), "a1234567");
        assert_eq!(redact_note("x_1234567"), "x_1234567");
        assert_eq!(redact_note("id=1234567"), "id=1234567");
        assert_eq!(redact_note("?1234567"), "?1234567");
        assert_eq!(redact_note("-1234567"), "-1234567");
        assert_eq!(redact_note("+1234567"), "<phone>");
        assert_eq!(redact_note("++1234567"), "++1234567");
        // A trailing word character backs the match off to a separator, or fails.
        assert_eq!(redact_note("1234567a"), "1234567a");
        assert_eq!(redact_note("123 456 7890x"), "123 456 7890x");
        assert_eq!(redact_note("1-2-3-4-5-6-7"), "<phone>");
        assert_eq!(redact_note("1 2 3 4 5 6 7 8 9x"), "<phone> 9x");
        assert_eq!(redact_note("1234567 8"), "<phone>");
        assert_eq!(redact_note("12345678x"), "12345678x");
        assert_eq!(redact_note("1234567_"), "1234567_");
        assert_eq!(redact_note("tel:1234567"), "tel:1234567");
        assert_eq!(redact_note("(1234567)"), "(<phone>)");
        // The address redaction runs first.
        assert_eq!(redact_note("1.2.3.4.5.6.7"), "<ip>.5.6.7");
        assert_eq!(redact_note("12345678 and 87654321"), "<phone> and <phone>");
        // Astral characters are one non-word character before or after.
        assert_eq!(redact_note("\u{1F600}1234567\u{1F600}"), "\u{1F600}<phone>\u{1F600}");
    }

    // apps/server/test/reports.test.ts:181
    #[test]
    fn dedup_holds_at_most_the_row_cap_evicting_the_oldest() {
        let mut d = ReportDedup::new();
        let room = rid(ROOM);
        for i in 0..=MAX_DEDUP_ENTRIES {
            d.add(&room, &format!("k{i}"), T0 + i as i64);
        }
        assert_eq!(d.size(), MAX_DEDUP_ENTRIES);
        assert!(!d.has(&room, "k0"));
        assert!(d.has(&room, &format!("k{MAX_DEDUP_ENTRIES}")));
    }

    // apps/server/test/reports.test.ts:190
    #[test]
    fn dedup_expire_drops_at_or_before_the_cutoff_and_drop_room_one_rooms_marks() {
        let mut d = ReportDedup::new();
        let (room, other) = (rid(ROOM), rid(OTHER));
        d.add(&room, "a", T0);
        d.add(&other, "a", T0 + 1);
        d.add(&room, "b", T0 + 2);
        d.expire(T0);
        assert_eq!([d.has(&room, "a"), d.has(&other, "a"), d.has(&room, "b")], [false, true, true]);
        d.drop_room(&room);
        assert_eq!((d.size(), d.has(&other, "a")), (1, true));
    }

    #[test]
    fn dedup_re_adding_a_mark_makes_it_the_newest() {
        let mut d = ReportDedup::new();
        let room = rid(ROOM);
        for i in 0..MAX_DEDUP_ENTRIES {
            d.add(&room, &format!("k{i}"), T0);
        }
        d.add(&room, "k0", T0);
        d.add(&room, "new", T0);
        assert!(d.has(&room, "k0"), "refreshed, so k1 went instead");
        assert!(!d.has(&room, "k1"));
        assert_eq!(d.size(), MAX_DEDUP_ENTRIES);
    }

    // apps/server/test/reports.test.ts:77
    #[test]
    fn a_report_is_stored_with_reason_redacted_note_title_and_what_was_playing() {
        let (app, clock) = app();
        let embed = app.embeds.accept("https://youtu.be/dQw4w9WgXcQ").unwrap();
        add_room(
            &app,
            ROOM,
            RoomInit {
                title: Some(RoomTitle::parse("Film club").unwrap()),
                embed: Some(embed.clone()),
                ..RoomInit::default()
            },
        );
        clock.set_wall(T0 + 5000);
        let r = req(r#"{"reason":"hate","note":"host posts slurs, mail me at ada@example.com"}"#);
        assert_eq!(do_file(&app, ROOM, KEY, &r), FileResult::Received);
        let rows = stored(&app);
        assert_eq!(rows.len(), 1);
        let row = &rows[0];
        assert_eq!(row.room_id.as_str(), ROOM);
        assert_eq!(row.reason, "hate");
        assert_eq!(row.note.as_deref(), Some("host posts slurs, mail me at <email>"));
        assert_eq!(row.room_title.as_deref(), Some("Film club"));
        assert_eq!(row.embed_url.as_deref(), Some(embed.url()));
        assert_eq!(row.created_at, T0 + 5000);
        assert_eq!(row.id.as_str().len(), 22);
        assert!(text(&app).contains("omega_reports_total{outcome=\"received\"} 1"), "{}", text(&app));
    }

    // apps/server/test/reports.test.ts:98
    #[test]
    fn without_a_note_or_title_or_embed_those_are_null() {
        let (app, _) = app();
        add_room(&app, OTHER, RoomInit::default());
        assert_eq!(do_file(&app, OTHER, KEY, &spam()), FileResult::Received);
        let row = &stored(&app)[0];
        assert_eq!(
            (row.note.clone(), row.room_title.clone(), row.embed_url.clone()),
            (None, None, None)
        );
    }

    // apps/server/test/reports.test.ts:143
    #[test]
    fn the_same_key_reporting_the_same_room_again_is_already_reported_and_stores_nothing() {
        let (app, _) = app();
        add_room(&app, ROOM, RoomInit::default());
        add_room(&app, OTHER, RoomInit::default());
        assert_eq!(do_file(&app, ROOM, KEY, &spam()), FileResult::Received);
        assert_eq!(do_file(&app, ROOM, KEY, &spam()), FileResult::AlreadyReported);
        assert_eq!(stored(&app).len(), 1);
        // Other keys, and other rooms, are not duplicates.
        assert_eq!(do_file(&app, ROOM, "198.51.100.8", &spam()), FileResult::Received);
        assert_eq!(do_file(&app, OTHER, KEY, &spam()), FileResult::Received);
        assert_eq!(stored(&app).len(), 3);
        assert!(text(&app).contains("outcome=\"already_reported\"} 1"));
    }

    // apps/server/test/reports.test.ts:160
    #[test]
    fn keys_that_cannot_be_pinned_on_a_reporter_get_no_duplicate_check() {
        let (app, _) = app();
        add_room(&app, ROOM, RoomInit::default());
        for key in ["proxy:unknown", "unknown", "127.0.0.1"] {
            assert_eq!(do_file(&app, ROOM, key, &spam()), FileResult::Received, "{key}");
            assert_eq!(do_file(&app, ROOM, key, &spam()), FileResult::Received, "{key} again");
        }
    }

    // apps/server/test/reports.test.ts:218
    #[test]
    fn per_room_bucket_allows_a_burst_then_rate_limits_with_a_wait_of_at_least_a_second_and_refills() {
        let (app, clock) = app();
        add_room(&app, ROOM, RoomInit::default());
        add_room(&app, OTHER, RoomInit::default());
        for i in 0..REPORT_ROOM_BURST {
            assert_eq!(do_file(&app, ROOM, &format!("198.51.100.{}", i + 1), &spam()), FileResult::Received);
        }
        let FileResult::RateLimited { retry_after_ms } = do_file(&app, ROOM, "198.51.100.200", &spam()) else {
            panic!("expected rate_limited")
        };
        assert!((1000..=REPORT_ROOM_REFILL_MS).contains(&retry_after_ms), "{retry_after_ms}");
        assert_eq!(do_file(&app, OTHER, "198.51.100.200", &spam()), FileResult::Received);
        clock.set_mono(app.mono() + REPORT_ROOM_REFILL_MS as f64);
        assert_eq!(do_file(&app, ROOM, "198.51.100.201", &spam()), FileResult::Received);
        assert!(text(&app).contains("outcome=\"rate_limited\"} 1"));
    }

    // apps/server/test/reports.test.ts:202
    #[test]
    fn per_key_bucket_admits_a_burst_then_says_how_long_to_wait_and_loopback_skips_it() {
        let (app, clock) = app();
        for _ in 0..REPORT_KEY_BURST {
            assert_eq!(admit_key(&app, KEY), 0);
        }
        let wait = admit_key(&app, KEY);
        assert!((1000..=REPORT_KEY_REFILL_MS).contains(&wait), "{wait}");
        assert_eq!(admit_key(&app, "198.51.100.9"), 0, "another key");
        for _ in 0..10 {
            assert_eq!(admit_key(&app, "127.0.0.1"), 0);
        }
        clock.set_mono(app.mono() + REPORT_KEY_REFILL_MS as f64);
        assert_eq!(admit_key(&app, KEY), 0);
    }

    // apps/server/test/reports.test.ts:255
    #[test]
    fn at_the_open_cap_nothing_more_is_stored() {
        let (app, _) = app();
        add_room(&app, ROOM, RoomInit::default());
        {
            let store = app.store();
            let reports = store.reports();
            for i in 0..REPORT_MAX_OPEN {
                reports
                    .add(&NewReport {
                        id: ReportId::parse(&format!("{i:022}")).unwrap(),
                        room_id: rid(ROOM),
                        reason: "spam".into(),
                        note: None,
                        room_title: None,
                        embed_url: None,
                        created_at: T0,
                    })
                    .unwrap();
            }
        }
        assert_eq!(do_file(&app, ROOM, KEY, &spam()), FileResult::Unavailable);
        assert_eq!(stored(&app).len(), REPORT_MAX_OPEN);
        assert!(text(&app).contains("outcome=\"unavailable\"} 1"));
        assert_eq!(app.reports.dedup_size(), 0);
    }

    // apps/server/test/reports.test.ts:269
    #[test]
    fn a_store_failure_is_unavailable_refunds_the_buckets_and_leaves_no_duplicate_mark() {
        let (app, clock) = app();
        add_room(&app, ROOM, RoomInit::default());
        // A negative wall clock is not a valid `created_at`, so the write is refused.
        clock.set_wall(-1);
        for _ in 0..REPORT_ROOM_BURST + 5 {
            assert_eq!(do_file(&app, ROOM, KEY, &spam()), FileResult::Unavailable);
        }
        assert_eq!(app.reports.dedup_size(), 0);
        // Key bucket refunded too: still three left.
        for _ in 0..REPORT_KEY_BURST {
            assert_eq!(admit_key(&app, KEY), 0);
        }
        clock.set_wall(T0);
        assert_eq!(do_file(&app, ROOM, "203.0.113.1", &spam()), FileResult::Received);
    }

    #[test]
    fn count_records_an_outcome_decided_before_file() {
        let (app, _) = app();
        for outcome in ["invalid_body", "payload_too_large", "room_not_found", "rate_limited", "unavailable"] {
            count(&app, outcome);
        }
        let t = text(&app);
        for outcome in ["invalid_body", "payload_too_large", "room_not_found"] {
            assert!(t.contains(&format!("outcome=\"{outcome}\"}} 1")), "{outcome}");
        }
    }

    // apps/server/test/takedown.test.ts:262
    #[test]
    fn list_groups_by_room_most_reported_first_then_newest_then_id_and_newest_first_within_a_room() {
        let (app, clock) = app();
        let (a, b, c) = (rid(ROOM), rid(OTHER), rid("cccccccccccccccccccccccccc"));
        add_room(&app, ROOM, RoomInit::default());
        add_room(&app, OTHER, RoomInit::default());
        for (n, (room, key)) in [(&b, "k1"), (&a, "k2"), (&b, "k3"), (&a, "k4"), (&c, "k5")].into_iter().enumerate() {
            clock.set_wall(T0 + n as i64 * 10);
            app.store()
                .reports()
                .add(&NewReport {
                    id: ReportId::parse(&format!("{key}{:020}", 0)).unwrap(),
                    room_id: room.clone(),
                    reason: "spam".into(),
                    note: None,
                    room_title: Some("t".into()),
                    embed_url: None,
                    created_at: app.wall(),
                })
                .unwrap();
        }
        let rooms = list(&app).unwrap();
        // b and a have two each; a's newest (T0+30) beats b's (T0+20); c has one and is gone.
        let order: Vec<&str> = rooms.iter().map(|r| r.id.as_str()).collect();
        assert_eq!(order, [ROOM, OTHER, "cccccccccccccccccccccccccc"]);
        assert_eq!(rooms[0].reports[0].created_at, T0 + 30, "newest first");
        assert_eq!(rooms[0].reports[1].created_at, T0 + 10);
        assert_eq!(rooms[0].state, ReportedState::Live);
        assert_eq!(rooms[0].title.as_deref(), Some(""), "a live untitled room says empty, as TS does");
        assert_eq!(rooms[0].visibility, Some(RoomVisibility::Public));
        assert_eq!(rooms[0].members, Some(0));
        assert_eq!(rooms[2].state, ReportedState::Gone);
        assert_eq!((rooms[2].title.clone(), rooms[2].visibility, rooms[2].members), (None, None, None));
        assert_eq!(rooms[0].reports[0].title.as_deref(), Some("t"));
    }

    // apps/server/test/takedown.test.ts:288
    #[test]
    fn a_taken_down_room_that_has_gone_shows_as_taken_down() {
        let (app, _) = app();
        add_room(&app, ROOM, RoomInit::default());
        do_file(&app, ROOM, KEY, &spam());
        // Tombstoned but the open report still listed (as when the actioning failed).
        app.store().reports().add_takedown(&rid(ROOM), T0).unwrap();
        app.reports.mark_taken_down(&rid(ROOM));
        app.remove_room(&rid(ROOM), RemoveReason::Closed);
        assert_eq!(list(&app).unwrap()[0].state, ReportedState::TakenDown);
    }

    #[test]
    fn the_listing_serializes_as_the_admin_schema() {
        let r = AdminReportRoom {
            id: rid(ROOM),
            state: ReportedState::TakenDown,
            title: None,
            visibility: None,
            members: None,
            reports: vec![AdminReport {
                id: ReportId::parse(&"a".repeat(22)).unwrap(),
                created_at: 5,
                reason: "spam".into(),
                note: None,
                title: Some("t".into()),
                embed_url: None,
            }],
        };
        assert_eq!(
            serde_json::to_string(&r).unwrap(),
            format!(
                r#"{{"id":"{ROOM}","state":"taken_down","title":null,"visibility":null,"members":null,"reports":[{{"id":"{}","createdAt":5,"reason":"spam","note":null,"title":"t","embedUrl":null}}]}}"#,
                "a".repeat(22)
            )
        );
    }

    // apps/server/test/takedown.test.ts:312
    #[test]
    fn dismiss_closes_one_report_and_dismiss_room_closes_a_rooms_and_lets_it_be_reported_again() {
        let (app, _) = app();
        add_room(&app, ROOM, RoomInit::default());
        do_file(&app, ROOM, KEY, &spam());
        assert_eq!(do_file(&app, ROOM, KEY, &spam()), FileResult::AlreadyReported);
        let id = stored(&app)[0].id.clone();
        assert_eq!(dismiss(&app, &id).unwrap(), 1);
        assert_eq!(dismiss(&app, &id).unwrap(), 0);
        do_file(&app, ROOM, "203.0.113.5", &spam());
        assert_eq!(dismiss_room(&app, &rid(ROOM)).unwrap(), 1);
        assert_eq!(
            do_file(&app, ROOM, KEY, &spam()),
            FileResult::Received,
            "marks dropped with the dismissal"
        );
        assert_eq!(open_count(&app).unwrap(), 1);
    }

    // apps/server/test/takedown.test.ts:107
    #[test]
    fn a_takedown_closes_every_member_deletes_the_room_tombstones_the_id_and_actions_its_reports() {
        let (app, _) = app();
        let cell = add_room(&app, ROOM, RoomInit::default());
        let (tx, mut rx) = channel();
        cell.lock().subscribers.attach(ConnId(1), tx);
        do_file(&app, ROOM, KEY, &spam());
        let out = takedown(&app, &rid(ROOM)).unwrap();
        assert!(out.live);
        let Some(Outbound::Close(code, _)) = rx.try_recv() else { panic!() };
        assert_eq!(code, 4006);
        assert!(app.registry.get(&rid(ROOM)).is_none());
        assert!(app.store().rooms().list_rooms().unwrap().is_empty());
        assert!(is_taken_down(&app, &rid(ROOM)));
        assert_eq!(app.store().reports().takedowns().unwrap(), [rid(ROOM)]);
        assert_eq!(open_count(&app).unwrap(), 0, "actioned");
        assert_eq!(app.reports.dedup_size(), 0);
        assert!(text(&app).contains("omega_takedowns_total 1"), "{}", text(&app));
    }

    // apps/server/test/takedown.test.ts:186, :235
    #[test]
    fn a_rerun_does_not_count_again_and_a_room_no_longer_live_is_still_tombstoned() {
        let (app, _) = app();
        assert_eq!(takedown(&app, &rid(ROOM)).unwrap(), Takedown { live: false });
        assert!(is_taken_down(&app, &rid(ROOM)));
        assert_eq!(takedown(&app, &rid(ROOM)).unwrap(), Takedown { live: false });
        assert!(text(&app).contains("omega_takedowns_total 1"));
    }

    #[test]
    fn a_takedown_that_cannot_write_its_tombstone_changes_nothing() {
        let (app, clock) = app();
        add_room(&app, ROOM, RoomInit::default());
        clock.set_wall(-1);
        assert!(takedown(&app, &rid(ROOM)).is_err());
        assert!(!is_taken_down(&app, &rid(ROOM)));
        assert!(app.registry.get(&rid(ROOM)).is_some());
    }

    #[test]
    fn a_takedown_also_deletes_a_row_a_failed_earlier_delete_left_behind() {
        let (app, _) = app();
        // A row without a live room.
        app.store()
            .rooms()
            .create_room(&crate::store::NewRoom::seed(
                rid(ROOM),
                None,
                T0,
                crate::contract::layout::default_layout(),
            ))
            .unwrap();
        assert!(!takedown(&app, &rid(ROOM)).unwrap().live);
        assert!(app.store().rooms().list_rooms().unwrap().is_empty());
    }

    // apps/server/test/reports.test.ts:402
    #[test]
    fn purge_removes_rows_and_marks_older_than_the_retention() {
        let (app, clock) = app();
        add_room(&app, ROOM, RoomInit::default());
        do_file(&app, ROOM, KEY, &spam());
        clock.set_wall(T0 + REPORT_RETENTION_MS as i64 - 1);
        purge(&app).unwrap();
        assert_eq!(open_count(&app).unwrap(), 1);
        assert_eq!(app.reports.dedup_size(), 1);
        clock.set_wall(T0 + REPORT_RETENTION_MS as i64);
        purge(&app).unwrap();
        assert_eq!(open_count(&app).unwrap(), 0);
        assert_eq!(app.reports.dedup_size(), 0);
    }

    #[test]
    fn mint_report_id_is_22_url_safe_characters_and_unique() {
        let a = crate::secrets::mint_report_id().unwrap();
        let b = crate::secrets::mint_report_id().unwrap();
        assert_eq!(a.as_str().len(), 22);
        assert_ne!(a, b);
    }
}
