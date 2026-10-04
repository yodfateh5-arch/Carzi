// All drawing. Everything is procedural — no image assets — so the whole game
// is a handful of text files.

import { WORLD, GROUND_Y, SLING, MATERIALS } from './sim.js';

const TAU = Math.PI * 2;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const lerp = (a, b, t) => a + (b - a) * t;

/** Deterministic pseudo-random from a seed, for stable decoration placement. */
export function hashNoise(seed) {
  let s = Math.sin(seed * 127.1 + 311.7) * 43758.5453;
  return s - Math.floor(s);
}

// ---------------------------------------------------------------------------
// camera
// ---------------------------------------------------------------------------

export class Camera {
  constructor() {
    this.cx = WORLD.w / 2;
    this.cy = WORLD.h / 2;
    this.zoom = 1;
    this.targetZoom = 1;
    this.targetX = this.cx;
    this.targetY = this.cy;
    this.viewW = WORLD.w;
    this.viewH = WORLD.h;
  }

  /**
   * Fit a world-space rect into the viewport, with padding in world units.
   * On a portrait screen we deliberately frame *less* width than the level so
   * the fort stays big and readable, and let the camera pan to follow the shot.
   */
  fit(rect, canvasW, canvasH, pad = 60) {
    const w = rect.maxX - rect.minX + pad * 2;
    const h = rect.maxY - rect.minY + pad * 2;
    const portrait = canvasH > canvasW;
    const framedW = portrait ? Math.min(w, Math.max(760, canvasW / (canvasH / h))) : w;
    this.targetZoom = Math.min(canvasW / framedW, canvasH / h);
    this.targetX = (rect.minX + rect.maxX) / 2;
    this.targetY = (rect.minY + rect.maxY) / 2;
    this.viewW = canvasW;
    this.viewH = canvasH;
  }

  follow(x, y, tight = 0.1) {
    this.targetX = x;
    this.targetY = y;
    this._tight = tight;
  }

  snap() {
    this.cx = this.targetX;
    this.cy = this.targetY;
    this.zoom = this.targetZoom;
  }

  update() {
    const k = this._tight ?? 0.12;
    this.cx = lerp(this.cx, this.targetX, k);
    this.cy = lerp(this.cy, this.targetY, k);
    this.zoom = lerp(this.zoom, this.targetZoom, 0.1);

    // never show past the world edges unless the viewport is bigger than it
    const halfW = this.viewW / (2 * this.zoom);
    const halfH = this.viewH / (2 * this.zoom);
    if (WORLD.w > halfW * 2) this.cx = clamp(this.cx, halfW, WORLD.w - halfW);
    else this.cx = WORLD.w / 2;
    if (WORLD.h + 120 > halfH * 2) this.cy = clamp(this.cy, halfH - 140, WORLD.h - halfH + 60);
    else this.cy = WORLD.h / 2;
  }

  apply(ctx) {
    ctx.translate(this.viewW / 2, this.viewH / 2);
    ctx.scale(this.zoom, this.zoom);
    ctx.translate(-this.cx, -this.cy);
  }

  /** Visible world rect, useful for culling. */
  rect() {
    const halfW = this.viewW / (2 * this.zoom);
    const halfH = this.viewH / (2 * this.zoom);
    return { minX: this.cx - halfW, maxX: this.cx + halfW, minY: this.cy - halfH, maxY: this.cy + halfH };
  }

  screenToWorld(sx, sy) {
    return {
      x: (sx - this.viewW / 2) / this.zoom + this.cx,
      y: (sy - this.viewH / 2) / this.zoom + this.cy,
    };
  }
}

// ---------------------------------------------------------------------------
// renderer
// ---------------------------------------------------------------------------

