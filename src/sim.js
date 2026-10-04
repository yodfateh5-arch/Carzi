// Core simulation: world construction, damage rules, scoring, game phases.
//
// This module is deliberately free of any DOM/canvas/audio code so that the
// exact same rules can be exercised headlessly by tools/simulate.mjs.
//
// Units: Matter.js "pixels per 16.6ms step" for velocity, radians for angles.

import Matter from './engine.js';
import { WORLD, GROUND_Y } from './levels.js';

const { Engine, Composite, Bodies, Body, Events, Vector } = Matter;

export { WORLD, GROUND_Y };

// ---------------------------------------------------------------------------
// tuning
// ---------------------------------------------------------------------------

export const SLING = Object.freeze({
  x: 280,
  // The pouch sits ~120px above the ground: any higher and a flat shot sails
  // over ground-level targets for the first ~900px of the map (see
  // tools/tolerance.mjs), which makes close-in creatures unhittable.
  y: 700,
  maxStretch: 120,
  minStretch: 16,
  maxSpeed: 36, // px per step at full stretch (45° full power ≈ 1400px carry)
});

export const MATERIALS = Object.freeze({
  wood: {
    hp: 58, density: 0.0016, friction: 0.6, frictionStatic: 0.9, restitution: 0.04,
    score: 100, label: 'Wood', c: '#b8813f',
  },
  ice: {
    hp: 27, density: 0.0011, friction: 0.12, frictionStatic: 0.2, restitution: 0.14,
    score: 150, label: 'Ice', c: '#7fd4f0',
  },
  stone: {
    hp: 190, density: 0.0040, friction: 0.72, frictionStatic: 1.0, restitution: 0.03,
    score: 200, label: 'Stone', c: '#8f96a3',
  },
  tnt: {
    hp: 22, density: 0.0020, friction: 0.5, frictionStatic: 0.7, restitution: 0.05,
    score: 250, label: 'TNT', c: '#d9503a',
  },
});

export const AMMO = Object.freeze({
  stone: {
    r: 17, density: 0.0065, restitution: 0.16, friction: 0.5,
    label: 'Stone Shot', ability: null, tagline: 'Reliable. Heavy.',
  },
  bomb: {
    r: 18, density: 0.0060, restitution: 0.2, friction: 0.5,
    label: 'Bomb', ability: 'explode', tagline: 'Tap in flight to detonate.',
  },
  splitter: {
    r: 16, density: 0.0055, restitution: 0.22, friction: 0.45,
    label: 'Splitter', ability: 'split', tagline: 'Tap in flight to split in three.',
  },
  boulder: {
    r: 27, density: 0.0085, restitution: 0.1, friction: 0.6,
    label: 'Boulder', ability: null, tagline: 'Crushing mass.',
  },
});

// Damage model: dmg = K * sqrt(strikerMass) * vn^2, i.e. a fast hit hurts far
// more than a slow heavy one, and a shot does the same damage to a big slab as
// to a small brick. Both constants are the same — the *materials* carry the
// difference (weaker hp, and stone shots get a bonus against creatures).
const K_BLOCK = 0.05;
const K_CREATURE = 0.07;
const MIN_IMPACT = 5.0;       // below this, impacts are cosmetic only
const MIN_IMPACT_CREATURE = 7.0;
const GROUND_HIT_SCALE = 1.5;  // the ground does not budge, so landings hurt
const SOUND_IMPACT = 1.1;     // below this, no event at all
const MAX_HIT_DAMAGE = 520;   // sanity clamp per collision
const CREATURE_HP = 80;

// Circles would otherwise roll across the whole map forever (Matter has no
// rolling friction), which looks silly and kills creatures cheaply. We damp
// angular + linear velocity a little every step instead.
const ROLL_DAMP = 0.86;
const ROLL_LINEAR_DAMP = 0.994;

// sustained load needed to squash something, and how fast
const CRUSH_LOAD_TIME = 0.25;
const CRUSH_DPS = 34;

const BLAST = Object.freeze({
  radius: 180,
  damage: 250,
  impulse: 26,   // momentum; dv = impulse * falloff / mass
  maxDv: 19,
});

