// Level definitions for FORTFALL.
//
// Coordinate space is a fixed 1600x900 "world". (0,0) is top-left, +y is down.
// The ground surface sits at y = GROUND_Y and the slingshot at x ≈ 205.
//
// Structures are authored *bottom-up* with helpers that compute centres from
// the surface a piece rests on. Hand-writing centre coordinates leads to blocks
// that float a few pixels in the air and settle (or topple) the moment the
// level loads — every piece here is placed exactly.
//
// Everything in this file is pure data, so the headless solver in tools/ can
// import the very same levels the browser runs.

export const WORLD = Object.freeze({ w: 1700, h: 900 });
export const GROUND_Y = 820;

// ---------------------------------------------------------------------------
// builders — all of these push into the `out` array and return the new surface
// ---------------------------------------------------------------------------

/** Rectangular block whose *underside* rests at `bottom`. Returns its top y. */
export function box(out, x, bottom, w, h, material = 'wood') {
  out.push({ cx: x, cy: bottom - h / 2, w, h, material, a: 0 });
  return bottom - h;
}

/** Horizontal plank centred on `x`, `len` long, `t` thick. Returns its top y. */
export const plank = (out, x, bottom, len, t, material = 'wood') => box(out, x, bottom, len, t, material);

/** Vertical column of `n` blocks of `w` x `h`. Returns the top surface. */
export function column(out, x, base, n, w, h, material = 'wood') {
  let top = base;
  for (let i = 0; i < n; i++) top = box(out, x, top, w, h, material);
  return top;
}

/**
 * One storey: two columns + a ceiling plank that ties them together.
 * Returns { top, innerLeft, innerRight } — the ceiling's top surface and the
 * usable interior span between the columns.
 */
export function storey(out, { x, base, span, colW = 26, colH = 90, ceilT = 20, material = 'wood' }) {
  const half = span / 2 - colW / 2;
  column(out, x - half, base, 1, colW, colH, material);
  column(out, x + half, base, 1, colW, colH, material);
  const top = plank(out, x, base - colH, span, ceilT, material);
  return { top, innerLeft: x - half + colW / 2, innerRight: x + half - colW / 2 };
}

/** `n` storeys stacked on `base`. Returns { top, innerLeft, innerRight } of the last one. */
export function tower(out, { x, base, n = 1, span = 150, colW = 26, colH = 90, ceilT = 20, material = 'wood', taper = 0 }) {
  let cur = { top: base, innerLeft: x, innerRight: x };
  for (let i = 0; i < n; i++) {
    cur = storey(out, { x, base: cur.top, span: span - taper * i, colW, colH, ceilT, material });
  }
  return cur;
}

/** A creature's centre so it rests on `surfaceY`. */
export const on = (surfaceY, r = 21) => surfaceY - r - 1;
export const critter = (x, surfaceY, r = 21) => ({ cx: x, cy: on(surfaceY, r), r });

// ---------------------------------------------------------------------------
// levels
// ---------------------------------------------------------------------------

/** Shared accumulator so each level reads as a build script. */
class Build {
  constructor() {
    this.blocks = [];
    this.creatures = [];
  }
  box(...a) { return box(this.blocks, ...a); }
  plank(...a) { return plank(this.blocks, ...a); }
  column(...a) { return column(this.blocks, ...a); }
  storey(opts) { return storey(this.blocks, opts); }
  tower(opts) { return tower(this.blocks, opts); }
  critter(x, surfaceY, r = 21) { this.creatures.push(critter(x, surfaceY, r)); return this; }
}

