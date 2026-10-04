// FORTFALL — game shell: input, camera framing, effects, progression, HUD.

import { LEVELS } from './levels.js';
import { createSim, SLING, solveAim } from './sim.js';
import { Renderer } from './render.js';
import { Particles } from './particles.js';
import { Sfx } from './audio.js';

const SAVE_KEY = 'fortfall.save.v1';
const STEP = 1 / 60;

const $ = (id) => document.getElementById(id);

class Game {
  constructor() {
    this.canvas = $('game');
    this.renderer = new Renderer(this.canvas);
    this.particles = new Particles();
    this.sfx = new Sfx();

    this.levelIndex = 0;
    this.sim = null;
    this.phase = 'title';           // title | playing | result
    this.shake = 0;
    this.acc = 0;
    this.last = performance.now();
    this.drag = null;
    this.aim = { angle: 32, power: 1 };   // keyboard aim state
    this.preview = [];
    this.resultShown = false;
    this.hintTimer = 0;
    this.save = loadSave();

    this.bindUI();
    this.bindInput();
    window.addEventListener('resize', () => this.renderer.resize());
    this.showScreen('title');
    this.loop = this.loop.bind(this);
    requestAnimationFrame(this.loop);
  }

  // ---- progression --------------------------------------------------------

  starsFor(level, score) {
    const [, two, three] = level.stars;
    if (score >= three) return 3;
    if (score >= two) return 2;
    return 1;
  }

  recordScore() {
    const level = LEVELS[this.levelIndex];
    const score = this.sim.score;
    const stars = this.starsFor(level, score);
    const s = this.save;
    s.stars[level.id] = Math.max(s.stars[level.id] ?? 0, stars);
    s.best[level.id] = Math.max(s.best[level.id] ?? 0, score);
    writeSave(s);
    return { stars, best: s.best[level.id] };
  }

  // ---- level lifecycle ----------------------------------------------------

  startLevel(index) {
    this.levelIndex = Math.max(0, Math.min(LEVELS.length - 1, index));
    this.level = LEVELS[this.levelIndex];
    this.sim = createSim(this.level);
    this.sim.drainEvents();
    this.particles.clear();
    this.shake = 0;
    this.resultShown = false;
    this.phase = 'playing';
    this.preview = [];
    this.drag = null;
    this.hintTimer = 9;
    this.renderer.frame(this.level, 'overview');
    this.renderer.camera.snap();
    this.aim = { angle: this.level.id % 2 ? 34 : 28, power: 1 };
    this.showScreen(null);
    this.updateHud(true);
    this.setHint(this.level.hint);
  }

  restart() {
    this.startLevel(this.levelIndex);
  }

  nextLevel() {
    if (this.levelIndex + 1 < LEVELS.length) this.startLevel(this.levelIndex + 1);
    else this.showScreen('levels');
  }

  // ---- input --------------------------------------------------------------

  bindInput() {
    const c = this.canvas;
    c.addEventListener('pointerdown', (e) => this.onDown(e));
    c.addEventListener('pointermove', (e) => this.onMove(e));
    c.addEventListener('pointerup', (e) => this.onUp(e));
    c.addEventListener('pointercancel', () => this.cancelDrag());
    c.addEventListener('contextmenu', (e) => e.preventDefault());

    window.addEventListener('keydown', (e) => this.onKey(e));
  }

  pointerWorld(e) {
    const r = this.canvas.getBoundingClientRect();
    return this.renderer.camera.screenToWorld(e.clientX - r.left, e.clientY - r.top);
  }

  onDown(e) {
    this.sfx.resume();
    if (this.phase !== 'playing') return;
    const sim = this.sim;
    const w = this.pointerWorld(e);
    if (sim.phase === 'fly') {
      // tap in flight fires the loaded shot's ability
      sim.triggerAbility();
      return;
    }
    if (sim.phase !== 'aim') return;
    this.canvas.setPointerCapture?.(e.pointerId);
    const pouch = sim.activeBody ? sim.activeBody.position : { x: SLING.x, y: SLING.y };
    const d = Math.hypot(w.x - pouch.x, w.y - pouch.y);
    // near the pouch: grab it. anywhere else: pull back relative to the press.
    this.drag = d < 150 / this.renderer.camera.zoom
      ? { mode: 'absolute', ox: 0, oy: 0, sx: w.x, sy: w.y }
      : { mode: 'relative', ox: pouch.x - w.x, oy: pouch.y - w.y, sx: w.x, sy: w.y };
    this.applyDrag(w);
  }

  onMove(e) {
    if (this.phase !== 'playing' || !this.drag || this.sim.phase !== 'aim') return;
    this.applyDrag(this.pointerWorld(e));
  }

