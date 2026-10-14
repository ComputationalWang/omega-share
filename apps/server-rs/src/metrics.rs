//! Port of `apps/server/src/metrics.ts`: Prometheus text, only counts, sizes and durations (OME-504).
//! No label or value names an address, nickname, room or title. The listener is a later slice.

use crate::contract::constants::close;
use std::fmt::Write as _;
use std::sync::atomic::{AtomicU64, Ordering};

/// What the live server knows right now, read at scrape time. The process gauges are inputs here
/// (not read inside `render`) so the output is a pure function of the counts.
#[derive(Debug, Clone, Copy, Default)]
pub struct Gauges {
    pub rooms: u64,
    pub sockets: u64,
    pub members: u64,
    /// Open abuse reports.
    pub open_reports: u64,
    pub rss_bytes: f64,
    pub uptime_seconds: f64,
}

/// Relay time buckets, seconds: a frame in, fanned out, on the server (docs/perf-budgets.md: 50 ms end to end).
const RELAY_BUCKETS: [f64; 10] = [0.00005, 0.0001, 0.00025, 0.0005, 0.001, 0.0025, 0.005, 0.01, 0.025, 0.05];

/// Close code the server sends on a restart (`SERVICE_RESTART` in metrics.ts).
pub const SERVICE_RESTART: u16 = 1012;
/// Close codes the server sends itself, in render order.
const COUNTED_CLOSES: [u16; 9] = [
    close::JOIN_TIMEOUT,
    close::ROOM_FULL,
    close::ROOM_CLOSED,
    close::RATE_LIMITED,
    close::BAD_MESSAGES,
    close::KICKED,
    close::TAKEN_DOWN,
    close::SESSION_REPLACED,
    SERVICE_RESTART,
];
/// `REPORT_OUTCOMES`: report statuses, then error codes (ADR 0033 section 3).
const REPORT_OUTCOMES: [&str; 7] = [
    "received",
    "already_reported",
    "invalid_body",
    "payload_too_large",
    "room_not_found",
    "rate_limited",
    "unavailable",
];
/// `REPORT_REASONS`.
const REPORT_REASONS: [&str; 6] = ["sexual", "violence", "hate", "spam", "danger", "other"];

/// Lock-free: every counter is an atomic, so the relay path never waits on a scrape (or the reverse).
/// A scrape reads the counters one by one, so it may see a frame in the count but not yet in its bucket.
#[derive(Debug, Default)]
pub struct Metrics {
    /// Per bucket (not cumulative) plus +Inf last; cumulated at render.
    relay_counts: [AtomicU64; RELAY_BUCKETS.len() + 1],
    /// An `f64`'s bits, added with a compare-and-swap loop.
    relay_sum: AtomicU64,
    relay_count: AtomicU64,
    closes: [AtomicU64; COUNTED_CLOSES.len()],
    reports: [AtomicU64; REPORT_OUTCOMES.len()],
    reasons: [AtomicU64; REPORT_REASONS.len()],
    takedowns: AtomicU64,
}

fn bump(counter: Option<&AtomicU64>) -> bool {
    counter.map(|c| c.fetch_add(1, Ordering::Relaxed)).is_some()
}

impl Metrics {
    pub fn new() -> Self {
        Self::default()
    }

    /// One relayed frame took `ms` on the server.
    pub fn observe_relay(&self, ms: f64) {
        let s = ms / 1000.0;
        // `s > le` is false for NaN, so NaN lands in the first bucket, as in TS.
        let i = RELAY_BUCKETS
            .iter()
            .position(|le| s.is_nan() || s <= *le)
            .unwrap_or(RELAY_BUCKETS.len());
        bump(self.relay_counts.get(i));
        // The closure always returns Some, so the update cannot fail.
        let _ = self.relay_sum.try_update(Ordering::Relaxed, Ordering::Relaxed, |bits| {
            Some((f64::from_bits(bits) + s).to_bits())
        });
        self.relay_count.fetch_add(1, Ordering::Relaxed);
    }

    /// False for a code the server does not count.
    pub fn count_close(&self, code: u16) -> bool {
        COUNTED_CLOSES
            .iter()
            .position(|c| *c == code)
            .is_some_and(|i| bump(self.closes.get(i)))
    }

