//! SQLite persistence (ADR 0050), the port of `apps/server/src/store/*`. The database file is shared
//! with the TS server for the rollback window, so the SQL, the migrations (the same `.sql` files) and
//! the stored text must stay byte-compatible: `tests/store_interop.rs` proves it both ways.
//!
//! One connection, owned by [`Store`] (the App holds it in a `std::sync::Mutex`); [`RoomStore`] and
//! [`ReportStore`] are cheap borrowed views, so both write through the same connection and the same
//! transaction state. Nothing here is on the relay path.

pub mod db;
pub mod reports;
pub mod rooms;

use rusqlite::Connection;
use std::fmt;

pub use db::{Migration, open_database};
pub use reports::{NewReport, REPORT_MAX_ROWS, ReportId, ReportStore};
pub use rooms::{NewRoom, RoomStore, SeatHold, StoredQueueItem, StoredRoom};

/// Why a store call failed. It never carries a room title, nickname, token, URL or SQLite's own message
/// (which can quote values): only fixed text, SQLite result codes and counts. The one deliberate
/// exception is [`StoreError::CorruptRoom`], see its docs.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StoreError {
    /// SQLite refused the statement; the extended result code (`-1` when the error has none).
    Db(i32),
    /// Migration `file` (a fixed name from `apps/server/migrations`) failed, with SQLite's result code.
    Migration { file: String, code: i32 },
    /// The migration list has a gap, a duplicate or a bad file name; `file` is the first bad one.
    MigrationOrder { file: String },
    /// The file's `user_version` is ahead of this binary: refusing to start (rollback safety).
    SchemaNewer { found: i64, known: usize },
    /// Writing the private file or its directory failed (the OS error kind, not the path).
    Io(std::io::ErrorKind),
    /// A value written through the store is outside its schema; `what` is a fixed field name.
    Invalid(&'static str),
    /// The write named a room that does not exist.
    NoRoom,
    /// The room does not hold that queue item.
    NoQueueItem,
    /// A `rooms` row fails the contract, so the whole load fails (persistence.test.ts:134: a corrupt
    /// row refuses to boot instead of serving a forged layout). `id` is the row's internal room id,
    /// JSON-quoted as TS does, and is the only text a `StoreError` carries from the data.
    /// It stays out of the JSON error log: `log.rs` cuts a message at its first quote, so a logged
    /// `corrupt rooms row "…"` never shows the id; only the boot failure that names the room prints
    /// it, via [`StoreError::corrupt_room_id`], not via `log_error`.
    CorruptRoom { id: String },
}

impl StoreError {
    /// The room a boot failed on, for the one message that must name it. `None` for every other error.
    pub fn corrupt_room_id(&self) -> Option<&str> {
        match self {
            Self::CorruptRoom { id } => Some(id),
            _ => None,
        }
    }
}

impl fmt::Display for StoreError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Db(code) => write!(f, "database error (code {code})"),
            Self::Migration { file, code } => write!(f, "migration {file} failed (code {code})"),
            Self::MigrationOrder { file } => write!(f, "migration {file}: out of order"),
            Self::SchemaNewer { found, known } => {
                write!(
                    f,
                    "database user_version {found} is newer than this server knows ({known}): refusing to start"
                )
            }
            Self::Io(kind) => write!(f, "database file: {kind}"),
            Self::Invalid(what) => write!(f, "invalid {what}"),
            Self::NoRoom => f.write_str("no such room"),
            Self::NoQueueItem => f.write_str("no such queue item"),
            // Quote first, so the log's cut at the first quote drops the id.
            Self::CorruptRoom { id } => write!(f, "corrupt rooms row {id}"),
        }
    }
}

impl std::error::Error for StoreError {}

impl From<rusqlite::Error> for StoreError {
    fn from(e: rusqlite::Error) -> Self {
        Self::Db(e.sqlite_error().map_or(-1, |f| f.extended_code))
    }
}

/// The process's one database: the connection plus views over it.
pub struct Store {
    conn: Connection,
}

impl Store {
    /// `openDatabase`: `:memory:` or a file path, migrated.
    pub fn open(path: &str) -> Result<Self, StoreError> {
        open_database(path).map(|conn| Self { conn })
    }

    pub fn rooms(&self) -> RoomStore<'_> {
        RoomStore::new(&self.conn)
    }

    pub fn reports(&self) -> ReportStore<'_> {
        ReportStore::new(&self.conn)
    }

    /// `PRAGMA wal_checkpoint(TRUNCATE)` (graceful shutdown, ADR 0032).
    pub fn checkpoint(&self) -> Result<(), StoreError> {
        db::checkpoint(&self.conn)
    }
}
