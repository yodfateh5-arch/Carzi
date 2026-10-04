// Procedural sound effects — everything is synthesised with the Web Audio API,
// so the game ships with zero audio assets and still has weight, glass, stone
// and explosions that differ from one another.

export class Sfx {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.muted = false;
    this.noiseBuffer = null;
  }

  /** Browsers only allow audio after a gesture; call this from a pointerdown. */
  resume() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      this.ctx = new AC();
      this.master = this.ctx.createGain();
      this.master.gain.value = this.muted ? 0 : 0.55;
      this.master.connect(this.ctx.destination);
      this.noiseBuffer = this.makeNoise();
    }
    if (this.ctx.state === 'suspended') this.ctx.resume();
  }

  setMuted(muted) {
    this.muted = muted;
    if (this.master) this.master.gain.value = muted ? 0 : 0.55;
  }

  makeNoise() {
    const len = this.ctx.sampleRate * 1.2;
    const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    return buf;
  }

  get now() { return this.ctx.currentTime; }

  /** Filtered noise burst — the backbone of impacts, glass and explosions. */
  noise({ dur = 0.2, type = 'bandpass', freq = 800, q = 1, gain = 0.5, sweepTo = null, delay = 0 }) {
    if (!this.ctx || this.muted) return;
    const t = this.now + delay;
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    src.playbackRate.value = 1;
    const filt = this.ctx.createBiquadFilter();
    filt.type = type;
    filt.frequency.setValueAtTime(freq, t);
    if (sweepTo) filt.frequency.exponentialRampToValueAtTime(Math.max(40, sweepTo), t + dur);
    filt.Q.value = q;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(Math.max(0.001, gain), t + Math.min(0.02, dur * 0.2));
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(filt).connect(g).connect(this.master);
    src.start(t);
    src.stop(t + dur + 0.05);
  }

  /** A short pitched tone. */
  tone({ freq = 220, to = null, dur = 0.18, type = 'sine', gain = 0.3, delay = 0 }) {
    if (!this.ctx || this.muted) return;
    const t = this.now + delay;
    const o = this.ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    if (to) o.frequency.exponentialRampToValueAtTime(Math.max(20, to), t + dur);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(Math.max(0.001, gain), t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(this.master);
    o.start(t);
    o.stop(t + dur + 0.03);
  }

  // ---- game events --------------------------------------------------------

  stretch() { this.noise({ dur: 0.08, type: 'highpass', freq: 900, gain: 0.06 }); }

  launch(power = 1) {
    this.noise({ dur: 0.3, type: 'bandpass', freq: 500, sweepTo: 160, q: 0.8, gain: 0.35 * (0.5 + power * 0.5) });
    this.tone({ freq: 180 * (0.8 + power * 0.4), to: 70, dur: 0.22, type: 'triangle', gain: 0.2 });
  }

  impact(power, material) {
    const p = Math.min(1, power / 14);
    if (p < 0.06) return;
    const base = material === 'ice' ? 1500 : material === 'stone' ? 300 : 180;
    this.noise({ dur: 0.12 + p * 0.14, type: 'lowpass', freq: base * (2.2 - p), gain: 0.10 + p * 0.28 });
    this.tone({ freq: 110 + (1 - p) * 90, to: 48, dur: 0.13, type: 'sine', gain: 0.06 + p * 0.16 });
  }

  shatter(material) {
    if (material === 'ice') {
      this.noise({ dur: 0.3, type: 'highpass', freq: 2600, gain: 0.22 });
      for (let i = 0; i < 5; i++) {
        this.tone({ freq: 1500 + Math.random() * 2200, dur: 0.12, type: 'triangle', gain: 0.06, delay: i * 0.03 });
      }
      this.noise({ dur: 0.5, type: 'bandpass', freq: 4200, q: 2, gain: 0.09, delay: 0.05 });
    } else if (material === 'stone') {
      this.noise({ dur: 0.34, type: 'bandpass', freq: 420, sweepTo: 160, q: 0.7, gain: 0.3 });
      this.tone({ freq: 90, to: 40, dur: 0.3, type: 'square', gain: 0.1 });
    } else if (material === 'tnt') {
      this.explode();
    } else {
      this.noise({ dur: 0.3, type: 'bandpass', freq: 700, sweepTo: 240, q: 0.6, gain: 0.28 });
      this.tone({ freq: 150, to: 60, dur: 0.24, type: 'square', gain: 0.08 });
    }
  }

  explode() {
    this.noise({ dur: 0.65, type: 'lowpass', freq: 1200, sweepTo: 90, gain: 0.6 });
    this.tone({ freq: 120, to: 32, dur: 0.6, type: 'sine', gain: 0.35 });
    this.noise({ dur: 0.25, type: 'highpass', freq: 2200, gain: 0.18 });
  }

  split() {
    this.tone({ freq: 620, to: 1180, dur: 0.16, type: 'triangle', gain: 0.16 });
    this.noise({ dur: 0.18, type: 'bandpass', freq: 1400, q: 1.2, gain: 0.16 });
  }

  pop() {
    this.tone({ freq: 520, to: 150, dur: 0.18, type: 'square', gain: 0.14 });
    this.noise({ dur: 0.16, type: 'bandpass', freq: 900, q: 1.4, gain: 0.18 });
  }

  click() { this.tone({ freq: 880, dur: 0.06, type: 'triangle', gain: 0.12 }); }

  win() {
    [523.25, 659.25, 783.99, 1046.5].forEach((f, i) =>
      this.tone({ freq: f, dur: 0.28, type: 'triangle', gain: 0.2, delay: i * 0.09 }));
  }

  lose() {
    [392, 329.63, 261.63].forEach((f, i) =>
      this.tone({ freq: f, dur: 0.34, type: 'sine', gain: 0.18, delay: i * 0.12 }));
  }
}
