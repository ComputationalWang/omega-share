//! Port of `apps/server/src/playback.ts`: the room's shared playback clock, pure. Every function takes
//! the wall clock (`Date.now()`) as `now_wall` Unix ms; the server stamps `at` with it, not the monotonic clock.

use crate::contract::capabilities::any_playback_caps;
use crate::contract::constants::{COUNTDOWN_MS, MAX_POSITION_S};
use crate::contract::generic_embed::AnyEmbed;
use crate::contract::ids::MemberId;
use crate::contract::state::{PlaybackAction, PlaybackState, Position, Rate, Rev, ServerTime};

/// A `control` message's payload.
#[derive(Clone, Copy)]
pub struct Control<'a> {
    /// Canonical `Embed.url` of the video being controlled.
    pub url: &'a str,
    pub playing: bool,
    /// The wire schema bounds it to `0..=MAX_POSITION_S`; it is clamped anyway.
    pub position: f64,
    /// A shared 3-2-1 (ADR 0056): a play starts at `at + COUNTDOWN_MS`.
    pub countdown: bool,
}

/// Without the url: which video a member controls is not for logs (ADR 0032).
impl std::fmt::Debug for Control<'_> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Control")
            .field("playing", &self.playing)
            .field("position", &self.position)
            .field("countdown", &self.countdown)
            .finish_non_exhaustive()
    }
}

/// A position further than this from the extrapolated one counts as a seek (ADR 0011).
const SEEK_THRESHOLD_S: f64 = 1.0;

/// `Math.min(MAX_POSITION_S, Math.max(0, s))`.
fn clamp(s: f64) -> f64 {
    s.clamp(0.0, MAX_POSITION_S)
}

/// Unix ms as the schema's `ServerTime`; the wall clock is past 1970, so the fallback is unreachable.
fn server_time(now_wall: i64) -> ServerTime {
    ServerTime(u64::try_from(now_wall).unwrap_or(0))
}

/// The `load` state of a freshly shared embed. `prev_rev` is the room's last rev (-1 if none).
pub fn load_playback(prev_rev: i64, now_wall: i64, by: Option<MemberId>) -> PlaybackState {
    PlaybackState {
        playing: true,
        position: Position::ZERO,
        rate: Rate::ONE,
        at: server_time(now_wall),
        rev: Rev(u64::try_from(prev_rev.saturating_add(1)).unwrap_or(0)),
        action: PlaybackAction::Load,
        by,
        start_at: None,
    }
}

/// The state of an embed restored from the DB after a restart: paused at 0, by no one (OME-280).
pub fn restored_playback(now_wall: i64) -> PlaybackState {
    PlaybackState {
        playing: false,
        position: Position::ZERO,
        rate: Rate::ONE,
        at: server_time(now_wall),
        rev: Rev(0),
        action: PlaybackAction::Pause,
        by: None,
        start_at: None,
    }
}

/// Where the video should be at server time `now_wall`. The expression order is the TS one (f64 rounding).
/// A countdown play holds at `position` until `start_at`, then runs from there (ADR 0056).
pub fn expected_position(state: &PlaybackState, now_wall: i64) -> f64 {
    if state.playing {
        let (from, now) = match state.start_at {
            Some(start) => (start.0 as f64, (now_wall as f64).max(start.0 as f64)),
            None => (state.at.0 as f64, now_wall as f64),
        };
        clamp(state.position.get() + ((now - from) / 1000.0) * state.rate.get())
    } else {
        state.position.get()
    }
}