const TNT_BLAST = Object.freeze({
  radius: 165,
  damage: 230,
  impulse: 24,
  maxDv: 17,
});

const SETTLE_SPEED = 0.4;
const SETTLE_ANGULAR = 0.07;
const SETTLE_STEPS = 26;
const SHOT_TIMEOUT_MS = 7500;

// ---------------------------------------------------------------------------
// gravity probe: lets the renderer draw an honest trajectory preview
// ---------------------------------------------------------------------------

// One place for gravity: the sim engine and the trajectory predictor must never
// disagree (a stale probe here once made every previewed arc half as steep as
// the real shot).
export const GRAVITY_SCALE = 0.002;

let GRAVITY_PER_STEP = 0.55;
{
  const probe = Engine.create({ gravity: { x: 0, y: 1, scale: GRAVITY_SCALE } });
  const ball = Bodies.circle(0, 0, 10, { frictionAir: 0.01 });
  Composite.add(probe.world, ball);
  Engine.update(probe, 1000 / 60);
  const v1 = ball.velocity.y;
  Engine.update(probe, 1000 / 60);
  GRAVITY_PER_STEP = ball.velocity.y - v1;
  Engine.clear(probe);
}
export { GRAVITY_PER_STEP };

/**
 * Convert "launch at this angle with this much power" into the drag offset, the
 * actual launch origin (the pouch is where the shot sits, not the sling post!)
 * and the launch velocity — applying both the stretch limit and the ground
 * clamp. The renderer's trajectory preview, the hint system and the headless
 * solver all go through here so they can never disagree with the sim.
 */
export function solveAim(angleDeg, power = 1) {
  const len = Math.max(SLING.minStretch, Math.min(SLING.maxStretch, SLING.maxStretch * power));
  const rad = (angleDeg * Math.PI) / 180;
  const dx = -Math.cos(rad) * len;
  let dy = Math.sin(rad) * len;
  const dyMax = GROUND_Y - SLING.y - 24;
  if (dy > dyMax) dy = dyMax;
  const stretch = Math.hypot(dx, dy);
  const origin = { x: SLING.x + dx, y: SLING.y + dy };
  const speed = SLING.maxSpeed * (stretch / SLING.maxStretch);
  return {
    dragX: dx, dragY: dy, origin, stretch, speed,
    vx: (-dx / stretch) * speed,
    vy: (-dy / stretch) * speed,
    power: stretch / SLING.maxStretch,
  };
}

/** Ballistic preview of a launch, ignoring collisions. Returns [{x,y}...]. */
export function predictPath(x0, y0, vx, vy, steps = 46, frictionAir = 0.01) {
  const pts = [];
  let x = x0, y = y0, vxv = vx, vyv = vy;
  for (let i = 0; i < steps; i++) {
    vxv *= 1 - frictionAir;
    vyv = vyv * (1 - frictionAir) + GRAVITY_PER_STEP;
    x += vxv;
    y += vyv;
    pts.push({ x, y });
    if (y > GROUND_Y || x > WORLD.w + 200) break;
  }
  return pts;
}

/**
 * Angle (degrees) whose ballistic arc passes closest to (tx, ty) at the given
 * power. Used by the hint system and by headless tests to aim like a player.
 * Returns { angle, dist } or null when nothing comes close.
 */
