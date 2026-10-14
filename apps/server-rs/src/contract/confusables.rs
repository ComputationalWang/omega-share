//! UTS #39 confusables, mirroring `packages/shared/src/confusables.ts`. The per-room nickname key
//! is persisted (seat holds hash it, ADR 0043), so it must equal the TS key character for character.
//! The table is `confusables.txt`, generated from `confusables-table.ts` by `corpus/gen.ts`.

use super::unicode_props::{is_capital, is_mark};
use std::collections::HashMap;
use std::sync::LazyLock;
use unicode_normalization::UnicodeNormalization;

/// Unicode version of `confusables.txt`: newer than the property and normalisation tables (17),
/// as in `confusables-table.ts`. A test pins both so a deliberate mismatch stays visible.
pub const CONFUSABLES_VERSION: &str = "18.0.0";

/// Unicode confusables.txt 18.0.0, as `confusables-table.ts` holds it: one entry per line, the
/// source code point then its prototype. © Unicode, Inc., Unicode licence.
const TABLE: &str = include_str!("confusables.txt");

static PROTOTYPES: LazyLock<HashMap<char, &'static str>> = LazyLock::new(|| {
    TABLE
        .split('\n')
        .filter_map(|entry| {
            let mut chars = entry.chars();
            let from = chars.next()?;
            Some((from, chars.as_str()))
        })
        .collect()
});

/// UTS #39 skeleton: NFD, each code point replaced by its prototype, NFD.
pub fn skeleton(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    for c in input.nfd() {
        match PROTOTYPES.get(&c) {
            Some(prototype) => out.push_str(prototype),
            None => out.push(c),
        }
    }
    out.nfd().collect()
}

/// Per-room uniqueness key: the skeleton, made case-insensitive, accent-free. Takes any string, as
/// the TS function does (callers pass a `Nickname`).
pub fn nickname_key(nickname: &str) -> String {
    let mut folded = String::with_capacity(nickname.len());
    for c in nickname.nfd() {
        match PROTOTYPES.get(&c) {
            None => folded.push(c),
            // A capital whose prototype has no capital ("I" -> "l") is lowercased first.
            Some(prototype) if is_capital(c) && !prototype.chars().any(is_capital) => {
                folded.push_str(&skeleton(&c.to_lowercase().collect::<String>()));
            }
            Some(prototype) => folded.push_str(prototype),
        }
    }
    let lowered = folded.nfd().collect::<String>().to_lowercase();
    skeleton(&lowered).chars().filter(|&c| !is_mark(c)).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key(s: &str) -> String {
        nickname_key(s)
    }

    #[test]
    fn skeleton_maps_confusables_to_their_prototype() {
        // packages/shared/test/confusables.test.ts:14
        assert_eq!(skeleton("А"), "A"); // CYRILLIC CAPITAL LETTER A
        assert_eq!(skeleton("1"), "l");
        assert_eq!(skeleton("0"), "O");
        assert_eq!(skeleton("m"), "rn");
        // :22 leaves the rest alone
        assert_eq!(skeleton("Alice"), "Alice");
        assert_eq!(skeleton("李雷"), "李雷");
    }

    #[test]
    fn lookalikes_collide() {
        // packages/shared/test/confusables.test.ts:32
        assert_eq!(key("Alice"), key("Аӏісе"));
        assert_eq!(key("coco"), key("сосо"));
        assert_eq!(key("TOM"), key("ΤΟΜ"));
        assert_eq!(key("Alice"), key("Ａlice"));
        assert_eq!(key("Alice"), key("ＡＬＩＣＥ"));
        assert_eq!(key("Alice"), key("A1ice"));
        assert_eq!(key("Bob"), key("B0b"));
        assert_eq!(key("Arnie"), key("Amie"));
        assert_eq!(key("Alice"), key("alice"));
        assert_eq!(key("Alice"), key("ALICE"));
        assert_eq!(key("Alice"), key("АӀІСЕ"));
        assert_eq!(key("José"), key("jose"));
        assert_eq!(key("Zoë"), key("zoë"));
    }

    #[test]
    fn distinct_names_stay_apart() {
        // packages/shared/test/confusables.test.ts:62
        for (a, b) in [
            ("Alice", "Alicia"),
            ("Bob", "Rob"),
            ("Ann", "Anna"),
            ("Eve", "Eva"),
            ("Sam", "Pam"),
            ("Mia", "Nia"),
            ("bob 2", "bob2"),
            ("Alice", "Алиса"),
            ("李雷", "李"),
            ("Kai", "Kal"),
            ("Alice", "AIice"),
        ] {
            assert_ne!(key(a), key(b), "{a} / {b}");
        }
    }

    #[test]
    fn keys_are_stable() {
        // packages/shared/test/confusables.test.ts:80
        for name in ["Alice", "A1ice", "Аӏісе", "B0b", "Amie"] {
            let k = key(name);
            assert_eq!(key(&k), k, "{name}");
        }
    }

    #[test]
    fn matches_the_ts_key_on_hand_checked_inputs() {
        // Values from the TS nicknameKey under Bun 1.4.2.
        assert_eq!(key("Alice"), "alice");
        assert_eq!(key("Bob"), "bob");
        assert_eq!(key("Ꭺ"), "a");
    }

    #[test]
    fn unicode_versions_are_pinned() {
        // Table 18.0.0, normalisation and properties 17 (Bun 1.4.2 / ICU 78.3 is 17.0 too). Moving
        // either is a deliberate act: update `confusables-table.ts`/crates, regenerate the corpora.
        assert_eq!(CONFUSABLES_VERSION, "18.0.0");
        assert_eq!(unicode_normalization::UNICODE_VERSION, (17, 0, 0));
        assert!(is_mark('\u{1ADB}'), "properties are Unicode 17");
    }

    #[test]
    fn the_table_has_every_entry() {
        assert_eq!(PROTOTYPES.len(), 5212);
    }
}
