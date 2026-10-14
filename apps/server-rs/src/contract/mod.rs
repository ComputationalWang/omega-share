//! The wire contract, mirroring `packages/shared` (ADR 0050). Every type here is parsed at the
//! boundary; nothing past it handles unparsed input.

pub mod generic_embed;
pub mod js_compat;
pub mod session;

use serde::de::DeserializeOwned;
use std::fmt;
use validator::Validate;

/// Input the contract refuses. `reason` is for tests only: it can quote the input (a field name, a
/// value), so it is never logged and never sent on the wire.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Invalid {
    pub reason: String,
}

impl Invalid {
    pub fn new(reason: impl Into<String>) -> Self {
        Self { reason: reason.into() }
    }
}

impl fmt::Display for Invalid {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "invalid: {}", self.reason)
    }
}

impl std::error::Error for Invalid {}

/// The shape (serde), then the field rules (validator), in one step. Duplicate keys are refused
/// (serde), unlike `JSON.parse`'s last-wins: a deliberate difference (PORTING.md).
pub fn parse_json<T: DeserializeOwned + Validate>(raw: &[u8]) -> Result<T, Invalid> {
    let wire: T = serde_json::from_slice(raw).map_err(|e| Invalid::new(e.to_string()))?;
    wire.validate().map_err(|e| Invalid::new(e.to_string()))?;
    Ok(wire)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::Deserialize;

    #[derive(Debug, Deserialize, Validate, PartialEq)]
    #[serde(deny_unknown_fields)]
    struct Seat {
        #[validate(range(min = 0, max = 7))]
        seat: u8,
    }

    #[test]
    fn accepts_a_valid_body() {
        assert_eq!(parse_json::<Seat>(br#"{"seat":3}"#), Ok(Seat { seat: 3 }));
    }

    #[test]
    fn refuses_a_rule_breach_naming_the_field() {
        let err = parse_json::<Seat>(br#"{"seat":8}"#).unwrap_err();
        assert!(err.reason.contains("seat"), "{err}");
    }

    #[test]
    fn refuses_bad_json_wrong_types_unknown_and_duplicate_keys() {
        for raw in [
            &b"{"[..],
            br#"{"seat":"3"}"#,
            br#"{"seat":3,"x":1}"#,
            br#"{"seat":3,"seat":4}"#,
            br#"{"seat":3.0}"#,
            br#"{"seat":-1}"#,
            b"null",
            b"",
        ] {
            assert!(parse_json::<Seat>(raw).is_err(), "{}", String::from_utf8_lossy(raw));
        }
    }
}
