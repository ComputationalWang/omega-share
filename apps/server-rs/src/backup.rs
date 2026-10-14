//! `omega-server backup snapshot | verify <file> | restore <file> | prune` (port of `apps/server/scripts/backup.ts`,
//! runbook docs/ops/backup.md).

/// `omega-YYYY-MM-DD.db`, the UTC date of the Unix-ms instant `now_ms`.
pub fn snapshot_name(now_ms: i64) -> String {
    let _ = now_ms;
    String::new()
}