    /// One report answered; `reason` only for a stored one. False (nothing counted) for an unknown outcome or reason.
    pub fn count_report(&self, outcome: &str, reason: Option<&str>) -> bool {
        let Some(o) = REPORT_OUTCOMES.iter().position(|x| *x == outcome) else {
            return false;
        };
        let r = match reason {
            None => None,
            Some(r) => match REPORT_REASONS.iter().position(|x| *x == r) {
                Some(i) => Some(i),
                None => return false,
            },
        };
        bump(self.reports.get(o));
        if let Some(i) = r {
            bump(self.reasons.get(i));
        }
        true
    }

    pub fn count_takedown(&self) {
        self.takedowns.fetch_add(1, Ordering::Relaxed);
    }

    pub fn render(&self, g: &Gauges) -> String {
        let mut out = String::with_capacity(4096);
        let load = |c: &AtomicU64| c.load(Ordering::Relaxed);
        let gauge = |out: &mut String, name: &str, help: &str, value: &str| {
            let _ = write!(out, "# HELP {name} {help}\n# TYPE {name} gauge\n{name} {value}\n");
        };
        gauge(&mut out, "omega_rooms", "Live rooms.", &g.rooms.to_string());
        gauge(&mut out, "omega_sockets", "Open WebSockets, joined or not.", &g.sockets.to_string());
        gauge(&mut out, "omega_members", "Joined members, all rooms.", &g.members.to_string());

        let relay = "omega_relay_latency_seconds";
        let _ = write!(
            out,
            "# HELP {relay} Server time from a frame's arrival to its fan-out.\n# TYPE {relay} histogram\n"
        );
        let mut cumulative = 0u64;
        for (le, n) in RELAY_BUCKETS.iter().zip(&self.relay_counts) {
            cumulative += load(n);
            let _ = writeln!(out, "{relay}_bucket{{le=\"{}\"}} {cumulative}", js_number(*le));
        }
        let count = load(&self.relay_count);
        let _ = write!(
            out,
            "{relay}_bucket{{le=\"+Inf\"}} {count}\n{relay}_sum {}\n{relay}_count {count}\n",
            js_number(f64::from_bits(load(&self.relay_sum)))
        );

        let closes = "omega_ws_closes_total";
        let _ = write!(
            out,
            "# HELP {closes} WebSocket closes the server sent, by close code.\n# TYPE {closes} counter\n"
        );
        for (code, n) in COUNTED_CLOSES.iter().zip(&self.closes) {
            let _ = writeln!(out, "{closes}{{code=\"{code}\"}} {}", load(n));
        }

        let counter = |out: &mut String, name: &str, help: &str, label: &str, keys: &[&str], values: &[AtomicU64]| {
            let _ = write!(out, "# HELP {name} {help}\n# TYPE {name} counter\n");
            for (k, n) in keys.iter().zip(values) {
                let _ = writeln!(out, "{name}{{{label}=\"{k}\"}} {}", n.load(Ordering::Relaxed));
            }
        };
        counter(
            &mut out,
            "omega_reports_total",
            "Abuse reports answered, by outcome.",
            "outcome",
            &REPORT_OUTCOMES,
            &self.reports,
        );
        counter(
            &mut out,
            "omega_reports_received_total",
            "Abuse reports stored, by reason.",
            "reason",
            &REPORT_REASONS,
            &self.reasons,
        );
        gauge(&mut out, "omega_reports_open", "Open abuse reports.", &g.open_reports.to_string());
        let _ = write!(
            out,
            "# HELP omega_takedowns_total Rooms taken down by the operator.\n# TYPE omega_takedowns_total counter\nomega_takedowns_total {}\n",
            load(&self.takedowns)
        );

        gauge(
            &mut out,
            "process_resident_memory_bytes",
            "Resident set size.",
            &js_number(g.rss_bytes),
        );
        gauge(
            &mut out,
            "process_uptime_seconds",
            "Seconds since the process started.",
            &js_number(g.uptime_seconds),
        );
        out
    }
}

