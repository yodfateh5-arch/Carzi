#!/usr/bin/env node
// Headless tooling for FORTFALL.
//
//   node tools/simulate.mjs probe            physics / damage calibration report
//   node tools/simulate.mjs solve all        beam-search a solution for every level
//   node tools/simulate.mjs solve 4          ... just level 4
//   node tools/simulate.mjs verify           assert every level is winnable + report
//
// The point: no level ships without being proven beatable with its own ammo
// loadout, and star thresholds are derived from a real solution rather than
// guessed.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LEVELS, GROUND_Y, WORLD } from '../src/levels.js';
import { createSim, SLING, MATERIALS, AMMO, GRAVITY_PER_STEP, predictPath, angleToHit } from '../src/sim.js';
import Matter from '../src/engine.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CAND_ANGLES = [6, 11, 16, 21, 26, 31, 36, 41, 46, 51];
const CAND_POWERS = [0.7, 0.85, 1.0];

// ---------------------------------------------------------------------------
// shot execution
// ---------------------------------------------------------------------------

function setAimFromAction(sim, action) {
  const len = Math.max(SLING.minStretch, Math.min(SLING.maxStretch, SLING.maxStretch * action.power));
  const rad = (action.angle * Math.PI) / 180;
  // drag away from the pouch, opposite the intended launch direction
  sim.aim(-Math.cos(rad) * len, Math.sin(rad) * len);
}

/** Human-readable label for a candidate action. */
function label(action) {
  let s = `${action.angle}° @ ${Math.round(action.power * 100)}%`;
  if (action.splitAtX) s += ` split@x=${action.splitAtX}`;
  if (action.detonate) s += ' detonate-on-contact';
  return s;
}

/** Fire one action, running the ability trigger if the loadout supports one. */
function playShot(sim, action, { maxSteps = 900 } = {}) {
  const before = sim.ammoIndex;
  setAimFromAction(sim, action);
  if (!sim.launch()) return { fired: false };
  let contact = false;
  let steps = 0;
  while (sim.phase === 'fly' && steps < maxSteps) {
    sim.step();
    steps++;
    const evs = sim.drainEvents();
    for (const e of evs) {
      if (e.type === 'impact' && sim.activeBody && e.ids?.includes(sim.activeBody.id)) contact = true;
    }
    if (sim.abilityReady) {
      if (action.splitAtX && sim.activeBody.position.x >= action.splitAtX) sim.triggerAbility();
      else if (action.detonate && contact) sim.triggerAbility();
    }
  }
  if (sim.phase === 'fly') {
    // ran past the cap; force the shot to retire so the search can continue
    while (sim.phase === 'fly') sim.step();
  }
  return { fired: true, steps, advanced: sim.ammoIndex > before || sim.phase !== 'aim' };
}

/**
 * Candidate shots for the *current* state. Blunt sweep to smash up a
 * structure, plus aim-assisted angles that a player would use: the exact arc
 * that reaches each living creature (and each creature's structure).
 */
function candidatesFor(sim, level, shotIndex) {
  const type = AMMO[level.ammo[shotIndex]];
  const angles = new Set(CAND_ANGLES);
  const targets = [];
  for (const c of sim.critters) {
    if (c.dead) continue;
    targets.push({ x: c.body.position.x, y: c.body.position.y });
    // aim at the top of the structure it is sitting on, too
    targets.push({ x: c.body.position.x, y: c.body.position.y + c.r * 3 });
  }
  // also aim at the roof above every living creature: that is how a player digs
  // a bunker open (and how a solver should, too)
  for (const c of sim.critters) {
    if (c.dead) continue;
    const above = sim.blocks
      .filter((bl) => !bl.dead && bl.body.position.y < c.body.position.y
        && Math.abs(bl.body.position.x - c.body.position.x) < bl.w / 2 + c.r)
      .sort((p, q) => q.body.position.y - p.body.position.y)[0];
    if (above) {
      targets.push({ x: above.body.position.x, y: above.body.position.y + above.h / 2 });
      targets.push({ x: above.body.position.x, y: above.body.position.y });
    }
  }

  for (const t of targets) {
    // every arc that actually passes near the target, not just the closest one:
    // a trajectory that grazes a crate may be blocked, one 3° higher may not
    const near = [];
    for (let a = 1; a <= 66; a += 0.5) {
      const rad = (a * Math.PI) / 180;
      const pts = predictPath(SLING.x, SLING.y, Math.cos(rad) * SLING.maxSpeed, -Math.sin(rad) * SLING.maxSpeed, 400, 0.01);
      let d = Infinity;
      for (const p of pts) d = Math.min(d, Math.hypot(p.x - t.x, p.y - t.y));
      if (d < 26) near.push({ a, d });
    }
    near.sort((x, y) => x.d - y.d);
    for (const n of near.slice(0, 8)) angles.add(Math.round(n.a * 10) / 10);
  }
  const out = [];
  for (const angle of angles) {
    for (const power of CAND_POWERS) {
      const base = { angle, power };
      if (type.ability === 'split') {
        for (const splitAtX of [700, 850, 1000, 1150]) out.push({ ...base, splitAtX });
      } else if (type.ability === 'explode') {
        out.push({ ...base, detonate: true });
      } else {
        out.push(base);
      }
    }
  }
  return out;
}

