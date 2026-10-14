//! Ports of `packages/shared/test/{embed,embed-providers,generic-embed,capabilities}.test.ts`.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic, reason = "tests")]

use omega_server::contract::capabilities::{PlaybackCaps, RateSupport, playback_caps};
use omega_server::contract::constants::{MAX_EMBED_URL_LENGTH, MAX_URL_LENGTH};
use omega_server::contract::embed::{Embed, canonicalize_embed, is_synced_provider_host};
use omega_server::contract::generic_embed::{
    AnyEmbed, AnyEmbedOptions, MAX_GENERIC_EMBED_URL_LENGTH, canonicalize_any_embed, canonicalize_generic_embed, normalize_hostname,
};
use serde_json::{Value, json};

const ID: &str = "dQw4w9WgXcQ";

fn json_of(e: &impl serde::Serialize) -> String {
    serde_json::to_string(e).unwrap()
}

fn yt(id: &str) -> String {
    format!(r#"{{"provider":"youtube","videoId":"{id}","url":"https://www.youtube.com/embed/{id}"}}"#)
}

fn canon(input: &str) -> Option<String> {
    canonicalize_embed(input).map(|e| json_of(&e))
}

fn parse_embed(v: Value) -> Option<Embed> {
    serde_json::from_value(v).ok()
}

fn parse_any(v: Value) -> Option<AnyEmbed> {
    serde_json::from_value(v).ok()
}

const LIVE: &str =
    r#"{"provider":"twitch","kind":"live","channel":"some_streamer","url":"https://player.twitch.tv/?channel=some_streamer"}"#;
const VOD: &str = r#"{"provider":"twitch","kind":"vod","videoId":"40464143","url":"https://player.twitch.tv/?video=v40464143"}"#;
const VIMEO: &str = r#"{"provider":"vimeo","videoId":"76979871","hash":null,"url":"https://player.vimeo.com/video/76979871"}"#;
const UNLISTED: &str =
    r#"{"provider":"vimeo","videoId":"76979871","hash":"abc123def4","url":"https://player.vimeo.com/video/76979871?h=abc123def4"}"#;
const GENERIC: &str = r#"{"provider":"generic","host":"player.example.com","url":"https://player.example.com/embed/42"}"#;

fn accepts(table: &[(&str, &str)]) {
    for (input, want) in table {
        assert_eq!(canon(input).as_deref(), Some(*want), "{input}");
    }
}

fn rejects(inputs: &[&str]) {
    for input in inputs {
        assert_eq!(canon(input), None, "{input}");
    }
}

// packages/shared/test/embed.test.ts:8
#[test]
fn youtube_allowed() {
    let want = yt(ID);
    let allowed = [
        format!("https://www.youtube.com/watch?v={ID}"),
        format!("https://youtube.com/watch?v={ID}"),
        format!("https://m.youtube.com/watch?v={ID}"),
        format!("http://www.youtube.com/watch?v={ID}"),
        format!("https://www.youtube.com/watch?v={ID}&t=42s&list=PL123"),
        format!("https://www.youtube.com/watch?feature=share&v={ID}"),
        format!("https://WWW.YouTube.COM/watch?v={ID}"),
        format!("https://youtu.be/{ID}"),
        format!("https://youtu.be/{ID}?t=10"),
        format!("https://www.youtube.com/embed/{ID}"),
        format!("https://youtube.com/embed/{ID}?autoplay=1"),
        format!("https://www.youtube-nocookie.com/embed/{ID}"),
        format!("https://youtube-nocookie.com/embed/{ID}"),
        format!("  https://youtu.be/{ID}  "),
        format!("https://www.youtube.com/watch?v={ID}#comments"),
    ];
    for input in allowed {
        assert_eq!(canon(&input).as_deref(), Some(want.as_str()), "{input}");
    }
    // packages/shared/test/embed.test.ts:34
    assert_eq!(canon("https://youtu.be/a_B-c9D_e-F").as_deref(), Some(yt("a_B-c9D_e-F").as_str()));
}

// packages/shared/test/embed.test.ts:40
#[test]
fn youtube_rejected() {
    let long = format!("https://www.youtube.com/watch?v={ID}&x={}", "a".repeat(3000));
    let table = [
        String::new(),
        "hello world".into(),
        ID.into(),
        format!("javascript:alert(1)//https://youtu.be/{ID}"),
        format!(r#"data:text/html,<iframe src="https://youtu.be/{ID}">"#),
        format!("ftp://youtube.com/watch?v={ID}"),
        format!("//www.youtube.com/watch?v={ID}"),
        format!("https://user:pass@www.youtube.com/watch?v={ID}"),
        format!("https://evil@youtube.com/watch?v={ID}"),
        format!("https://www.youtube.com:8443/watch?v={ID}"),
        format!("https://vimeo.com/{ID}"),
        format!("https://youtube.com.evil.example/watch?v={ID}"),
        format!("https://evilyoutube.com/watch?v={ID}"),
        format!("https://music.youtube.com/watch?v={ID}"),
        format!("https://youtube.com./watch?v={ID}"),
        format!("https:\\\\evil.example\\www.youtube.com/watch?v={ID}"),
        format!("https://142.250.1.1/watch?v={ID}"),
        "https://youtu.be/dQw4w9WgXc".into(),
        "https://youtu.be/dQw4w9WgXcQQ".into(),
        "https://youtu.be/dQw4w9WgX.Q".into(),
        "https://youtu.be/dQw4w9WgX%51".into(),
        "https://www.youtube.com/watch?list=PL123".into(),
        "https://www.youtube.com/watch?v=".into(),
        format!("https://www.youtube.com/watch?v={ID}&v=aaaaaaaaaaa"),
        "https://www.youtube.com/watch?v=<script>xx".into(),
        format!("https://youtu.be/{ID}/extra"),
        "https://youtu.be/".into(),
        format!("https://youtu.be/watch?v={ID}"),
        format!("https://www.youtube.com/embed/{ID}/x"),
        format!("https://www.youtube.com/embed/{ID}/"),
        "https://www.youtube.com/embed/".into(),
        format!("https://www.youtube-nocookie.com/watch?v={ID}"),
        "https://www.youtube.com/@somechannel".into(),
        format!("https://www.youtube.com/shorts/{ID}"),
        "https://www.youtube.com/embed/live_stream?channel=UC123".into(),
        "https://www.youtube.com/embed/videoseries?list=PL123".into(),
        long,
    ];
    for input in table {
        assert_eq!(canon(&input), None, "{input}");
    }
}

// packages/shared/test/embed.test.ts:88
#[test]
fn embed_parsing_accepts_canonical_and_refuses_the_rest() {
    let canonical: Value = serde_json::from_str(&yt(ID)).unwrap();
    assert!(parse_embed(canonical.clone()).is_some());
    let invalid = [
        json!({"provider": "vimeo", "videoId": ID, "url": format!("https://www.youtube.com/embed/{ID}")}),
        json!({"provider": "youtube", "videoId": "nope", "url": "https://www.youtube.com/embed/nope"}),
        json!({"provider": "youtube", "videoId": ID, "url": format!("https://youtu.be/{ID}")}),
        json!({"provider": "youtube", "videoId": ID, "url": "https://www.youtube.com/embed/aaaaaaaaaaa"}),
        json!({"provider": "youtube", "videoId": ID, "url": "https://evil.example/"}),
        json!({"provider": "youtube", "videoId": "videoseries", "url": "https://www.youtube.com/embed/videoseries"}),
        json!({"provider": "youtube", "videoId": "live_stream", "url": "https://www.youtube.com/embed/live_stream"}),
        json!({"provider": "youtube", "videoId": ID}),
        Value::Null,
        json!([]),
        json!("x"),
    ];
    for v in invalid {
        assert_eq!(parse_embed(v.clone()), None, "{v}");
    }
}

#[test]
fn embed_parsing_strips_unknown_keys_like_a_valibot_object() {
    let with_extra = json!({"provider": "youtube", "videoId": ID, "url": format!("https://www.youtube.com/embed/{ID}"), "extra": 1});
    assert_eq!(json_of(&parse_embed(with_extra).unwrap()), yt(ID));
}

// packages/shared/test/embed-providers.test.ts:37
#[test]
fn twitch_accepted() {
    for input in [
        "https://www.twitch.tv/some_streamer",
        "https://twitch.tv/some_streamer",
        "https://m.twitch.tv/some_streamer",
        "http://www.twitch.tv/some_streamer",
        "https://www.twitch.tv/some_streamer/",
        "https://www.twitch.tv/Some_Streamer",
        "https://WWW.Twitch.TV/some_streamer?sr=a",
        "  https://www.twitch.tv/some_streamer#chat  ",
        "https://player.twitch.tv/?channel=some_streamer",
        "https://player.twitch.tv/?channel=Some_Streamer&parent=example.com&autoplay=false",
    ] {
        accepts(&[(input, LIVE)]);
    }
    for input in [
        "https://www.twitch.tv/videos/40464143",
        "https://m.twitch.tv/videos/40464143?t=1h2m3s",
        "https://player.twitch.tv/?video=v40464143",
        "https://player.twitch.tv/?video=40464143&parent=example.com",
        "https://player.twitch.tv/?video=V40464143",
    ] {
        accepts(&[(input, VOD)]);
    }
    // :57 a 1-char and a 25-char login are both valid
    assert_eq!(
        canonicalize_embed("https://twitch.tv/a").unwrap().url(),
        "https://player.twitch.tv/?channel=a"
    );
    let long = "a".repeat(25);
    assert_eq!(
        canonicalize_embed(&format!("https://twitch.tv/{long}")).unwrap().url(),
        format!("https://player.twitch.tv/?channel={long}")
    );
}

// packages/shared/test/embed-providers.test.ts:63
#[test]
fn twitch_rejected() {
    let long_query = format!("https://www.twitch.tv/some_streamer?x={}", "a".repeat(3000));
    let long_login = format!("https://www.twitch.tv/{}", "a".repeat(26));
    let long_vod = format!("https://www.twitch.tv/videos/{}", "1".repeat(13));
    rejects(&[
        "https://clips.twitch.tv/SomeClipSlug-abc",
        "https://www.twitch.tv/some_streamer/clip/SomeClipSlug-abc",
        "https://player.twitch.tv/?collection=abc123&video=v40464143",
        "https://player.twitch.tv/?collection=abc123",
        "https://player.twitch.tv/?channel=some_streamer&video=v40464143",
        "https://player.twitch.tv/?channel=a&channel=b",
        "https://player.twitch.tv/?video=v1&video=v2",
        "https://player.twitch.tv/",
        "https://player.twitch.tv/embed?channel=some_streamer",
        "https://player.twitch.tv/?channel=",
        "https://www.twitch.tv/",
        "https://www.twitch.tv/directory",
        "https://www.twitch.tv/videos",
        "https://www.twitch.tv/settings",
        "https://player.twitch.tv/?channel=directory",
        "https://www.twitch.tv/some_streamer/videos",
        "https://www.twitch.tv/some_streamer//",
        "https://www.twitch.tv/videos/40464143/extra",
        "https://www.twitch.tv/videos/40464143/",
        &long_login,
        "https://www.twitch.tv/some-streamer",
        "https://www.twitch.tv/some.streamer",
        "https://www.twitch.tv/some%5Fstreamer",
        "https://www.twitch.tv/strеamer",
        "https://player.twitch.tv/?channel=a%22onload%3D",
        "https://www.twitch.tv/videos/040464143",
        "https://player.twitch.tv/?video=v0",
        &long_vod,
        "https://www.twitch.tv/videos/abc",
        "https://player.twitch.tv/?video=vv40464143",
        "https://player.twitch.tv/?video=v",
        "https://user:pass@www.twitch.tv/some_streamer",
        "https://evil@player.twitch.tv/?channel=some_streamer",
        "https://www.twitch.tv:8443/some_streamer",
        "https://twitch.tv.evil.example/some_streamer",
        "https://eviltwitch.tv/some_streamer",
        "https://dashboard.twitch.tv/some_streamer",
        "https://twitch.tv./some_streamer",
        "javascript:alert(1)//https://twitch.tv/some_streamer",
        &long_query,
    ]);
}

// packages/shared/test/embed-providers.test.ts:108
#[test]
fn vimeo_accepted() {
    for input in [
        "https://vimeo.com/76979871",
        "https://www.vimeo.com/76979871",
        "http://vimeo.com/76979871",
        "https://Vimeo.COM/76979871?share=copy#t=10",
        "https://vimeo.com/channels/staffpicks/76979871",
        "https://vimeo.com/groups/shortfilms/videos/76979871",
        "https://vimeo.com/album/1234/video/76979871",
        "https://vimeo.com/showcase/1234/video/76979871",
        "https://player.vimeo.com/video/76979871",
        "https://player.vimeo.com/video/76979871?autoplay=1&dnt=1",
    ] {
        accepts(&[(input, VIMEO)]);
    }
    for input in [
        "https://vimeo.com/76979871/abc123def4",
        "https://vimeo.com/76979871/ABC123DEF4",
        "https://player.vimeo.com/video/76979871?h=abc123def4",
        "https://player.vimeo.com/video/76979871?badge=0&h=abc123def4&dnt=1",
    ] {
        accepts(&[(input, UNLISTED)]);
    }
}

// packages/shared/test/embed-providers.test.ts:127
#[test]
fn vimeo_rejected() {
    let long_hash = format!("https://vimeo.com/76979871/{}", "a".repeat(33));
    let long_id = format!("https://vimeo.com/{}", "1".repeat(13));
    let long_query = format!("https://vimeo.com/76979871?x={}", "a".repeat(3000));
    rejects(&[
        "https://vimeo.com/event/1234567",
        "https://vimeo.com/event/1234567/embed",
        "https://vimeo.com/showcase/1234",
        "https://vimeo.com/channels/staffpicks",
        "https://vimeo.com/someuser",
        "https://vimeo.com/",
        "https://vimeo.com/076979871",
        &long_id,
        "https://player.vimeo.com/video/abc",
        "https://vimeo.com/76979871/abc12",
        &long_hash,
        "https://vimeo.com/76979871/xyz123def4",
        "https://player.vimeo.com/video/76979871?h=abc123%22def",
        "https://player.vimeo.com/video/76979871?h=",
        "https://player.vimeo.com/video/76979871?h=abc123def4&h=abc123def5",
        "https://vimeo.com/76979871/abc123def4/extra",
        "https://player.vimeo.com/video/76979871/extra",
        "https://player.vimeo.com/video/76979871/",
        "https://player.vimeo.com/76979871",
        "https://vimeo.com/76979871/",
        "https://vimeo.com/channels/staffpicks/76979871/extra",
        "https://vimeo.com/groups/shortfilms/76979871",
        "https://vimeo.com/album/1234/76979871",
        "https://player.videoji.hk/video/76979871",
        "https://player.vimeo.work/video/76979871",
        "https://api.vimeo.com/videos/76979871",
        "https://vimeo.com.evil.example/76979871",
        "https://evilvimeo.com/76979871",
        "https://user:pass@vimeo.com/76979871",
        "https://player.vimeo.com:444/video/76979871",
        "javascript:alert(1)//https://vimeo.com/76979871",
        &long_query,
    ]);
}

// packages/shared/test/embed-providers.test.ts:164
#[test]
fn embed_parsing_twitch_and_vimeo() {
    for s in [LIVE, VOD, VIMEO, UNLISTED] {
        let v: Value = serde_json::from_str(s).unwrap();
        assert_eq!(json_of(&parse_embed(v).unwrap()), s);
    }
    let live: Value = serde_json::from_str(LIVE).unwrap();
    let vod: Value = serde_json::from_str(VOD).unwrap();
    let vimeo: Value = serde_json::from_str(VIMEO).unwrap();
    let unlisted: Value = serde_json::from_str(UNLISTED).unwrap();
    let with = |base: &Value, k: &str, val: Value| {
        let mut b = base.clone();
        b[k] = val;
        b
    };
    let invalid = [
        with(&live, "url", json!("https://www.twitch.tv/some_streamer")),
        with(
            &live,
            "url",
            json!("https://player.twitch.tv/?channel=some_streamer&parent=evil.example"),
        ),
        with(&live, "url", json!("https://player.twitch.tv/?channel=other")),
        with(
            &with(&live, "channel", json!("Some_Streamer")),
            "url",
            json!("https://player.twitch.tv/?channel=Some_Streamer"),
        ),
        with(
            &with(&live, "channel", json!("directory")),
            "url",
            json!("https://player.twitch.tv/?channel=directory"),
        ),
        json!({"provider": "twitch", "channel": "some_streamer", "url": "https://player.twitch.tv/?channel=some_streamer"}),
        json!({"provider": "twitch", "kind": "clip", "channel": "some_streamer", "url": "https://player.twitch.tv/?channel=some_streamer"}),
        with(&vod, "url", json!("https://player.twitch.tv/?video=40464143")),
        json!({"provider": "twitch", "kind": "live", "videoId": "40464143", "url": "https://player.twitch.tv/?video=v40464143"}),
        with(
            &with(&vod, "videoId", json!("0")),
            "url",
            json!("https://player.twitch.tv/?video=v0"),
        ),
        with(&vimeo, "url", json!("https://vimeo.com/76979871")),
        with(&unlisted, "url", json!("https://player.vimeo.com/video/76979871")),
        with(&vimeo, "url", json!("https://player.vimeo.com/video/76979871?h=abc123def4")),
        json!({"provider": "vimeo", "videoId": "76979871", "url": "https://player.vimeo.com/video/76979871"}),
        with(
            &with(&unlisted, "hash", json!("ABC123DEF4")),
            "url",
            json!("https://player.vimeo.com/video/76979871?h=ABC123DEF4"),
        ),
        with(&vimeo, "url", json!("https://evil.example/")),
        json!({"provider": "vimeo", "videoId": ID, "hash": null, "url": format!("https://www.youtube.com/embed/{ID}")}),
    ];
    for v in invalid {
        assert_eq!(parse_embed(v.clone()), None, "{v}");
    }
}

// packages/shared/test/embed-providers.test.ts:196
#[test]
fn max_embed_url_length_covers_every_provider() {
    for input in [
        "https://youtu.be/dQw4w9WgXcQ".to_owned(),
        format!("https://twitch.tv/{}", "a".repeat(25)),
        format!("https://twitch.tv/videos/{}", "9".repeat(12)),
        format!("https://vimeo.com/{}/{}", "9".repeat(12), "f".repeat(32)),
    ] {
        let e = canonicalize_embed(&input).unwrap();
        assert!(e.url().len() <= MAX_EMBED_URL_LENGTH, "{input}");
    }
}

#[test]
fn raw_length_cap_is_utf16_units() {
    let base = format!("https://youtu.be/{ID}?x=");
    let at = |units: usize| format!("{base}{}", "a".repeat(units - base.len()));
    assert!(canonicalize_embed(&at(MAX_URL_LENGTH)).is_some());
    assert!(canonicalize_embed(&at(MAX_URL_LENGTH + 1)).is_none());
    // 1000 astral chars are 2000 UTF-16 units but 4000 UTF-8 bytes: the cap counts units.
    let astral = |n: usize| format!("{base}{}", "\u{1F600}".repeat(n));
    assert!(canonicalize_embed(&astral((MAX_URL_LENGTH - base.len()) / 2)).is_some());
    assert!(canonicalize_embed(&astral((MAX_URL_LENGTH - base.len()) / 2 + 1)).is_none());
}

#[test]
fn kelvin_sign_lowercases_to_k_in_a_twitch_channel() {
    // U+212A KELVIN SIGN: `toLowerCase()` gives "k", so this is the login "k".
    assert_eq!(
        canonicalize_embed("https://player.twitch.tv/?channel=%E2%84%AA").unwrap().url(),
        "https://player.twitch.tv/?channel=k"
    );
    // `+` is a space in a query, so it never reaches a login.
    assert_eq!(canonicalize_embed("https://player.twitch.tv/?channel=a+b"), None);
}

#[test]
fn key_order_is_the_ts_literal_order() {
    assert_eq!(canon("https://youtu.be/dQw4w9WgXcQ").unwrap(), yt(ID));
    assert_eq!(canon("https://twitch.tv/some_streamer").unwrap(), LIVE);
    assert_eq!(canon("https://twitch.tv/videos/40464143").unwrap(), VOD);
    assert_eq!(canon("https://vimeo.com/76979871").unwrap(), VIMEO);
    assert_eq!(canon("https://vimeo.com/76979871/abc123def4").unwrap(), UNLISTED);
}

// packages/shared/test/capabilities.test.ts:10
#[test]
fn playback_caps_table() {
    let caps = |url: &str| *playback_caps(&canonicalize_embed(url).unwrap());
    let c = |seek, live, rate| PlaybackCaps { seek, live, rate };
    assert_eq!(caps("https://youtu.be/dQw4w9WgXcQ"), c(true, false, RateSupport::Yes));
    assert_eq!(caps("https://vimeo.com/76979871"), c(true, false, RateSupport::Probe));
    assert_eq!(caps("https://vimeo.com/76979871/abc123def4"), c(true, false, RateSupport::Probe));
    assert_eq!(caps("https://www.twitch.tv/videos/40464143"), c(true, false, RateSupport::No));
    assert_eq!(caps("https://www.twitch.tv/some_streamer"), c(false, true, RateSupport::No));
    assert_eq!(
        json_of(&caps("https://vimeo.com/76979871")),
        r#"{"seek":true,"live":false,"rate":"probe"}"#
    );
    // a shared static object: no allocation per call
    let a = playback_caps(&canonicalize_embed("https://youtu.be/dQw4w9WgXcQ").unwrap());
    let b = playback_caps(&canonicalize_embed("https://youtu.be/aaaaaaaaaaa").unwrap());
    assert!(std::ptr::eq(a, b));
}

// ---------------------------------------------------------------------------------- generic

fn generic(input: &str) -> Option<String> {
    canonicalize_generic_embed(input, &[]).map(|e| json_of(&e))
}

fn own(hosts: &[&str]) -> Vec<String> {
    hosts.iter().map(|h| (*h).to_owned()).collect()
}

// packages/shared/test/generic-embed.test.ts:23
#[test]
fn generic_accepted() {
    for input in [
        "https://player.example.com/embed/42",
        "https://Player.EXAMPLE.com/embed/42",
        "  https://player.example.com/embed/42 \n",
        "https://player.example.com:443/embed/42",
        "https://player.example.com/a/../embed/42",
    ] {
        assert_eq!(generic(input).as_deref(), Some(GENERIC), "{input}");
    }
    let want = |host: &str, url: &str| format!(r#"{{"provider":"generic","host":"{host}","url":"{url}"}}"#);
    assert_eq!(
        generic("https://media.example.org/v?id=7&t=30").unwrap(),
        want("media.example.org", "https://media.example.org/v?id=7&t=30")
    );
    assert_eq!(generic("https://example.net").unwrap(), want("example.net", "https://example.net/"));
    assert_eq!(
        generic("https://bücher.de/e").unwrap(),
        want("xn--bcher-kva.de", "https://xn--bcher-kva.de/e")
    );
}

// packages/shared/test/generic-embed.test.ts:55
#[test]
fn generic_rejected() {
    let over_raw = format!("https://player.example.com/{}", "a".repeat(MAX_URL_LENGTH));
    let over_stored = format!("https://player.example.com/{}", "a".repeat(MAX_GENERIC_EMBED_URL_LENGTH));
    for input in [
        "http://player.example.com/embed/42",
        "javascript:alert(1)",
        "javascript://player.example.com/%0aalert(1)",
        "data:text/html,<script>alert(1)</script>",
        "blob:https://player.example.com/550e8400-e29b-41d4-a716-446655440000",
        "file:///etc/passwd",
        "ftp://player.example.com/x",
        "wss://player.example.com/x",
        "https://user@player.example.com/embed/42",
        "https://user:pass@player.example.com/embed/42",
        "https://player.example.com@evil.example/embed/42",
        "https://player.example.com:8443/embed/42",
        "https://93.184.216.34/embed",
        "https://127.0.0.1/embed",
        "https://192.168.1.10/embed",
        "https://169.254.169.254/latest/meta-data/",
        "https://2130706433/",
        "https://0x7f.0.0.1/",
        "https://127.1/",
        "https://[::1]/embed",
        "https://[::ffff:127.0.0.1]/embed",
        "https://[2606:2800:220:1:248:1893:25c8:1946]/embed",
        "https://localhost/embed",
        "https://localhost./embed",
        "https://app.localhost/embed",
        "https://intranet/embed",
        "https://printer.local/embed",
        "https://metadata.google.internal/embed",
        "https://nas.home.arpa/embed",
        "https://box.localdomain/embed",
        "https://router.lan/embed",
        "https://1.0.0.127.in-addr.arpa/",
        "https://example.test/embed",
        "https://player.example/embed",
        "https://player.invalid/embed",
        "https://abc.onion/embed",
        "https://abc.alt/embed",
        "https://a.localtest.me/embed",
        "https://lvh.me/embed",
        "https://127.0.0.1.nip.io/embed",
        "https://10-0-0-1.sslip.io/embed",
        "https://player.example.com./embed/42",
        "https://my_host.example.com/embed",
        "https://player.example.123/embed",
        &over_raw,
        &over_stored,
        "/embed/42",
        "not a url",
        "",
        "https://www.youtube.com/playlist?list=PL123",
        "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
        "https://youtu.be/dQw4w9WgXcQ",
        "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ",
        "https://clips.twitch.tv/embed?clip=AwkwardHelplessSalamander",
        "https://www.twitch.tv/some_streamer",
        "https://player.vimeo.com/video/76979871",
        "https://foo.vimeo.com/x",
    ] {
        assert_eq!(generic(input), None, "{input}");
    }
}

// packages/shared/test/generic-embed.test.ts:123
#[test]
fn generic_own_origin() {
    let opts = own(&["omega.example.org"]);
    let g = |input: &str, hosts: &[String]| canonicalize_generic_embed(input, hosts);
    assert_eq!(g("https://omega.example.org/rooms/lobby", &opts), None);
    assert_eq!(g("https://OMEGA.example.org/x", &opts), None);
    assert_eq!(g("https://cdn.omega.example.org/x", &opts), None);
    assert_eq!(g("https://notomega.example.org/x", &opts).unwrap().host(), "notomega.example.org");
    let messy = own(&[" Share.Example.ORG. ", "bücher.de"]);
    assert_eq!(g("https://x.share.example.org/", &messy), None);
    assert_eq!(g("https://share.example.org/", &messy), None);
    assert_eq!(g("https://xn--bcher-kva.de/", &messy), None);
    // packages/shared/test/generic-embed.test.ts:143
    assert_eq!(normalize_hostname(" Share.Example.ORG. ").as_deref(), Some("share.example.org"));
    assert_eq!(normalize_hostname("bücher.de").as_deref(), Some("xn--bcher-kva.de"));
    assert_eq!(normalize_hostname("localhost").as_deref(), Some("localhost"));
    assert_eq!(normalize_hostname("https://share.example.org/"), None);
    assert_eq!(normalize_hostname("share.example.org:8080"), None);
    assert_eq!(normalize_hostname(""), None);
    assert_eq!(json_of(&g("https://player.example.com/embed/42", &opts).unwrap()), GENERIC);
    // a bad own-host entry is skipped (TS filters the nulls), not fatal
    assert!(g("https://player.example.com/x", &own(&["a/b", ""])).is_some());
}

// packages/shared/test/generic-embed.test.ts:156
#[test]
fn generic_never_panics_on_weird_input() {
    for input in [
        "https://",
        "https://%",
        "https://a..b/",
        "https://-a.example/",
        "https://a-.example/",
        "\u{0}",
        "https://ex\u{0}ample.com/",
    ] {
        let _ = generic(input);
    }
}

// packages/shared/test/generic-embed.test.ts:167
#[test]
fn generic_embed_parsing() {
    let g: Value = serde_json::from_str(GENERIC).unwrap();
    assert_eq!(json_of(&parse_any(g.clone()).unwrap()), GENERIC);
    let bad = [
        json!({"provider": "generic", "host": "player.example.com", "url": "https://Player.example.com/embed/42"}),
        json!({"provider": "generic", "host": "other.example.com", "url": "https://player.example.com/embed/42"}),
        json!({"provider": "generic", "host": "player.example.com", "url": "http://player.example.com/embed/42"}),
        json!({"provider": "generic", "host": "x", "url": "javascript:alert(1)"}),
        json!({"provider": "generic", "host": "127.0.0.1", "url": "https://127.0.0.1/"}),
        json!({"provider": "generic", "host": "localhost", "url": "https://localhost/"}),
        json!({"provider": "generic", "host": "player.example.com", "url": "https://u@player.example.com/"}),
        json!({"provider": "generic", "host": "player.vimeo.com", "url": "https://player.vimeo.com/video/76979871"}),
        json!({"provider": "generic", "url": "https://player.example.com/embed/42"}),
    ];
    for v in bad {
        assert_eq!(parse_any(v.clone()), None, "{v}");
    }
    // a synced embed is also an AnyEmbed; key order is preserved
    let vimeo: Value = serde_json::from_str(VIMEO).unwrap();
    assert_eq!(json_of(&parse_any(vimeo).unwrap()), VIMEO);
}

// packages/shared/test/generic-embed.test.ts:189
#[test]
fn any_embed() {
    let on = AnyEmbedOptions {
        generic: true,
        own_hosts: &[],
    };
    let off = AnyEmbedOptions {
        generic: false,
        own_hosts: &[],
    };
    let any = |input: &str, o: AnyEmbedOptions<'_>| canonicalize_any_embed(input, o);
    assert_eq!(any("https://youtu.be/dQw4w9WgXcQ", on).map(|e| json_of(&e)).unwrap(), yt(ID));
    assert_eq!(json_of(&any("https://player.example.com/embed/42", on).unwrap()), GENERIC);
    assert_eq!(any("https://player.example.com/embed/42", off), None);
    assert!(any("https://youtu.be/dQw4w9WgXcQ", off).unwrap().is_synced());
    let hosts = own(&["omega.example.org"]);
    assert_eq!(
        any(
            "https://omega.example.org/x",
            AnyEmbedOptions {
                generic: true,
                own_hosts: &hosts
            }
        ),
        None
    );
    // a malformed synced URL does not fall back to generic
    assert_eq!(any("https://www.youtube.com/watch?v=short", on), None);
    // canonicalize_embed itself stays synced-only
    assert_eq!(canonicalize_embed("https://player.example.com/embed/42"), None);
    assert!(!any("https://player.example.com/embed/42", on).unwrap().is_synced());
    assert_eq!(
        any("https://player.example.com/embed/42", on).unwrap().url(),
        "https://player.example.com/embed/42"
    );
}

// packages/shared/test/generic-embed.test.ts:213
#[test]
fn provider_registry_hosts() {
    for h in [
        "youtu.be",
        "m.youtube.com",
        "clips.twitch.tv",
        "player.vimeo.com",
        "youtube-nocookie.com",
        "x.vimeo.com",
    ] {
        assert!(is_synced_provider_host(h), "{h}");
    }
    for h in ["player.example.com", "notyoutube.com", "youtube.com.evil.com", ""] {
        assert!(!is_synced_provider_host(h), "{h}");
    }
}

#[test]
fn generic_href_cap_is_1024_units() {
    let base = "https://player.example.com/";
    let at = |n: usize| format!("{base}{}", "a".repeat(n - base.len()));
    assert!(generic(&at(MAX_GENERIC_EMBED_URL_LENGTH)).is_some());
    assert_eq!(generic(&at(MAX_GENERIC_EMBED_URL_LENGTH + 1)), None);
    assert!(generic(&at(MAX_GENERIC_EMBED_URL_LENGTH - 1)).is_some());
}

#[test]
fn dns_label_and_name_length_rules() {
    let label63 = "a".repeat(63);
    assert!(generic(&format!("https://{label63}.com/")).is_some());
    assert_eq!(generic(&format!("https://{}.com/", "a".repeat(64))), None);
    // 253 total is the longest public name; the URL parser itself already refuses more.
    let name = |tail: usize| format!("{label63}.{label63}.{label63}.{}.com", "d".repeat(tail));
    assert_eq!(name(57).len(), 253);
    assert!(generic(&format!("https://{}/", name(57))).is_some());
    assert_eq!(generic(&format!("https://{}/", name(58))), None);
    assert!(generic("https://a-b.com/").is_some());
    assert_eq!(generic("https://-a.com/"), None);
    assert_eq!(generic("https://a-.com/"), None);
    assert_eq!(generic("https://example.xn--/"), None);
    assert!(generic("https://example.xn--p1ai/").is_some());
    assert!(generic("https://example.ab/").is_some());
    assert_eq!(generic("https://example.a/"), None);
}
