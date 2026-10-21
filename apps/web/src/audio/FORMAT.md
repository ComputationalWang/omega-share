# `assets/sound/recipes.json` (OME-1638 engine, OME-1642 palette)

Every sound is synthesized with WebAudio from data. No audio files.

```json
{
  "version": 1,
  "sounds": {
    "step.wood": { "gain": 0.5, "layers": [
      { "noise": "white", "filter": { "type": "bandpass", "freq": 900, "q": 2 }, "env": { "a": 0.002, "d": 0.05 } },
      { "osc": "sine", "freq": 140, "to": 90, "env": { "a": 0.002, "d": 0.07 }, "gain": 0.6 }
    ] },
    "tone.night": { "gain": 0.08, "loop": true, "layers": [
      { "noise": "pink", "filter": { "type": "lowpass", "freq": 400 }, "env": { "a": 1.5 } }
    ] }
  }
}
```

- `gain` (0..1): the sound's mixed level, before the user's volume. A layer's own `gain` (default 1) multiplies it.
- A layer is either an oscillator (`osc`: `sine` | `triangle` | `square` | `sawtooth`, `freq` in Hz, optional `to`: the
  frequency it glides to, exponentially, by the end of the envelope) or noise (`noise`: `white` | `pink` | `brown`).
- `filter` (optional): a `BiquadFilterNode`, `type` `lowpass` | `highpass` | `bandpass`, `freq` Hz, `q` (default 1).
- `env`, all seconds: `a` attack (to the peak), `d` decay (down to `s`, default 0), `s` sustain level 0..1, `r` release
  after `hold` (default 0) at the sustain level. A one-shot ends at `a + d + hold + r`. `delay` starts a layer later.
- `loop: true` (room tones only): layers attack and hold at `s` (default 1) until the engine stops it, then release.

Names the engine plays: `step.wood`, `step.carpet`, `step.tile`, `chair.sit`, `chair.stand`, `door`, `ui.tick`,
`ui.toggle`, `ui.error`, `pop`, `tone.warm`, `tone.cool`, `tone.night` (no tone for mood `none`), `swell`. A missing name
is silent. Unknown fields are rejected, so a typo shows up in the engine's test, not as silence.