/** Score a sim: kills dominate, then structures destroyed, then points. */
function value(sim) {
  const progress = 1 - sim.aliveCreatures / Math.max(1, sim.creatureTotal);
  return sim.killCount * 1e9 + progress * 1e8 + sim.destroyedCount * 1e5 + sim.score;
}

function playLine(level, line) {
  const sim = createSim(level);
  sim.drainEvents();
  for (const action of line) {
    if (sim.phase !== 'aim') break;
    playShot(sim, action);
  }
  return sim;
}

/**
 * Coarse signature of the *outcome* of a line. Two very different shots that
 * leave the fort in the same state are the same state as far as the search is
 * concerned, so collapsing them keeps the beam wide where it matters.
 */
function stateSignature(sim) {
  const critters = sim.critters.map((c) => (c.dead ? 'X' : Math.round(c.hp / 12))).join(',');
  const materials = sim.blocks.filter((b) => !b.dead).map((b) => b.material[0]).sort().join('');
  return `${sim.killCount}:${critters}:${materials}`;
}

// ---------------------------------------------------------------------------
// beam search
// ---------------------------------------------------------------------------

function solveLevel(level, { beam = 10, budgetMs = 90_000, log = () => {} } = {}) {
  const t0 = performance.now();
  let best = { sim: playLine(level, []), line: [], v: -Infinity };
  let bestWin = null;
  let frontier = [{ line: [], sim: best.sim }];
  const maxDepth = level.ammo.length;

  for (let depth = 0; depth < maxDepth; depth++) {
    const scored = [];
    for (const node of frontier) {
      if (performance.now() - t0 > budgetMs) break;
      const cands = candidatesFor(node.sim, level, depth); // state-dependent aims
      for (const cand of cands) {
        if (performance.now() - t0 > budgetMs) break;
        const line = [...node.line, cand];
        const sim = playLine(level, line);
        sim.drainEvents();
        const v = value(sim);
        const rec = { line, sim, v };
        scored.push(rec);
        if (sim.phase === 'won' && (!bestWin || v > bestWin.v)) bestWin = rec;
        if (v > best.v) best = { sim, line, v };
      }
      if (performance.now() - t0 > budgetMs) break;
    }
    if (!scored.length) break;

    // dedupe identical outcomes (a zero-damage shot from many angles is the same state)
    scored.sort((a, b) => b.v - a.v);
    const next = [];
    const seen = new Set();
    for (const rec of scored) {
      if (rec.sim.phase === 'lost' || rec.sim.phase === 'won') continue;
      const key = stateSignature(rec.sim);
      if (seen.has(key)) continue;
      seen.add(key);
      next.push({ line: rec.line, sim: rec.sim });
      if (next.length >= beam) break;
    }
    log(`  depth ${depth + 1}: ${scored.length} candidates, best value ${scored[0].v.toFixed(0)}, frontier ${next.length}`);
    if (!next.length || bestWin) break;
    frontier = next;
  }

  const win = bestWin;
  const result = {
    id: level.id,
    name: level.name,
    solved: !!win,
    shots: win ? win.line.length : 0,
    score: win ? win.sim.score : best.sim.score,
    kills: win ? win.sim.killCount : best.sim.killCount,
    creatures: level.creatures.length,
    destroyed: win ? win.sim.destroyedCount : best.sim.destroyedCount,
    blocks: level.blocks.length,
    line: win ? win.line.map((a) => ({ ...a, label: label(a) })) : best.line.map((a) => ({ ...a, label: label(a) })),
    elapsedMs: Math.round(performance.now() - t0),
    bestValue: best.v,
    partial: win ? null : {
      kills: best.sim.killCount,
      score: best.sim.score,
      line: best.line.map((a) => ({ ...a, label: label(a) })),
    },
  };
  return result;
}

// ---------------------------------------------------------------------------
// probes / calibration
// ---------------------------------------------------------------------------

