//! Port of `apps/server/src/secrets.ts`: minting, hashing and checking bearer secrets (ADR 0015, 0028, 0043).
//! Randomness is the OS CSPRNG (`getrandom`), never a seeded generator. Nothing here prints a secret.

use crate::contract::ids::{InviteKey, MemberId, OwnerToken, QueueItemId, ResumeToken, RoomId, ShareToken};
use crate::contract::room::{DiceSides, DieValue};
use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;

/// The OS random source failed, or the minted text did not parse (a bug): the caller answers 5xx and logs nothing secret.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct EntropyError;

impl std::fmt::Display for EntropyError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("no secure randomness")
    }
}

impl std::error::Error for EntropyError {}

const B64: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const HEX: &[u8; 16] = b"0123456789abcdef";
const BASE32: &[u8; 32] = b"abcdefghijklmnopqrstuvwxyz234567";

fn random<const N: usize>() -> Result<[u8; N], EntropyError> {
    let mut bytes = [0u8; N];
    getrandom::fill(&mut bytes).map_err(|_| EntropyError)?;
    Ok(bytes)
}

/// Base64url without padding (`Buffer#toString("base64url")`).
fn base64url(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let n = chunk
            .iter()
            .enumerate()
            .fold(0u32, |acc, (i, b)| acc | (u32::from(*b) << (16 - 8 * i)));
        // 1 byte -> 2 chars, 2 -> 3, 3 -> 4.
        for i in 0..=chunk.len() {
            let index = usize::try_from((n >> (18 - 6 * i)) & 63).unwrap_or(0);
            out.push(char::from(B64.get(index).copied().unwrap_or(b'A')));
        }
    }
    out
}

/// The room id encoding of 16 random bytes: lowercase base32, 26 chars (ADR 0028 §1).
fn room_id_from_bytes(bytes: &[u8; 16]) -> String {
    let mut out = String::with_capacity(26);
    let (mut bits, mut value) = (0u32, 0u32);
    let mut push = |v: u32| {
        out.push(char::from(
            BASE32.get(usize::try_from(v & 31).unwrap_or(0)).copied().unwrap_or(b'a'),
        ))
    };
    for byte in bytes {
        value = (value << 8) | u32::from(*byte);
        bits += 8;
        while bits >= 5 {
            push(value >> (bits - 5));
            bits -= 5;
        }
        value &= (1 << bits) - 1;
    }
    // 128 = 25 x 5 + 3: the last 3 bits, padded.
    if bits > 0 {
        push(value << (5 - bits));
    }
    out
}

/// 16 random bytes: 22 chars (share tokens, owner tokens, invite keys; ADR 0015, 0028).
fn mint_16() -> Result<String, EntropyError> {
    Ok(base64url(&random::<16>()?))
}

pub fn mint_share_token() -> Result<ShareToken, EntropyError> {
    ShareToken::parse(&mint_16()?).ok_or(EntropyError)
}

pub fn mint_owner_token() -> Result<OwnerToken, EntropyError> {
    OwnerToken::parse(&mint_16()?).ok_or(EntropyError)
}

pub fn mint_invite_key() -> Result<InviteKey, EntropyError> {
    InviteKey::parse(&mint_16()?).ok_or(EntropyError)
}

/// 32 random bytes: 43 chars (resume tokens, ADR 0043). Memory only, never stored or logged.
pub fn mint_resume_token() -> Result<ResumeToken, EntropyError> {
    ResumeToken::parse(&base64url(&random::<32>()?)).ok_or(EntropyError)
}

/// A fresh report id: 16 random bytes, 22 chars (`mintSecret` in reports.ts). The operator's handle, never sent to the reporter.
pub fn mint_report_id() -> Result<crate::store::ReportId, EntropyError> {
    crate::store::ReportId::parse(&mint_16()?).ok_or(EntropyError)
}

pub fn new_room_id() -> Result<RoomId, EntropyError> {
    RoomId::parse(&room_id_from_bytes(&random::<16>()?)).ok_or(EntropyError)
}

/// A fresh member id: a v4 UUID in lowercase hex, as `crypto.randomUUID()` writes it (36 chars).
pub fn mint_member_id() -> Result<MemberId, EntropyError> {
    let mut b = random::<16>()?;
    // RFC 4122: version 4 in the high nibble of byte 6, variant 10 in the top bits of byte 8.
    if let Some(v) = b.get_mut(6) {
        *v = (*v & 0x0f) | 0x40;
    }
    if let Some(v) = b.get_mut(8) {
        *v = (*v & 0x3f) | 0x80;
    }
    let mut out = String::with_capacity(36);
    for (i, byte) in b.iter().enumerate() {
        if matches!(i, 4 | 6 | 8 | 10) {
            out.push('-');
        }
        out.push(char::from(HEX.get(usize::from(byte >> 4)).copied().unwrap_or(b'0')));
        out.push(char::from(HEX.get(usize::from(byte & 15)).copied().unwrap_or(b'0')));
    }
    MemberId::parse(&out).ok_or(EntropyError)
}