/// `String(n)` for a JS number: the shortest digits that round-trip, plain up to 1e21 and down to 1e-6,
/// exponent form beyond (ECMAScript Number::toString).
fn js_number(n: f64) -> String {
    if n.is_nan() {
        return "NaN".into();
    }
    if n == 0.0 {
        return "0".into();
    }
    if n.is_infinite() {
        return if n < 0.0 { "-Infinity" } else { "Infinity" }.into();
    }
    // `{:e}` is Rust's shortest round-trip form: "d.ddde-5".
    let sci = format!("{:e}", n.abs());
    let (mantissa, exp) = sci.split_once('e').unwrap_or((&sci, "0"));
    let digits: String = mantissa.chars().filter(char::is_ascii_digit).collect();
    let k = i64::try_from(digits.len()).unwrap_or(i64::MAX);
    // The decimal point sits after `point` digits (ECMAScript's n).
    let point = exp.parse::<i64>().unwrap_or(0) + 1;
    let sign = if n < 0.0 { "-" } else { "" };
    let zeros = |count: i64| "0".repeat(usize::try_from(count).unwrap_or(0));
    let head = |count: i64| digits.chars().take(usize::try_from(count).unwrap_or(0)).collect::<String>();
    let tail = |count: i64| digits.chars().skip(usize::try_from(count).unwrap_or(0)).collect::<String>();
    let body = if k <= point && point <= 21 {
        format!("{digits}{}", zeros(point - k))
    } else if 0 < point && point <= 21 {
        format!("{}.{}", head(point), tail(point))
    } else if -6 < point && point <= 0 {
        format!("0.{}{digits}", zeros(-point))
    } else {
        let e = point - 1;
        let e_sign = if e < 0 { '-' } else { '+' };
        let fraction = if k == 1 { String::new() } else { format!(".{}", tail(1)) };
        format!("{}{fraction}e{e_sign}{}", head(1), e.abs())
    };
    format!("{sign}{body}")
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::indexing_slicing, clippy::string_slice, reason = "tests")]
mod tests {
    use super::*;

    const REASONS: [&str; 6] = ["sexual", "violence", "hate", "spam", "danger", "other"];
    const OUTCOMES: [&str; 7] = [
        "received",
        "already_reported",
        "invalid_body",
        "payload_too_large",
        "room_not_found",
        "rate_limited",
        "unavailable",
    ];

    fn sample(text: &str, name: &str) -> f64 {
        let prefix = format!("{name} ");
        let line = text
            .lines()
            .find(|l| l.starts_with(&prefix))
            .unwrap_or_else(|| panic!("no sample {name}"));
        line[prefix.len()..].parse().unwrap()
    }

    fn gauges() -> Gauges {
        Gauges {
            rooms: 2,
            sockets: 3,
            members: 4,
            open_reports: 5,
            rss_bytes: 123_456_789.0,
            uptime_seconds: 12.5,
        }
    }

    #[test]
    fn js_number_formats_like_string_of_a_number() {
        for (n, want) in [
            (0.0, "0"),
            (-0.0, "0"),
            (1.0, "1"),
            (-1.5, "-1.5"),
            (0.00005, "0.00005"),
            (0.1 + 0.2, "0.30000000000000004"),
            (123.456, "123.456"),
            (1e-6, "0.000001"),
            (1e-7, "1e-7"),
            (1.5e-7, "1.5e-7"),
            (1e21, "1e+21"),
            (1e20, "100000000000000000000"),
            (1.2345e22, "1.2345e+22"),
            (9_007_199_254_740_991.0, "9007199254740991"),
            (f64::NAN, "NaN"),
            (f64::INFINITY, "Infinity"),
            (f64::NEG_INFINITY, "-Infinity"),
        ] {
            assert_eq!(js_number(n), want, "{n:e}");
        }
    }

    #[test]
    fn counts_rooms_sockets_members_relay_uptime_and_rss() {
        // apps/server/test/metrics.test.ts:67
        let m = Metrics::new();
        for _ in 0..5 {
            m.observe_relay(0.2);
        }
        let text = m.render(&gauges());
        assert_eq!(sample(&text, "omega_rooms"), 2.0);
        assert_eq!(sample(&text, "omega_sockets"), 3.0);
        assert_eq!(sample(&text, "omega_members"), 4.0);
        assert_eq!(sample(&text, "omega_reports_open"), 5.0);
        assert_eq!(sample(&text, "omega_relay_latency_seconds_count"), 5.0);
        assert_eq!(sample(&text, "omega_relay_latency_seconds_bucket{le=\"+Inf\"}"), 5.0);
        assert!(sample(&text, "omega_relay_latency_seconds_sum") > 0.0);
        assert_eq!(sample(&text, "process_resident_memory_bytes"), 123_456_789.0);
        assert_eq!(sample(&text, "process_uptime_seconds"), 12.5);
        assert!(text.ends_with("process_uptime_seconds 12.5\n"));
    }

