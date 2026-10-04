import { LEVELS } from '../src/levels.js';
import { createSim, SLING } from '../src/sim.js';

for (const idx of [0, 5, 11]) {
  const level = LEVELS[idx];
  const t0 = performance.now();
  const N = 10;
  for (let k = 0; k < N; k++) {
    const sim = createSim(level);
    const len = SLING.maxStretch;
    sim.aim(-Math.cos(0.6) * len, Math.sin(0.6) * len);
    sim.launch();
    for (let i = 0; i < 300 && sim.phase === 'fly'; i++) sim.step();
  }
  const dt = (performance.now() - t0) / N;
  console.log(`level ${idx}: bodies=${level.blocks.length + level.creatures.length} -> ${dt.toFixed(1)} ms / 300-step sim (~${(1000 / dt).toFixed(0)} sims/sec)`);
}
