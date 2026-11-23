'use strict';
/* Wounds, injections, temperature and bleeding.
   - Incisions open by Griffith crack opening under prestress across the cut (PP.Phys.cutGape).
   - Punch holes ovalise along the relaxed tension lines (Kirsch) and keep a tissue core until lifted.
   - Bleeding from the dermal plexus scales with depth, perfusion, epinephrine (vasoconstriction peaks ~7–10 min),
     applied pressure and clotting (bleeding time ~2–8 min); an unpressed emptied cavity fills into a hematoma.
   - Lidocaine: anaesthesia onset ~1–2 min; epinephrine blanching builds toward ~10 min (AAFP).
   - Temperature: warm compress heats tissue; diffusion + relaxation to ~32.5 °C skin temperature. */
PP.Wounds = function (W) {
  this.W = W;
  this.cuts = []; this.holes = []; this.punct = []; this.inj = [];
  this.N = 64; this.heat = new Float32Array(this.N * this.N).fill(32.5); this.heat2 = new Float32Array(this.N * this.N);
  this.T0 = 32.5;
  this.compress = null;     // {x,y,r} while the compress is held
  this.press = [];          // gauze pressure discs this frame {x,y,r}
  this.strokeId = 0;
  this.bleedVol = 0;
};

PP.Wounds.prototype.reset = function () {
  this.cuts.length = 0; this.holes.length = 0; this.punct.length = 0; this.inj.length = 0; this.heat.fill(this.T0);
};

PP.Wounds.prototype.depthLimits = function () {
  const A = this.W.area;
  return { epi: A.epi, dermis: A.dermis, total: A.dermis + 6 };
};

// lesions whose cavity this wound reaches; opens them
PP.Wounds.prototype.openLesions = function (x, y, rOpen, depth, kind, len, cx, cy, gape) {
  for (const L of this.W.lesions) {
    const lx = L.x + L.ox, ly = L.y + L.oy;
    const d = Math.hypot(x - lx, y - ly);
    const T = L.T;
    if (d > Math.max(L.R * 0.75, 0.6)) continue;
    const reach = T.open === 'open' ? 0 : Math.max(L.roofT * 0.8, 0.03);
    if (depth < reach) {
      if (kind === 'needle' && T.roofT > 0.2 && !L._needleWarn) { L._needleWarn = 1; this.W.fx.toast('warn', 'Too deep for a needle prick', 'This roof is ' + L.roofT.toFixed(1) + ' mm thick. Use the #11 blade (or let it point first).'); }
      continue;
    }
    if (kind === 'needle' && L.type === 'dpow') L.open.r = Math.max(L.open.r, L.open.r * 1.25);
    const prev = L.open.r;
    L.open.r = Math.max(L.open.r, rOpen);
    L.open.L = Math.max(0.03, Math.min(L.roofT, 1.5));
    L.open.kind = L.open.kind || kind;
    if (len) { L.incLen = Math.max(L.incLen || 0, len); L.incCx = (cx || x) - lx; L.incCy = (cy || y) - ly; L.open.w = Math.max(L.open.w || 0, Math.min(len, L.d)); L.open.h = Math.max(L.open.h || 0, Math.max(gape || 0, 0.12)); }
    if (L.T.mobile && len) L.open.r = Math.max(L.open.r, 0.6);
    if (prev <= 0 && L.open.r > 0) {
      L.state = L.state === 'intact' ? 'opened' : L.state; L.events.push('opened:' + kind);
      // what the blade finds depends on the lesion
      const blade = kind === 'blade11' || kind === 'blade15' || kind === 'punch';
      if (blade && L.queue.length) L.incisionRelease(this.W.ctx, kind);
      if (blade && L.solid() && !L._solidCut) { L._solidCut = 1; this.W.fx.toast('warn', 'Nothing to drain', 'This is solid inflammation, not a cavity: the cut only bleeds (MSD). Leave it, or inject steroid.'); }
      // injecting into / incising a pressurised abscess: pus wells up immediately
      if ((L.type === 'furuncle' || L.type === 'carbuncle' || L.type === 'pseudocyst' || L.type === 'giant') && L.P > 2) L.surfaceRuptureLike = true;
      if (L.hair && kind === 'needle') { /* tip still embedded until lifted */ }
      this.W.fx.opened(L, kind);
    }
  }
};

