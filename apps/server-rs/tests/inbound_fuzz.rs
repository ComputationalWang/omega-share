//! The inbound boundary never panics: random bytes and random mutations of valid frames, from a
//! fixed-seed PRNG (no dependency). Also times the worst-case frame (run with `--nocapture`).
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic, clippy::indexing_slicing, reason = "a test harness")]

use omega_server::contract::client_message::parse_client_message;
use omega_server::contract::requests::{parse_create_room_request, parse_report_request, parse_share_request};
use serde::Deserialize;
use std::time::Instant;

struct Rng(u64);

impl Rng {
    /// xorshift64*
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 >> 12;
        self.0 ^= self.0 << 25;
        self.0 ^= self.0 >> 27;
        self.0.wrapping_mul(0x2545_F491_4F6C_DD1D)
    }
    fn below(&mut self, n: usize) -> usize {
        usize::try_from(self.next() % u64::try_from(n).unwrap()).unwrap()
    }
    fn byte(&mut self) -> u8 {
        u8::try_from(self.next() & 0xff).unwrap()
    }
}

#[derive(Deserialize)]
struct Case {
    input: String,
    ok: bool,
}

fn valid_frames() -> Vec<String> {
    let cases: Vec<Case> = serde_json::from_str(include_str!("../corpus/out/client-message-raw.json")).unwrap();
    cases.into_iter().filter(|c| c.ok).map(|c| c.input).collect()
}

fn feed(bytes: &[u8]) {
    let text = String::from_utf8_lossy(bytes);
    let _ = parse_client_message(&text);
    let _ = parse_create_room_request(bytes);
    let _ = parse_share_request(bytes);
    let _ = parse_report_request(bytes);
}

const SNIPPETS: &[&str] = &["{", "}", "[", "]", "\"", "\\", "\\ud800", "\\u0000", ",", ":", "null", "1e400", "-0", "{\"type\":"];

#[test]
fn random_bytes_never_panic() {
    let mut rng = Rng(0x9E37_79B9_7F4A_7C15);
    for _ in 0..20_000 {
        let len = rng.below(600);
        let bytes: Vec<u8> = (0..len).map(|_| rng.byte()).collect();
        feed(&bytes);
    }
    feed(&vec![b'['; 100_000]);
    feed(&vec![b'{'; 5000]);
    feed(&b"[".repeat(4096));
    feed(&"9".repeat(4000).into_bytes());
}

#[test]
fn mutated_valid_frames_never_panic() {
    let frames = valid_frames();
    assert!(frames.len() > 50);
    let mut rng = Rng(0xD1B5_4A32_D192_ED03);
    for _ in 0..60_000 {
        let mut b = frames[rng.below(frames.len())].clone().into_bytes();
        for _ in 0..=rng.below(4) {
            match rng.below(6) {
                0 if !b.is_empty() => {
                    let i = rng.below(b.len());
                    b[i] = rng.byte();
                }
                1 if !b.is_empty() => {
                    let i = rng.below(b.len());
                    b.truncate(i);
                }
                2 => {
                    let i = rng.below(b.len() + 1);
                    let s = SNIPPETS[rng.below(SNIPPETS.len())].as_bytes();
                    b.splice(i..i, s.iter().copied());
                }
                3 if !b.is_empty() => {
                    b.remove(rng.below(b.len()));
                }
                4 if b.len() > 1 => {
                    let (i, j) = (rng.below(b.len()), rng.below(b.len()));
                    b.swap(i, j);
                }
                _ => {
                    let other = frames[rng.below(frames.len())].as_bytes();
                    let i = rng.below(b.len() + 1);
                    b.splice(i..i, other.iter().copied());
                }
            }
        }
        feed(&b);
    }
}

/// Frames at the cap that make the parser work hardest: a layout-set packed to the byte limit,
/// deep nesting, a chat of combining marks, a chat of ZWJ emoji sequences.
#[test]
fn worst_case_frame_parse_time() {
    let piece = r#"{"kind":"plant","col":9,"row":9,"facing":"se"},"#;
    let furniture = piece.repeat(78);
    let layout = format!(r#"{{"type":"layout-set","layout":{{"furniture":[{furniture}{{"kind":"tv","col":0,"row":0,"facing":"se"}}]}}}}"#);
    let marks = format!(r#"{{"type":"chat","text":"a{}"}}"#, "\u{0301}".repeat(1300));
    let nested = format!(r#"{{"type":"layout-set","layout":{}{}}}"#, "[".repeat(2000), "]".repeat(2000));
    let emoji = format!(r#"{{"type":"chat","text":"{}"}}"#, "👨\u{200d}👩\u{200d}👧 ".repeat(100));
    let mut worst = 0u128;
    for frame in [layout, marks, nested, emoji] {
        assert!(frame.len() <= 4096, "{}", frame.len());
        let start = Instant::now();
        for _ in 0..200 {
            let _ = parse_client_message(&frame);
        }
        let per = start.elapsed().as_nanos() / 200;
        println!("{} bytes: {per} ns/parse", frame.len());
        worst = worst.max(per);
    }
    // Generous: this is an unoptimised build. The point is that nothing is quadratic or worse.
    assert!(worst < 5_000_000, "worst parse {worst} ns");
}
