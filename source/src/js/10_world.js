'use strict';
/* World: simulation state + orchestration. */
PP.World = function () {
  const W = this;
  this.S = Object.assign({ blood: true, bloodAmt: 1, lens: true, surgical: true, pain: true, sound: true, spurt: 1.6, ooze: 1.4, shield: false, ring: true, preset: 'max' }, PP.storage.get('settings', {}));
  this.S.shield = false;
  this.phys = new PP.Phys();
  this.parts = new PP.Particles(7000);
  this.wounds = new PP.Wounds(this);
  this.decals = new PP.Decals(this);
  this.lesions = [];
  this.tools = new PP.Tools(this);
  this.audio = new PP.Audio();
  this.clock = 0; this.time = 0;
  this.seed = +(PP.params.get('seed') || Math.floor(Math.random() * 1e9));
  this.rng = PP.rng(this.seed);
  this.toneIdx = PP.storage.get('tone', 1);
  this.areaId = PP.params.get('area') || PP.storage.get('area', 'cheek');
  if (!PP.AREAS[this.areaId]) this.areaId = 'cheek';
  this.cam = { x: 0, y: 0, zoom: 1, vw: 24, vh: 15, cw: 1, ch: 1, shake: 0, sx: 0, sy: 0,
    update(w, h) { this.cw = w; this.ch = h; this.vw = W.area.view / this.zoom; this.vh = (this.vw * h) / w; } };
  this.envYaw = -0.55; this.exposure = 1.0; this.keyDir = [-0.58, 0.52, 0.62];
  this.reliefK = 1; this.detScale = 0.6; this.detAmt = 0.6;
  this.stats = { pops: 0, vol: 0, perfect: 0, deep: 0, flinch: 0, bruise: 0 };
  this.painLevel = 0;
  this.activeLesion = null;
  this.gravity = [0, -9000, -3000];
  this.lensZ = 125;
  this.grid = { n: 0 };
  this.ctx = { phys: this.phys, parts: this.parts, S: this.S, heatAt: (x, y) => this.wounds.heatAt(x, y), skinH: (x, y) => this.visH(x, y), fx: null, rng: this.rng, clock: 0 };
};

PP.World.prototype.setArea = function (id) {
  this.areaId = id; this.area = PP.AREAS[id];
  this.phys.setArea(this.area);
  const g = this.area.grav;
  this.gravity = [g[0] * 9810, g[1] * 9810, g[2] * 9810];
  const base = this.area.base || id, bodySkin = this.area.set === 'body';
  this.detScale = bodySkin ? 1.0 : 0.55;
  this.detAmt = bodySkin ? 0.35 : 0.22;
  this.reliefK = base === 'nose' ? 1.5 : 1.35;
  PP.storage.set('area', id);
};

// tone means (melanin, hemoglobin, shade) solved from a target sRGB colour in optical density space
PP.World.prototype.setTone = function (i) {
  this.toneIdx = i; PP.storage.set('tone', i);
  const lin = PP.hex2lin(PP.TONES[i].hex);
  const OD = lin.map((c) => -Math.log(Math.max(c, 1e-3)));
  const B = this.manifest.basis;
  const M = [B.melanin[0], B.hemoglobin[0], B.shade[0], B.melanin[1], B.hemoglobin[1], B.shade[1], B.melanin[2], B.hemoglobin[2], B.shade[2]];
  const inv = PP.inv3(M);
  const m = inv[0] * OD[0] + inv[1] * OD[1] + inv[2] * OD[2];
  const h = inv[3] * OD[0] + inv[4] * OD[1] + inv[5] * OD[2];
  const s = inv[6] * OD[0] + inv[7] * OD[1] + inv[8] * OD[2];
  this.tone = { mean: new Float32Array([m, h - this.area.red, s]), amp: new Float32Array([0.02 + 0.035 * m, 0.02, 0.08]) };
  this.skinLin = lin;
};
PP.World.prototype.skinColLin = function () { return this.skinLin || [0.7, 0.5, 0.4]; };