  applyDrag(w) {
    const sim = this.sim;
    const target = this.drag.mode === 'absolute'
      ? { x: w.x, y: w.y }
      : { x: w.x + this.drag.ox, y: w.y + this.drag.oy };
    const dx = target.x - SLING.x;
    const dy = target.y - SLING.y;
    // only allow pulling "back" (behind the post) and only a sensible amount
    const clampedX = Math.min(dx, 8);
    const before = { ...sim.dragging };
    sim.aim(clampedX, dy);
    const moved = Math.hypot(sim.dragging.x - before.x, sim.dragging.y - before.y);
    if (moved > 6) this.sfx.stretch();
    this.preview = sim.predictShot();
    this.updateHud();
  }

  onUp() {
    if (!this.drag || this.phase !== 'playing') return;
    const sim = this.sim;
    this.drag = null;
    if (sim.phase !== 'aim') return;
    const v = sim.aimVector();
    if (!v) {
      sim.aim(0, 0);          // too small a pull: put it back on the pouch
      this.preview = [];
      return;
    }
    sim.launch();
    this.preview = [];
    this.hintTimer = 0;
  }

  cancelDrag() {
    if (this.drag && this.sim?.phase === 'aim') this.sim.aim(0, 0);
    this.drag = null;
    this.preview = [];
  }

