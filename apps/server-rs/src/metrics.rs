//! Port of `apps/server/src/metrics.ts`: Prometheus text, only counts, sizes and durations (OME-504).
//! No label or value names an address, nickname, room or title. The listener is a later slice.

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

#[derive(Debug, Default)]
pub struct Metrics {}

impl Metrics {
    pub fn new() -> Self {
        Self {}
    }

    /// One relayed frame took `ms` on the server.
    pub fn observe_relay(&self, _ms: f64) {}

    /// False for a code the server does not count.
    pub fn count_close(&self, _code: u16) -> bool {
        false
    }

    /// One report answered; `reason` only for a stored one. False for an unknown outcome or reason.
    pub fn count_report(&self, _outcome: &str, _reason: Option<&str>) -> bool {
        false
    }

    pub fn count_takedown(&self) {}

    pub fn render(&self, _g: &Gauges) -> String {
        String::new()
    }
}

/// `String(n)` for a JS number.
fn js_number(_n: f64) -> String {
    String::new()
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::indexing_slicing, reason = "tests")]
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
        let line = text.lines().find(|l| l.starts_with(&prefix)).unwrap_or_else(|| panic!("no sample {name}"));
        line[prefix.len()..].parse().unwrap()
    }

    fn gauges() -> Gauges {
        Gauges { rooms: 2, sockets: 3, members: 4, open_reports: 5, rss_bytes: 123_456_789.0, uptime_seconds: 12.5 }
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