PP.World.prototype.newPatch = function (seed) {
  if (seed != null) this.seed = seed;
  this.rng = PP.rng(this.seed); this.ctx.rng = this.rng;
  this.parts.clear(); this.wounds.reset(); this.decals.reset(); this.phys.clearGhosts();
  this.lesions = []; this.clock = 0; this.ctx.clock = 0;
  this.render.setupWorld();
  this.lesions = this.genLesions(this.area, this.rng);
  // a new patch keeps your view (zoom and position); only the centre is kept on the patch
  const s = this.area.size / 2, C = this.cam;
  C.x = PP.clamp(C.x, -s, s); C.y = PP.clamp(C.y, -s, s);
  C.tx = C.x; C.ty = C.y; C.tz = C.zoom; C.vxp = C.vyp = 0;
  this.activeUntil = this.time + 1;
  this.fx.patchChanged();
};
// scatter an area's typical blemish mix over its patch (big ones first, no overlaps)
PP.World.prototype.genLesions = function (A, rng, accept) {
  const out = [], placed = [];
  const tryPlace = (type, d, cl) => {
    const T = PP.LTYPES[type];
    if (!T) return;
    if (!this.S.surgical && ['epidermoid', 'pilar', 'lipoma', 'carbuncle', 'furuncle', 'steatocystoma', 'abscess', 'inflamedCyst'].includes(type)) return;
    for (let k = 0; k < 60; k++) {
      const span = A.size * 0.42;
      // clusters (Favre-Racouchot comedones, folliculitis) pack tightly around one centre
      const x = cl ? cl.x + rng.range(-cl.r, cl.r) : rng.range(-span, span) * (type === 'filament' ? 0.6 : 1);
      const y = cl ? cl.y + rng.range(-cl.r, cl.r) : rng.range(-span, span) * (type === 'filament' ? 0.6 : 1);
      if (cl && Math.hypot(x - cl.x, y - cl.y) > cl.r) continue;
      const R = (d || (T.d[0] + T.d[1]) / 2) / 2;
      const gap = cl ? 0.5 : type === 'filament' ? 0.8 : 2.5;
      const ok = placed.every((p) => Math.hypot(p.x - x, p.y - y) > p.R + R + Math.min(gap, p.gap != null ? p.gap : 2.5)) && (!accept || accept(x, y, R));
      if (ok) { const L = new PP.Lesion(out.length, type, x, y, rng, { d }); out.push(L); placed.push({ x, y, R: L.R, gap: cl ? 0.5 : null }); return; }
    }
  };
  const mix = A.mix.filter((m) => PP.LTYPES[m[0]]).sort((a, b) => PP.LTYPES[b[0]].d[1] - PP.LTYPES[a[0]].d[1]);
  for (const [type, n, opt] of mix) {
    if (opt && opt.cluster) {
      const span = A.size * 0.42 - opt.cluster / 2, cl = { x: rng.range(-span, span), y: rng.range(-span, span), r: opt.cluster / 2 };
      for (let k = 0; k < n; k++) tryPlace(type, null, cl);
    } else for (let k = 0; k < n; k++) tryPlace(type);
  }
  return out;
};

/* Per-area state: every area keeps its own blemishes, wounds, films and physiology field, so what you popped
   stays popped when you zoom out to the face and back in (loose particles are cleared on a switch). */
