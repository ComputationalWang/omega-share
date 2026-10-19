//! Opaque ids and bearer secrets, mirroring `ids.ts`, `room.ts` (`RoomIdSchema`), `share.ts`,
//! `room-ownership.ts` and `session.ts`. Each is a newtype whose only constructor validates, so a
//! value of the type is a value the TS schema accepts.

/// A validating string newtype: private field, `parse`, `as_str`, `Serialize` as a plain string,
/// `Deserialize` that validates (so it nests in wire structs). `$validate` returns the schema's
/// OUTPUT, `None` for a refusal.
macro_rules! string_newtype {
    ($(#[$meta:meta])* $name:ident, $validate:expr) => {
        $crate::contract::ids::newtype_impl!($(#[$meta])* #[derive(Debug, Clone, PartialEq, Eq, Hash)] $name, $validate);
    };
}

/// A bearer secret: like `string_newtype!`, but `Debug` never prints the value, there is no
/// `PartialEq`/`Eq`/`Hash` (a variable-time `==` is a timing leak), and `ct_eq` compares in constant
/// time. `as_str` stays for the places that must send or hash it.
macro_rules! secret_newtype {
    ($(#[$meta:meta])* $name:ident, $validate:expr) => {
        $crate::contract::ids::newtype_impl!($(#[$meta])* #[derive(Clone)] $name, $validate);

        impl std::fmt::Debug for $name {
            fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                f.write_str(concat!(stringify!($name), "(…)"))
            }
        }

        impl $name {
            /// Constant-time equality (`subtle`); the lengths are public.
            pub fn ct_eq(&self, other: &Self) -> bool {
                subtle::ConstantTimeEq::ct_eq(self.0.as_bytes(), other.0.as_bytes()).into()
            }
        }
    };
}

macro_rules! newtype_impl {
    ($(#[$meta:meta])* $name:ident, $validate:expr) => {
        $(#[$meta])*
        pub struct $name(String);

        impl $name {
            /// `None` when the schema refuses `input`.
            pub fn parse(input: &str) -> Option<Self> {
                let validate: fn(&str) -> Option<String> = $validate;
                validate(input).map(Self)
            }

            pub fn as_str(&self) -> &str {
                &self.0
            }
        }

        impl serde::Serialize for $name {
            fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
                serializer.serialize_str(&self.0)
            }
        }

        impl<'de> serde::Deserialize<'de> for $name {
            fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
                let raw = <std::borrow::Cow<'de, str> as serde::Deserialize>::deserialize(deserializer)?;
                Self::parse(&raw).ok_or_else(|| serde::de::Error::custom(concat!("invalid ", stringify!($name))))
            }
        }
    };
}
pub(crate) use {newtype_impl, string_newtype};

use super::constants::ROOM_ID_MAX_LENGTH;

/// `^[A-Za-z0-9_-]{min,max}$`, ASCII only (JS `$` has no trailing-newline allowance).
fn base64url(s: &str, max: usize) -> bool {
    (1..=max).contains(&s.len()) && s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

fn exact_token(s: &str, len: usize) -> Option<String> {
    (s.len() == len && base64url(s, len)).then(|| s.to_owned())
}

string_newtype!(
    /// Server-assigned member id, `^[A-Za-z0-9_-]{1,64}$`.
    MemberId,
    |s| base64url(s, 64).then(|| s.to_owned())
);
string_newtype!(
    /// Server-assigned queue item id, `^[A-Za-z0-9_-]{1,32}$`.
    QueueItemId,
    |s| base64url(s, 32).then(|| s.to_owned())
);
string_newtype!(
    /// Server-assigned poll id, `^[A-Za-z0-9_-]{1,32}$` (OME-1452).
    PollId,
    |s| base64url(s, 32).then(|| s.to_owned())
);
string_newtype!(
    /// Room id, `^[a-z0-9-]{1,32}$`.
    RoomId,
    |s| ((1..=ROOM_ID_MAX_LENGTH).contains(&s.len())
        && s.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-'))
    .then(|| s.to_owned())
);
secret_newtype!(
    /// Member-bound share secret: 22 base64url characters (128 bits).
    ShareToken,
    |s| exact_token(s, SHARE_TOKEN_LENGTH)
);
secret_newtype!(
    /// A room owner's bearer secret, same shape as the share token.
    OwnerToken,
    |s| exact_token(s, SHARE_TOKEN_LENGTH)
);
secret_newtype!(
    /// Key that admits a joiner to a private room, same shape as the share token.
    InviteKey,
    |s| exact_token(s, SHARE_TOKEN_LENGTH)
);
secret_newtype!(
    /// Durable session resume secret: 43 base64url characters (256 bits).
    ResumeToken,
    |s| exact_token(s, RESUME_TOKEN_LENGTH)
);

/// Length of a share token (ADR 0015).
pub const SHARE_TOKEN_LENGTH: usize = 22;
/// Length of a resume token (ADR 0043).
pub const RESUME_TOKEN_LENGTH: usize = 43;

/// `parseBearer`: the token of an `Authorization: Bearer <token>` header. Only "bearer" is
/// case-insensitive (ASCII: the TS regex has no `u` flag), the header is exactly 29 characters.
/// Shape only: the caller checks the token against the room. Also `parseShareAuthorization`.
pub fn parse_bearer(header: &str) -> Option<ShareToken> {
    let (scheme, token) = (header.get(..6)?, header.get(7..)?);
    (header.len() == 7 + SHARE_TOKEN_LENGTH && scheme.eq_ignore_ascii_case("bearer") && header.as_bytes().get(6) == Some(&b' '))
        .then(|| ShareToken::parse(token))?
}

#[cfg(test)]
#[allow(clippy::string_slice, reason = "the test token is ASCII")]
mod tests {
    use super::*;

    const TOKEN: &str = "AbCdEfGhIjKlMnOpQr_-09";

    #[test]
    fn id_lengths_and_alphabets() {
        // packages/shared/test/wire.test.ts:61, m3-contract.test.ts:51
        for ok in ["lobby", "room-1", "a", &"a".repeat(32)] {
            assert!(RoomId::parse(ok).is_some(), "{ok}");
        }
        for bad in ["", "Lobby", "a/b", &"a".repeat(33), "a_b", "a\n"] {
            assert!(RoomId::parse(bad).is_none(), "{bad:?}");
        }
        assert!(MemberId::parse(&"A_-9".repeat(16)).is_some());
        assert!(MemberId::parse(&"a".repeat(65)).is_none());
        assert!(QueueItemId::parse(&"a".repeat(32)).is_some());
        assert!(QueueItemId::parse(&"a".repeat(33)).is_none());
        assert!(MemberId::parse("").is_none() && QueueItemId::parse("").is_none());
        assert!(MemberId::parse("é").is_none());
    }

    #[test]
    fn share_owner_invite_tokens_are_22_base64url() {
        // packages/shared/test/share-token.test.ts:25, rooms-contract.test.ts:78
        assert!(ShareToken::parse(TOKEN).is_some());
        assert!(OwnerToken::parse(TOKEN).is_some());
        assert!(InviteKey::parse(TOKEN).is_some());
        for bad in [
            "",
            &TOKEN[1..],
            &format!("{TOKEN}A"),
            &format!("{}==", &TOKEN[..20]),
            &format!("{}+", &TOKEN[..21]),
            &format!("{}/", &TOKEN[..21]),
            &format!("{} ", &TOKEN[..21]),
            &format!("{}é", &TOKEN[..21]),
            &format!("{}\n", &TOKEN[..21]),
        ] {
            assert!(ShareToken::parse(bad).is_none(), "{bad:?}");
            assert!(OwnerToken::parse(bad).is_none(), "{bad:?}");
            assert!(InviteKey::parse(bad).is_none(), "{bad:?}");
        }
    }

    #[test]
    fn resume_token_is_43_base64url() {
        // packages/shared/test/session-contract.test.ts:11
        let token = format!("Ab_-{}", "x".repeat(39));
        assert!(ResumeToken::parse(&token).is_some());
        for bad in [
            "x".repeat(42),
            "x".repeat(44),
            format!("{}=", "x".repeat(42)),
            format!("{}/", "x".repeat(42)),
            format!("{}+", "x".repeat(42)),
            format!("{token}\n"),
        ] {
            assert!(ResumeToken::parse(&bad).is_none(), "{bad:?}");
        }
    }

    #[test]
    fn parse_bearer_reads_the_header() {
        // packages/shared/test/share-token.test.ts:56
        for scheme in ["Bearer", "bearer", "BEARER", "BeArEr"] {
            let got = parse_bearer(&format!("{scheme} {TOKEN}"));
            assert_eq!(got.as_ref().map(ShareToken::as_str), Some(TOKEN), "{scheme}");
        }
        let rejected = [
            String::new(),
            "Bearer".into(),
            "Bearer ".into(),
            TOKEN.into(),
            format!("Basic {TOKEN}"),
            format!("Bearer{TOKEN}"),
            format!("Bearer  {TOKEN}"),
            format!("Bearer\t{TOKEN}"),
            format!("Bearer {TOKEN} x"),
            format!("Bearer {}!", &TOKEN[..21]),
            format!("Bearer {}", &TOKEN[2..]),
            format!("Bearer {TOKEN}AA"),
            format!("Bearer {}==", &TOKEN[..20]),
            format!("Bearer {}", "A".repeat(100_000)),
        ];
        for header in rejected {
            assert!(parse_bearer(&header).is_none(), "{:?}", header.chars().take(40).collect::<String>());
        }
    }

    #[test]
    fn serde_round_trips_and_validates() {
        let id: MemberId = serde_json::from_str("\"m_1\"").unwrap();
        assert_eq!(serde_json::to_string(&id).unwrap(), "\"m_1\"");
        assert!(serde_json::from_str::<MemberId>("\"m 1\"").is_err());
        assert!(serde_json::from_str::<MemberId>("1").is_err());
        assert!(serde_json::from_str::<MemberId>("null").is_err());
        // Escaped input is unescaped before validation: "m1" is "m1".
        assert_eq!(serde_json::from_str::<MemberId>("\"m\\u0031\"").unwrap().as_str(), "m1");
    }

    #[test]
    fn secrets_never_debug_print_their_value() {
        // PORTING.md rule 8: a `{:?}` or a failed assert must not leak a bearer secret.
        let share = ShareToken::parse(TOKEN).unwrap();
        let owner = OwnerToken::parse(TOKEN).unwrap();
        let invite = InviteKey::parse(TOKEN).unwrap();
        let resume = ResumeToken::parse(&format!("Ab_-{}", "x".repeat(39))).unwrap();
        for shown in [
            format!("{share:?}"),
            format!("{owner:?}"),
            format!("{invite:#?}"),
            format!("{resume:?}"),
        ] {
            assert!(!shown.contains("AbCd") && !shown.contains("Ab_-"), "{shown}");
        }
        assert_eq!(format!("{share:?}"), "ShareToken(…)");
    }

    #[test]
    fn secrets_compare_with_ct_eq() {
        // PORTING.md rule 9: constant-time compare (no PartialEq on secrets).
        let a = ShareToken::parse(TOKEN).unwrap();
        assert!(a.ct_eq(&ShareToken::parse(TOKEN).unwrap()));
        assert!(!a.ct_eq(&ShareToken::parse(&"a".repeat(22)).unwrap()));
        let r = ResumeToken::parse(&"x".repeat(43)).unwrap();
        assert!(r.ct_eq(&ResumeToken::parse(&"x".repeat(43)).unwrap()));
        assert!(!r.ct_eq(&ResumeToken::parse(&"y".repeat(43)).unwrap()));
        let o = OwnerToken::parse(TOKEN).unwrap();
        assert!(o.ct_eq(&o.clone()));
        assert!(!InviteKey::parse(TOKEN).unwrap().ct_eq(&InviteKey::parse(&"b".repeat(22)).unwrap()));
    }
}
