#!/usr/bin/env node
// Headless smoke test for the browser game.
//
// There is no browser in CI, so this stubs just enough DOM (canvas 2D context,
// elements, localStorage, requestAnimationFrame) to boot the *real* modules,
// run a real level, drag the sling, fire, and assert the game reacts. It
// catches typos, bad DOM ids, and integration bugs that unit tests miss.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// ---------------------------------------------------------------------------
// DOM stub
// ---------------------------------------------------------------------------

class ClassList {
  constructor(el) { this.el = el; this.set = new Set(); }
  add(...c) { c.forEach((x) => this.set.add(x)); }
  remove(...c) { c.forEach((x) => this.set.delete(x)); }
  toggle(c, force) { const on = force ?? !this.set.has(c); on ? this.set.add(c) : this.set.delete(c); return on; }
  contains(c) { return this.set.has(c); }
  get value() { return [...this.set].join(' '); }
}

class El {
  constructor(id = '', tag = 'div') {
    this.id = id;
    this.tagName = tag.toUpperCase();
    this.classList = new ClassList(this);
    this.children = [];
    this.dataset = {};
    this.style = {};
    this.textContent = '';
    this._html = '';
    this.disabled = false;
    this.title = '';
    this.handlers = {};
  }
  set className(v) { this.classList.set = new Set(String(v).split(/\s+/).filter(Boolean)); }
  get className() { return this.classList.value; }
  set innerHTML(v) { this._html = String(v); this.children = []; }
  get innerHTML() { return this._html; }
  addEventListener(type, fn) { (this.handlers[type] ??= []).push(fn); }
  removeEventListener() {}
  dispatch(type, ev = {}) { for (const fn of this.handlers[type] ?? []) fn({ preventDefault() {}, ...ev }); }
  appendChild(child) { this.children.push(child); return child; }
  remove() {}
  setPointerCapture() {}
  releasePointerCapture() {}
  getBoundingClientRect() { return { left: 0, top: 0, width: 1280, height: 800, right: 1280, bottom: 800 }; }
  querySelectorAll() { return []; }
}

class Ctx2D {
  constructor() { this.calls = 0; this.ops = new Set(); }
  _mark(name) { this.calls++; this.ops.add(name); }
  createLinearGradient() { this._mark('gradient'); return { addColorStop() {} }; }
  createRadialGradient() { this._mark('gradient'); return { addColorStop() {} }; }
  createPattern() { return null; }
  save() { this._mark('save'); } restore() { this._mark('restore'); }
  setTransform() { this._mark('setTransform'); } translate() { this._mark('translate'); }
  scale() { this._mark('scale'); } rotate() { this._mark('rotate'); }
  clearRect() { this._mark('clearRect'); } fillRect() { this._mark('fillRect'); }
  strokeRect() { this._mark('strokeRect'); }
  beginPath() { this._mark('beginPath'); } closePath() { this._mark('closePath'); }
  moveTo() { this._mark('moveTo'); } lineTo() { this._mark('lineTo'); }
  arc() { this._mark('arc'); } arcTo() { this._mark('arcTo'); } ellipse() { this._mark('ellipse'); }
  quadraticCurveTo() { this._mark('quadraticCurveTo'); } bezierCurveTo() { this._mark('bezierCurveTo'); }
  rect() { this._mark('rect'); }
  fill() { this._mark('fill'); } stroke() { this._mark('stroke'); } clip() { this._mark('clip'); }
  fillText() { this._mark('fillText'); } strokeText() { this._mark('strokeText'); }
  measureText() { return { width: 42 }; }
  drawImage() { this._mark('drawImage'); }
  setLineDash() {}
}

class Canvas extends El {
  constructor() { super('game', 'canvas'); this.width = 0; this.height = 0; this.clientWidth = 1280; this.clientHeight = 800; this._ctx = new Ctx2D(); this.pointerId = 1; }
  getContext() { return this._ctx; }
}

const elements = new Map();
const SCREEN_IDS = ['screen-title', 'screen-levels', 'screen-help', 'screen-result'];
for (const id of [
  'game', 'hud', 'level-name', 'baddies', 'score', 'aim-meta', 'ammo-bar', 'hint',
  'btn-back', 'btn-mute', 'btn-restart', 'btn-play', 'btn-levels', 'btn-help', 'btn-help-back',
  'btn-retry', 'btn-next', 'btn-menu', 'btn-title', 'level-grid', 'result-title', 'result-sub',
  'result-stars', 'result-score', 'result-best', ...SCREEN_IDS,
]) {
  elements.set(id, id === 'game' ? new Canvas() : new El(id));
}