PP.World.prototype.ensureAreas = function () {
  this.areaStates = this.areaStates || {};
  for (const id of Object.keys(PP.AREAS)) {
    if (id === this.areaId || this.areaStates[id]) continue;
    let h = 2166136261; for (const c of id) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
    const seed = (this.seed ^ h) >>> 0;
    this.areaStates[id] = { seed, lesions: this.genLesions(PP.AREAS[id], PP.rng(seed)), gpu: null };
  }
};
PP.World.prototype.stashArea = function () {
  const R = this.render, Wd = this.wounds, D = this.decals;
  this.areaStates = this.areaStates || {};
  for (const L of this.lesions) {
    // particle chains do not survive a switch
    if (L.plug) { L.plug.chainTop = -1; L.plug.chainRoot = -1; L.plug.moving = false; }
    if (L.sac) L.sac.chain = -1;
    if (L.hair) L.hair.chain = -1;
    L.coreChain = -1;
  }
  this.areaStates[this.areaId] = {
    seed: this.seed, lesions: this.lesions,
    wounds: { cuts: Wd.cuts, holes: Wd.holes, punct: Wd.punct, inj: Wd.inj, heat: Wd.heat },
    decals: { patches: D.patches, dose: D.dose, gauzeCol: D.gauzeCol },
    gpu: R.physA ? { physA: R.physA, physB: R.physB, film: R.film } : null,
  };
  R.physA = R.physB = R.film = null;
  Wd.cuts = []; Wd.holes = []; Wd.punct = []; Wd.inj = []; Wd.heat = new Float32Array(Wd.N * Wd.N).fill(Wd.T0);
  D.patches = []; D.dose = new Map(); D.gauzeCol = [0.95, 0.95, 0.93];
  this.lesions = [];
};
// after setArea(): bring back the stored state of the new area (or make a fresh patch)
PP.World.prototype.restoreArea = function () {
  const R = this.render, st = this.areaStates && this.areaStates[this.areaId];
  this.parts.clear(); this.phys.contacts.length = 0; this.phys.clearGhosts(); this.activeLesion = null; R.drops.length = 0;
  if (!st) { this.newPatch(); return; }
  delete this.areaStates[this.areaId];
  if (st.gpu) { R.physA = st.gpu.physA; R.physB = st.gpu.physB; R.film = st.gpu.film; R.drops.length = 0; }
  else R.setupWorld();
  this.seed = st.seed; this.rng = PP.rng((st.seed + Math.floor(this.time * 1000)) >>> 0); this.ctx.rng = this.rng;
  this.lesions = st.lesions; this.lesions.forEach((L, i) => { L.id = i; });
  if (st.wounds) Object.assign(this.wounds, st.wounds);
  if (st.decals) Object.assign(this.decals, st.decals);
  this.cam.x = this.cam.y = 0; this.cam.tx = this.cam.ty = 0; this.cam.vxp = this.cam.vyp = 0;
  this.activeUntil = this.time + 1;
  this.fx.patchChanged();
};

PP.World.prototype.clearPatch = function () {
  this.phys.clearGhosts();
  this.parts.clear(); this.wounds.reset(); this.decals.reset(); this.render.setupWorld();
  this.lesions = []; this.fx.patchChanged();
};
PP.World.prototype.addLesion = function (type, x, y, d) {
  const L = new PP.Lesion(this.lesions.length, type, x, y, this.rng, { d });
  this.lesions.push(L); this.fx.patchChanged(); return L;
};

