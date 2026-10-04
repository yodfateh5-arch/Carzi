# FORTFALL

A physics demolition puzzler for the browser. Load a slingshot, smash ramshackle
forts and topple every creature inside — with twelve hand-built levels, four ammo
types, and a headless solver that proves each level is beatable before it ships.

Everything is procedural: no images, no audio files, no build step. Just
JavaScript modules, one vendored physics engine, and ~2,000 lines of game.

## Run it

```bash
npm install          # only dependency is matter-js (vendored for the browser too)
npm start            # → http://localhost:8080
```

ES modules can't be loaded from `file://`, so the repo ships a tiny static
server (`tools/serve.mjs`). Any static host works — it's just files.

## How to play

| Action | Mouse / touch | Keyboard |
| --- | --- | --- |
| Aim | drag the pouch back (or drag anywhere) | `←` `→` angle, `↑` `↓` power |
| Fire | release | `Space` |
| Trigger the loaded shot | tap / click mid-flight | `Space` |
| Restart level | ⟳ | `R` |
| Mute | 🔊 | `M` |
| Level list | ☰ | `Esc` |

Kill every creature to clear a level. **Score** comes from kills (1000 each),
destroyed material (100–250 per block) and unused ammo (1000 each); **stars**
are awarded against per-level thresholds derived from a real solution, so 3
stars always means "played it about as well as it can be played".

**Ammo**

| Shot | What it is | Mid-flight trick |
| --- | --- | --- |
| Stone | reliable, heavy | — |
| Bomb | shoves and burns whatever is near the blast | tap to detonate |
| Splitter | three projectiles from one shot | tap to split |
| Boulder | big, slow, crushing | — |

**Materials** — wood splinters, ice shatters, stone shrugs off hits, TNT chains.
Thin walls topple; roofs crush whatever is beneath them.

## Project layout

```
index.html          HUD, menus, overlays
styles.css          all UI styling
src/engine.js       Matter.js loader (browser global / npm in Node)
src/levels.js       level data + bottom-up builders (box/column/storey/tower)
src/sim.js          simulation, damage model, scoring, aiming math  ← the core
src/render.js       camera + all procedural drawing
src/particles.js    dust, splinters, shards, smoke, score popups
src/audio.js        synthesised sound effects (Web Audio)
src/game.js         loop, input, effects, progression, save file
vendor/matter.min.js  matter-js 0.20, loaded as a classic script
tools/              solver, tests, static server, dev utilities
```

`src/sim.js` has no DOM code at all — the browser game and every tool in
`tools/` run the exact same simulation.

## What the tools do

```bash
npm test        # 30 physics/rule regression tests
npm run smoke   # boots the real game modules against a DOM stub, plays a level
npm start       # dev server
npm run probe   # physics calibration report
npm run verify  # prove every level is winnable (beam search per level)
npm run solve   # …and write tools/level-report.json with the winning lines
```

* **`tools/tests.mjs`** asserts the rules the game *feels* like it should have:
  every level must sit still for 10 seconds (no drift, no deaths), a 200px fall
  is survivable but a 1600px one is not, a well-aimed full-power shot is lethal,
  ice shatters while stone survives a single hit, bombs and splitters do what
  they advertise, and no body ever reaches a NaN transform.
* **`tools/simulate.mjs`** is a beam-search solver. For each level it tries a
  crude angle/power sweep *plus* aim-assisted shots computed from the live
  creature positions (`angleToHit()`), keeps a diverse frontier (states are
  deduplicated by outcome, not by shot), and reports the cheapest line that
  clears the level. `tools/level-report.json` is the record of the last run —
  it's what the star thresholds came from, and what `npm run smoke` replays
  through the real game end-to-end.
* **`tools/tolerance.mjs`** answers "can a player actually hit that?" — it
  measures, for every distance, the arc with the closest approach to a
  ground-level target and how many degrees of slop still land within 25px.

## Notes on the physics (why the numbers are what they are)

Units are Matter.js pixels and 1/60s steps. Gravity is `0.002` scale →
`g = 0.55 px/step²`; the sling launches at up to `36 px/step`, which carries a
full-power 45° shot about 1400px in 1.3s — a readable arc that reaches the whole
map instead of a flat bullet.

* **Damage** is `k · √(striker mass) · vn²`, with `vn` the closing speed along
  the contact normal. A fast hit hurts far more than a slow heavy one, and a
  shot does the same damage to a big slab as to a small brick; the *material*
  carries the difference (wood 58 hp, ice 27, stone 190, TNT 22). Landing on
  terrain multiplies creature damage by 1.5 — the ground doesn't budge.
* **Creatures** have 80 hp. A direct full-power stone kills, a 400px fall
  doesn't, a 1600px one does, and anything resting on them does 34 dps once it
  has been still for a quarter second.
* **Circles get rolling resistance** — but only while they are touching
  something. Applying it in mid-air made shots drop short of the trajectory the
  player was shown; that bug is why `predictPath`, `angleToHit`, the solver and
  the HUD all now go through one `solveAim()`.
* **The pouch is only ~120px above the ground.** A slingshot mounted higher
  cannot hit ground-level targets closer than ~1000px at all, because a flat
  shot simply flies over them. That single constraint is why the levels sit
  where they do — `tools/tolerance.mjs` measures the reachable band
  (roughly 600–1400px from the sling) and levels are authored inside it.

## Authoring a level

Levels are built bottom-up so nothing floats or settles on load:

```js
build(b) {
  const storey = b.storey({ x: 1000, base: GROUND_Y, span: 220, colW: 26, colH: 130, ceilT: 20, material: 'ice' });
  b.critter(1000, storey.top);            // sits exactly on that surface
  b.box(1120, GROUND_Y, 34, 124, 'stone'); // one piece: stacked bricks hinge and topple
}
```

Two rules learned the hard way, both enforced by `tools/tests.mjs`:

1. **Brace everything.** A plank on a single post is a see-saw, and two stacked
   bricks make a hinge — both collapse on their own a second after the level
   loads. Give every storey two columns, and make tall legs single bodies.
2. **Give every creature a direct-fire window.** A creature tucked behind a wall
   shorter than its own silhouette cannot be hit by any arc; a creature sealed
   inside a fort needs a mechanic (bomb through the roof, drop the roof on it).
   Check with `npm run verify` and `node /tmp/…`-style single-shot sweeps.

## Licence

MIT. Physics by [matter-js](https://brm.io/matter-js/) (MIT).