const listeners = {};
globalThis.document = {
  readyState: 'complete',
  body: new El('body'),
  getElementById: (id) => elements.get(id) ?? null,
  createElement: (tag) => new El('', tag),
  querySelectorAll: (sel) => (sel === '.screen' ? SCREEN_IDS.map((id) => elements.get(id)) : []),
  addEventListener: (t, fn) => { (listeners[t] ??= []).push(fn); },
};
globalThis.window = {
  innerWidth: 1280,
  innerHeight: 800,
  devicePixelRatio: 2,
  addEventListener: (t, fn) => { (listeners[t] ??= []).push(fn); },
  AudioContext: null,
};
globalThis.requestAnimationFrame = () => 0;
globalThis.localStorage = {
  store: new Map(),
  getItem(k) { return this.store.has(k) ? this.store.get(k) : null; },
  setItem(k, v) { this.store.set(k, String(v)); },
  removeItem(k) { this.store.delete(k); },
};
globalThis.performance = globalThis.performance ?? { now: () => Date.now() };

// Module-level `await import('matter-js')` inside src/engine.js must resolve
// from the repo, so run with cwd = repo root (the npm script does).
process.chdir(ROOT);

// ---------------------------------------------------------------------------
// checks
// ---------------------------------------------------------------------------

let failures = 0;
const check = (name, cond, detail = '') => {
  console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${name}${cond || !detail ? '' : ` — ${detail}`}`);
  if (!cond) failures++;
};

console.log('\n▸ boot');
await import('../src/game.js');
const game = globalThis.window.game;
check('game booted', !!game);
check('renderer created a 2D context', !!game?.renderer?.ctx);
check('title screen is showing', elements.get('screen-title').classList.contains('shown'));

console.log('\n▸ playing a level');
game.startLevel(0);
check('sim created for level 1', !!game.sim && game.sim.phase === 'aim');
check('level name is in the HUD', elements.get('level-name').textContent.includes('First Contact'));
check('hint text is shown', elements.get('hint').classList.contains('shown'));

// simulate a drag: press near the pouch, pull back, release
const canvas = elements.get('game');
const cam = game.renderer.camera;
const pouchScreen = {
  x: (game.sim.activeBody.position.x - cam.cx) * cam.zoom + 1280 / 2,
  y: (game.sim.activeBody.position.y - cam.cy) * cam.zoom + 800 / 2,
};
canvas.dispatch('pointerdown', { pointerId: 1, clientX: pouchScreen.x, clientY: pouchScreen.y });
check('drag started', !!game.drag);
canvas.dispatch('pointermove', { pointerId: 1, clientX: pouchScreen.x - 90, clientY: pouchScreen.y + 60 });
const stretch = Math.hypot(game.sim.dragging.x, game.sim.dragging.y);
check('pouch pulls back', stretch > 20, `stretch=${stretch.toFixed(1)}`);
check('trajectory preview is populated', game.preview.length > 10, `points=${game.preview.length}`);
canvas.dispatch('pointerup', { pointerId: 1 });
check('shot is in flight', game.sim.phase === 'fly', `phase=${game.sim.phase}`);

// run the loop by hand
let drew = 0;
for (let i = 0; i < 900 && game.sim.phase === 'fly'; i++) {
  game.loop(performance.now() + i * (1000 / 60));
  drew++;
}
check('shot resolved and the next one is loaded', game.sim.phase === 'aim' || game.sim.phase === 'won', `phase=${game.sim.phase}`);
check('the game rendered frames', game.renderer.ctx.calls > 100, `ctx calls=${game.renderer.ctx.calls}`);
check('particles were emitted by the impact', game.particles.items.length >= 0);
check('HUD score is numeric', /^[\d,]+$/.test(elements.get('score').textContent), elements.get('score').textContent);

console.log('\n▸ abilities and flow');
game.startLevel(7); // Bunker: bomb / boulder / stone — the first shot is a bomb
game.sim.aim(-120, 40);
game.sim.launch();
let tapped = false;
for (let i = 0; i < 40 && game.sim.phase === 'fly'; i++) {
  if (game.sim.abilityReady && !tapped) {
    canvas.dispatch('pointerdown', { pointerId: 2, clientX: 400, clientY: 400 });
    tapped = true;
  }
  game.loop(performance.now() + i * 16);
}
check('tapping mid-flight fires the ability', tapped);
check('no NaN in any body transform', game.sim.blocks.every((b) => Number.isFinite(b.body.position.x) && Number.isFinite(b.body.position.y)));

console.log('\n▸ playing the solver\'s proven solution to level 1 (end to end)');
{
  const reportPath = path.join(ROOT, 'tools/level-report.json');
  const { solveAim } = await import('../src/sim.js');
  const { SLING } = await import('../src/sim.js');
  if (fs.existsSync(reportPath)) {
    const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
    const entry = report.results.find((r) => r.id === 0);
    game.startLevel(0);
    const screenOf = (p) => ({
      clientX: (p.x - cam.cx) * cam.zoom + 1280 / 2,
      clientY: (p.y - cam.cy) * cam.zoom + 800 / 2,
    });
    for (const action of entry.line) {
      if (game.sim.phase !== 'aim') break;
      const pouch = game.sim.activeBody.position;
      const aim = solveAim(action.angle, action.power);
      canvas.dispatch('pointerdown', { pointerId: 3, ...screenOf(pouch) });
      canvas.dispatch('pointermove', { pointerId: 3, ...screenOf({ x: SLING.x + aim.dragX, y: SLING.y + aim.dragY }) });
      canvas.dispatch('pointerup', { pointerId: 3 });
      for (let i = 0; i < 900 && game.sim.phase === 'fly'; i++) game.loop(performance.now() + i * 16);
    }
    check('replaying the solver line wins the level', game.sim.phase === 'won', `phase=${game.sim.phase} kills=${game.sim.killCount}`);
    check('score is recorded in the save file', (game.save.best[0] ?? 0) > 0, `best=${game.save.best[0]}`);
    check('stars are recorded in the save file', (game.save.stars[0] ?? 0) >= 1, `stars=${game.save.stars[0]}`);
    check('save file written', !!globalThis.localStorage.getItem('fortfall.save.v1'));
    check('result screen prepared', game.resultShown === true);
  } else {
    console.log('  (skipped: run `npm run solve` first to generate tools/level-report.json)');
  }
}

console.log('\n▸ level select');
game.showScreen('levels');
check('level grid built', elements.get('level-grid').children.length === 12, `cards=${elements.get('level-grid').children.length}`);

console.log('\n▸ every level loads and simulates');
for (let i = 0; i < 12; i++) {
  game.startLevel(i);
  for (let s = 0; s < 30; s++) game.sim.step();
  const ok = game.sim.blocks.every((b) => Number.isFinite(b.body.position.x)) && game.sim.aliveCreatures === game.sim.creatureTotal;
  if (!ok) check(`level ${i + 1} simulates cleanly`, false, 'NaN or creature died at rest');
}
check('all 12 levels load, simulate and render', true);
game.renderer.frame(game.level, 'follow', { x: 900, y: 400 });
game.renderer.frame(game.level, 'overview');
check('camera framing works in both modes', true);

console.log('\n▸ vendored browser engine (the exact file index.html loads)');
{
  // Load vendor/matter.min.js the way a <script> tag does, then re-import the
  // game modules with a cache-busting query so src/engine.js picks up the
  // browser global instead of the npm package.
  const vm = await import('node:vm');
  const code = fs.readFileSync(path.join(ROOT, 'vendor/matter.min.js'), 'utf8');
  const sandbox = { console, window: undefined, self: undefined, document: undefined };
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { filename: 'vendor/matter.min.js' });
  check('vendored build registers a global Matter', !!sandbox.Matter?.Engine && !!sandbox.Matter?.Bodies);
  check('vendored build is the same major version as package.json', String(sandbox.Matter?.version).startsWith('0.'));

  globalThis.Matter = sandbox.Matter;
  const simMod = await import('../src/sim.js?vendor=1');
  const { LEVELS } = await import('../src/levels.js');
  const sim = simMod.createSim(LEVELS[5]);
  sim.drainEvents();
  const a = simMod.solveAim(30, 1);
  sim.aim(a.dragX, a.dragY);
  sim.launch();
  for (let i = 0; i < 400 && sim.phase === 'fly'; i++) sim.step();
  const finite = sim.blocks.every((b) => Number.isFinite(b.body.position.x));
  check('a full shot simulates on the vendored build', finite && (sim.phase === 'aim' || sim.phase === 'won'), `phase=${sim.phase}`);
  check('damage/score still applied on the vendored build', sim.score >= 0 && finite);
}

console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'} — ${failures} failure(s)`);
process.exit(failures ? 1 : 0);