export class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.camera = new Camera();
    this.dpr = 1;
    this.time = 0;
    this.resize();
  }

  resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = this.canvas.clientWidth || window.innerWidth;
    const h = this.canvas.clientHeight || window.innerHeight;
    this.dpr = dpr;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.cssW = w;
    this.cssH = h;
    this.camera.viewW = w;
    this.camera.viewH = h;
  }

  /** World-space rect worth looking at for this level. */
  levelBounds(level) {
    let minX = SLING.x - 260, maxX = SLING.x + 140;
    let minY = SLING.y - 220, maxY = GROUND_Y + 30;
    for (const b of level.blocks) {
      minX = Math.min(minX, b.cx - b.w / 2);
      maxX = Math.max(maxX, b.cx + b.w / 2);
      minY = Math.min(minY, b.cy - b.h / 2);
    }
    for (const c of level.creatures) {
      minX = Math.min(minX, c.cx - c.r);
      maxX = Math.max(maxX, c.cx + c.r);
      minY = Math.min(minY, c.cy - c.r);
    }
    return { minX, maxX, minY, maxY };
  }

  frame(level, mode = 'overview', focus = null) {
    const cam = this.camera;
    const b = this.levelBounds(level);
    // keep sky in shot so tall arcs stay visible
    b.minY = Math.min(b.minY, GROUND_Y - 640);
    cam.fit(b, this.cssW, this.cssH, 70);
    if (mode === 'overview' || !focus) {
      // while aiming, bias the view so the sling and the fort are both in frame
      cam.follow(SLING.x - 40, b.minY + (b.maxY - b.minY) * 0.55 + 40, 0.12);
    } else {
      cam.follow(clamp(focus.x, SLING.x - 120, b.maxX), clamp(focus.y, b.minY, GROUND_Y), 0.14);
    }
    cam.update();
  }

  draw(ctx0, scene) {
    const { level, sim, particles, shake = 0, effect } = scene;
    const ctx = this.ctx;
    this.time += 1 / 60;
    ctx.save();
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.cssW, this.cssH);
    this.drawSky(ctx);

    ctx.save();
    if (shake > 0.01) {
      const s = shake * 14;
      ctx.translate((Math.random() - 0.5) * s, (Math.random() - 0.5) * s);
    }
    this.camera.apply(ctx);
    this.drawTerrain(ctx);
    this.drawSling(ctx, sim);
    if (effect?.preview?.length) this.drawPreview(ctx, effect.preview, effect.previewPower);
    const view = this.camera.rect();
    for (const info of sim.blocks) {
      if (info.dead) continue;
      const b = info.body;
      if (b.position.x < view.minX - 200 || b.position.x > view.maxX + 200) continue;
      this.drawBlock(ctx, info, b);
    }
    for (const info of sim.critters) {
      if (info.dead) continue;
      this.drawCreature(ctx, info, level);
    }
    for (const body of sim.ammoBodies) {
      if (body.plugin?.gone) continue;
      this.drawAmmo(ctx, body, sim);
    }
    particles.draw(ctx);
    ctx.restore();
    ctx.restore();
  }

  // ---- background ---------------------------------------------------------

  drawSky(ctx) {
    const { cssW: w, cssH: h } = this;
    const g = ctx.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, '#1b1140');
    g.addColorStop(0.42, '#5c2b63');
    g.addColorStop(0.72, '#c25a5f');
    g.addColorStop(1, '#f0955f');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);

    const groundOnScreen = (GROUND_Y - this.camera.cy) * this.camera.zoom + h / 2;
    const horizon = clamp(groundOnScreen, h * 0.25, h);

    // sun
    const sunY = horizon - h * 0.16;
    const sunR = Math.max(38, h * 0.075);
    const sg = ctx.createRadialGradient(w * 0.72, sunY, sunR * 0.2, w * 0.72, sunY, sunR * 3.2);
    sg.addColorStop(0, 'rgba(255,224,170,0.95)');
    sg.addColorStop(0.18, 'rgba(255,170,110,0.55)');
    sg.addColorStop(1, 'rgba(255,120,90,0)');
    ctx.fillStyle = sg;
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = 'rgba(255,240,205,0.95)';
    ctx.beginPath();
    ctx.arc(w * 0.72, sunY, sunR, 0, TAU);
    ctx.fill();

    // parallax ridges
    const layers = [
      { depth: 0.06, color: '#3a2050', amp: 60, base: 0.98, freq: 0.0042 },
      { depth: 0.14, color: '#2d1840', amp: 90, base: 1.02, freq: 0.0028 },
      { depth: 0.26, color: '#1f1030', amp: 120, base: 1.08, freq: 0.002 },
    ];
    for (const L of layers) {
      const off = -this.camera.cx * L.depth * this.camera.zoom * 0.6;
      ctx.fillStyle = L.color;
      ctx.beginPath();
      ctx.moveTo(-200, h);
      for (let x = -200; x <= w + 200; x += 12) {
        const wx = (x - off) * L.freq;
        const y = horizon - 30 + Math.sin(wx) * L.amp * 0.5 + Math.sin(wx * 2.7 + 1.3) * L.amp * 0.25 - L.amp * 0.2;
        ctx.lineTo(x, y * L.base);
      }
      ctx.lineTo(w + 200, h);
      ctx.closePath();
      ctx.fill();
    }

    // clouds
    ctx.save();
    ctx.globalAlpha = 0.18;
    ctx.fillStyle = '#ffd8c0';
    for (let i = 0; i < 7; i++) {
      const seed = hashNoise(i * 3.7);
      const cx = ((seed * 1.3 + this.time * 0.02 * (0.4 + seed)) % 1.3 - 0.15) * w;
      const cy = h * (0.08 + seed * 0.3);
      const s = 40 + seed * 90;
      ctx.beginPath();
      ctx.ellipse(cx, cy, s * 2.1, s * 0.55, 0, 0, TAU);
      ctx.ellipse(cx + s * 1.2, cy - s * 0.22, s * 1.3, s * 0.45, 0, 0, TAU);
      ctx.fill();
    }
    ctx.restore();
  }

  drawTerrain(ctx) {
    const view = this.camera.rect();
    const x0 = Math.min(view.minX, 0) - 200;
    const x1 = Math.max(view.maxX, WORLD.w) + 200;
    // dirt
    const g = ctx.createLinearGradient(0, GROUND_Y, 0, WORLD.h + 200);
    g.addColorStop(0, '#5b3f2a');
    g.addColorStop(0.25, '#4a3222');
    g.addColorStop(1, '#2c1d15');
    ctx.fillStyle = g;
    ctx.fillRect(x0, GROUND_Y, x1 - x0, WORLD.h + 260 - GROUND_Y);
    // grass cap
    ctx.fillStyle = '#4f7a3a';
    ctx.fillRect(x0, GROUND_Y - 9, x1 - x0, 12);
    ctx.fillStyle = '#63934a';
    ctx.beginPath();
    ctx.moveTo(x0, GROUND_Y - 6);
    for (let x = x0; x < x1; x += 26) {
      const n = hashNoise(Math.floor(x / 26) * 1.7);
      ctx.lineTo(x + 6, GROUND_Y - 6 - (6 + n * 9));
      ctx.lineTo(x + 13, GROUND_Y - 6);
    }
    ctx.lineTo(x1, GROUND_Y - 6);
    ctx.closePath();
    ctx.fill();
    // pebbles
    ctx.fillStyle = 'rgba(255,255,255,0.05)';
    for (let i = 0; i < 60; i++) {
      const n = hashNoise(i * 5.3);
      const n2 = hashNoise(i * 9.1 + 4);
      const x = (n * (x1 - x0)) + x0;
      const y = GROUND_Y + 18 + n2 * 180;
      ctx.fillRect(x, y, 3 + n2 * 5, 2 + n * 3);
    }
  }

  // ---- slingshot ----------------------------------------------------------

  drawSling(ctx, sim) {
    const pouch = sim.activeBody && !sim.activeBody.plugin?.gone && sim.phase === 'aim'
      ? sim.activeBody.position
      : { x: SLING.x, y: SLING.y };
    const baseY = GROUND_Y;

    // posts
    ctx.save();
    ctx.strokeStyle = '#6b4526';
    ctx.lineCap = 'round';
    ctx.lineWidth = 13;
    ctx.beginPath();
    ctx.moveTo(SLING.x - 20, baseY);
    ctx.lineTo(SLING.x - 20, SLING.y + 6);
    ctx.moveTo(SLING.x + 20, baseY);
    ctx.lineTo(SLING.x + 20, SLING.y - 10);
    ctx.stroke();
    ctx.strokeStyle = '#845631';
    ctx.lineWidth = 8;
    ctx.beginPath();
    ctx.moveTo(SLING.x - 20, baseY);
    ctx.lineTo(SLING.x - 20, SLING.y + 4);
    ctx.moveTo(SLING.x + 20, baseY);
    ctx.lineTo(SLING.x + 20, SLING.y - 12);
    ctx.stroke();

    // rubber band
    const leftArm = { x: SLING.x - 20, y: SLING.y - 10 };
    const rightArm = { x: SLING.x + 20, y: SLING.y - 14 };
    ctx.strokeStyle = '#2f2338';
    ctx.lineWidth = 7;
    ctx.beginPath();
    ctx.moveTo(leftArm.x, leftArm.y);
    ctx.lineTo(pouch.x, pouch.y);
    ctx.moveTo(rightArm.x, rightArm.y);
    ctx.lineTo(pouch.x, pouch.y);
    ctx.stroke();

    // leather pouch
    ctx.fillStyle = '#6d5136';
    ctx.beginPath();
    ctx.ellipse(pouch.x, pouch.y, 14, 9, Math.atan2(rightArm.y - pouch.y, rightArm.x - pouch.x), 0, TAU);
    ctx.fill();
    ctx.restore();
  }

  drawPreview(ctx, points, power) {
    ctx.save();
    for (let i = 0; i < points.length; i++) {
      const t = i / points.length;
      const p = points[i];
      const a = (1 - t) * 0.85 * (0.5 + power * 0.5);
      ctx.globalAlpha = a;
      ctx.fillStyle = i === points.length - 1 ? '#ffe9a8' : '#fff4d0';
      ctx.beginPath();
      ctx.arc(p.x, p.y, i === points.length - 1 ? 7 : 4.2 - t * 1.6, 0, TAU);
      ctx.fill();
    }
    ctx.restore();
  }

  // ---- blocks -------------------------------------------------------------

  drawBlock(ctx, info, body) {
    const { w, h } = info;
    const mat = info.mat ?? MATERIALS[info.material];
    const dmg = 1 - clamp(info.hp / info.maxHp, 0, 1);
    ctx.save();
    ctx.translate(body.position.x, body.position.y);
    ctx.rotate(body.angle);

    if (info.material === 'ice') {
      const g = ctx.createLinearGradient(-w / 2, -h / 2, w / 2, h / 2);
      g.addColorStop(0, 'rgba(180,240,255,0.88)');
      g.addColorStop(0.45, 'rgba(140,220,246,0.72)');
      g.addColorStop(1, 'rgba(200,246,255,0.85)');
      ctx.fillStyle = g;
    } else if (info.material === 'stone') {
      const g = ctx.createLinearGradient(0, -h / 2, 0, h / 2);
      g.addColorStop(0, '#9ea6b3');
      g.addColorStop(1, '#6f7684');
      ctx.fillStyle = g;
    } else if (info.material === 'tnt') {
      ctx.fillStyle = '#b8382c';
    } else {
      const g = ctx.createLinearGradient(0, -h / 2, 0, h / 2);
      g.addColorStop(0, '#c08a4a');
      g.addColorStop(1, '#8e5f2c');
      ctx.fillStyle = g;
    }

    roundRect(ctx, -w / 2, -h / 2, w, h, Math.min(6, w / 3, h / 3));
    ctx.fill();

    // top highlight + outline
    ctx.strokeStyle = 'rgba(255,255,255,0.22)';
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.fillStyle = 'rgba(255,255,255,0.14)';
    ctx.fillRect(-w / 2 + 3, -h / 2 + 3, w - 6, Math.min(4, h * 0.2));

    if (info.material === 'wood') {
      ctx.strokeStyle = 'rgba(60,34,12,0.28)';
      ctx.lineWidth = 1.4;
      const lines = Math.max(2, Math.round(Math.min(w, h) / 14));
      for (let i = 1; i < lines; i++) {
        const t = (i / lines - 0.5) * (h > w ? w : 0);
        ctx.beginPath();
        if (h > w) { ctx.moveTo(-w / 2 + 3 + i * 4, -h / 2 + 3); ctx.lineTo(-w / 2 + 3 + i * 4, h / 2 - 3); }
        else { ctx.moveTo(-w / 2 + 3, -h / 2 + 3 + i * 4); ctx.lineTo(w / 2 - 3, -h / 2 + 3 + i * 4); }
        ctx.stroke();
      }
    } else if (info.material === 'stone') {
      ctx.fillStyle = 'rgba(255,255,255,0.13)';
      for (let i = 0; i < 9; i++) {
        const n = hashNoise(info.seed * 40 + i);
        const n2 = hashNoise(info.seed * 90 + i * 3);
        ctx.beginPath();
        ctx.arc((n - 0.5) * (w - 8), (n2 - 0.5) * (h - 8), 1.3 + n2 * 1.7, 0, TAU);
        ctx.fill();
      }
    } else if (info.material === 'ice') {
      ctx.strokeStyle = 'rgba(255,255,255,0.6)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(-w / 2 + 4, h / 2 - 5);
      ctx.lineTo(w / 2 - 6, -h / 2 + 6);
      ctx.stroke();
    } else if (info.material === 'tnt') {
      ctx.fillStyle = '#f4e3c8';
      ctx.fillRect(-w / 2 + 3, -h * 0.16, w - 6, h * 0.32);
      ctx.fillStyle = '#7a2318';
      ctx.font = `700 ${Math.round(h * 0.26)}px "Trebuchet MS", sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('TNT', 0, 0);
    }

    // damage cracks
    if (dmg > 0.12) {
      ctx.strokeStyle = `rgba(25,15,10,${0.25 + dmg * 0.5})`;
      ctx.lineWidth = 1.6 + dmg * 1.4;
      const cracks = 1 + Math.floor(dmg * 4);
      for (let i = 0; i < cracks; i++) {
        const n = hashNoise(info.seed * 10 + i * 2.3);
        const n2 = hashNoise(info.seed * 20 + i * 5.1);
        const sx = (n - 0.5) * w * 0.8;
        const sy = -h / 2 + n2 * h * 0.3;
        ctx.beginPath();
        ctx.moveTo(sx, sy);
        ctx.lineTo(sx + (n2 - 0.5) * w * 0.5, sy + h * 0.45);
        if (dmg > 0.5) ctx.lineTo(sx + (n - 0.5) * w * 0.6, sy + h * 0.8);
        ctx.stroke();
      }
    }

    if (info.flash > 0) {
      ctx.fillStyle = `rgba(255,255,255,${info.flash * 0.5})`;
      roundRect(ctx, -w / 2, -h / 2, w, h, 5);
      ctx.fill();
    }
    ctx.restore();
  }

  // ---- creatures ----------------------------------------------------------

  drawCreature(ctx, info, level) {
    const p = info.body.position;
    const r = info.r;
    const hurt = 1 - clamp(info.hp / info.maxHp, 0, 1);
    const { x: vx, y: vy } = info.body.velocity;
    const speed = Math.hypot(vx, vy);
    const squash = clamp(1 - speed * 0.02, 0.82, 1);
    const wobble = Math.sin(this.time * 6 + info.body.id) * 0.05 * (0.3 + hurt);

    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.rotate(info.body.angle * 0.6);
    ctx.scale(1 / squash + wobble, squash + wobble);

    const hue = (info.body.id * 47) % 360;
    const base = hurt > 0.55 ? `hsl(${hue} 45% 52%)` : `hsl(${hue} 62% 62%)`;
    const shade = hurt > 0.55 ? `hsl(${hue} 40% 38%)` : `hsl(${hue} 58% 46%)`;
    const g = ctx.createRadialGradient(-r * 0.3, -r * 0.4, r * 0.2, 0, 0, r * 1.15);
    g.addColorStop(0, base);
    g.addColorStop(1, shade);
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(0, 0, r, 0, TAU);
    ctx.fill();

    // belly
    ctx.fillStyle = 'rgba(255,255,255,0.18)';
    ctx.beginPath();
    ctx.ellipse(0, r * 0.35, r * 0.62, r * 0.42, 0, 0, TAU);
    ctx.fill();

    // eyes look toward the slingshot
    const look = clamp((SLING.x - p.x) / 400, -0.5, 0.5);
    for (const s of [-1, 1]) {
      ctx.fillStyle = '#fff';
      ctx.beginPath();
      ctx.arc(s * r * 0.33, -r * 0.16, r * 0.31, 0, TAU);
      ctx.fill();
      ctx.fillStyle = '#241a2c';
      ctx.beginPath();
      ctx.arc(s * r * 0.33 + look * r * 0.12, -r * 0.16 + r * 0.05, r * 0.15, 0, TAU);
      ctx.fill();
    }

    // brows angle down as it takes damage
    ctx.strokeStyle = 'rgba(40,20,30,0.8)';
    ctx.lineWidth = Math.max(2, r * 0.14);
    ctx.lineCap = 'round';
    for (const s of [-1, 1]) {
      const bx = s * r * 0.33;
      const by = -r * 0.52 + hurt * r * 0.12;
      ctx.beginPath();
      ctx.moveTo(bx - r * 0.22, by - hurt * r * 0.1);
      ctx.lineTo(bx + r * 0.22, by + hurt * r * 0.22);
      ctx.stroke();
    }

    // mouth: a worried line that opens when hurt
    ctx.strokeStyle = 'rgba(45,22,34,0.85)';
    ctx.lineWidth = Math.max(2, r * 0.11);
    ctx.beginPath();
    if (hurt < 0.4) {
      ctx.arc(0, r * 0.22, r * 0.26, 0.15 * Math.PI, 0.85 * Math.PI);
    } else {
      ctx.ellipse(0, r * 0.3, r * 0.22, r * (0.14 + hurt * 0.16), 0, 0, TAU);
    }
    ctx.stroke();

    if (info.flash > 0) {
      ctx.fillStyle = `rgba(255,255,255,${info.flash * 0.55})`;
      ctx.beginPath();
      ctx.arc(0, 0, r, 0, TAU);
      ctx.fill();
    }
    ctx.restore();
  }

  // ---- ammo ---------------------------------------------------------------

  drawAmmo(ctx, body, sim) {
    const type = body.plugin?.ammo;
    if (!type) return;
    const r = body.radius ?? type.r;
    const p = body.position;
    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.rotate(body.angle);

    if (type.key === 'bomb') {
      const g = ctx.createRadialGradient(-r * 0.35, -r * 0.4, r * 0.2, 0, 0, r * 1.2);
      g.addColorStop(0, '#5a5560');
      g.addColorStop(1, '#221f28');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(0, 0, r, 0, TAU);
      ctx.fill();
      ctx.strokeStyle = '#8a8391';
      ctx.lineWidth = 2;
      ctx.stroke();
      // fuse + spark
      ctx.strokeStyle = '#c8a06a';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(0, -r);
      ctx.quadraticCurveTo(r * 0.5, -r * 1.5, r * 0.15, -r * 1.8);
      ctx.stroke();
      const sp = 0.6 + Math.sin(this.time * 30) * 0.4;
      ctx.fillStyle = `rgba(255,190,90,${0.7 + sp * 0.3})`;
      ctx.beginPath();
      ctx.arc(r * 0.1, -r * 1.85, 3.4 * sp + 2, 0, TAU);
      ctx.fill();
    } else if (type.key === 'splitter') {
      const g = ctx.createRadialGradient(-r * 0.3, -r * 0.4, r * 0.2, 0, 0, r * 1.2);
      g.addColorStop(0, '#cfe6ff');
      g.addColorStop(1, '#6b7f9e');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(0, 0, r, 0, TAU);
      ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,0.75)';
      ctx.lineWidth = 1.6;
      for (let i = 0; i < 3; i++) {
        const a = (i / 3) * TAU + 0.5;
        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.lineTo(Math.cos(a) * r, Math.sin(a) * r);
        ctx.stroke();
      }
    } else {
      const g = ctx.createRadialGradient(-r * 0.35, -r * 0.4, r * 0.2, 0, 0, r * 1.2);
      if (type.key === 'boulder') {
        g.addColorStop(0, '#9aa38f');
        g.addColorStop(1, '#5c6353');
      } else {
        g.addColorStop(0, '#c3c8d2');
        g.addColorStop(1, '#767d8a');
      }
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(0, 0, r, 0, TAU);
      ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,0.25)';
      ctx.lineWidth = 1.4;
      ctx.stroke();
    }
    ctx.restore();
  }
}

export function roundRect(ctx, x, y, w, h, r) {
  const rr = Math.min(r, Math.abs(w) / 2, Math.abs(h) / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}