/// A fresh queue item id (ADR 0031 section 1): 12 random bytes, base64url, 16 chars. Opaque, never reused.
pub fn mint_item_id() -> Result<QueueItemId, EntropyError> {
    QueueItemId::parse(&base64url(&random::<12>()?)).ok_or(EntropyError)
}

/// SHA-256 of a secret: what the store keeps instead of it (ADR 0028 §3).
pub fn hash_secret(secret: &str) -> [u8; 32] {
    Sha256::digest(secret.as_bytes()).into()
}

/// Whether `secret` hashes to `hash`, in constant time. False when there is no hash (a pinned room has no owner).
/// Both sides are fixed-length digests, so the time does not depend on how many leading bytes match.
pub fn secret_matches(hash: Option<&[u8]>, secret: &str) -> bool {
    hash.is_some_and(|h| bool::from(hash_secret(secret).as_slice().ct_eq(h)))
}

/// A die face in `1..=sides`, uniform: draws at or above the largest multiple of `sides` below 2^32 are drawn
/// again, so no face is favoured (no modulo bias). Each draw is rejected with probability under `sides` / 2^32.
fn uniform(sides: u32, mut draw: impl FnMut() -> Result<u32, EntropyError>) -> Result<u32, EntropyError> {
    let sides = sides.max(1);
    let span = 1u64 << 32;
    let limit = span - span % u64::from(sides);
    loop {
        let x = draw()?;
        if u64::from(x) < limit {
            return Ok(x % sides + 1);
        }
    }
}

/// `/roll` (OME-1423): a die face from the OS CSPRNG.
pub fn roll(sides: DiceSides) -> Result<DieValue, EntropyError> {
    let face = uniform(u32::from(sides.get()), || random::<4>().map(u32::from_le_bytes))?;
    DieValue::new(u64::from(face)).ok_or(EntropyError)
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::indexing_slicing, reason = "tests")]
mod tests {
    use super::*;

    // OME-1423: a die by rejection sampling, so every face is equally likely.
    #[test]
    fn uniform_rejects_the_biased_tail_and_maps_into_one_to_sides() {
        // 2^32 = 6 * 715827882 + 4: the top 4 draws would favour faces 1..4, so they are drawn again.
        let mut draws = [u32::MAX, u32::MAX - 3, 0].into_iter();
        assert_eq!(uniform(6, || draws.next().ok_or(EntropyError)), Ok(1));
        let mut draws = [u32::MAX - 4].into_iter();
        assert_eq!(uniform(6, || draws.next().ok_or(EntropyError)), Ok(6));
        let mut draws = [5, 11].into_iter();
        assert_eq!(
            (uniform(6, || draws.next().ok_or(EntropyError)), uniform(6, || Ok(11))),
            (Ok(6), Ok(6))
        );
        // A power of two rejects nothing.
        assert_eq!(uniform(2, || Ok(u32::MAX)), Ok(2));
        assert_eq!(uniform(6, || Err(EntropyError)), Err(EntropyError));
    }

    #[test]
    fn roll_lands_in_one_to_sides_and_covers_every_face() {
        use crate::contract::room::DiceSides;
        for n in [2u64, 6, 100] {
            let sides = DiceSides::new(n).unwrap();
            let mut seen = std::collections::HashSet::new();
            for _ in 0..4000 {
                let v = u64::from(roll(sides).unwrap().get());
                assert!((1..=n).contains(&v));
                seen.insert(v);
            }
            assert_eq!(seen.len() as u64, n);
        }
    }

    fn hex(bytes: &[u8]) -> String {
        bytes.iter().map(|b| format!("{b:02x}")).collect()
    }

    #[test]
    fn hash_secret_matches_the_ts_vectors() {
        // Generated by running `hashSecret` from apps/server/src/secrets.ts with bun.
        for (input, want) in [
            ("", "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"),
            ("a", "ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb"),
            (
                "AbCdEfGhIjKlMnOpQr_-09",
                "870ed0d5c16db8bd99f8b83b94d7d798306686a54b65f0b58fcd713051f04358",
            ),
            ("é", "4a99557e4033c3539de2eb65472017cad5f9557f7a0625a09f1c3f6e2ba69c4c"),
            ("日本語🙂", "e5fb2086a3129afba96c8008d8c9d19533daf7560d11ad6a7a5193d1fe7166b1"),
            (&"x".repeat(43), "cc0b1c2c66f3bb9fd1a081c626ba1bef62f6f96441a43be15268523776ac26a1"),
        ] {
            assert_eq!(hex(&hash_secret(input)), want, "{input:?}");
        }
    }

