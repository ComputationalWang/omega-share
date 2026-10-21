// Placeholder recipes (OME-1638) until the Designer's palette (OME-1642) lands in assets/sound/recipes.json: a soft
// footstep per floor, a chair creak, a UI tick, a pop and a quiet night tone. Same format (FORMAT.md), parsed the same way.
export const PLACEHOLDER_RECIPES: unknown = {
  version: 1,
  sounds: {
    "step.wood": { gain: 0.22, layers: [{ noise: "brown", filter: { type: "lowpass", freq: 700 }, env: { a: 0.002, d: 0.06 } }, { osc: "sine", freq: 150, to: 90, env: { a: 0.002, d: 0.05 }, gain: 0.5 }] },
    "step.carpet": { gain: 0.16, layers: [{ noise: "pink", filter: { type: "lowpass", freq: 350 }, env: { a: 0.006, d: 0.07 } }] },
    "step.tile": { gain: 0.18, layers: [{ noise: "white", filter: { type: "bandpass", freq: 2400, q: 3 }, env: { a: 0.001, d: 0.035 } }, { osc: "triangle", freq: 900, to: 700, env: { a: 0.001, d: 0.03 }, gain: 0.3 }] },
    "chair.sit": { gain: 0.2, layers: [{ noise: "brown", filter: { type: "lowpass", freq: 500 }, env: { a: 0.01, d: 0.15 } }, { osc: "triangle", freq: 220, to: 160, env: { a: 0.02, d: 0.12 }, gain: 0.3 }] },
    "chair.stand": { gain: 0.18, layers: [{ noise: "brown", filter: { type: "lowpass", freq: 600 }, env: { a: 0.01, d: 0.1 } }, { osc: "triangle", freq: 170, to: 230, env: { a: 0.02, d: 0.1 }, gain: 0.3 }] },
    "door": { gain: 0.2, layers: [{ osc: "triangle", freq: 330, to: 250, env: { a: 0.01, d: 0.25 } }, { noise: "brown", filter: { type: "lowpass", freq: 400 }, env: { a: 0.005, d: 0.2 }, gain: 0.6 }] },
    "ui.tick": { gain: 0.12, layers: [{ osc: "sine", freq: 1400, env: { a: 0.001, d: 0.03 } }] },
    "pop": { gain: 0.16, layers: [{ osc: "sine", freq: 500, to: 1100, env: { a: 0.002, d: 0.08 } }] },
    "tone.night": { gain: 0.05, loop: true, layers: [{ noise: "brown", filter: { type: "lowpass", freq: 300 }, env: { a: 2, r: 1 } }] },
  },
};