/// Applies `control` from `by` (last write wins), synced or generic embed alike (ADR 0057 section 1). `None` when
/// there is no embed or `control.url` is not the current embed's url. On a live embed the position is always 0 and a control is only a play or a pause.
pub fn apply_control(
    state: Option<&PlaybackState>,
    embed: Option<&AnyEmbed>,
    control: &Control<'_>,
    by: &MemberId,
    now_wall: i64,
) -> Option<PlaybackState> {
    let (state, embed) = (state?, embed?);
    if embed.url() != control.url {
        return None;
    }
    let live = any_playback_caps(embed).live;
    let position = if live { 0.0 } else { clamp(control.position) };
    let action = if !live && (position - expected_position(state, now_wall)).abs() > SEEK_THRESHOLD_S {
        PlaybackAction::Seek
    } else if control.playing {
        PlaybackAction::Play
    } else {
        PlaybackAction::Pause
    };
    let at = server_time(now_wall);
    // Only a play: a seek or a pause (also one during a countdown) starts at once (ADR 0056).
    let start_at = (control.countdown && !live && action == PlaybackAction::Play).then(|| ServerTime(at.0.saturating_add(COUNTDOWN_MS)));
    Some(PlaybackState {
        playing: control.playing,
        // `None` only for a NaN position, which the wire schema never lets through.
        position: Position::new(position)?,
        rate: state.rate,
        at,
        rev: Rev(state.rev.0.saturating_add(1)),
        action,
        by: Some(by.clone()),
        start_at,
    })
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::indexing_slicing, reason = "tests")]
mod tests {
    use super::*;
    use crate::contract::embed::canonicalize_embed;

    const URL: &str = "https://www.youtube.com/embed/dQw4w9WgXcQ";
    const T0: i64 = 1_700_000_000_000;