PP.Wounds.prototype.addPuncture = function (x, y, depth) {
  const r = 0.16 + 0.06 * this.W.rng();
  this.punct.push({ x, y, r, depth, t: this.W.clock, clot: 0, acc: 0 });
  if (this.punct.length > 40) this.punct.shift();
  this.openLesions(x, y, PP.clamp(0.2, 0.15, 0.3), depth, 'needle');
  this.W.pain(x, y, 0.25);
};

// a blade stroke segment; consecutive segments of one stroke merge into one cut
PP.Wounds.prototype.addCut = function (ax, ay, bx, by, depthAdd, blade, stroke) {
  const len = Math.hypot(bx - ax, by - ay);
  if (len < 0.05) return null;
  const lim = this.depthLimits();
  let c = this.cuts.find((k) => k.stroke === stroke);
  if (c) {
    // extend (straight-ish strokes) or start a new one if direction changes a lot
    const dx = bx - c.bx, dy = by - c.by;
    const cd = Math.hypot(c.bx - c.ax, c.by - c.ay) + 1e-6;
    const dot = ((c.bx - c.ax) * dx + (c.by - c.ay) * dy) / (cd * (Math.hypot(dx, dy) + 1e-6));
    if (dot > 0.8 || cd < 0.3) { c.bx = bx; c.by = by; }
    else { c = null; }
  }
  if (!c) {
    // a second pass along an existing cut deepens it
    const ex = this.cuts.find((k) => this.segDist(k, (ax + bx) / 2, (ay + by) / 2) < 0.35 && k.stroke !== stroke);
    if (ex) { ex.depth = Math.min(lim.total, ex.depth + depthAdd); ex.stroke = stroke; this.updCut(ex); return ex; }
    c = { ax, ay, bx, by, depth: 0, t: this.W.clock, clot: 0, acc: 0, stroke, blade, id: ++this.strokeId };
    this.cuts.push(c);
    if (this.cuts.length > 16) this.cuts.shift();
  }
  c.depth = Math.min(blade === 'blade11' ? Math.max(c.depth, depthAdd) : lim.total, Math.max(c.depth, depthAdd));
  this.updCut(c);
  this.W.pain((ax + bx) / 2, (ay + by) / 2, 0.55 * len);
  return c;
};
PP.Wounds.prototype.updCut = function (c) {
  const lim = this.depthLimits();
  const len = Math.hypot(c.bx - c.ax, c.by - c.ay);
  const dx = (c.bx - c.ax) / (len + 1e-6), dy = (c.by - c.ay) / (len + 1e-6);
  c.len = len; c.dx = dx; c.dy = dy;
  c.gape = this.W.phys.cutGape(dx, dy, len / 2, c.depth / lim.dermis);
  const mx = (c.ax + c.bx) / 2, my = (c.ay + c.by) / 2;
  const rEq = Math.sqrt((len * Math.max(c.gape, 0.22 * len)) / Math.PI);
  // any lesion the cut crosses gets an opening; the cut remembers what it went through
  for (const L of this.W.lesions) {
    const d = this.segDist(c, L.x + L.ox, L.y + L.oy);
    if (d >= Math.max(L.R * 0.6, 0.6)) continue;
    if (!c.L || L.R > c.L.R) { c.L = L; c.layer = PP.CUTLAYER[L.type] || 0; c.layerZ = Math.max(L.roofT, 0.05); }
    c.inflam = Math.max(c.inflam || 0, L.inflam + (L.deep || 0) * 0.4);
    if (L.T.open === 'open' && (c.blade === 'blade11' || c.blade === 'blade15') && !L._openCut) { L._openCut = 1; this.W.fx.toast('warn', 'Already open', 'A blackhead has its own pore: cutting only adds a wound. Use the comedone loop.'); }
    this.openLesions(L.x + L.ox, L.y + L.oy, Math.min(rEq, 2.2), c.depth, c.blade, len, mx, my, c.gape);
  }
};
PP.Wounds.prototype.segDist = function (c, x, y) {
  const vx = c.bx - c.ax, vy = c.by - c.ay, l2 = vx * vx + vy * vy + 1e-9;
  const t = PP.clamp(((x - c.ax) * vx + (y - c.ay) * vy) / l2, 0, 1);
  return Math.hypot(c.ax + vx * t - x, c.ay + vy * t - y);
};

PP.Wounds.prototype.addPunch = function (x, y, a, depth) {
  const h = this.W.phys.holeRadii(a);
  let hole = this.holes.find((k) => Math.hypot(k.x - x, k.y - y) < 0.5);
  if (!hole) { hole = { x, y, r: a, depth: 0, t: this.W.clock, clot: 0, acc: 0, core: true, along: h.along, across: h.across }; this.holes.push(hole); if (this.holes.length > 8) this.holes.shift(); }
  hole.depth = Math.max(hole.depth, depth);
  this.openLesions(x, y, a * 0.9, hole.depth, 'punch');
  this.W.pain(x, y, 0.4);
  return hole;
};

