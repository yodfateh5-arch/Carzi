import { SLING, predictPath, GROUND_Y, WORLD } from '/home/user/Carzi/src/sim.js';
const px = (d, ang, power=1) => {
  const rad = ang*Math.PI/180, v = SLING.maxSpeed*power;
  const pts = predictPath(SLING.x, SLING.y, Math.cos(rad)*v, -Math.sin(rad)*v, 500, 0.01);
  const f = pts.find(p => p.x >= SLING.x + d);
  return f ? f.y : null;
};
console.log('dist  best-angle  y@dist  tolerance(±deg keeping within 25px)');
for (const d of [400,500,600,700,800,900,1000,1100,1200,1300,1400]) {
  let best = null;
  for (let a = 1; a <= 60; a += 0.1) {
    const y = px(d, a);
    if (y === null) continue;
    const err = Math.abs(y - (GROUND_Y - 22));  // a creature sitting on the ground
    if (!best || err < best.err) best = { a, y, err: Math.abs(y-(GROUND_Y-22)) };
  }
  // tolerance: how many degrees around `best.a` keep the height within ±25px of target
  let lo = best.a, hi = best.a;
  for (let a = best.a; a > 0.5; a -= 0.1) { if (Math.abs((px(d,a) ?? -9999) - best.y) > 25) break; lo = a; }
  for (let a = best.a; a < 70; a += 0.1) { if (Math.abs((px(d,a) ?? 9999) - best.y) > 25) break; hi = a; }
  console.log(`${String(d).padStart(4)}   ${best.a.toFixed(1).padStart(5)}°     ${best.y.toFixed(0).padStart(4)}    ${(hi-lo).toFixed(2)}° ${best.err<25?'(reachable)':'UNREACHABLE'}`);
}