function probe() {
  const out = [];
  out.push(`world ${WORLD.w}x${WORLD.h}, ground y=${GROUND_Y}`);
  out.push(`gravity per 1/60 step: ${GRAVITY_PER_STEP.toFixed(4)} px/step^2`);
  out.push(`launch speed at full stretch: ${SLING.maxSpeed} px/step`);

  // 1. flat-ish trajectory landing distance
  const v = SLING.maxSpeed;
  const path = predictPath(SLING.x, SLING.y, v * Math.cos(0.45), -v * Math.sin(0.45));
  const last = path[path.length - 1];
  out.push(`45-ish° full power lands near x=${last.x.toFixed(0)} y=${last.y.toFixed(0)}`);

  // 2. single block-break calibration: fire a stone at each material at full power
  for (const mat of ['wood', 'ice', 'stone']) {
    const lvl = {
      id: 999, name: 'probe', ammo: ['stone'], stars: [0, 0, 0],
      blocks: [{ cx: 1000, cy: GROUND_Y - 75, w: 200, h: 150, material: mat, a: 0 }],
      creatures: [{ cx: 400, cy: 400, r: 1 }],
    };
    const sim = createSim(lvl);
    sim.drainEvents();
    const info = sim.blocks[0];
    playShot(sim, { angle: 30, power: 1 });
    const parts = sim.blocks.filter((b) => b.dead).length;
    out.push(`stone shot vs ${mat} wall (hp ${MATERIALS[mat].hp}): destroyed=${parts} hpLeft=${info.hp.toFixed(0)}`);
  }

  // 3. idle stability: a creature sitting on the ground must not die on its own
  const sim2 = createSim({
    id: 998, name: 'probe2', ammo: ['stone'], stars: [0, 0, 0],
    blocks: [], creatures: [{ cx: 1100, cy: GROUND_Y - 22, r: 21 }],
  });
  sim2.drainEvents();
  for (let i = 0; i < 400; i++) sim2.step();
  out.push(`creature left alone after 400 steps: alive=${sim2.aliveCreatures === 1}, hp=${sim2.critters[0].hp}`);
  return out.join('\n');
}

// ---------------------------------------------------------------------------
// cli
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) args[a.slice(2)] = argv[i + 1]?.startsWith('--') ? true : argv[++i] ?? true;
    else args._.push(a);
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
const cmd = args._[0] ?? 'probe';

if (cmd === 'probe') {
  console.log(probe());
  console.log('\nAmmo table:');
  for (const [k, v] of Object.entries(AMMO)) console.log(`  ${k.padEnd(9)} r=${v.r} density=${v.density} ability=${v.ability ?? '-'} — ${v.tagline}`);
  console.log('\nMaterial table:');
  for (const [k, v] of Object.entries(MATERIALS)) console.log(`  ${k.padEnd(6)} hp=${String(v.hp).padStart(3)} density=${v.density} points=${v.score}`);
} else if (cmd === 'solve' || cmd === 'verify') {
  const which = args._[1] ?? 'all';
  const list = which === 'all' ? LEVELS.map((_, i) => i) : [Number(which)];
  const budget = Number(args.budget ?? 120_000);
  const results = [];
  const t0 = performance.now();
  for (const i of list) {
    const level = LEVELS[i];
    process.stdout.write(`level ${i} "${level.name}" (${level.blocks.length} blocks, ${level.creatures.length} creatures, ammo ${level.ammo.join('/')})...\n`);
    const r = solveLevel(level, { budgetMs: budget, log: (m) => console.log(m) });
    results.push(r);
    console.log(`  -> ${r.solved ? `SOLVED in ${r.shots} shots, score ${r.score}` : `unsolved: killed ${r.kills}/${r.creatures}, score ${r.score}`} (${(r.elapsedMs / 1000).toFixed(1)}s)`);
  }
  console.log(`\ntotal ${((performance.now() - t0) / 1000).toFixed(1)}s`);

  if (args.out) {
    const outPath = path.isAbsolute(args.out) ? args.out : path.join(HERE, '..', args.out);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, JSON.stringify({ generatedAt: new Date().toISOString(), results }, null, 2));
    console.log(`wrote ${path.relative(path.join(HERE, '..'), outPath)}`);
  }

  const unsolved = results.filter((r) => !r.solved);
  if (cmd === 'verify' && unsolved.length) {
    console.error(`\nFAIL: ${unsolved.length} level(s) not proven winnable: ${unsolved.map((r) => r.id).join(', ')}`);
    process.exit(1);
  }
  if (cmd === 'verify') console.log('\nPASS: every level is winnable with its own ammo loadout.');
} else {
  console.error(`unknown command: ${cmd}`);
  process.exit(1);
}