// skin height grid over the view (for particle collisions and tool placement)
PP.World.prototype.buildHeightGrid = function () {
  // one pass: dents + in-plane displacement per node; thickening (-Heff * div u) from grid differences
  const C = this.cam, G = this.grid, ph = this.phys;
  const nx = 56, ny = Math.max(20, Math.round((56 * C.vh) / C.vw));
  if (G.n !== nx * ny) { G.h = new Float32Array(nx * ny); G.ux = new Float32Array(nx * ny); G.uy = new Float32Array(nx * ny); G.lift = new Float32Array(nx * ny); G.n = nx * ny; }
  G.lift.fill(0); G.hasLift = false;
  G.nx = nx; G.ny = ny;
  const pad = 6;
  G.x0 = C.x - C.vw / 2 - pad; G.y0 = C.y - C.vh / 2 - pad; G.dx = (C.vw + 2 * pad) / (nx - 1); G.dy = (C.vh + 2 * pad) / (ny - 1);
  // live loads plus relaxing ones (viscoelastic recovery after release); ghosts are scaled by their decay
  const gk = ph.ghosts.length ? ph.ghostK() : 0;
  const cs = ph.contacts, gs = ph.ghosts, hasQ = cs.some((c) => c.qx || c.qy) || gs.some((c) => c.qx || c.qy);
  const tmp = [0, 0], fold = ph.foldNow();
  const load = (c, x, y, s) => {
    const r = Math.hypot(x - c.x, y - c.y);
    if (r > 6 * ph.Ld) return 0;
    let w = 0;
    if (c.fn) w += ph.dentW(c.fn * s, c.aV || c.a, r);
    if (c.suction) w -= ph.dentW(c.suction * s * 1e-3 * Math.PI * c.a * c.a, c.a, r) * 0.5;
    return w;
  };
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const x = G.x0 + i * G.dx, y = G.y0 + j * G.dy, k = j * nx + i;
    let w = 0;
    for (const c of cs) w += load(c, x, y, 1);
    for (const c of gs) w += load(c, x, y, gk);
    if (hasQ) {
      ph.uAt(x, y, tmp); G.ux[k] = tmp[0]; G.uy[k] = tmp[1];
      // (tmp is reused below for the relaxing loads)
      for (const c of gs) if (c.qx || c.qy) { tmp[0] = 0; tmp[1] = 0; ph.cerruti(c.qx * gk, c.qy * gk, c.a, x - c.x, y - c.y, tmp); G.ux[k] += tmp[0]; G.uy[k] += tmp[1]; }
    }
    G.h[k] = w + this.lesionH(x, y);
  }
  if (hasQ) for (let j = 1; j < ny - 1; j++) for (let i = 1; i < nx - 1; i++) {
    const k = j * nx + i;
    const div = (G.ux[k + 1] - G.ux[k - 1]) / (2 * G.dx) + (G.uy[k + nx] - G.uy[k - nx]) / (2 * G.dy);
    const th = -ph.Heff * div;
    G.h[k] += th;
    // large-deformation shape (pinch fold where it rises above the small-strain thickening, pad pile-up rims):
    // a visual lift drawn by the deformation pass and applied to everything resting on the skin there, so
    // extruded contents ride on the fold; the calibrated contact/flow physics keeps the small-strain surface
    const x = G.x0 + i * G.dx, y = G.y0 + j * G.dy;
    let lift = fold ? Math.max(0, fold.k * ph.foldW(x, y, fold.P) - Math.max(0, th)) : 0;
    for (const c of cs) if (c.pad && c.fn) lift += ph.pileUp(c, Math.hypot(x - c.x, y - c.y));
    for (const c of gs) if (c.pad && c.fn) lift += gk * ph.pileUp(c, Math.hypot(x - c.x, y - c.y));
    if (lift) { G.lift[k] = lift; G.hasLift = true; }
  }
};
PP.World.prototype.liftAt = function (x, y) {
  const G = this.grid;
  if (!G.hasLift) return 0;
  const fx = (x - G.x0) / G.dx, fy = (y - G.y0) / G.dy;
  if (fx < 0 || fy < 0 || fx >= G.nx - 1 || fy >= G.ny - 1) return 0;
  const i = Math.floor(fx), j = Math.floor(fy), u = fx - i, v = fy - j, n = G.nx, h = G.lift;
  return (h[j * n + i] * (1 - u) + h[j * n + i + 1] * u) * (1 - v) + (h[(j + 1) * n + i] * (1 - u) + h[(j + 1) * n + i + 1] * u) * v;
};
// the surface as drawn (physics surface + large-deformation lift)
PP.World.prototype.visH = function (x, y) { return this.skinH(x, y) + this.liftAt(x, y); };
PP.World.prototype.lesionH = function (x, y) {
  let h = 0;
  for (const L of this.lesions) {
    const dx = x - L.x - L.ox, dy = y - L.y - L.oy;
    const r2 = (dx * dx + dy * dy) / (L.R * L.R);
    if (r2 >= 1) continue;
    h += L.domeH() * Math.pow(1 - r2, 1.5);
  }
  return h;
};
PP.World.prototype.skinH = function (x, y) {
  const G = this.grid;
  const fx = (x - G.x0) / G.dx, fy = (y - G.y0) / G.dy;
  if (!G.h || fx < 0 || fy < 0 || fx >= G.nx - 1 || fy >= G.ny - 1) return this.lesionH(x, y);
  const i = Math.floor(fx), j = Math.floor(fy), u = fx - i, v = fy - j, n = G.nx;
  const h = G.h;
  return (h[j * n + i] * (1 - u) + h[j * n + i + 1] * u) * (1 - v) + (h[(j + 1) * n + i] * (1 - u) + h[(j + 1) * n + i + 1] * u) * v;
};

