//! Text schemas: nickname, room title, chat text, report note. Each newtype holds the schema's
//! OUTPUT (normalised), so `as_str()` is what the TS server would store and broadcast. Pipe order
//! matters: a nickname is normalised, then trimmed; chat is trimmed, then normalised.

use super::ids::string_newtype;

string_newtype!(
    /// `NicknameSchema`: NFKC, trim, 1..=20 UTF-16 units of words, no invisible letters, Latin never
    /// mixed with Cyrillic, Greek, Armenian or Cherokee.
    Nickname,
    |s| nickname(s)
);
string_newtype!(
    /// `RoomTitleSchema`: the nickname rules, 1..=32 units, plus `' ! ? & , : # + ( )`, and no emoji marks.
    RoomTitle,
    |s| room_title(s)
);
string_newtype!(
    /// `ChatTextSchema`: `plain_text(CHAT_MAX_LENGTH)`.
    ChatText,
    |s| plain_text(s, super::constants::CHAT_MAX_LENGTH)
);
string_newtype!(
    /// `ReportNoteSchema`: raw at most 600 units, line breaks and tabs become one space, then `plain_text(300)`.
    ReportNote,
    |s| report_note(s)
);

fn nickname(input: &str) -> Option<String> {
    let _ = input;
    None
}

fn room_title(input: &str) -> Option<String> {
    let _ = input;
    None
}

/// `plainTextSchema(max)`: trim, NFC, 1..=max units, no controls/format/separators except ZWJ inside
/// an emoji sequence, at most 3 marks in a row, no invisible letters, something visible.
pub fn plain_text(input: &str, max: usize) -> Option<String> {
    let _ = (input, max);
    None
}

