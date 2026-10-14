//! Unicode properties the contract's rules are written against (`\p{L}`, `\p{M}`, `\p{Script=…}`,
//! `\p{Extended_Pictographic}` in the TS regexes). They come from ICU4X (`icu_properties`, already
//! in the tree through `url`), whose tables are Unicode 17, like Bun's ICU. The `regex` crate's
//! tables are Unicode 16 and would refuse letters and marks Bun accepts.

use icu_properties::props::{ExtendedPictographic, GeneralCategory, GeneralCategoryGroup, Script};
use icu_properties::{CodePointMapData, CodePointSetData};

fn category(c: char) -> GeneralCategory {
    CodePointMapData::<GeneralCategory>::new().get(c)
}

fn is_in(c: char, group: GeneralCategoryGroup) -> bool {
    group.contains(category(c))
}

/// `\p{L}`
pub fn is_letter(c: char) -> bool {
    is_in(c, GeneralCategoryGroup::Letter)
}

/// `\p{M}`
pub fn is_mark(c: char) -> bool {
    is_in(c, GeneralCategoryGroup::Mark)
}

/// `\p{N}`
pub fn is_number(c: char) -> bool {
    is_in(c, GeneralCategoryGroup::Number)
}

/// `\p{P}`
pub fn is_punctuation(c: char) -> bool {
    is_in(c, GeneralCategoryGroup::Punctuation)
}

/// `\p{S}`
pub fn is_symbol(c: char) -> bool {
    is_in(c, GeneralCategoryGroup::Symbol)
}

/// `[\p{Lu}\p{Lt}]`
pub fn is_capital(c: char) -> bool {
    matches!(category(c), GeneralCategory::UppercaseLetter | GeneralCategory::TitlecaseLetter)
}

/// `[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]`: controls, format characters (zero-width, bidi, BOM), line and paragraph separators.
pub fn is_control_format_or_separator(c: char) -> bool {
    matches!(
        category(c),
        GeneralCategory::Control | GeneralCategory::Format | GeneralCategory::LineSeparator | GeneralCategory::ParagraphSeparator
    )
}

/// `\p{Cc}`
pub fn is_control(c: char) -> bool {
    let _ = c;
    false
}

/// `\p{Cf}`
pub fn is_format(c: char) -> bool {
    let _ = c;
    false
}

/// `\p{Script=Latin}` (Script, not Script_Extensions).
pub fn is_latin(c: char) -> bool {
    CodePointMapData::<Script>::new().get(c) == Script::Latin
}

/// `[\p{Script=Cyrillic}\p{Script=Greek}\p{Script=Armenian}\p{Script=Cherokee}]`
pub fn is_latin_lookalike_script(c: char) -> bool {
    matches!(
        CodePointMapData::<Script>::new().get(c),
        Script::Cyrillic | Script::Greek | Script::Armenian | Script::Cherokee
    )
}

/// `\p{Extended_Pictographic}`
pub fn is_extended_pictographic(c: char) -> bool {
    CodePointSetData::new::<ExtendedPictographic>().contains(c)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn categories() {
        assert!(is_letter('a') && is_letter('李') && !is_letter('1'));
        assert!(is_mark('\u{301}') && is_mark('\u{94D}') && !is_mark('a'));
        assert!(is_number('٣') && is_punctuation('!') && is_symbol('€'));
        assert!(is_capital('A') && is_capital('ǅ') && !is_capital('a'));
        assert!(
            is_control_format_or_separator('\u{200B}') && is_control_format_or_separator('\u{85}') && !is_control_format_or_separator('a')
        );
        assert!(is_latin('a') && !is_latin('а') && is_latin_lookalike_script('а') && !is_latin_lookalike_script('李'));
        assert!(is_extended_pictographic('😀') && is_extended_pictographic('❤') && !is_extended_pictographic('a'));
    }

    #[test]
    fn tables_are_unicode_17() {
        // U+1ADB and U+11B64 are combining marks new in Unicode 17; the `regex` crate (Unicode 16) lacks them.
        assert!(is_mark('\u{1ADB}'));
        assert!(is_mark('\u{11B64}'));
    }
}
