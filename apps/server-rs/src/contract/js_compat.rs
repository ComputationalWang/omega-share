//! JavaScript string semantics the wire contract was written against (Valibot in `packages/shared`).
//! The Rust side must accept and reject exactly what the TS side does, so these replace the std
//! versions wherever a contract rule depends on them (ADR 0050).

/// ECMAScript WhiteSpace and LineTerminator: what `String.prototype.trim` strips and `\s` matches.
/// Unlike `char::is_whitespace` it includes U+FEFF and excludes U+0085.
pub fn is_js_whitespace(c: char) -> bool {
    matches!(
        c,
        '\t' | '\n' | '\u{B}' | '\u{C}' | '\r' | ' ' | '\u{A0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200A}' | '\u{2028}' | '\u{2029}' | '\u{202F}' | '\u{205F}' | '\u{3000}' | '\u{FEFF}'
    )
}

/// `String.prototype.trim`.
pub fn js_trim(s: &str) -> &str {
    s.trim_matches(is_js_whitespace)
}

/// `String.prototype.length`: UTF-16 code units, what Valibot's `minLength`/`maxLength` count.
pub fn utf16_len(s: &str) -> usize {
    s.chars().map(char::len_utf16).sum()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn whitespace_is_the_ecmascript_set() {
        for c in [
            '\t', '\n', '\u{B}', '\u{C}', '\r', ' ', '\u{A0}', '\u{1680}', '\u{2000}', '\u{200A}', '\u{2028}', '\u{2029}', '\u{202F}',
            '\u{205F}', '\u{3000}', '\u{FEFF}',
        ] {
            assert!(is_js_whitespace(c), "{c:?} is JS whitespace");
        }
        for c in ['\u{85}', '\u{180E}', '\u{200B}', 'a', '\0'] {
            assert!(!is_js_whitespace(c), "{c:?} is not JS whitespace");
        }
    }

    #[test]
    fn trim_strips_bom_but_not_nel() {
        assert_eq!(js_trim("\u{FEFF} a \u{3000}"), "a");
        assert_eq!(js_trim("\u{85}a"), "\u{85}a");
        assert_eq!(js_trim("   "), "");
        assert_eq!(js_trim(""), "");
    }

    #[test]
    fn length_counts_utf16_units() {
        assert_eq!(utf16_len(""), 0);
        assert_eq!(utf16_len("abc"), 3);
        assert_eq!(utf16_len("é"), 1);
        assert_eq!(utf16_len("a😀"), 3);
    }
}
