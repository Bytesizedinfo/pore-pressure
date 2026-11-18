'use strict';
/* Pore Pressure — shared utilities. Units: mm, seconds, N, kPa (1 kPa = 1e-3 N/mm^2), µL = mm^3. */
const PP = (window.PP = window.PP || {});

PP.clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
PP.lerp = (a, b, t) => a + (b - a) * t;
PP.smooth = (e0, e1, x) => { const t = PP.clamp((x - e0) / (e1 - e0), 0, 1); return t * t * (3 - 2 * t); };
PP.len = (x, y) => Math.sqrt(x * x + y * y);

// deterministic RNG (mulberry32)
PP.rng = function (seed) {
  let a = seed >>> 0;
  const f = function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  f.range = (lo, hi) => lo + (hi - lo) * f();
  f.pick = (arr) => arr[Math.floor(f() * arr.length) % arr.length];
  f.normal = () => { let u = 0, v = 0; while (u === 0) u = f(); v = f(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
  return f;
};

PP.params = new URLSearchParams(location.search);
PP.TEST = PP.params.get('test') || '';

// diagnostics panel (errors always shown; test verdicts written here too)
PP.diag = {
  lines: [],
  errors: 0,
  el: null,
  write(msg, isErr) {
    if (isErr) this.errors++;
    this.lines.push((isErr ? 'ERROR: ' : '') + msg);
    if (!this.el) this.el = document.getElementById('diag');
    if (this.el && (isErr || PP.TEST)) { this.el.hidden = false; this.el.textContent = this.lines.join('\n'); }
  },
  error(msg) { this.write(String(msg), true); },
};
window.addEventListener('error', (e) => PP.diag.error('JS: ' + e.message + ' @' + (e.lineno || '?') + ':' + (e.colno || '?')));
window.addEventListener('unhandledrejection', (e) => PP.diag.error('Promise: ' + (e.reason && (e.reason.stack || e.reason.message) || e.reason)));

PP.storage = {
  get(k, d) { try { const v = localStorage.getItem('pp.' + k); return v == null ? d : JSON.parse(v); } catch (_) { return d; } },
  set(k, v) { try { localStorage.setItem('pp.' + k, JSON.stringify(v)); } catch (_) { /* storage unavailable */ } },
};

PP.fmtVol = (ul) => (ul >= 1000 ? (ul / 1000).toFixed(ul >= 10000 ? 1 : 2) + ' mL' : ul >= 10 ? ul.toFixed(0) + ' µL' : ul.toFixed(1) + ' µL');
PP.fmtClock = (s) => {
  if (s < 3600) { const m = Math.floor(s / 60), ss = Math.floor(s % 60); return '+' + m + ':' + String(ss).padStart(2, '0'); }
  if (s < 172800) { const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60); return '+' + h + 'h ' + String(m).padStart(2, '0') + 'm'; }
  return '+' + (s / 86400).toFixed(1) + ' days';
};

// sRGB helpers
PP.s2l = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
PP.hex2lin = (h) => [1, 3, 5].map((i) => PP.s2l(parseInt(h.substr(i, 2), 16) / 255));

// 3x3 inverse (row-major arrays)
PP.inv3 = function (m) {
  const [a, b, c, d, e, f, g, h, i] = m;
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
  const det = a * A + b * B + c * C;
  return [A / det, -(b * i - c * h) / det, (b * f - c * e) / det,
    B / det, (a * i - c * g) / det, -(a * f - c * d) / det,
    C / det, -(a * h - b * g) / det, (a * e - b * d) / det];
};