  onKey(e) {
    this.sfx.resume();
    if (e.key === 'm') { this.toggleMute(); return; }
    if (e.key === 'Escape') { this.showScreen('levels'); return; }
    if (e.key === 'r' && this.sim) { this.restart(); return; }
    if (e.key === 'n' && this.sim) { this.nextLevel(); return; }
    if (this.phase !== 'playing') return;
    const sim = this.sim;
    if (sim.phase === 'fly') {
      if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); sim.triggerAbility(); }
      return;
    }
    const stepA = e.shiftKey ? 5 : 1;
    if (e.key === 'ArrowLeft') { this.aim.angle = Math.min(70, this.aim.angle + stepA); }
    else if (e.key === 'ArrowRight') { this.aim.angle = Math.max(1, this.aim.angle - stepA); }
    else if (e.key === 'ArrowUp') { this.aim.power = Math.min(1, this.aim.power + 0.05); }
    else if (e.key === 'ArrowDown') { this.aim.power = Math.max(0.4, this.aim.power - 0.05); }
    else if (e.key === ' ' || e.key === 'Enter') { this.launchKeyboard(); }
    else return;
    e.preventDefault();
    if (sim.phase === 'aim') {
      const a = solveAim(this.aim.angle, this.aim.power);
      sim.aim(a.dragX, a.dragY);
      this.preview = sim.predictShot();
      this.updateHud();
    }
  }

  launchKeyboard() {
    const sim = this.sim;
    if (sim.phase !== 'aim') return;
    const v = sim.aimVector();
    if (!v) { this.setHint('Pull the pouch back first, then release to fire.'); return; }
    sim.launch();
    this.preview = [];
    this.hintTimer = 0;
  }

  toggleMute() {
    this.save.muted = !this.save.muted;
    writeSave(this.save);
    this.sfx.setMuted(this.save.muted);
    $('btn-mute').textContent = this.save.muted ? '🔇' : '🔊';
  }

  // ---- events → effects ---------------------------------------------------

  handleEvent(ev) {
    const P = this.particles;
    switch (ev.type) {
      case 'launch':
        this.sfx.launch(ev.power);
        P.burst('dust', ev.x, ev.y, 8, { dir: -0.6, spread: 1.4, speedScale: 0.7 });
        break;
      case 'impact': {
        const mat = ev.ma ?? ev.mb;
        const power = ev.power;
        this.sfx.impact(power, mat);
        if (power > 2.2) {
          const kind = mat === 'ice' ? 'ice' : mat === 'stone' ? 'stone' : ev.a === 'ground' || ev.b === 'ground' ? 'dust' : 'wood';
          P.burst(kind, ev.x, ev.y, Math.min(10, 2 + power * 0.6), { dir: -Math.PI / 2, spread: 2.2, speedScale: 0.5 + power / 10 });
        }
        if (power > 9) this.shake = Math.min(1, this.shake + power / 40);
        break;
      }
      case 'destroy': {
        const kind = ev.material === 'ice' ? 'ice' : ev.material === 'stone' ? 'stone' : ev.material === 'tnt' ? 'tnt' : 'wood';
        P.burst(kind, ev.x, ev.y, ev.material === 'ice' ? 20 : 16, { spread: Math.PI * 2, speedScale: 1.1 });
        P.burst('smoke', ev.x, ev.y, ev.material === 'stone' ? 8 : 4, { spread: Math.PI * 2 });
        this.sfx.shatter(ev.material);
        P.score(ev.x, ev.y - 18, `+${ev.points}`);
        this.shake = Math.min(1, this.shake + 0.25);
        break;
      }
      case 'creatureDead':
        P.burst('dust', ev.x, ev.y, 18, { spread: Math.PI * 2, speedScale: 1.2 });
        P.burst('smoke', ev.x, ev.y, 6, { spread: Math.PI * 2 });
        P.score(ev.x, ev.y - 26, `+${ev.points}`, '#ffd76a');
        this.sfx.pop();
        this.shake = Math.min(1, this.shake + 0.3);
        break;
      case 'explode':
        P.burst('blast', ev.x, ev.y, 16, { spread: Math.PI * 2, speedScale: 1.4 });
        P.burst('smoke', ev.x, ev.y, 14, { spread: Math.PI * 2, gravityScale: -0.2 });
        P.burst('spark', ev.x, ev.y, 16, { spread: Math.PI * 2, speedScale: 1.6 });
        this.sfx.explode();
        this.shake = 1;
        break;
      case 'split':
        P.burst('spark', ev.x, ev.y, 10, { spread: Math.PI * 2 });
        this.sfx.split();
        break;
      case 'win':
        this.sfx.win();
        this.onResult(true);
        break;
      case 'lost':
        this.sfx.lose();
        this.onResult(false);
        break;
      default:
        break;
    }
  }

  onResult(won) {
    if (this.resultShown) return;
    this.resultShown = true;
    const level = this.level;
    const sim = this.sim;
    let stars = 0;
    if (won) {
      const rec = this.recordScore();
      stars = rec.stars;
    }
    setTimeout(() => {
      this.phase = 'result';
      this.showResult(won, stars, sim.score);
    }, won ? 900 : 700);
  }

  // ---- HUD / screens ------------------------------------------------------

  bindUI() {
    $('btn-restart').addEventListener('click', () => this.restart());
    $('btn-mute').addEventListener('click', () => this.toggleMute());
    $('btn-back').addEventListener('click', () => this.showScreen('levels'));
    $('btn-play').addEventListener('click', () => this.startLevel(this.save.lastLevel ?? 0));
    $('btn-levels').addEventListener('click', () => this.showScreen('levels'));
    $('btn-help').addEventListener('click', () => this.showScreen('help'));
    $('btn-help-back').addEventListener('click', () => this.showScreen('title'));
    $('btn-retry').addEventListener('click', () => this.restart());
    $('btn-next').addEventListener('click', () => this.nextLevel());
    $('btn-menu').addEventListener('click', () => this.showScreen('levels'));
    $('btn-title').addEventListener('click', () => this.showScreen('levels'));
    this.buildLevelGrid();
    $('btn-mute').textContent = this.save.muted ? '🔇' : '🔊';
    this.sfx.setMuted(!!this.save.muted);
  }

  buildLevelGrid() {
    const grid = $('level-grid');
    grid.innerHTML = '';
    LEVELS.forEach((level, i) => {
      const stars = this.save.stars[level.id] ?? 0;
      const best = this.save.best[level.id] ?? 0;
      const card = document.createElement('button');
      card.className = 'level-card';
      card.innerHTML = `
        <span class="level-no">${i + 1}</span>
        <span class="level-title">${level.name}</span>
        <span class="level-stars">${'★'.repeat(stars)}${'☆'.repeat(3 - stars)}</span>
        <span class="level-best">${best ? best.toLocaleString() : '—'}</span>`;
      card.addEventListener('click', () => { this.sfx.resume(); this.sfx.click(); this.startLevel(i); });
      grid.appendChild(card);
    });
  }

  showScreen(name) {
    for (const el of document.querySelectorAll('.screen')) el.classList.remove('shown');
    document.body.dataset.screen = name ?? 'playing';
    if (name) {
      $(`screen-${name}`)?.classList.add('shown');
      if (name === 'levels') this.buildLevelGrid();
      if (name !== 'playing') this.phase = name === 'title' ? 'title' : this.phase;
    }
  }

  showResult(won, stars, score) {
    $('result-title').textContent = won ? 'Fort Toppled!' : 'Out of Ammo';
    $('result-sub').textContent = won
      ? `${this.level.name} cleared`
      : `${this.sim.aliveCreatures} of ${this.level.creatures.length} still standing`;
    $('result-stars').innerHTML = won
      ? [0, 1, 2].map((i) => `<span class="${i < stars ? 'on' : ''}">★</span>`).join('')
      : '';
    $('result-score').textContent = won ? `${score.toLocaleString()}` : '—';
    $('result-best').textContent = `${(this.save.best[this.level.id] ?? score).toLocaleString()}`;
    const nextBtn = $('btn-next');
    nextBtn.disabled = this.levelIndex + 1 >= LEVELS.length;
    $('screen-result').classList.add('shown');
    this.phase = 'result';
  }

  setHint(text) {
    const el = $('hint');
    el.textContent = text ?? '';
    el.classList.toggle('shown', !!text);
  }

  updateHud(force = false) {
    const sim = this.sim;
    if (!sim) return;
    const hud = (this._hud ??= {});
    const title = `${this.levelIndex + 1}. ${this.level.name}`;
    if (force || hud.title !== title) {
      $('level-name').textContent = title;
      hud.title = title;
    }
    if (force || hud.score !== sim.score) {
      $('score').textContent = sim.score.toLocaleString();
      hud.score = sim.score;
    }
    const dead = sim.creatureTotal - sim.aliveCreatures;
    if (force || hud.dead !== dead) {
      $('baddies').innerHTML = Array.from({ length: sim.creatureTotal }, (_, i) =>
        `<span class="pip ${i < dead ? 'dead' : ''}"></span>`).join('');
      hud.dead = dead;
    }
    const spentKey = `${sim.ammoIndex}/${sim.phase}`;
    if (force || hud.ammo !== spentKey) {
      const bar = $('ammo-bar');
      bar.innerHTML = '';
      this.level.ammo.forEach((key, i) => {
        const el = document.createElement('span');
        el.className = 'ammo';
        if (i < sim.ammoIndex) el.classList.add('spent');
        else if (i === sim.ammoIndex && sim.phase !== 'won' && sim.phase !== 'lost') el.classList.add('current');
        el.dataset.kind = key;
        el.title = key;
        el.textContent = { stone: '●', bomb: '✸', splitter: '❋', boulder: '⬤' }[key] ?? '●';
        bar.appendChild(el);
      });
      hud.ammo = spentKey;
    }
    const v = sim.aimVector();
    const meta = sim.phase === 'aim'
      ? (v ? `${Math.round(v.power * 100)}% power` : 'pull back to aim')
      : sim.phase === 'fly' && sim.abilityReady ? 'tap to trigger ability' : '';
    if (force || hud.meta !== meta) {
      $('aim-meta').textContent = meta;
      hud.meta = meta;
    }
  }

  // ---- loop ---------------------------------------------------------------

  loop(now) {
    const dtMs = Math.min(50, now - this.last);
    this.last = now;
    this.acc += dtMs / 1000;

    if (this.phase === 'playing' || this.phase === 'result') {
      let steps = 0;
      while (this.acc >= STEP && steps < 5) {
        this.acc -= STEP;
        steps++;
        this.sim.step(STEP);
        for (const ev of this.sim.drainEvents()) this.handleEvent(ev);
        this.particles.update();
        this.shake *= 0.9;
        if (this.hintTimer > 0) {
          this.hintTimer -= STEP;
          if (this.hintTimer <= 0) this.setHint('');
        }
      }
      this.updateHud();
    }

    this.frame();
    requestAnimationFrame(this.loop);
  }

  frame() {
    const sim = this.sim;
    if (!sim) {
      // idle background on the title screen
      this.renderer.draw(this.renderer.ctx, { level: LEVELS[0], sim: createSimOnce, particles: this.particles, shake: 0 });
      return;
    }
    const flying = sim.phase === 'fly' && sim.activeBody;
    const focus = flying ? sim.activeBody.position : null;
    this.renderer.frame(this.level, flying ? 'follow' : 'overview', focus);
    this.renderer.draw(this.renderer.ctx, {
      level: this.level,
      sim,
      particles: this.particles,
      shake: this.shake,
      effect: { preview: this.preview, previewPower: sim.aimVector()?.power ?? 0 },
    });
  }
}

// ---------------------------------------------------------------------------
// save file
// ---------------------------------------------------------------------------

function loadSave() {
  const base = { stars: {}, best: {}, muted: false, lastLevel: 0 };
  try {
    const raw = localStorage.getItem(SAVE_KEY);
    return raw ? { ...base, ...JSON.parse(raw) } : base;
  } catch {
    return base;
  }
}

function writeSave(save) {
  try { localStorage.setItem(SAVE_KEY, JSON.stringify(save)); } catch { /* private mode */ }
}

// ---------------------------------------------------------------------------

let createSimOnce = null;
function boot() {
  createSimOnce = createSim(LEVELS[0]);
  window.game = new Game();
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
else boot();