PP.World.prototype.pain = function (x, y, amt) {
  const an = this.wounds.anesth(x, y);
  this.painLevel = Math.min(1.6, this.painLevel + amt * (1 - an));
  if (this.S.pain && this.painLevel > 1 && !this._flinchCool) {
    this._flinchCool = 1.2;
    this.stats.flinch++;
    this.cam.shake = 0.25;
    // the tool slips: an extra cut segment if a blade is down
    const T = this.tools;
    if ((T.id === 'blade15' || T.id === 'blade11') && T.ptr.down) {
      const a = this.rng() * Math.PI * 2;
      this.wounds.addCut(T.ptr.x, T.ptr.y, T.ptr.x + Math.cos(a) * 1.5, T.ptr.y + Math.sin(a) * 1.5, 0.6, T.id, -this.rng());
    }
    this.fx.toast('bad', 'Patient flinched', 'That hurt: no local anaesthetic here. Infiltrate lidocaine around the site first, then use Wait for it to take effect.');
  }
};

PP.World.prototype.absorb = function (x, y, r, zmax) {
  const P = this.parts;
  for (let i = 0; i < P.hi; i++) {
    if (!P.alive[i]) continue;
    if (Math.hypot(P.x[i] - x, P.y[i] - y) > r || P.z[i] > zmax) continue;
    if (P.pin[i]) continue;
    const m = P.mat[i];
    if (P.isLiquid(m) || m === PP.MAT.pus || m === PP.MAT.keratin || m === PP.MAT.sebum || m === PP.MAT.oil || m === PP.MAT.fat || m === PP.MAT.molluscum) {
      this.decals.stain([P.cr[i], P.cg[i], P.cb[i]]);
      P.kill(i);
    }
  }
};

