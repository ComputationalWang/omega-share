//! The wire contract, mirroring `packages/shared` (ADR 0050). Every type here is parsed at the
//! boundary; nothing past it handles unparsed input.

pub mod constants;
pub mod generic_embed;
pub mod js_compat;
pub mod layout;
pub mod session;

use serde::de::value::MapAccessDeserializer;
use serde::de::{DeserializeOwned, MapAccess, Visitor};
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use std::fmt;
use std::marker::PhantomData;
use validator::{Validate, ValidationErrors};

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

/// A JSON object, never the array form serde's derive also accepts for structs and internally tagged
/// enums (`["tv",0,0,"se"]` is not a furniture piece; Valibot refuses it). Every struct- or
/// tagged-enum-typed field of a wire type is an `Obj<_>`, and [`parse_json`] reads its top level
/// through one.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Obj<T>(pub T);

impl<'de, T: Deserialize<'de>> Deserialize<'de> for Obj<T> {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct MapOnly<T>(PhantomData<T>);
        impl<'de, T: Deserialize<'de>> Visitor<'de> for MapOnly<T> {
            type Value = T;
            fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str("a JSON object")
            }
            fn visit_map<A: MapAccess<'de>>(self, map: A) -> Result<T, A::Error> {
                T::deserialize(MapAccessDeserializer::new(map))
            }
        }
        // `deserialize_map` refuses an array before the derived visitor could read it as a sequence.
        deserializer.deserialize_map(MapOnly(PhantomData)).map(Obj)
    }
}

/// Transparent; validator wants a `Vec<Obj<_>>` item serializable to build its error values.
impl<T: Serialize> Serialize for Obj<T> {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        self.0.serialize(serializer)
    }
}

impl<T: Validate> Validate for Obj<T> {
    fn validate(&self) -> Result<(), ValidationErrors> {
        self.0.validate()
    }
}

/// The shape (serde), then the field rules (validator), in one step. Duplicate keys are refused
/// (serde), unlike `JSON.parse`'s last-wins: a deliberate difference (PORTING.md).
pub fn parse_json<T: DeserializeOwned + Validate>(raw: &[u8]) -> Result<T, Invalid> {
    let Obj(wire) = serde_json::from_slice::<Obj<T>>(raw).map_err(|e| Invalid::new(e.to_string()))?;
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

    #[derive(Debug, Deserialize, Validate, PartialEq)]
    #[serde(deny_unknown_fields)]
    struct Outer {
        #[validate(nested)]
        inner: Obj<Seat>,
    }

    #[derive(Debug, Deserialize, PartialEq)]
    #[serde(tag = "type", deny_unknown_fields)]
    enum Tagged {
        #[serde(rename = "a")]
        A { x: u8 },
    }

    // serde's derive also reads a struct from a JSON array, fields in order; Valibot never does.
    #[test]
    fn a_struct_is_an_object_never_its_array_form() {
        assert!(parse_json::<Seat>(b"[3]").is_err());
        assert!(serde_json::from_str::<Obj<Seat>>("[3]").is_err());
        assert_eq!(serde_json::from_str::<Obj<Seat>>(r#"{"seat":3}"#).unwrap().0, Seat { seat: 3 });
        // At any depth, and for internally tagged enums (whose array form starts with the tag).
        assert!(parse_json::<Outer>(br#"{"inner":[3]}"#).is_err());
        assert_eq!(parse_json::<Outer>(br#"{"inner":{"seat":3}}"#).unwrap().inner.0, Seat { seat: 3 });
        assert!(serde_json::from_str::<Obj<Tagged>>(r#"["a",1]"#).is_err());
        assert_eq!(
            serde_json::from_str::<Obj<Tagged>>(r#"{"type":"a","x":1}"#).unwrap().0,
            Tagged::A { x: 1 }
        );
    }

    #[test]
    fn nested_rules_run_through_obj() {
        let err = parse_json::<Outer>(br#"{"inner":{"seat":9}}"#).unwrap_err();
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
            br#"{"seat":3e0}"#,
            br#"{"seat":-0}"#,
            br#"{"seat":-1}"#,
            b"null",
            b"",
        ] {
            assert!(parse_json::<Seat>(raw).is_err(), "{}", String::from_utf8_lossy(raw));
        }
    }
}