const raw = [
  {
    name: 'First Contact',
    hint: 'Drag the pouch back and let go — the dotted arc shows where it flies.',
    ammo: ['stone', 'stone', 'stone'],
    stars: [0, 1800, 2800],
    build(b) {
      // Tutorial: one creature in the open at comfortable range, with a crate
      // wall behind it so an over-shot still knocks something down. A target
      // standing on the ground has a ~7° wide window here; one perched high on
      // a table only had ~1°, which is a cruel first shot.
      b.critter(860, GROUND_Y);
      b.box(1000, GROUND_Y, 30, 90, 'wood');
      b.box(1055, GROUND_Y, 30, 90, 'wood');
      b.plank(1027, GROUND_Y - 90, 130, 20, 'wood');
    },
  },
  {
    name: 'Glass House',
    hint: 'Ice shatters. Aim low and let the whole house drop.',
    ammo: ['stone', 'stone', 'stone'],
    stars: [0, 1900, 3100],
    build(b) {
      const ground = b.storey({ x: 980, base: GROUND_Y, span: 220, colW: 26, colH: 130, ceilT: 20, material: 'ice' });
      const upper = b.storey({ x: 980, base: ground.top, span: 130, colW: 26, colH: 110, ceilT: 20, material: 'ice' });
      b.critter(980, upper.top);
      // stands in front of the house, not behind it: a creature tucked behind a
      // wall shorter than its own silhouette cannot be hit by any arc
      b.critter(810, GROUND_Y);
    },
  },
  {
    name: 'Twin Towers',
    hint: 'One shot per tower. Watch the roof cave in.',
    ammo: ['stone', 'stone', 'boulder'],
    stars: [0, 1800, 2800],
    build(b) {
      const a = b.tower({ x: 980, base: GROUND_Y, n: 2, span: 140, colW: 26, colH: 90, ceilT: 20 });
      const c = b.tower({ x: 1300, base: GROUND_Y, n: 2, span: 140, colW: 26, colH: 90, ceilT: 20 });
      b.critter(980, a.top);
      b.critter(1300, c.top);
    },
  },
  {
    name: 'Stone Fort',
    hint: 'Stone is tough. Save the bomb for the front wall.',
    ammo: ['stone', 'bomb', 'stone'],
    stars: [0, 1800, 2800],
    build(b) {
      const base = b.column(900, GROUND_Y, 2, 34, 60, 'stone');
      b.column(1010, GROUND_Y, 2, 34, 60, 'stone');
      const roof = b.plank(955, base, 190, 30, 'stone');
      const inner = b.column(955, roof, 1, 28, 100, 'wood');
      const top = b.plank(955, inner, 210, 22, 'wood');
      b.critter(955, top);
    },
  },
  {
    name: 'Scaffold',
    hint: 'Cut the legs out and the whole thing comes down.',
    ammo: ['stone', 'stone', 'bomb'],
    stars: [0, 1800, 2800],
    build(b) {
      const l1 = b.storey({ x: 1035, base: GROUND_Y, span: 240, colW: 28, colH: 130, ceilT: 20 });
      const l2 = b.storey({ x: 1035, base: l1.top, span: 220, colW: 28, colH: 110, ceilT: 20, material: 'stone' });
      const l3 = b.storey({ x: 1035, base: l2.top, span: 150, colW: 26, colH: 90, ceilT: 18 });
      b.critter(1035, l3.top);
      b.critter(1300, GROUND_Y);
    },
  },
  {
    name: 'TNT Yard',
    hint: 'Tapped mid-air, a bomb detonates on command.',
    ammo: ['stone', 'bomb', 'stone'],
    stars: [0, 1800, 2900],
    build(b) {
      const legL = b.column(1000, GROUND_Y, 1, 32, 110, 'stone');
      b.column(1140, GROUND_Y, 1, 32, 110, 'stone');
      b.box(1070, GROUND_Y, 44, 44, 'tnt'); // crate between the legs
      const roof = b.plank(1070, legL, 220, 22, 'wood');
      const up = b.storey({ x: 1070, base: roof, span: 190, colW: 26, colH: 60, ceilT: 20 });
      b.critter(1070, up.top);
      b.critter(1330, GROUND_Y);
    },
  },
  {
    name: 'Ice Palace',
    hint: 'A splitter spreads three stones across the palace.',
    ammo: ['splitter', 'stone', 'boulder'],
    stars: [0, 2400, 3800],
    build(b) {
      const palace = b.tower({ x: 1000, base: GROUND_Y, n: 2, span: 160, colW: 26, colH: 88, ceilT: 20, material: 'ice' });
      const spire = b.tower({ x: 1000, base: palace.top, n: 1, span: 110, colW: 26, colH: 80, ceilT: 20, material: 'ice' });
      b.critter(1000, spire.top);
      b.critter(1000, GROUND_Y); // sealed inside the ground floor
      const annex = b.tower({ x: 1290, base: GROUND_Y, n: 1, span: 130, colW: 26, colH: 100, ceilT: 20 });
      b.critter(1290, annex.top);
    },
  },
  {
    name: 'Bunker',
    hint: 'Blow the roof open, then drop something heavy inside.',
    ammo: ['bomb', 'boulder', 'stone'],
    stars: [0, 2800, 4500],
    build(b) {
      b.box(940, GROUND_Y, 36, 124, 'stone');
      b.box(1160, GROUND_Y, 36, 124, 'stone');
      const roof = b.plank(1050, GROUND_Y - 124, 300, 32, 'stone');
      const tnt = b.box(1150, roof, 44, 44, 'tnt');
      const inner = b.storey({ x: 1030, base: roof, span: 170, colW: 28, colH: 70, ceilT: 22 });
      b.critter(1030, inner.top);
      b.critter(1050, GROUND_Y); // sealed inside
      b.critter(1150, tnt);
    },
  },
  {
    name: 'Split Decision',
    hint: 'Detonate the splitter mid-flight with a tap.',
    ammo: ['splitter', 'splitter', 'stone'],
    stars: [0, 2500, 4000],
    build(b) {
      for (const [x, material] of [[900, 'wood'], [1180, 'ice'], [1440, 'wood']]) {
        const t = b.tower({ x, base: GROUND_Y, n: 1, span: 130, colW: 26, colH: 110, ceilT: 20, material });
        b.critter(x, t.top);
      }
    },
  },
  {
    name: 'Great Wall',
    hint: 'Topple the wall onto everyone sheltering behind it.',
    ammo: ['boulder', 'stone', 'bomb'],
    stars: [0, 2100, 3400],
    build(b) {
      // a squat, wide wall — tall enough to shelter behind, short enough to stand
      for (let row = 0; row < 3; row++) {
        for (let i = 0; i < 5; i++) b.box(880 + i * 30, GROUND_Y - row * 70, 30, 70, 'stone');
      }
      b.critter(1170, GROUND_Y);
      b.critter(1270, GROUND_Y);
      const annex = b.tower({ x: 1370, base: GROUND_Y, n: 1, span: 130, colW: 26, colH: 100, ceilT: 20, material: 'ice' });
      b.critter(1370, annex.top);
    },
  },
  {
    name: 'Switchback',
    hint: 'Two floors, two shots. Start with the top storey.',
    ammo: ['stone', 'splitter', 'bomb', 'stone'],
    stars: [0, 2800, 4500],
    build(b) {
      const a = b.box(880, GROUND_Y, 32, 124, 'stone'); // one piece per leg: no hinge
      b.box(1220, GROUND_Y, 32, 124, 'stone');
      const l1 = b.plank(1050, a, 380, 28, 'stone');
      const l2 = b.storey({ x: 1050, base: l1, span: 220, colW: 28, colH: 110, ceilT: 24 });
      const tnt = b.box(1050, l2.top, 46, 46, 'tnt');
      b.critter(1050, tnt);
      b.critter(1050, GROUND_Y); // inside the ground floor
      b.critter(1400, GROUND_Y);
    },
  },
  {
    name: 'Fortfall Keep',
    hint: 'Everything you have learned, all at once.',
    ammo: ['splitter', 'bomb', 'boulder', 'stone', 'stone'],
    stars: [0, 3900, 6100],
    build(b) {
      const a = b.box(880, GROUND_Y, 34, 124, 'stone'); // single pieces: a stack of
      b.box(1060, GROUND_Y, 34, 124, 'stone');          // two bricks can hinge and
      b.box(1240, GROUND_Y, 34, 124, 'stone');          // topple the whole keep
      const roof = b.plank(1060, a, 420, 30, 'stone');
      const keep = b.tower({ x: 990, base: roof, n: 2, span: 130, colW: 26, colH: 84, ceilT: 20 });
      const tnt = b.box(1110, roof, 46, 46, 'tnt');
      b.critter(990, keep.top);
      b.critter(1110, tnt);
      const annex = b.tower({ x: 1220, base: roof, n: 1, span: 120, colW: 26, colH: 84, ceilT: 20, material: 'ice' });
      b.critter(1220, annex.top);
      b.critter(960, GROUND_Y); // inside the keep
    },
  },
];

// Structures are authored around x = 880-1440 but the shots can only reach
// ground level from ~700px out, so everything is shifted into the reachable
// band (see tools/tolerance.mjs). Levels stay authored in one tidy space.
const LEVEL_OFFSET_X = 120;

export const LEVELS = raw.map((lvl, i) => {
  const b = new Build();
  lvl.build(b);
  const shift = (o) => ({ ...o, cx: o.cx + LEVEL_OFFSET_X });
  return {
    id: i,
    name: lvl.name,
    hint: lvl.hint,
    ammo: lvl.ammo,
    stars: lvl.stars,
    blocks: b.blocks.map(shift),
    creatures: b.creatures.map(shift),
  };
});

export default LEVELS;