// whatever lies loose on the skin under the wipe (anything not still attached to its lesion) is picked up
PP.World.prototype.loose = function (i) {
  const P = this.parts;
  if (!P.alive[i] || P.pin[i]) return false;
  if ((P.next[i] >= 0 || P.prev[i] >= 0) && P.chainOf(i).some((k) => P.pin[k])) return false;
  return true;
};
PP.World.prototype.wipeAt = function (x, y, r, zmax) {
  const P = this.parts, T = this.tools, g = T.wipeCol, st = T.wipeStain;
  let n = 0;
  for (let i = 0; i < P.hi; i++) {
    if (!P.alive[i] || P.z[i] > zmax) continue;
    const reach = r + (P.isLiquid(P.mat[i]) && P.onSkin[i] ? 1.485 * P.r[i] : 0);
    if (Math.hypot(P.x[i] - x, P.y[i] - y) > reach || !this.loose(i)) continue;
    // the stain it leaves on the wipe: blood red, pus cream, serum straw (diluted by the saline), else its own colour
    const v = 4.19 * P.r[i] ** 3, fb = P.fb[i], fp = P.fp[i];
    const c = P.isLiquid(P.mat[i]) || P.mat[i] === PP.MAT.pus
      ? [PP.lerp(PP.lerp(0.93, 0.9, fp), 0.62, fb), PP.lerp(PP.lerp(0.88, 0.82, fp), 0.07, fb), PP.lerp(PP.lerp(0.68, 0.55, fp), 0.08, fb)]
      : [P.cr[i], P.cg[i], P.cb[i]];
    const w = v / (v + T.wipeVol + 0.3);
    for (let k = 0; k < 3; k++) st[k] = PP.lerp(st[k], c[k], w);
    T.wipeVol += v;
    P.kill(i); n++;
  }
  // it saturates with what it picks up but never goes muddy: at most ~3/4 of the way to the stain colour
  const s = 0.75 * (1 - Math.exp(-T.wipeVol / 5));
  for (let k = 0; k < 3; k++) g[k] = PP.lerp(0.94, st[k], s);
  if (n) this.activeUntil = this.time + 0.5;
  return n;
};
// a full wipe-down: loose material, pools and stains gone (an iodine prep stays)
PP.World.prototype.cleanSkin = function () {
  const P = this.parts;
  for (let i = 0; i < P.hi; i++) if (this.loose(i)) P.kill(i);
  this.render.brush(0, 0, this.area.size * 0.75, [1, 1, 1, 0], 'sub');
  this.activeUntil = this.time + 1;
};

PP.World.prototype.lensHit = function (i) {
  if (!this.S.lens) return;
  const P = this.parts, C = this.cam;
  const u = (P.x[i] - C.x) / C.vw + 0.5, v = (P.y[i] - C.y) / C.vh + 0.5;
  if (u < -0.1 || u > 1.1 || v < -0.1 || v > 1.1) return;
  const m = P.mat[i] === PP.MAT.blood || P.mat[i] === PP.MAT.bloodyPus ? 0 : P.mat[i] === PP.MAT.serum ? 2 : 1;
  this.render.drops.push({ u, v, r: PP.clamp(P.r[i] * 0.09, 0.012, 0.07), a: 0.95, m, vy: 0 });
  if (this.render.drops.length > 24) this.render.drops.shift();
  if (!this._lensToast) { this._lensToast = 1; this.fx.toast('warn', 'On the lens', 'Spray reached the camera. Hold gauze loosely over the site (Shift-click with gauze) or wipe the lens.'); }
};

PP.World.prototype.particleWorld = function () {
  const W = this;
  if (this._pw) return this._pw;
  this._pw = {
    area: null, gravity: null, lensZ: this.lensZ,
    skinH: (x, y) => W.skinH(x, y),
    onLens: (i) => W.lensHit(i),
    onSettle: (i) => {
      const P = W.parts, kind = P.fb[i] > 0.3 ? 'blood' : P.fp[i] > 0.5 ? 'pus' : 'serum';
      W.decals.paint(P.x[i], P.y[i], P.r[i] * 1.6, kind, 1);
    },
    // the thin film a running bead leaves behind: a continuous wet stain along its path
    onTrail: (i, dist, w) => {
      const P = W.parts, kind = P.fb[i] > 0.3 ? 'blood' : P.fp[i] > 0.5 ? 'pus' : 'serum';
      W.decals.paint(P.x[i], P.y[i], w * 0.36, kind, PP.clamp(dist * 3, 0.15, 0.6));
    },
    onBreak: () => {},
    colliders: [],
  };
  // splatter shield: loose gauze over the active lesion catches anything rising through it
  this._pw.colliders.push((i, P) => {
    if (!W.S.shield || !W.activeLesion || P.pin[i]) return;
    const L = W.activeLesion;
    if (P.z[i] > 8.5 && P.z[i] < 12 && Math.hypot(P.x[i] - L.x, P.y[i] - L.y) < Math.max(L.R * 2.2, 6)) { W.decals.stain([P.cr[i], P.cg[i], P.cb[i]]); P.kill(i); }
  });
  return this._pw;
};

