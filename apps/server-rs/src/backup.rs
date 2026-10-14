//! `omega-server backup snapshot | verify <file> | restore <file> | prune` (port of `apps/server/scripts/backup.ts`,
//! runbook docs/ops/backup.md).

use crate::cli::time;

/// `omega-YYYY-MM-DD.db`, the UTC date of the Unix-ms instant `now_ms` (`toISOString().slice(0, 10)`).
pub fn snapshot_name(now_ms: i64) -> String {
    let iso = time(Some(now_ms)).unwrap_or_default();
    format!("omega-{}.db", iso.chars().take(10).collect::<String>())
}