    #[test]
    fn counts_4029_and_4004_closes() {
        // apps/server/test/metrics.test.ts:84
        let m = Metrics::new();
        let before = m.render(&gauges());
        assert_eq!(sample(&before, "omega_ws_closes_total{code=\"4029\"}"), 0.0);
        assert_eq!(sample(&before, "omega_ws_closes_total{code=\"4004\"}"), 0.0);
        assert!(m.count_close(4029) && m.count_close(4004));
        let after = m.render(&gauges());
        assert_eq!(sample(&after, "omega_ws_closes_total{code=\"4029\"}"), 1.0);
        assert_eq!(sample(&after, "omega_ws_closes_total{code=\"4004\"}"), 1.0);
        assert!(!m.count_close(1006), "a code the server never sends itself");
    }

    #[test]
    fn reports_by_outcome_and_reason_and_takedowns() {
        let m = Metrics::new();
        assert!(m.count_report("received", Some("spam")));
        assert!(m.count_report("already_reported", None));
        assert!(!m.count_report("nope", None));
        assert!(!m.count_report("received", Some("nope")));
        m.count_takedown();
        let text = m.render(&gauges());
        assert_eq!(sample(&text, "omega_reports_total{outcome=\"received\"}"), 1.0);
        assert_eq!(sample(&text, "omega_reports_total{outcome=\"already_reported\"}"), 1.0);
        assert_eq!(sample(&text, "omega_reports_received_total{reason=\"spam\"}"), 1.0);
        assert_eq!(sample(&text, "omega_takedowns_total"), 1.0);
        for o in OUTCOMES {
            assert!(text.contains(&format!("omega_reports_total{{outcome=\"{o}\"}}")), "{o}");
        }
        for r in REASONS {
            assert!(text.contains(&format!("omega_reports_received_total{{reason=\"{r}\"}}")), "{r}");
        }
    }

    #[test]
    fn every_line_is_a_known_metric_shape() {
        // apps/server/test/metrics.test.ts:104: comments, or `name{label="value"} number`, nothing free-form.
        let m = Metrics::new();
        m.observe_relay(0.3);
        m.count_close(4029);
        m.count_report("received", Some("hate"));
        let text = m.render(&gauges());
        assert!(text.ends_with('\n') && !text.ends_with("\n\n"));
        let lines: Vec<&str> = text.trim_end().split('\n').collect();
        assert!(lines.len() > 10);
        for line in lines {
            if let Some(rest) = line.strip_prefix("# ") {
                assert!(rest.starts_with("HELP ") || rest.starts_with("TYPE "), "{line}");
                continue;
            }
            let (name, value) = line.rsplit_once(' ').unwrap();
            assert!(value.parse::<f64>().is_ok(), "{line}");
            let (metric, label) = name.split_once('{').map_or((name, ""), |(m, l)| (m, l));
            assert!(metric.bytes().all(|b| b.is_ascii_lowercase() || b == b'_'), "{line}");
            let ok = label.is_empty()
                || label.starts_with("le=\"") && label.ends_with("\"}")
                || label.starts_with("code=\"") && label[6..label.len() - 2].bytes().all(|b| b.is_ascii_digit())
                || OUTCOMES.iter().any(|o| label == format!("outcome=\"{o}\"}}"))
                || REASONS.iter().any(|r| label == format!("reason=\"{r}\"}}"));
            assert!(ok, "{line}");
        }
    }

    #[test]
    fn observations_from_many_threads_are_all_counted() {
        let m = Metrics::new();
        std::thread::scope(|s| {
            for _ in 0..8 {
                s.spawn(|| {
                    for _ in 0..1000 {
                        m.observe_relay(1.0);
                        m.count_close(4029);
                        m.count_takedown();
                    }
                });
            }
        });
        let text = m.render(&gauges());
        assert_eq!(sample(&text, "omega_relay_latency_seconds_count"), 8000.0);
        assert_eq!(sample(&text, "omega_relay_latency_seconds_bucket{le=\"0.001\"}"), 8000.0);
        assert!((sample(&text, "omega_relay_latency_seconds_sum") - 8.0).abs() < 1e-9);
        assert_eq!(sample(&text, "omega_ws_closes_total{code=\"4029\"}"), 8000.0);
        assert_eq!(sample(&text, "omega_takedowns_total"), 8000.0);
    }
}
