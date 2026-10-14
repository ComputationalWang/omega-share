//! UTS #39 confusables, mirroring `packages/shared/src/confusables.ts`. The per-room nickname key
//! is persisted (seat holds hash it, ADR 0043), so it must equal the TS key character for character.
//! The table is `confusables.txt`, generated from `confusables-table.ts` by `corpus/gen.ts`.

/// UTS #39 skeleton: NFD, each code point replaced by its prototype, NFD.
pub fn skeleton(input: &str) -> String {
    let _ = input;
    String::new()
}

/// Per-room uniqueness key: the skeleton, made case-insensitive, accent-free. Takes any string, as
/// the TS function does (callers pass a `Nickname`).
pub fn nickname_key(nickname: &str) -> String {
    let _ = nickname;
    String::new()
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
}