PP.Wounds.prototype.inject = function (x, y, kind, vol) {
  let j = this.inj.find((k) => k.kind === kind && Math.hypot(k.x - x, k.y - y) < 2.5);
  if (!j) { j = { x, y, kind, vol: 0, t: this.W.clock }; this.inj.push(j); if (this.inj.length > 8) this.inj.shift(); }
  j.vol = Math.min(3, j.vol + vol);
  return j;
};
// anaesthesia 0..1 and epinephrine vasoconstriction 0..1 at a point
PP.Wounds.prototype.anesth = function (x, y) {
  let a = 0;
  for (const j of this.inj) {
    if (j.kind !== 'lido') continue;
    const age = this.W.clock - j.t, R = 5 + 4 * j.vol;
    const d = Math.hypot(x - j.x, y - j.y);
    a = Math.max(a, (1 - Math.exp(-age / 45)) * PP.clamp(j.vol / 0.6, 0, 1) * (1 - PP.smooth(R * 0.6, R, d)));
  }
  // acidic, hyperaemic abscess tissue: less un-ionised lidocaine and faster washout
  for (const L of this.W.lesions) {
    if ((L.type === 'furuncle' || L.type === 'carbuncle' || L.type === 'pseudocyst') && !L.drained && Math.hypot(x - L.x, y - L.y) < L.R) { a *= 0.45; break; }
  }
  return a;
};
PP.Wounds.prototype.epi = function (x, y) {
  let e = 0;
  for (const j of this.inj) {
    if (j.kind !== 'lido') continue;
    const age = this.W.clock - j.t, R = 5 + 4 * j.vol;
    const d = Math.hypot(x - j.x, y - j.y);
    e = Math.max(e, (1 - Math.exp(-age / 280)) * PP.clamp(j.vol / 0.6, 0, 1) * (1 - PP.smooth(R * 0.5, R, d)));
  }
  return e;
};

PP.Wounds.prototype.heatAt = function (x, y) {
  const s = this.W.area.size, N = this.N;
  const gx = PP.clamp(((x / s) + 0.5) * N - 0.5, 0, N - 1.001), gy = PP.clamp(((y / s) + 0.5) * N - 0.5, 0, N - 1.001);
  const ix = Math.floor(gx), iy = Math.floor(gy), fx = gx - ix, fy = gy - iy;
  const h = this.heat, i = iy * N + ix;
  return (h[i] * (1 - fx) + h[i + 1] * fx) * (1 - fy) + (h[i + N] * (1 - fx) + h[i + N + 1] * fx) * fy;
};
PP.Wounds.prototype.stepHeat = function (dt) {
  const N = this.N, s = this.W.area.size, cell = s / N;
  const D = 0.14;                         // mm^2/s (tissue thermal diffusivity ~0.1–0.15)
  const steps = Math.min(40, Math.ceil(dt / 0.25));
  const h = dt / steps;
  for (let k = 0; k < steps; k++) {
    const a = this.heat, b = this.heat2;
    const lam = Math.min(0.24, (D * h) / (cell * cell));
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
      const i = y * N + x;
      const l = a[y * N + Math.max(0, x - 1)], r = a[y * N + Math.min(N - 1, x + 1)];
      const u = a[Math.max(0, y - 1) * N + x], d = a[Math.min(N - 1, y + 1) * N + x];
      let v = a[i] + lam * (l + r + u + d - 4 * a[i]);
      v += (this.T0 - v) * (h / 120);                 // perfusion carries heat away (~2 min)
      if (this.compress) {
        const wx = (x + 0.5) * cell - s / 2, wy = (y + 0.5) * cell - s / 2;
        const dd = Math.hypot(wx - this.compress.x, wy - this.compress.y);
        if (dd < this.compress.r) v += (41 - v) * (h / 25);   // warm moist compress ~41 °C
      }
      b[i] = v;
    }
    this.heat = b; this.heat2 = a;
  }
};

PP.Wounds.prototype.pressureAt = function (x, y) {
  let p = 0;
  for (const g of this.press) { const d = Math.hypot(x - g.x, y - g.y); if (d < g.r) p = Math.max(p, g.k); }
  for (const c of this.W.phys.contacts) { if (c.fn > 0.3 && Math.hypot(x - c.x, y - c.y) < c.a) p = Math.max(p, 0.6); }
  return p;
};

