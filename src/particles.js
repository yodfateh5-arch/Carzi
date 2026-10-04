// Particle system: dust, splinters, shards, smoke, sparks and floating score
// popups. Pure data + canvas drawing, no dependency on the sim.

const GRAVITY = 0.22;

const PRESETS = {
  dust: { colors: ['#c9b79b', '#a99175', '#8d7a63'], r: [3, 8], life: [24, 46], speed: [0.4, 2.2], gravity: 0.06, fade: 0.9 },
  wood: { colors: ['#c08a45', '#a06f31', '#7d5522'], r: [3, 9], life: [30, 60], speed: [1.5, 6], gravity: 0.3, spin: 0.3 },
  ice: { colors: ['#cdf3ff', '#9fe3fb', '#ffffff', '#7fd4f0'], r: [2, 7], life: [26, 52], speed: [1.8, 6.5], gravity: 0.28, spin: 0.4 },
  stone: { colors: ['#9aa1ad', '#7c838f', '#5f6672'], r: [3, 10], life: [30, 66], speed: [1.2, 5], gravity: 0.32 },
  smoke: { colors: ['rgba(90,90,96,0.5)', 'rgba(140,140,150,0.42)', 'rgba(60,60,70,0.4)'], r: [8, 20], life: [40, 90], speed: [0.4, 1.8], gravity: -0.02, grow: 0.25 },
  spark: { colors: ['#ffe08a', '#ffb347', '#fff3c4'], r: [1.5, 4], life: [14, 30], speed: [2, 8], gravity: 0.12 },
  tnt: { colors: ['#ffd166', '#ff7b3d', '#e63946', '#4a4a4a'], r: [3, 11], life: [26, 58], speed: [2, 9], gravity: 0.28 },
  blast: { colors: ['rgba(255,214,140,0.85)', 'rgba(255,140,72,0.7)', 'rgba(255,80,60,0.55)'], r: [10, 34], life: [16, 34], speed: [1, 5], gravity: 0.02, grow: 0.8 },
  splash: { colors: ['#b7f0ff', '#8fe0f7', '#ffffff'], r: [2, 6], life: [20, 40], speed: [1.5, 5], gravity: 0.3 },
};

export class Particles {
  constructor(max = 900) {
    this.items = [];
    this.max = max;
    this.texts = [];
  }

  clear() {
    this.items.length = 0;
    this.texts.length = 0;
  }

  /** Burst of `count` particles of a kind. */
  burst(kind, x, y, count = 12, opts = {}) {
    const p = PRESETS[kind] ?? PRESETS.dust;
    const spread = opts.spread ?? Math.PI * 2;
    const dir = opts.dir ?? -Math.PI / 2;
    for (let i = 0; i < count; i++) {
      if (this.items.length >= this.max) break;
      const a = dir + (Math.random() - 0.5) * spread;
      const sp = rand(p.speed) * (opts.speedScale ?? 1);
      this.items.push({
        kind,
        x: x + (Math.random() - 0.5) * (opts.jitter ?? 6),
        y: y + (Math.random() - 0.5) * (opts.jitter ?? 6),
        vx: Math.cos(a) * sp,
        vy: Math.sin(a) * sp - (opts.lift ?? 0),
        r: rand(p.r) * (opts.sizeScale ?? 1),
        life: rand(p.life) | 0,
        maxLife: 0,
        color: p.colors[(Math.random() * p.colors.length) | 0],
        gravity: (opts.gravity ?? p.gravity ?? GRAVITY) * (opts.gravityScale ?? 1),
        grow: (p.grow ?? 0) * (opts.growScale ?? 1),
        spin: (Math.random() - 0.5) * (p.spin ?? 0.25),
        angle: Math.random() * Math.PI,
        shape: kind === 'wood' || kind === 'ice' || kind === 'stone' ? 'rect' : 'circle',
      });
    }
    for (const it of this.items) if (!it.maxLife) it.maxLife = it.life;
  }

  /** Floating "+250" style popup. */
  score(x, y, text, color = '#ffe9a8') {
    this.texts.push({ x, y, text, color, life: 66, maxLife: 66, vy: -1.05 });
  }

  update() {
    for (let i = this.items.length - 1; i >= 0; i--) {
      const it = this.items[i];
      it.vy += it.gravity;
      it.vx *= 0.995;
      it.x += it.vx;
      it.y += it.vy;
      it.angle += it.spin;
      it.r += it.grow;
      if (--it.life <= 0) this.items.splice(i, 1);
    }
    for (let i = this.texts.length - 1; i >= 0; i--) {
      const t = this.texts[i];
      t.y += t.vy;
      t.vy *= 0.985;
      if (--t.life <= 0) this.texts.splice(i, 1);
    }
  }

  draw(ctx) {
    for (const it of this.items) {
      const t = it.life / it.maxLife;
      ctx.save();
      ctx.globalAlpha = it.kind === 'smoke' || it.kind === 'blast' ? Math.min(1, t * 1.6) : Math.min(1, t * 2.2);
      ctx.fillStyle = it.color;
      ctx.translate(it.x, it.y);
      if (it.shape === 'rect') {
        ctx.rotate(it.angle);
        ctx.fillRect(-it.r, -it.r * 0.6, it.r * 2, it.r * 1.2);
      } else {
        ctx.beginPath();
        ctx.arc(0, 0, it.r, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
    }
    for (const t of this.texts) {
      const k = t.life / t.maxLife;
      ctx.save();
      ctx.globalAlpha = Math.min(1, k * 2.5);
      ctx.fillStyle = t.color;
      ctx.font = `700 ${Math.round(26 + 8 * (1 - k))}px "Trebuchet MS", system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.lineWidth = 4;
      ctx.strokeStyle = 'rgba(20,12,30,0.75)';
      ctx.strokeText(t.text, t.x, t.y);
      ctx.fillText(t.text, t.x, t.y);
      ctx.restore();
    }
  }
}

const rand = ([a, b]) => a + Math.random() * (b - a);