// one simulation step (dt seconds, real time)
PP.World.prototype.step = function (dt) {
  this.time += dt; this.clock += dt; this.ctx.clock = this.clock;
  this.tools.update(dt);
  this.ctx.toolId = this.tools.id;
  // the collision surface only needs refreshing once per displayed frame
  if (this.time - (this._gridT || -1) >= 1 / 60) { this.buildHeightGrid(); this._gridT = this.time; }
  // active lesion = the one nearest the pointer
  const p = this.tools.ptr;
  let best = null, bd = 1e9;
  for (const L of this.lesions) { const d = Math.hypot(p.x - L.x - L.ox, p.y - L.y - L.oy) - L.R; if (d < bd) { bd = d; best = L; } }
  this.activeLesion = bd < 6 ? best : null;
  for (const L of this.lesions) L.update(dt, this.ctx);
  for (const L of this.lesions) if (L.suck) { /* suction helps open pores: handled through pressure */ }
  this.wounds.stepHeat(dt);
  this.wounds.stepBleed(dt);
  const pw = this.particleWorld();
  pw.area = this.area; pw.gravity = this.gravity;
  const sub = 2;
  for (let k = 0; k < sub; k++) this.parts.step(dt / sub, pw);
  // thin films evaporate: wetness fades over a few minutes (blood stains stay, darkening as they dry)
  this._evap = (this._evap || 0) + dt;
  if (this._evap > 0.7) { this._evap = 0; this.render.brush(0, 0, this.area.size * 0.75, [0, 0, 1 / 255, 0], 'sub'); }
  // pain decays; flinch cooldown
  this.painLevel = Math.max(0, this.painLevel - dt * 0.35);
  if (this._flinchCool) this._flinchCool = Math.max(0, this._flinchCool - dt);
  // lens droplets run down slowly
  for (const d of this.render.drops) { d.vy = Math.min(d.vy + dt * 0.002 * d.r * 40, 0.02); d.v -= d.vy * dt; d.a = Math.max(0, d.a - dt * 0.004); }
  this.render.drops = this.render.drops.filter((d) => d.v > -0.2 && d.a > 0.05);
  // stats
  let vol = 0; for (const L of this.lesions) vol += L.ext; this.stats.vol = vol;
  // camera shake
  if (this.cam.shake > 0) { this.cam.shake = Math.max(0, this.cam.shake - dt); }
};

// time-lapse: advance slow processes by sec seconds
PP.World.prototype.timelapse = function (sec) {
  const steps = 24, dt = sec / steps;
  for (let k = 0; k < steps; k++) {
    this.clock += dt; this.ctx.clock = this.clock;
    for (const L of this.lesions) L.slow(dt, this.ctx);
    for (const el of [...this.wounds.cuts, ...this.wounds.holes, ...this.wounds.punct]) el.clot = Math.min(1, el.clot + dt / 240);
    this.wounds.stepHeat(Math.min(dt, 600));
  }
  // settle all loose liquid into the skin film; dry films
  const P = this.parts;
  for (let i = 0; i < P.hi; i++) if (P.alive[i] && P.isLiquid(P.mat[i]) && !P.pin[i]) { this.particleWorld().onSettle(i); P.kill(i); }
  this.render.brush(0, 0, this.area.size, [0, 0, Math.min(1, sec / 600), 0], 'sub');
  this.render.timelapseDt = sec;
  this.fx.toast('', 'Time-lapse ' + PP.fmtClock(sec).replace('+', ''), 'Clinic clock ' + PP.fmtClock(this.clock) + '. Anaesthetic onset, clotting, healing and steroid response advanced.');
  this.fx.patchChanged();
};