    #[test]
    fn base64url_matches_buffer_to_string() {
        // bun: Buffer.from(bytes).toString("base64url")
        assert_eq!(base64url(&[0; 16]), "AAAAAAAAAAAAAAAAAAAAAA");
        assert_eq!(base64url(&[255; 16]), "_____________________w");
        let seq: Vec<u8> = (0..16).collect();
        assert_eq!(base64url(&seq), "AAECAwQFBgcICQoLDA0ODw");
        let seq2: Vec<u8> = (0..16u8).map(|i| i.wrapping_mul(17).wrapping_add(3)).collect();
        assert_eq!(base64url(&seq2), "AxQlNkdYaXqLnK2-z-DxAg");
        let seq32: Vec<u8> = (0..32u8).map(|i| 255 - i * 3).collect();
        assert_eq!(base64url(&seq32), "__z59vPw7ern5OHe29jV0s_MycbDwL26t7SxrquopaI");
    }

    #[test]
    fn room_id_encoding_matches_ts() {
        // bun: the `newRoomId` loop over fixed bytes.
        assert_eq!(room_id_from_bytes(&[0; 16]), "aaaaaaaaaaaaaaaaaaaaaaaaaa");
        assert_eq!(room_id_from_bytes(&[255; 16]), "77777777777777777777777774");
        let seq: [u8; 16] = std::array::from_fn(|i| u8::try_from(i).unwrap());
        assert_eq!(room_id_from_bytes(&seq), "aaaqeayeaudaocajbifqydiob4");
        let seq2: [u8; 16] = std::array::from_fn(|i| u8::try_from((i * 17 + 3) % 256).unwrap());
        assert_eq!(room_id_from_bytes(&seq2), "amkcknshlbuxvc44vw7m7yhrai");
    }

    #[test]
    fn minted_values_have_the_contract_shape_and_do_not_repeat() {
        // apps/server/src/secrets.ts:5-8 (22 and 43 chars) and :24 (26 chars)
        let mut seen = std::collections::HashSet::new();
        for _ in 0..500 {
            assert!(seen.insert(mint_share_token().unwrap().as_str().to_owned()));
            assert!(seen.insert(mint_owner_token().unwrap().as_str().to_owned()));
            assert!(seen.insert(mint_invite_key().unwrap().as_str().to_owned()));
            assert!(seen.insert(mint_resume_token().unwrap().as_str().to_owned()));
            let id = new_room_id().unwrap();
            assert_eq!(id.as_str().len(), 26);
            assert!(id.as_str().bytes().all(|b| b.is_ascii_lowercase() || (b'2'..=b'7').contains(&b)));
            assert!(seen.insert(id.as_str().to_owned()));
        }
    }

    #[test]
    fn secret_matches_checks_the_hash() {
        let hash = hash_secret("hunter2");
        assert!(secret_matches(Some(&hash), "hunter2"));
        assert!(!secret_matches(Some(&hash), "hunter3"));
        assert!(!secret_matches(Some(&hash), ""));
        assert!(!secret_matches(None, "hunter2"));
        // A stored hash of the wrong length never matches (TS `timingSafeEqual` would throw).
        assert!(!secret_matches(Some(&hash[..31]), "hunter2"));
        assert!(!secret_matches(Some(&[]), ""));
    }

    #[test]
    fn errors_name_no_secret() {
        assert_eq!(EntropyError.to_string(), "no secure randomness");
    }

    #[test]
    fn member_ids_are_v4_uuids_in_lowercase_hex() {
        // `crypto.randomUUID()`: 8-4-4-4-12, version nibble 4, variant 8..b.
        let shape = |id: &str| {
            let parts: Vec<&str> = id.split('-').collect();
            parts.iter().map(|p| p.len()).collect::<Vec<_>>() == [8, 4, 4, 4, 12]
                && id.bytes().all(|b| b == b'-' || b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
                && parts[2].starts_with('4')
                && parts[3].starts_with(|c| "89ab".contains(c))
        };
        let ids: Vec<_> = (0..200).map(|_| mint_member_id().unwrap()).collect();
        assert!(ids.iter().all(|id| shape(id.as_str())), "{:?}", ids.first().map(MemberId::as_str));
        let distinct: std::collections::HashSet<_> = ids.iter().map(MemberId::as_str).collect();
        assert_eq!(distinct.len(), ids.len());
    }

    #[test]
    fn item_ids_are_16_base64url_chars() {
        let ids: Vec<_> = (0..200).map(|_| mint_item_id().unwrap()).collect();
        assert!(ids.iter().all(|id| id.as_str().len() == 16));
        let distinct: std::collections::HashSet<_> = ids.iter().map(QueueItemId::as_str).collect();
        assert_eq!(distinct.len(), ids.len());
    }
}