// bleeding: spawn blood droplets along wounds
PP.Wounds.prototype.stepBleed = function (dt) {
  const W = this.W, S = W.S, P = W.parts;
  const lim = this.depthLimits();
  // clotting progresses once per wound per frame; gauze pressure roughly triples the rate
  const clot = (el, x, y) => { const press = this.pressureAt(x, y); el.clot = Math.min(1, el.clot + (dt / 240) * (press > 0.5 ? 3 : 1)); return press; };
  // emitted volume (µL) -> number of droplets of radius rd
  const emit = (el, rate, rd, x, y, press) => {
    if (!S.blood) return 0;
    const e = this.epi(x, y);
    const q = rate * (1 - 0.85 * e) * (1 - el.clot) * (1 - 0.92 * press) * S.bloodAmt;
    el.acc += q * dt;
    const vd = (4 / 3) * Math.PI * rd * rd * rd;
    let n = 0;
    while (el.acc > vd && n < 6) { el.acc -= vd; n++; this.bleedVol += vd; }
    return n;
  };
  for (const c of this.cuts) {
    const mx = (c.ax + c.bx) / 2, my = (c.ay + c.by) / 2;
    const press = clot(c, mx, my);
    const deep = PP.clamp((c.depth - lim.epi) / (lim.dermis * 0.6), 0, 1.5);
    if (deep <= 0) continue;
    const n = emit(c, (1 + 1.5 * (c.inflam || 0)) * 0.18 * c.len * deep, 0.13, mx, my, press);   // µL/s per mm at dermal depth (cal)
    for (let k = 0; k < n; k++) {
      const t = W.rng(), side = W.rng() < 0.5 ? -1 : 1;
      const x = PP.lerp(c.ax, c.bx, t) - c.dy * side * c.gape * 0.5, y = PP.lerp(c.ay, c.by, t) + c.dx * side * c.gape * 0.5;
      // emptied cyst with an incision and no pressure: blood pools inside (hematoma, AAFP)
      const L = W.lesions.find((l) => l.drained && l.V0 > 200 && Math.hypot(l.x - x, l.y - y) < l.R && press < 0.3);
      if (L && W.rng() < 0.6) { L.hematoma = Math.min(L.R * 0.25, L.hematoma + 0.012); continue; }
      const i = P.spawn(x, y, 0.05, 0.13, PP.MAT.blood);
      if (i >= 0) P.setVel(i, 0, 0, 2, 1 / 120);
    }
  }
  for (const h of this.holes) {
    const press = clot(h, h.x, h.y);
    const n = emit(h, 0.5 * PP.clamp(h.depth / lim.dermis, 0, 1.3), 0.14, h.x, h.y, press);
    for (let k = 0; k < n; k++) {
      const a = W.rng() * Math.PI * 2;
      const i = P.spawn(h.x + Math.cos(a) * h.along * 0.9, h.y + Math.sin(a) * h.across * 0.9, 0.05, 0.14, PP.MAT.blood);
      if (i >= 0) P.setVel(i, 0, 0, 2, 1 / 120);
    }
  }
  for (const p of this.punct) {
    const press = clot(p, p.x, p.y);
    const n = emit(p, 0.025 * PP.clamp(p.depth / 0.3, 0.2, 2), 0.11, p.x, p.y, press);
    for (let k = 0; k < n; k++) { const i = P.spawn(p.x, p.y, 0.05, 0.11, PP.MAT.blood); if (i >= 0) P.setVel(i, 0, 0, 1, 1 / 120); }
  }
  for (const L of W.lesions) {
    if (L.bleedOpen <= 0 || L.open.r <= 0) continue;
    const el = L._bleedEl || (L._bleedEl = { clot: 0, acc: 0 });
    const press = clot(el, L.x, L.y);
    if (L.Pext > 6) el.clot = Math.max(0, el.clot - dt * 0.5);   // squeezing re-opens capillaries
    const n = emit(el, 0.35 * L.bleedOpen * (0.5 + L.inflam), 0.12, L.x, L.y, press);
    for (let k = 0; k < n; k++) { const i = P.spawn(L.x + L.ox, L.y + L.oy, L.domeH() + 0.1, 0.12, PP.MAT.blood); if (i >= 0) P.setVel(i, 0, 0, 6, 1 / 120); }
    L.bleedOpen = Math.max(0, L.bleedOpen - dt * 0.05);
  }
};
