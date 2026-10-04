#!/usr/bin/env node
// Play a stored solution line and narrate every simulation event.
//   node tools/trace.mjs <levelIndex> [--report tools/level-report.json]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LEVELS } from '../src/levels.js';
import { createSim, SLING } from '../src/sim.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const idx = Number(process.argv[2] ?? 0);
const reportPath = path.join(HERE, 'level-report.json');
const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
const entry = report.results.find((r) => r.id === idx);
const level = LEVELS[idx];
const sim = createSim(level);
sim.drainEvents();
console.log(`# level ${idx} "${level.name}" — replaying: ${entry.line.map((a) => a.label).join(' / ')}`);

for (let shot = 0; shot < entry.line.length && sim.phase === 'aim'; shot++) {
  const action = entry.line[shot];
  const len = Math.max(SLING.minStretch, Math.min(SLING.maxStretch, SLING.maxStretch * action.power));
  const rad = (action.angle * Math.PI) / 180;
  sim.aim(-Math.cos(rad) * len, Math.sin(rad) * len);
  sim.launch();
  console.log(`\n--- shot ${shot + 1}: ${action.label} ---`);
  let contact = false;
  let steps = 0;
  while (sim.phase === 'fly' && steps < 900) {
    sim.step();
    steps++;
    const evs = sim.drainEvents();
    for (const e of evs) {
      if (e.type === 'impact' && sim.activeBody && e.ids?.includes(sim.activeBody.id)) contact = true;
      if (e.type === 'impact') continue; // too noisy
      if (e.type === 'creatureDead') console.log(`  step ${steps}: creature KILLED (${e.cause}) at (${e.x.toFixed(0)},${e.y.toFixed(0)})`);
      else if (e.type === 'destroy') console.log(`  step ${steps}: ${e.material} destroyed at (${e.x.toFixed(0)},${e.y.toFixed(0)}) +${e.points}`);
      else if (e.type === 'explode') console.log(`  step ${steps}: ${e.source} BLAST r=${e.radius} at (${e.x.toFixed(0)},${e.y.toFixed(0)})`);
      else if (e.type === 'split') console.log(`  step ${steps}: split at (${e.x.toFixed(0)},${e.y.toFixed(0)})`);
      else if (e.type === 'launch') console.log(`  step ${steps}: launched power ${(e.power * 100).toFixed(0)}%`);
      else if (e.type === 'win' || e.type === 'lost') console.log(`  step ${steps}: ${e.type.toUpperCase()} score ${e.score}`);
    }
    if (sim.abilityReady) {
      if (action.splitAtX && sim.activeBody.position.x >= action.splitAtX) sim.triggerAbility();
      else if (action.detonate && contact) sim.triggerAbility();
    }
  }
}
console.log(`\nfinal: phase=${sim.phase} score=${sim.score} kills=${sim.killCount} destroyed=${sim.destroyedCount}/${level.blocks.length}`);
