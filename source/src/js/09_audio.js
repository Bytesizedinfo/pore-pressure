'use strict';
/* Procedural sound (Web Audio). Starts on the first user gesture. */
PP.Audio = function () {
  this.ctx = null; this.on = PP.storage.get('sound', true); this.master = null;
  this.lastGrain = 0; this.vac = null; this.creakT = 0;
};
PP.Audio.prototype.start = function () {
  if (this.ctx || !this.on) return;
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    this.ctx = new AC();
    this.master = this.ctx.createGain(); this.master.gain.value = 0.55; this.master.connect(this.ctx.destination);
    const n = this.ctx.sampleRate * 1.5;
    this.noise = this.ctx.createBuffer(1, n, this.ctx.sampleRate);
    const d = this.noise.getChannelData(0); for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
  } catch (e) { this.ctx = null; }
};
PP.Audio.prototype.setOn = function (v) { this.on = v; PP.storage.set('sound', v); if (this.master) this.master.gain.value = v ? 0.55 : 0; if (v) this.start(); };
PP.Audio.prototype.burst = function (o) {
  const c = this.ctx; if (!c || !this.on) return;
  const t = c.currentTime + (o.delay || 0);
  const src = c.createBufferSource(); src.buffer = this.noise; src.playbackRate.value = o.rate || 1;
  const f = c.createBiquadFilter(); f.type = o.type || 'bandpass'; f.frequency.setValueAtTime(o.f0 || 800, t);
  if (o.f1) f.frequency.exponentialRampToValueAtTime(o.f1, t + (o.dur || 0.1));
  f.Q.value = o.q || 2;
  const g = c.createGain(); g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(o.vol || 0.3, t + (o.att || 0.004)); g.gain.exponentialRampToValueAtTime(0.0001, t + (o.dur || 0.1));
  src.connect(f); f.connect(g); g.connect(this.master);
  src.start(t, Math.random() * 1.2); src.stop(t + (o.dur || 0.1) + 0.05);
};
PP.Audio.prototype.tone = function (o) {
  const c = this.ctx; if (!c || !this.on) return;
  const t = c.currentTime + (o.delay || 0);
  const osc = c.createOscillator(); osc.type = o.wave || 'sine'; osc.frequency.setValueAtTime(o.f0, t);
  if (o.f1) osc.frequency.exponentialRampToValueAtTime(o.f1, t + o.dur);
  const g = c.createGain(); g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(o.vol || 0.2, t + 0.005); g.gain.exponentialRampToValueAtTime(0.0001, t + o.dur);
  osc.connect(g); g.connect(this.master); osc.start(t); osc.stop(t + o.dur + 0.05);
};
PP.Audio.prototype.pop = function (P) {
  const k = PP.clamp(P / 40, 0.3, 1.2);
  this.burst({ f0: 2600, f1: 600, q: 1.2, dur: 0.05, vol: 0.35 * k, type: 'bandpass' });
  this.tone({ f0: 180 * (1 + k * 0.3), f1: 70, dur: 0.09, vol: 0.32 * k });
  this.burst({ f0: 900, f1: 300, q: 3, dur: 0.16, vol: 0.12, delay: 0.03, rate: 0.7 });
};
PP.Audio.prototype.deep = function () { this.tone({ f0: 90, f1: 55, dur: 0.25, vol: 0.25 }); this.burst({ f0: 300, q: 1, dur: 0.2, vol: 0.12, type: 'lowpass' }); };
PP.Audio.prototype.spurt = function (v) { this.burst({ f0: 1800, f1: 500, q: 0.8, dur: 0.22, vol: PP.clamp(v / 6000, 0.1, 0.45), type: 'bandpass', rate: 1.4 }); };
PP.Audio.prototype.extrude = function (rate) {
  const c = this.ctx; if (!c || !this.on) return;
  const now = c.currentTime;
  const interval = PP.clamp(0.14 / Math.max(rate, 0.05), 0.025, 0.25);
  if (now - this.lastGrain < interval) return;
  this.lastGrain = now;
  this.burst({ f0: 260 + Math.random() * 380, f1: 120 + Math.random() * 100, q: 6, dur: 0.07 + Math.random() * 0.05, vol: 0.16, type: 'bandpass', rate: 0.6 });
};
PP.Audio.prototype.creak = function () { this.burst({ f0: 140, f1: 220, q: 9, dur: 0.12, vol: 0.12, type: 'bandpass', rate: 0.5 }); };
PP.Audio.prototype.tick = function () { this.burst({ f0: 5200, q: 4, dur: 0.02, vol: 0.18, type: 'bandpass' }); };
PP.Audio.prototype.slice = function () { this.burst({ f0: 6500, f1: 3500, q: 1.5, dur: 0.09, vol: 0.12, type: 'highpass' }); };
PP.Audio.prototype.click = function () { this.tone({ f0: 2400, f1: 1800, dur: 0.03, vol: 0.12, wave: 'square' }); };
PP.Audio.prototype.splat = function (size) { this.burst({ f0: 700, f1: 200, q: 2, dur: 0.06, vol: PP.clamp(size * 0.3, 0.05, 0.25), type: 'lowpass' }); };
PP.Audio.prototype.vacuum = function (on, level) {
  const c = this.ctx; if (!c) return;
  if (on && this.on && !this.vac) {
    const o = c.createOscillator(); o.type = 'sawtooth'; o.frequency.value = 118;
    const src = c.createBufferSource(); src.buffer = this.noise; src.loop = true;
    const f = c.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 900;
    const g = c.createGain(); g.gain.value = 0.0;
    o.connect(f); src.connect(f); f.connect(g); g.connect(this.master); o.start(); src.start();
    this.vac = { o, src, g, f };
  }
  if (this.vac) {
    this.vac.g.gain.setTargetAtTime(on && this.on ? 0.05 + level * 0.05 : 0, c.currentTime, 0.05);
    this.vac.o.frequency.setTargetAtTime(110 + level * 30, c.currentTime, 0.1);
    if (!on) { const v = this.vac; this.vac = null; setTimeout(() => { try { v.o.stop(); v.src.stop(); } catch (_) { /* already stopped */ } }, 300); }
  }
};
