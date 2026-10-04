#!/usr/bin/env node
// Report which authored bodies move when a level is left alone. Used while
// dialling in level geometry: a fort that collapses by itself is not a puzzle.
import { LEVELS } from '../src/levels.js';
import { createSim } from '../src/sim.js';

const idxs = process.argv[2] ? [Number(process.argv[2])] : LEVELS.map((_, i) => i);
for (const i of idxs) {
  const level = LEVELS[i];
  const sim = createSim(level);
  sim.drainEvents();
  const start = [...sim.blocks, ...sim.critters].map((b) => ({ x: b.body.position.x, y: b.body.position.y, kind: b.material ?? 'creature', info: b }));
  for (let s = 0; s < 600; s++) sim.step();
  const moves = start
    .map((s0) => ({ ...s0, d: Math.hypot(s0.info.body.position.x - s0.x, s0.info.body.position.y - s0.y), dead: s0.info.dead }))
    .filter((m) => m.d > 4 || m.dead)
    .sort((a, b) => b.d - a.d);
  console.log(`L${i} ${level.name}: ${moves.length ? '' : 'stable'}`);
  for (const m of moves.slice(0, 6)) {
    console.log(`   ${m.kind.padEnd(8)} spawn(${m.x.toFixed(0)},${m.y.toFixed(0)}) moved ${m.d.toFixed(1)}px -> (${m.info.body.position.x.toFixed(0)},${m.info.body.position.y.toFixed(0)})${m.dead ? ' DESTROYED' : ''}`);
  }
}