    fn embed_of(url: &str) -> AnyEmbed {
        AnyEmbed::Synced(canonicalize_embed(url).unwrap())
    }
    fn alice() -> MemberId {
        MemberId::parse("11111111-1111-4111-8111-111111111111").unwrap()
    }
    fn bob() -> MemberId {
        MemberId::parse("22222222-2222-4222-8222-222222222222").unwrap()
    }
    fn loaded(rev: i64) -> PlaybackState {
        load_playback(rev - 1, T0, None)
    }
    fn ctl(url: &str, playing: bool, position: f64) -> Control<'_> {
        Control {
            url,
            playing,
            position,
            countdown: false,
        }
    }
    fn countdown(url: &str, playing: bool, position: f64) -> Control<'_> {
        Control {
            countdown: true,
            ..ctl(url, playing, position)
        }
    }
    fn pos(s: f64) -> Position {
        Position::new(s).unwrap()
    }
    fn json(s: &PlaybackState) -> String {
        serde_json::to_string(s).unwrap()
    }

    // apps/server/test/playback.test.ts:19
    #[test]
    fn a_new_embed_starts_playing_at_0_with_action_load_and_no_author() {
        assert_eq!(
            json(&load_playback(-1, T0, None)),
            r#"{"playing":true,"position":0,"rate":1,"at":1700000000000,"rev":0,"action":"load","by":null}"#
        );
    }

    // apps/server/test/playback.test.ts:23
    #[test]
    fn rev_keeps_rising_across_embed_changes() {
        assert_eq!(load_playback(7, T0, None).rev, Rev(8));
        assert_eq!(load_playback(7, T0, Some(alice())).by, Some(alice()));
    }

    // OME-280
    #[test]
    fn a_restored_embed_is_paused_at_0_by_no_one() {
        assert_eq!(
            json(&restored_playback(T0)),
            r#"{"playing":false,"position":0,"rate":1,"at":1700000000000,"rev":0,"action":"pause","by":null}"#
        );
    }

    // apps/server/test/playback.test.ts:30
    #[test]
    fn expected_position_advances_while_playing() {
        assert_eq!(expected_position(&loaded(0), T0 + 2500), 2.5);
    }

    // apps/server/test/playback.test.ts:34
    #[test]
    fn expected_position_stays_put_while_paused() {
        let paused = PlaybackState {
            playing: false,
            position: pos(30.0),
            ..loaded(0)
        };
        assert_eq!(expected_position(&paused, T0 + 60_000), 30.0);
    }

    // apps/server/test/playback.test.ts:39
    #[test]
    fn expected_position_never_runs_past_max() {
        let near_end = PlaybackState {
            position: pos(MAX_POSITION_S - 1.0),
            ..loaded(0)
        };
        assert_eq!(expected_position(&near_end, T0 + 10_000), MAX_POSITION_S);
    }

    // serde_json without `float_roundtrip` reads some decimals 1 ulp off (the playback-expected corpus found
    // it: `want` and the computed value disagreed). Positions and rates come off the wire this way.
    #[test]
    fn decimals_off_the_wire_parse_to_the_same_double_as_js() {
        for (text, want) in [
            ("11.292300000000003", 11.292300000000003),
            ("1234.5683000000001", 1234.5683000000001),
            ("3960.2923000000005", 3960.2923000000005),
            ("0.30000000000000004", 0.1 + 0.2),
        ] {
            assert_eq!(serde_json::from_str::<f64>(text).unwrap().to_bits(), f64::to_bits(want), "{text}");
        }
    }

    // apps/server/test/playback.test.ts:44
    #[test]
    fn expected_position_never_goes_below_0_if_the_clock_steps_back() {
        assert_eq!(expected_position(&loaded(0), T0 - 5000), 0.0);
    }

    #[test]
    fn expected_position_scales_with_the_rate() {
        let fast = PlaybackState {
            rate: Rate::new(2.0).unwrap(),
            ..loaded(0)
        };
        assert_eq!(expected_position(&fast, T0 + 1500), 3.0);
    }

    // apps/server/test/playback.test.ts:50
    #[test]
    fn pause_at_the_extrapolated_position_is_a_pause_by_the_sender() {
        let yt = embed_of(URL);
        let next = apply_control(Some(&loaded(0)), Some(&yt), &ctl(URL, false, 10.4), &alice(), T0 + 10_000).unwrap();
        assert_eq!(
            json(&next),
            r#"{"playing":false,"position":10.4,"rate":1,"at":1700000010000,"rev":1,"action":"pause","by":"11111111-1111-4111-8111-111111111111"}"#
        );
    }

    // apps/server/test/playback.test.ts:55
    #[test]
    fn play_from_paused_within_1s_of_where_it_stopped_is_a_play() {
        let yt = embed_of(URL);
        let paused = PlaybackState {
            playing: false,
            position: pos(42.0),
            ..loaded(3)
        };
        let next = apply_control(Some(&paused), Some(&yt), &ctl(URL, true, 42.9), &bob(), T0 + 60_000).unwrap();
        assert_eq!(next.action, PlaybackAction::Play);
        assert_eq!(next.rev, Rev(4));
    }

    // apps/server/test/playback.test.ts:62
    #[test]
    fn more_than_1s_from_the_extrapolated_position_is_a_seek_playing_or_not() {
        let yt = embed_of(URL);
        let playing = apply_control(Some(&loaded(0)), Some(&yt), &ctl(URL, true, 120.0), &alice(), T0 + 10_000).unwrap();
        assert_eq!(playing.action, PlaybackAction::Seek);
        let paused = apply_control(Some(&loaded(0)), Some(&yt), &ctl(URL, false, 8.9), &alice(), T0 + 10_000).unwrap();
        assert_eq!(paused.action, PlaybackAction::Seek);
        // Exactly the threshold is not a seek.
        let edge = apply_control(Some(&loaded(0)), Some(&yt), &ctl(URL, true, 9.0), &alice(), T0 + 10_000).unwrap();
        assert_eq!(edge.action, PlaybackAction::Play);
    }

    // apps/server/test/playback.test.ts:69
    #[test]
    fn last_write_wins_each_accepted_control_replaces_the_state_and_bumps_rev() {
        let yt = embed_of(URL);
        let a = apply_control(Some(&loaded(0)), Some(&yt), &ctl(URL, false, 5.0), &alice(), T0 + 5000).unwrap();
        let b = apply_control(Some(&a), Some(&yt), &ctl(URL, true, 300.0), &bob(), T0 + 5001).unwrap();
        assert_eq!(
            json(&b),
            r#"{"playing":true,"position":300,"rate":1,"at":1700000005001,"rev":2,"action":"seek","by":"22222222-2222-4222-8222-222222222222"}"#
        );
    }

    // apps/server/test/playback.test.ts:76
    #[test]
    fn clamps_the_position_into_0_to_max() {
        let yt = embed_of(URL);
        let hi = apply_control(Some(&loaded(0)), Some(&yt), &ctl(URL, true, MAX_POSITION_S + 50.0), &alice(), T0).unwrap();
        assert_eq!(hi.position.get(), MAX_POSITION_S);
        let lo = apply_control(Some(&loaded(0)), Some(&yt), &ctl(URL, true, -3.0), &alice(), T0).unwrap();
        assert_eq!(lo.position.get(), 0.0);
    }

    // apps/server/test/playback.test.ts:83
    #[test]
    fn a_control_for_another_video_or_another_url_form_is_rejected() {
        let yt = embed_of(URL);
        for url in ["https://www.youtube.com/embed/aaaaaaaaaaa", "https://youtu.be/dQw4w9WgXcQ", ""] {
            assert!(
                apply_control(Some(&loaded(0)), Some(&yt), &ctl(url, false, 0.0), &alice(), T0).is_none(),
                "{url}"
            );
        }
    }

    // apps/server/test/playback.test.ts:91
    #[test]
    fn a_control_with_no_embed_or_no_state_is_rejected() {
        let yt = embed_of(URL);
        assert!(apply_control(None, None, &ctl(URL, false, 0.0), &alice(), T0).is_none());
        assert!(apply_control(Some(&loaded(0)), None, &ctl(URL, false, 0.0), &alice(), T0).is_none());
        assert!(apply_control(None, Some(&yt), &ctl(URL, false, 0.0), &alice(), T0).is_none());
    }

    // apps/server/test/playback.test.ts:100
    #[test]
    fn live_embed_ignores_the_position() {
        let live = embed_of("https://www.twitch.tv/somechannel");
        let at = T0 + 10_000;
        let next = apply_control(Some(&loaded(0)), Some(&live), &ctl(live.url(), true, 300.0), &alice(), at).unwrap();
        assert_eq!(
            json(&next),
            r#"{"playing":true,"position":0,"rate":1,"at":1700000010000,"rev":1,"action":"play","by":"11111111-1111-4111-8111-111111111111"}"#
        );
    }

    // apps/server/test/playback.test.ts:105
    #[test]
    fn live_pause_and_resume_are_shared_always_at_position_0() {
        let live = embed_of("https://www.twitch.tv/somechannel");
        let paused = apply_control(Some(&loaded(0)), Some(&live), &ctl(live.url(), false, 42.0), &alice(), T0 + 10_000).unwrap();
        assert_eq!(
            (paused.playing, paused.position.get(), paused.action),
            (false, 0.0, PlaybackAction::Pause)
        );
        let resumed = apply_control(Some(&paused), Some(&live), &ctl(live.url(), true, 0.0), &bob(), T0 + 70_000).unwrap();
        assert_eq!(
            (resumed.playing, resumed.position.get(), resumed.action),
            (true, 0.0, PlaybackAction::Play)
        );
        assert_eq!(resumed.by, Some(bob()));
    }

    // apps/server/test/playback.test.ts:114
    #[test]
    fn seekable_non_youtube_embeds_seek_on_a_far_position() {
        for url in ["https://www.twitch.tv/videos/123456789", "https://vimeo.com/76979871"] {
            let e = embed_of(url);
            let next = apply_control(Some(&loaded(0)), Some(&e), &ctl(e.url(), true, 95.0), &alice(), T0 + 10_000).unwrap();
            assert_eq!(
                (next.playing, next.position.get(), next.action),
                (true, 95.0, PlaybackAction::Seek),
                "{url}"
            );
        }
    }

    // ---- countdown (ADR 0056, OME-1634)

    #[test]
    fn a_countdown_play_from_paused_starts_3s_after_the_press() {
        let yt = embed_of(URL);
        let paused = PlaybackState {
            playing: false,
            position: pos(42.0),
            ..loaded(3)
        };
        let next = apply_control(Some(&paused), Some(&yt), &countdown(URL, true, 42.0), &bob(), T0 + 60_000).unwrap();
        assert_eq!(
            json(&next),
            r#"{"playing":true,"position":42,"rate":1,"at":1700000060000,"rev":4,"action":"play","by":"22222222-2222-4222-8222-222222222222","startAt":1700000063000}"#
        );
    }

    #[test]
    fn countdown_is_ignored_on_a_pause_a_seek_and_a_live_embed() {
        let yt = embed_of(URL);
        let pause = apply_control(Some(&loaded(0)), Some(&yt), &countdown(URL, false, 10.0), &alice(), T0 + 10_000).unwrap();
        assert_eq!((pause.action, pause.start_at), (PlaybackAction::Pause, None));
        let seek = apply_control(Some(&loaded(0)), Some(&yt), &countdown(URL, true, 300.0), &alice(), T0 + 10_000).unwrap();
        assert_eq!((seek.action, seek.start_at), (PlaybackAction::Seek, None));
        let live = embed_of("https://www.twitch.tv/somechannel");
        let paused = PlaybackState {
            playing: false,
            ..loaded(0)
        };
        let play = apply_control(Some(&paused), Some(&live), &countdown(live.url(), true, 0.0), &alice(), T0).unwrap();
        assert_eq!((play.action, play.start_at), (PlaybackAction::Play, None));
    }

    #[test]
    fn the_clock_holds_at_the_position_until_start_at_then_runs_from_there() {
        let yt = embed_of(URL);
        let paused = PlaybackState {
            playing: false,
            position: pos(42.0),
            ..loaded(0)
        };
        let next = apply_control(Some(&paused), Some(&yt), &countdown(URL, true, 42.0), &alice(), T0).unwrap();
        assert_eq!(expected_position(&next, T0 + 2_999), 42.0);
        assert_eq!(expected_position(&next, T0 + 3_000), 42.0);
        assert_eq!(expected_position(&next, T0 + 5_500), 44.5);
    }

    #[test]
    fn a_pause_during_the_countdown_is_a_pause_at_the_held_position_and_cancels_it() {
        let yt = embed_of(URL);
        let paused = PlaybackState {
            playing: false,
            position: pos(42.0),
            ..loaded(0)
        };
        let counting = apply_control(Some(&paused), Some(&yt), &countdown(URL, true, 42.0), &alice(), T0).unwrap();
        let cancelled = apply_control(Some(&counting), Some(&yt), &ctl(URL, false, 42.0), &bob(), T0 + 2_000).unwrap();
        assert_eq!(
            (cancelled.action, cancelled.playing, cancelled.start_at),
            (PlaybackAction::Pause, false, None)
        );
    }
}

#[cfg(test)]
mod debug_tests {
    use super::*;

    // ADR 0032 "name hashes only": the video a member controls is not printed by `{:?}`.
    #[test]
    fn a_controls_debug_has_no_url() {
        let control = Control {
            url: "https://www.youtube.com/embed/dQw4w9WgXcQ",
            playing: true,
            position: 12.5,
            countdown: false,
        };
        let text = format!("{control:?}");
        assert!(text.contains("Control") && text.contains("12.5") && text.contains("true"), "{text}");
        assert!(!text.contains("youtube") && !text.contains("dQw4w9WgXcQ"), "{text}");
    }
}