fn report_note(input: &str) -> Option<String> {
    let _ = input;
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn nick(s: &str) -> Option<String> {
        Nickname::parse(s).map(|n| n.as_str().to_owned())
    }
    fn title(s: &str) -> Option<String> {
        RoomTitle::parse(s).map(|n| n.as_str().to_owned())
    }
    fn chat(s: &str) -> Option<String> {
        ChatText::parse(s).map(|n| n.as_str().to_owned())
    }
    fn note(s: &str) -> Option<String> {
        ReportNote::parse(s).map(|n| n.as_str().to_owned())
    }

    #[test]
    fn nickname_accepts_and_normalises() {
        // packages/shared/test/wire.test.ts:72, :89, m3-contract.test.ts:141
        for ok in ["alice", "Bob 2", "zoë", "李雷", "हिन्दी", "a.b_c-d", &"x".repeat(20)] {
            assert_eq!(nick(ok).as_deref(), Some(ok), "{ok}");
        }
        assert_eq!(nick("  zoë ").as_deref(), Some("zoë"));
        assert_eq!(nick("Ａｌｉｃｅ").as_deref(), Some("Alice"));
        assert_eq!(nick("ｂｏｂ２").as_deref(), Some("bob2"));
        assert_eq!(nick("  Ａｌｉｃｅ ").as_deref(), Some("Alice"));
        assert_eq!(nick("zoe\u{308}").as_deref(), Some("zoë"));
    }

    #[test]
    fn nickname_refuses() {
        // packages/shared/test/wire.test.ts:72
        for bad in ["", "   ", &"x".repeat(21), "<b>hi</b>", "cool😎", "a\nb", "a\u{200d}b", "a\u{202e}b", "a  b", "\u{3164}", "a\u{ffa0}b", "\u{301}a"] {
            assert_eq!(nick(bad), None, "{bad:?}");
        }
        // m3-contract.test.ts:146: U+FDFA is one unit that NFKC expands to 18
        assert_eq!(nick("abc\u{FDFA}"), None);
        // :155 marks in a row
        assert!(nick("x\u{301}\u{302}").is_some());
        assert_eq!(nick("x\u{301}\u{302}\u{303}"), None);
        assert!(nick("हिन\u{94D}दी").is_some());
        // :161 scripts
        for bad in ["Аlice", "Aliοe", "Aliցe", "Ꭺlice", "bob боб"] {
            assert_eq!(nick(bad), None, "{bad}");
        }
        for ok in ["Борис", "Σοφία", "Alice 李"] {
            assert!(nick(ok).is_some(), "{ok}");
        }
        // :172 bidi and zero-width are rejected, not stripped
        for c in ["\u{200B}", "\u{200C}", "\u{200D}", "\u{2060}", "\u{FEFF}", "\u{200E}", "\u{200F}", "\u{202E}", "\u{2066}", "\u{061C}"] {
            assert_eq!(nick(&format!("al{c}ice")), None, "{c:?}");
        }
        // :178 empty after normalising
        assert_eq!(nick("\u{3000}"), None);
        assert_eq!(nick(" \u{A0} "), None);
        assert_eq!(nick(""), None);
        assert_eq!(nick("a\u{200B}b"), None);
    }

    #[test]
    fn room_title_rules() {
        // packages/shared/test/rooms-contract.test.ts:120
        for ok in ["Friday films", "Tom's movie night!", "Anime & chill (EU)", "Café #2"] {
            assert_eq!(title(ok).as_deref(), Some(ok));
        }
        assert_eq!(title("  Ｆｉｌｍｓ  ").as_deref(), Some("Films"));
        assert_eq!(title(""), None);
        assert_eq!(title("   "), None);
        assert!(title(&"a".repeat(32)).is_some());
        assert_eq!(title(&"a".repeat(33)), None);
        for bad in ["a\u{0}b", "a\u{202E}b", "a\u{200B}b", "a\u{200D}b", "<b>x</b>", "a/b", "film 🎬", "a  b", "a\nb", "\u{3164}"] {
            assert_eq!(title(bad), None, "{bad:?}");
        }
        for bad in ["Room #\u{FE0F}\u{20E3}", "Room 1\u{FE0F}\u{20E3}", "Room 1\u{20E3}", "Room \u{2764}\u{FE0E}"] {
            assert_eq!(title(bad), None, "{bad:?}");
        }
        assert_eq!(title("Fil\u{43C}s"), None);
        assert!(title("x\u{301}\u{301}").is_some());
        assert_eq!(title("x\u{301}\u{301}\u{301}"), None);
        assert_eq!(title("Филь\u{43C}ы").as_deref(), Some("Филь\u{43C}ы"));
    }

    #[test]
    fn chat_text_rules() {
        // packages/shared/test/m3-contract.test.ts:212
        assert_eq!(chat("zoe\u{308}").as_deref(), Some("zoë"));
        assert_eq!(chat("  hi  ").as_deref(), Some("hi"));
        for ok in ["\u{1F468}\u{200D}\u{1F469}\u{200D}\u{1F467}", "❤\u{FE0F}\u{200D}\u{1F525}", "\u{1F469}\u{1F3FD}\u{200D}\u{1F4BB}", "\u{1F3F3}\u{FE0F}\u{200D}\u{1F308}"] {
            assert!(chat(&format!("hi {ok}")).is_some(), "{ok:?}");
        }
        for bad in ["a\u{200D}b", "\u{1F44D}\u{200D}", "x \u{200D}\u{1F44D}", "a\u{200D}\u{1F44D}"] {
            assert_eq!(chat(bad), None, "{bad:?}");
        }
        assert!(chat("x\u{301}\u{302}\u{303}").is_some());
        assert_eq!(chat("x\u{301}\u{302}\u{303}\u{304}"), None);
        for c in ["\u{200B}", "\u{2060}", "\u{FEFF}", "\u{200E}", "\u{202E}", "\u{2067}"] {
            assert_eq!(chat(&format!("a{c}b")), None, "{c:?}");
        }
        assert!(chat(&"a".repeat(280)).is_some());
        assert_eq!(chat(&"a".repeat(281)), None);
        assert_eq!(chat("\u{85}hi").as_deref(), None);
    }

    #[test]
    fn report_note_rules() {
        // packages/shared/test/report-contract.test.ts:68
        assert_eq!(note("  hi  ").as_deref(), Some("hi"));
        assert_eq!(note("e\u{301}").as_deref(), Some("\u{E9}"));
        assert_eq!(note("line one\r\n\r\nline\ttwo").as_deref(), Some("line one line two"));
        assert_eq!(note(&"a".repeat(300)).map(|s| s.len()), Some(300));
        assert_eq!(note(&"a".repeat(301)), None);
        assert_eq!(note(&"a\n".repeat(1_000_000)), None);
        for bad in ["", "   ", "\n\t", "\u{200B}", "\u{3164}", "\u{301}\u{301}", "a\u{0}b", "a\u{202E}b", "a\u{FEFF}b", "a\u{200B}b", "a\u{7}b"] {
            assert_eq!(note(bad), None, "{bad:?}");
        }
        assert_eq!(note(&format!("q{}", "\u{301}".repeat(4))), None);
        // 300 collapsed units but 601 raw: refused unread
        assert_eq!(note(&format!("a{}b", "\n".repeat(599))), None);
        assert_eq!(note(&format!("a{}b", "\n".repeat(598))).as_deref(), Some("a b"));
    }

    #[test]
    fn deserialize_validates_and_normalises() {
        let n: Nickname = serde_json::from_str("\"Ａｌｉｃｅ\"").unwrap();
        assert_eq!(n.as_str(), "Alice");
        assert_eq!(serde_json::to_string(&n).unwrap(), "\"Alice\"");
        assert!(serde_json::from_str::<Nickname>("42").is_err());
        assert!(serde_json::from_str::<Nickname>("null").is_err());
        assert!(serde_json::from_str::<ChatText>("\"\"").is_err());
    }
}