export function angleToHit(tx, ty, power = 1, opts = {}) {
  const { coarseness = 0.5, maxAngle = 70 } = opts;
  let best = null;
  for (let a = 0; a <= maxAngle; a += coarseness) {
    const aim = solveAim(a, power);
    const pts = predictPath(aim.origin.x, aim.origin.y, aim.vx, aim.vy, 400, 0.01);
    for (const p of pts) {
      const d = Math.hypot(p.x - tx, p.y - ty);
      if (!best || d < best.dist) best = { angle: a, dist: d, x: p.x, y: p.y };
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// sim
// ---------------------------------------------------------------------------

export function createSim(level, opts = {}) {
  // Deterministic PRNG: the level solver replays action sequences from scratch
  // and relies on identical results every time.
  let rngState = (opts.seed ?? (0x9e3779b9 ^ ((level.id + 1) * 2654435761))) >>> 0;
  const rnd = () => {
    rngState = (rngState + 0x6d2b79f5) >>> 0;
    let t = rngState;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  const engine = Engine.create({
    // g = 0.55 px/step^2 (see GRAVITY_SCALE): with SLING.maxSpeed = 36 a
    // full-power 45° shot carries ~1400px in ~1.3s, so every structure in the
    // world is reachable with a readable arc rather than a flat bullet.
    gravity: { x: 0, y: 1, scale: GRAVITY_SCALE },
    enableSleeping: false,
  });
  engine.positionIterations = 12; // stiff stacks: keeps structures from sagging
  engine.velocityIterations = 8;
  engine.constraintIterations = 4;
  engine.timing.timeScale = 1;

  const world = engine.world;
  const events = [];
  const emit = (e) => events.push(e);

  /** id -> metadata for blocks / creatures */
  const blockInfo = new Map();
  const critterInfo = new Map();
  const allBlocks = [];
  const allCritters = [];
  const ammoBodies = [];

  let score = 0;
  let destroyed = 0;
  let kills = 0;
  let phase = 'aim';           // aim | fly | resolve | won | lost
  let ammoIndex = 0;
  let activeBody = null;       // current shot in the air
  let abilityUsed = false;
  let settledSteps = 0;
  let shotClock = 0;
  let dragging = { x: 0, y: 0 }; // aim vector, pixels offset from the pouch
  let nextId = 1;

  // ---- static scenery -----------------------------------------------------
  const ground = Bodies.rectangle(WORLD.w / 2, GROUND_Y + 60, WORLD.w + 600, 120, {
    isStatic: true, label: 'ground', friction: 0.9, restitution: 0.02,
  });
  Composite.add(world, ground);

  // ---- level population ---------------------------------------------------
  for (const def of level.blocks) {
    const mat = MATERIALS[def.material] ?? MATERIALS.wood;
    const body = Bodies.rectangle(def.cx, def.cy, def.w, def.h, {
      label: 'block',
      angle: def.a || 0,
      density: mat.density,
      friction: mat.friction,
      frictionStatic: mat.frictionStatic,
      restitution: mat.restitution,
      slop: 0.01,
    });
    const info = {
      id: nextId++, body, material: def.material, mat,
      w: def.w, h: def.h, hp: mat.hp, maxHp: mat.hp, dead: false, seed: rnd(), flash: 0,
    };
    blockInfo.set(body.id, info);
    allBlocks.push(info);
    Composite.add(world, body);
  }

  for (const def of level.creatures) {
    const body = Bodies.circle(def.cx, def.cy, def.r, {
      label: 'creature',
      density: 0.0012,
      friction: 0.55,
      frictionStatic: 0.9,
      restitution: 0.18,
      slop: 0.01,
    });
    body.plugin = { touching: false };
    const info = {
      id: nextId++, body, r: def.r, hp: CREATURE_HP, maxHp: CREATURE_HP,
      dead: false, crush: 0, flash: 0,
    };
    critterInfo.set(body.id, info);
    allCritters.push(info);
    Composite.add(world, body);
  }

  // ---- shot bookkeeping ---------------------------------------------------
  function ammoTypeAt(i) {
    const key = level.ammo[i];
    return key ? { key, ...AMMO[key] } : null;
  }

  function spawnAmmo() {
    const type = ammoTypeAt(ammoIndex);
    if (!type) { activeBody = null; return null; }
    // NOTE: create the shot *dynamic* and then freeze it. Passing
    // `isStatic: true` to the factory skips Matter's `_original` bookkeeping,
    // so `Body.setStatic(body, false)` at launch could never restore mass or
    // inertia (the shot would fly straight through the world).
    const body = Bodies.circle(SLING.x, SLING.y, type.r, {
      label: 'ammo',
      density: type.density,
      restitution: type.restitution,
      friction: type.friction,
      frictionStatic: 0.7,
      slop: 0.02,
    });
    Body.setStatic(body, true);
    body.plugin = { ammo: type, split: false };
    ammoBodies.push(body);
    Composite.add(world, body);
    activeBody = body;
    return body;
  }

  /** Offset the nocked shot inside the pouch (clamped to the stretch limit). */
  function aim(dx, dy) {
    const len = Math.hypot(dx, dy);
    const max = SLING.maxStretch;
    let x = dx, y = dy;
    if (len > max) { x = (dx / len) * max; y = (dy / len) * max; }
    // never let the nocked shot sink into the ground while aiming
    y = Math.min(y, GROUND_Y - SLING.y - 24);
    dragging = { x, y };
    if (activeBody && phase === 'aim') {
      Body.setPosition(activeBody, { x: SLING.x + x, y: SLING.y + y });
    }
    return dragging;
  }

  function aimVector() {
    const len = Math.hypot(dragging.x, dragging.y);
    if (len < SLING.minStretch) return null;
    const vx = (-dragging.x / len) * SLING.maxSpeed * (len / SLING.maxStretch);
    const vy = (-dragging.y / len) * SLING.maxSpeed * (len / SLING.maxStretch);
    return { vx, vy, power: len / SLING.maxStretch };
  }

  function launch() {
    if (phase !== 'aim' || !activeBody) return false;
    const v = aimVector();
    if (!v) return false;
    Body.setStatic(activeBody, false);
    Body.setVelocity(activeBody, { x: v.vx, y: v.vy });
    Body.setAngularVelocity(activeBody, 0.06);
    activeBody.plugin.launchedAt = 0;
    activeBody.plugin.flight = 0;
    phase = 'fly';
    abilityUsed = false;
    settledSteps = 0;
    shotClock = 0;
    emit({ type: 'launch', x: activeBody.position.x, y: activeBody.position.y, power: v.power, ammo: activeBody.plugin.ammo.key });
    return true;
  }

  /** Tap-triggered special: bombs detonate, splitters fragment. */
  function triggerAbility() {
    if (phase !== 'fly' || !activeBody || abilityUsed) return false;
    const type = activeBody.plugin.ammo;
    if (!type.ability) return false;
    if (type.ability === 'explode') {
      const p = { ...activeBody.position };
      abilityUsed = true;
      removeAmmo(activeBody);
      explode(p, BLAST, 'bomb');
      return true;
    }
    if (type.ability === 'split') {
      abilityUsed = true;
      const p = { ...activeBody.position };
      const v = { ...activeBody.velocity };
      const rot = activeBody.angle;
      removeAmmo(activeBody);
      const spread = 0.3;
      for (const da of [-spread, 0, spread]) {
        const c = Math.cos(da), s = Math.sin(da);
        const nv = { x: v.x * c - v.y * s, y: v.x * s + v.y * c };
        const child = Bodies.circle(p.x, p.y, type.r * 0.82, {
          label: 'ammo',
          density: type.density * 1.1,
          restitution: type.restitution,
          friction: type.friction,
          slop: 0.02,
          angle: rot,
        });
        child.plugin = { ammo: { ...type, ability: null }, split: true, launchedAt: 0, flight: 0 };
        ammoBodies.push(child);
        Composite.add(world, child);
        Body.setVelocity(child, nv);
        Body.setAngularVelocity(child, (rnd() - 0.5) * 0.3);
        activeBody = child; // track the middle child for settling
      }
      emit({ type: 'split', x: p.x, y: p.y });
      return true;
    }
    return false;
  }

  function removeAmmo(body) {
    const i = ammoBodies.indexOf(body);
    if (i >= 0) ammoBodies.splice(i, 1);
    Composite.remove(world, body);
    if (body.plugin) body.plugin.gone = true;
  }

  // ---- damage -------------------------------------------------------------
  function damageBlock(info, dmg, at) {
    if (info.dead) return;
    info.hp -= dmg;
    info.lastHit = at;
    info.flash = Math.min(1, info.flash + dmg / 90);
    if (info.hp <= 0) destroyBlock(info, at);
  }

  function destroyBlock(info, at) {
    if (info.dead) return;
    info.dead = true;
    destroyed++;
    score += info.mat.score;
    Composite.remove(world, info.body);
    const p = at || info.body.position;
    emit({
      type: 'destroy', x: p.x, y: p.y, material: info.material,
      w: info.w, h: info.h, angle: info.body.angle,
      points: info.mat.score, seed: info.seed,
    });
    if (info.material === 'tnt') {
      explode({ x: info.body.position.x, y: info.body.position.y }, TNT_BLAST, 'tnt');
    }
  }

  function damageCreature(info, dmg, at, cause = 'impact') {
    if (info.dead) return;
    info.hp -= dmg;
    info.flash = 1;
    if (info.hp <= 0) killCreature(info, at, cause);
  }

  function killCreature(info, at, cause) {
    if (info.dead) return;
    info.dead = true;
    kills++;
    score += 1000;
    const p = at || info.body.position;
    emit({ type: 'creatureDead', x: p.x, y: p.y, r: info.r, points: 1000, cause });
    Composite.remove(world, info.body);
  }

  function explode(p, spec, source) {
    emit({ type: 'explode', x: p.x, y: p.y, radius: spec.radius, source });
    const targets = [];
    for (const info of allBlocks) if (!info.dead) targets.push(info);
    for (const info of allCritters) if (!info.dead) targets.push(info);
    for (const b of ammoBodies) if (!b.plugin.gone) targets.push({ ammoBody: b });

    for (const t of targets) {
      const body = t.body || t.ammoBody;
      if (!body || body.isStatic) continue;
      const dx = body.position.x - p.x;
      const dy = body.position.y - p.y;
      const d = Math.hypot(dx, dy);
      if (d > spec.radius) continue;
      const falloff = Math.pow(1 - d / spec.radius, 1.25);
      const nx = d > 0.001 ? dx / d : 0;
      const ny = d > 0.001 ? dy / d - 0.35 : -1; // slight upward bias
      const nl = Math.hypot(nx, ny) || 1;
      let dv = (spec.impulse * falloff) / Math.max(0.4, body.mass);
      dv = Math.min(dv, spec.maxDv);
      Body.setVelocity(body, { x: body.velocity.x + (nx / nl) * dv, y: body.velocity.y + (ny / nl) * dv });
      Body.setAngularVelocity(body, body.angularVelocity + (rnd() - 0.5) * 0.3);
      const dmg = spec.damage * falloff;
      if (t.ammoBody) {
        // ammo survives, but gets shoved
      } else if (t.hp !== undefined && t.r !== undefined) {
        damageCreature(t, dmg * 0.9, { x: body.position.x, y: body.position.y }, 'blast');
      } else {
        damageBlock(t, dmg, { x: body.position.x, y: body.position.y });
      }
    }
    // NOTE: destroying a TNT block re-enters explode(), which is how chain
    // reactions propagate for free.
  }

  // ---- collision damage ---------------------------------------------------
  /**
   * Impact strength: how much "hurt" a contact can deliver.
   *   vn   — closing speed along the contact normal
   *   strikers — for each body, the mass of whatever hit *it*
   */
  function pairEnergy(a, b, normal) {
    const rvx = a.velocity.x - b.velocity.x;
    const rvy = a.velocity.y - b.velocity.y;
    const vn = Math.abs(rvx * normal.x + rvy * normal.y);
    return {
      vn,
      strikerForA: b.isStatic ? a.mass : b.mass,
      strikerForB: a.isStatic ? b.mass : a.mass,
    };
  }

  /** Flag bodies in contact so rolling resistance only applies on the ground. */
  function markTouching(pair) {
    if (pair.bodyA.plugin) pair.bodyA.plugin.touching = true;
    if (pair.bodyB.plugin) pair.bodyB.plugin.touching = true;
  }

  function handleCollision(pair) {
    markTouching(pair);
    const a = pair.bodyA, b = pair.bodyB;
    const normal = pair.collision ? pair.collision.normal : { x: 0, y: 1 };
    const { vn, strikerForA, strikerForB } = pairEnergy(a, b, normal);
    if (vn < SOUND_IMPACT) return;
    const hit = (strikerMass) => Math.min(K_BLOCK * Math.sqrt(Math.max(strikerMass, 0.05)) * vn * vn, MAX_HIT_DAMAGE);

    const contact = {
      x: (a.position.x + b.position.x) / 2,
      y: (a.position.y + b.position.y) / 2,
      power: vn,
      ids: [a.id, b.id],
      a: a.label, b: b.label,
      ma: blockInfo.get(a.id)?.material, mb: blockInfo.get(b.id)?.material,
    };
    emit({ type: 'impact', ...contact });

    const ia = blockInfo.get(a.id), ib = blockInfo.get(b.id);
    const ca = critterInfo.get(a.id), cb = critterInfo.get(b.id);

    if (vn >= MIN_IMPACT) {
      const da = hit(strikerForA);
      const db = hit(strikerForB);
      if (ia && !ia.dead) damageBlock(ia, da, contact);
      if (ib && !ib.dead) damageBlock(ib, db, contact);
    }

    // creatures: a firmer threshold, and terrain impacts hurt more — the ground
    // does not budge, so a bad landing is worse than a glancing plank
    const creatureHit = (info, other, striker) => {
      if (!info || info.dead || vn < MIN_IMPACT_CREATURE) return;
      const otherInfo = blockInfo.get(other.id) || critterInfo.get(other.id);
      let dmg = K_CREATURE * Math.sqrt(Math.max(striker, 0.05)) * vn * vn;
      if (other.isStatic || other.label === 'ground') dmg *= GROUND_HIT_SCALE;
      else if (otherInfo?.material === 'stone') dmg *= 1.35; // a thrown rock really hurts
      damageCreature(info, Math.min(dmg, MAX_HIT_DAMAGE), contact, other.isStatic ? 'fall' : 'hit');
    };
    creatureHit(ca, b, strikerForA);
    creatureHit(cb, a, strikerForB);
  }

  Events.on(engine, 'collisionStart', (e) => {
    for (const pair of e.pairs) handleCollision(pair);
  });

  Events.on(engine, 'collisionActive', (e) => {
    for (const pair of e.pairs) {
      markTouching(pair);
      const a = pair.bodyA, b = pair.bodyB;
      const ca = critterInfo.get(a.id);
      const cb = critterInfo.get(b.id);
      const n = pair.collision ? pair.collision.normal : null;
      if (!n) continue;
      // a creature is being crushed only when something of real mass is
      // resting *on top of* it and the contact normal is close to vertical
      const check = (info, other, isA) => {
        if (!info || info.dead) return;
        if (other.isStatic || other.mass < 3) { info.crush = 0; return; }
        const above = isA ? -n.y : n.y;
        const still = Math.hypot(other.velocity.x, other.velocity.y) < 1.6;
        if (above > 0.5 && still && other.position.y < info.body.position.y + info.r) {
          info.crush += 1 / 60;
        } else {
          info.crush = Math.max(0, info.crush - 2 / 60);
        }
        if (info.crush > CRUSH_LOAD_TIME) {
          damageCreature(info, CRUSH_DPS / 60, { ...info.body.position }, 'crush');
        }
      };
      if (ca) check(ca, b, true);
      if (cb) check(cb, a, false);
    }
  });

  // ---- stepping -----------------------------------------------------------
  function cull() {
    for (const b of [...ammoBodies]) {
      if (b.position.y > WORLD.h + 500 || b.position.x > WORLD.w + 700 || b.position.x < -700) {
        removeAmmo(b);
      }
    }
    for (const info of allCritters) {
      if (info.dead) continue;
      if (info.body.position.y > WORLD.h + 260) {
        killCreature(info, { x: info.body.position.x, y: WORLD.h - 40 }, 'fall');
      }
    }
  }

  function shotSettled() {
    if (!ammoBodies.length) return true;
    for (const b of ammoBodies) {
      const done = Math.hypot(b.velocity.x, b.velocity.y) < SETTLE_SPEED
        && Math.abs(b.angularVelocity) < SETTLE_ANGULAR;
      if (!done) return false;
    }
    return true;
  }

  function advancePhase() {
    const alive = allCritters.filter((c) => !c.dead).length;
    if (alive === 0) {
      // leftover ammo bonus
      const left = Math.max(0, level.ammo.length - ammoIndex);
      if (left > 0) score += left * 1000;
      phase = 'won';
      emit({ type: 'win', score, bonus: left * 1000 });
      return;
    }
    if (ammoIndex >= level.ammo.length) {
      phase = 'lost';
      emit({ type: 'lost', score });
      return;
    }
    phase = 'aim';
    dragging = { x: 0, y: 0 };
    spawnAmmo();
  }

  function dampCircles() {
    for (const list of [allCritters, ammoBodies]) {
      for (const item of list) {
        const body = item.body || item;
        if (body.isStatic || body.plugin?.gone) continue;
        // Rolling resistance only ever applies to a body in contact with
        // something — applying it mid-flight made shots drop short of the
        // trajectory the player was shown.
        if (!body.plugin?.touching) continue;
        if (Math.abs(body.angularVelocity) > 0.001) {
          Body.setAngularVelocity(body, body.angularVelocity * ROLL_DAMP);
        }
        const sp = Math.hypot(body.velocity.x, body.velocity.y);
        if (sp > 0.05) {
          Body.setVelocity(body, { x: body.velocity.x * ROLL_LINEAR_DAMP, y: body.velocity.y * ROLL_LINEAR_DAMP });
        }
      }
    }
  }

  function step(dt = 1 / 60) {
    for (const c of allCritters) c.body.plugin.touching = false;
    for (const b of ammoBodies) b.plugin.touching = false;
    Engine.update(engine, dt * 1000);
    dampCircles();
    cull();

    for (const info of allCritters) if (info.flash > 0) info.flash -= 0.08;
    for (const info of allBlocks) if (info.flash > 0) info.flash -= 0.12;

    if (phase === 'aim') {
      if (!activeBody) spawnAmmo();
      return;
    }
    if (phase !== 'fly') return;

    shotClock += dt * 1000;
    const ok = shotSettled();
    if (ok) settledSteps++; else settledSteps = 0;

    if (settledSteps >= SETTLE_STEPS || shotClock > SHOT_TIMEOUT_MS) {
      // retire the spent shot and move on
      if (ammoBodies.length) {
        const remaining = ammoBodies[0];
        // keep spent ammo lying around on screen, but stop tracking it
        remaining.plugin.spent = true;
        ammoBodies.length = 0;
      }
      activeBody = null;
      ammoIndex++;
      advancePhase();
    }
  }

  spawnAmmo();

  // ---- public surface -----------------------------------------------------
  const sim = {
    level, engine, world, ground,
    blocks: allBlocks, critters: allCritters, ammoBodies,
    events,
    get score() { return score; },
    get destroyedCount() { return destroyed; },
    get killCount() { return kills; },
    get phase() { return phase; },
    get ammoIndex() { return ammoIndex; },
    get ammoLeft() { return Math.max(0, level.ammo.length - ammoIndex); },
    get currentAmmo() { return activeBody && !activeBody.plugin.gone ? activeBody.plugin.ammo : null; },
    get activeBody() { return activeBody; },
    get dragging() { return dragging; },
    get abilityReady() {
      return phase === 'fly' && !abilityUsed && !!activeBody && !!activeBody.plugin.ammo.ability;
    },
    get aliveCreatures() { return allCritters.filter((c) => !c.dead).length; },
    get creatureTotal() { return allCritters.length; },
    blockInfo: (b) => blockInfo.get(b.id),
    critterInfo: (b) => critterInfo.get(b.id),
    rnd,
    aim,
    aimVector,
    launch,
    triggerAbility,
    step,
    predictPath,
    /** Dotted arc for the current drag, straight from the live shot body. */
    predictShot(steps = 52) {
      const v = aimVector();
      if (!v || !activeBody) return [];
      return predictPath(activeBody.position.x, activeBody.position.y, v.vx, v.vy, steps, activeBody.frictionAir);
    },
    drainEvents() {
      const out = events.slice();
      events.length = 0;
      return out;
    },
  };

  return sim;
}

export { SETTLE_STEPS, SHOT_TIMEOUT_MS };
