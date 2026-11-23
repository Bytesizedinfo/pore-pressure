'use strict';
/* Lesion cavity model.
   Pressure: contact loads reach the cavity via Boussinesq stress at depth + lateral compression (PP.Phys).
   Rupture: thin-shell (Laplace) stress sigma = P*R/(2t) in the roof vs the follicle/cyst wall. Whichever exceeds
   its strength first fails: roof -> surface pop; wall -> deep rupture into the dermis (AAD/AAFP behaviour).
   Contents leave through the opening according to their rheology (PP.flow), or as plugs (stick-slip,
   temperature-dependent friction), pearls, lobules, cores, hairs and sacs. */

PP.Lesion = function (id, type, x, y, rng, opt = {}) {
  const T = PP.LTYPES[type];
  this.id = id; this.type = type; this.T = T;
  this.x = x; this.y = y; this.ox = 0; this.oy = 0;
  this.seed = rng();
  const d = opt.d || rng.range(T.d[0], T.d[1]);
  this.d = d; this.R = d / 2;
  this.H0 = T.hf * this.R;
  const sizeK = d / ((T.d[0] + T.d[1]) / 2);
  this.depth = T.depth * Math.sqrt(sizeK);
  this.rc = T.cav * this.R;
  this.roofT = T.roofT * (0.85 + 0.3 * rng()); this.wallT = T.wallT;
  this.roofS = T.roofS * (0.85 + 0.3 * rng()); this.wallS = T.wallS * (0.85 + 0.3 * rng());
  this.inflam = { pustule: 0.55, giant: 0.6, furuncle: 0.9, carbuncle: 0.95, pseudocyst: 0.75, papule: 0.6, nodule: 0.8,
    ingrown: 0.45, molluscum: 0.05, sebhyper: 0.08, epidermoid: 0.05, pilar: 0, steatocystoma: 0.03, lipoma: 0,
    whitehead: 0.05, macrocomedone: 0.08, blackhead: 0.02, dpow: 0.03, trichostasis: 0.02, filament: 0, milium: 0 }[type] || 0;
  this.inflam *= 0.8 + 0.4 * rng();
  // contents
  let V0 = (4 / 3) * Math.PI * Math.pow(this.rc, 3) * 0.85;
  this.plug = null;
  if (T.contents.length && T.contents[0].k === 'plug') {
    const L = rng.range(T.plugL[0], T.plugL[1]) * Math.sqrt(sizeK);
    const pr = (T.openR || this.R * 0.35) * (T.vis === 1 || T.vis === 2 ? 0 : 1) || this.R * 0.32;
    this.plug = { L, r: Math.max(pr, this.R * 0.3), ext: 0, moving: false, out: false, tip: T.contents[0].tip, tuft: T.contents[0].tuft, stiff: T.contents[0].stiff, soft: T.contents[0].soft, chainTop: -1, chainRoot: -1 };
    V0 = Math.PI * this.plug.r * this.plug.r * L;
  }
  if (type === 'milium') V0 = (4 / 3) * Math.PI * Math.pow(this.rc, 3);
  if (type === 'lipoma') V0 = (4 / 3) * Math.PI * Math.pow(this.rc, 3) * 0.7;
  this.V0 = V0; this.V = V0;
  this.queue = T.contents.map((c) => Object.assign({}, c, { vol: c.f * V0 }));
  this.qi = 0;
  // pus colour variation: white-yellow, occasionally greenish (myeloperoxidase / pyocyanin) or blood-tinged
  const pr = rng();
  this.pusCol = pr < 0.08 ? PP.hex2lin('#dcd9a2') : pr < 0.2 ? PP.hex2lin('#ead0b2') : PP.hex2lin(rng() < 0.5 ? '#efe4b8' : '#ecdca8');
  // openings
  this.open = { r: 0, L: Math.max(this.roofT, 0.03), kind: '' };
  if (T.open === 'open') this.open = { r: T.openR * Math.sqrt(sizeK), L: 0.05, kind: 'pore' };
  if (T.open === 'punctum') this.punctum = T.openR;
  if (T.open === 'umbil') this.punctum = T.openR;
  this.P = 0; this.Pext = 0; this.Pcov = 0;
  this.state = 'intact';
  this.deep = 0; this.drained = false; this.popped = false;
  this.ext = 0;           // extracted volume (µL)
  this.irrit = 0; this.crater = 0; this.hematoma = 0; this.scab = 0; this.heal = 0;
  this.steroidT = -1; this.spreadFlag = false; this.recur = false;
  this.pointing = T.point ? 0.15 : 0;
  this.bleedOpen = 0;
  this.sac = T.sac ? { tear: T.sac.tear, integrity: 1, out: 0, chain: -1, frags: 0, ready: false, done: false } : null;
  this.lig = type === 'lipoma' && d > 30;   // retaining ligaments (large lipomas)
  this.pockets = T.pockets || 0;            // carbuncle loculations
  this.heads = [];
  if (T.heads) for (let k = 0; k < T.heads; k++) {
    const a = rng() * Math.PI * 2, rr = this.R * rng.range(0.15, 0.45);
    this.heads.push([Math.cos(a) * rr, Math.sin(a) * rr]);
  }
  this.hair = T.hair ? { angle: rng() * Math.PI * 2, freed: false, out: false, len: rng.range(5, 11), chain: -1 } : null;
  this.coreOut = false; this.coreChain = -1;
  this.done = false; this.bad = false;
  this.lastSq = 0;          // seconds since last squeeze (for tests / UI)
  this.Pmax = 0;
  this.events = [];
};

// volumetric flow (µL/s) through the current opening. Incisions are slits: Q = w h^3 dP / (12 mu L)
// (h = gape + hemostat spread); round openings use Hagen–Poiseuille. Both capped by the inertial
// (Bernoulli) limit Q <= A sqrt(2 dP / rho).
PP.Lesion.prototype.flowQ = function (c, dP, rRound) {
  const o = this.open;
  let Q, A;
  if (o.w && rRound == null) {
    const h = Math.max(o.h || 0.12, 0.05) + (this.spread || 0);
    let drive = dP;
    if (c.k === 'paste') { drive = dP - (2 * (c.ty || 0) * Math.max(o.L, 0.05)) / (h / 2); if (drive <= 0) return 0; }
    Q = (o.w * h * h * h * drive * 1e6) / (12 * (c.mu || 1000) * Math.max(o.L, 0.05));
    A = o.w * h;
  } else {
    const r = rRound != null ? rRound : o.r;
    Q = PP.flow(c.k, dP, r, o.L, c.mu || 1000, c.ty);
    A = Math.PI * r * r;
  }
  return Math.min(Q, A * PP.jetSpeed(Math.max(dP, 0)));
};
PP.Lesion.prototype.ropen = function () {
  const o = this.open;
  if (o.w) { const h = Math.max(o.h || 0.12, 0.05) + (this.spread || 0); return Math.sqrt((o.w * h) / Math.PI); }
  return o.r;
};
PP.Lesion.prototype.fill = function () { return this.V0 > 0 ? PP.clamp(this.V / this.V0, 0, 1) : 0; };
PP.Lesion.prototype.cur = function () { return this.queue[this.qi]; };
PP.Lesion.prototype.solid = function () { return this.T.open === 'none' && !this.queue.length; };

// current visible dome height (mm)
PP.Lesion.prototype.domeH = function () {
  const f = this.queue.length ? this.fill() : 1;
  const press = 1 + (this.T.bulge != null ? this.T.bulge : 0.5) * PP.clamp(this.P / 30, 0, 1) * f;
  let h = this.H0 * press * (0.25 + 0.75 * f) * (1 + 0.35 * this.deep);
  if (this.type === 'dpow' || this.type === 'blackhead' || this.type === 'filament' || this.type === 'trichostasis') h = this.H0;
  if (this.steroidT >= 0) h *= PP.clamp(1 - this.steroidT / (2.5 * 86400), 0.15, 1);
  return h + this.hematoma * 0.6;
};

/* Per-frame update. ctx: {phys, parts, W, S (settings), heatAt, fx (callbacks), dt} */
PP.Lesion.prototype.update = function (dt, ctx) {
  const ph = ctx.phys, S = ctx.S, T = this.T;
  if (this.done && this.type !== 'molluscum') { this.P *= 0.9; }
  const cx = this.x + this.ox, cy = this.y + this.oy;
  const load = ph.cavityLoad(cx, cy, Math.max(this.depth, 0.08));
  const headR = Math.max(this.R * 0.45, 0.4);
  const coverNow = ph.roofCover(cx, cy, Math.min(headR, this.R * 0.6));
  // contact pressure on the roof relaxes with the same tissue lag as the cavity pressure (no release artefact)
  this.Pcov += (coverNow - this.Pcov) * (1 - Math.exp(-dt / 0.06));
  const cover = this.Pcov;
  // lipoma is mobile: contacts push it aside instead of pressurising it (unless an incision gives it somewhere to go)
  if (T.mobile) {
    let fx = 0, fy = 0;
    for (const c of ph.contacts) {
      if (!c.fn) continue;
      const dx = cx - c.x, dy = cy - c.y, dd = Math.hypot(dx, dy) + 1e-6;
      if (dd < this.R + c.a) { const k = (c.fn * (1 - dd / (this.R + c.a))) / dd; fx += dx * k; fy += dy * k; }
    }
    const lim = this.R * 0.28;
    const tx = PP.clamp(fx * 3, -lim, lim), ty = PP.clamp(fy * 3, -lim, lim);
    const opened = this.open.r > 0;
    this.ox = PP.lerp(this.ox, opened ? tx * 0.2 : tx, 1 - Math.exp(-dt / 0.15));
    this.oy = PP.lerp(this.oy, opened ? ty * 0.2 : ty, 1 - Math.exp(-dt / 0.15));
  }
  const f = this.queue.length ? this.fill() : 1;
  // intrinsic tension (tense pustules/boils) + transmitted load; Kelvin–Voigt-like lag
  const intrinsic = (this.type === 'giant' ? 5 : this.type === 'furuncle' || this.type === 'carbuncle' ? 3 : this.type === 'pseudocyst' ? 2 : 0.5) * f;
  let target = intrinsic + load.total * (0.25 + 0.75 * Math.pow(f, 0.6));
  if (T.mobile && this.open.r <= 0) target *= 0.15;
  // pore vacuum: reduced pressure over an open pore adds to the outward pressure difference
  target += this.suck || 0;
  // molluscum: picking/squeezing with fingers spreads the virus to nearby skin (autoinoculation)
  if (this.type === 'molluscum' && load.total > 3 && (ctx.toolId === 'fingers' || ctx.toolId === 'swabs') && !this.spreadFlag) { this.spreadFlag = true; this.spreadAt = ctx.clock; this.events.push('autoinoc'); }
  this.Pext = load.total;
  this.P += (target - this.P) * (1 - Math.exp(-dt / 0.06));
  this.Pmax = Math.max(this.Pmax, this.P);
  if (load.total > 4) { this.lastSq = 0; this.irrit = Math.min(1, this.irrit + dt * load.total * 0.0015); }
  else this.lastSq += dt;

  // --- rupture criteria (only for closed lesions) -------------------------------------
  if (this.open.r <= 0 && !this.done) {
    const H = Math.max(this.domeH(), 0.05);
    const a = Math.max(headR * 0.8, 0.3);
    const Rc = PP.clamp((a * a + H * H) / (2 * H), 0.3, 25);
    const tRoof = Math.max(this.roofT * (T.point ? (0.2 + 0.8 * (1 - this.pointing)) : 1), 0.02);
    const sRoof = T.roofS ? (Math.max(0, this.P - cover) * Rc) / (2 * tRoof) : 0;
    const sWall = (this.P * Math.max(this.rc, 0.2)) / (2 * this.wallT);
    const rRoof = T.roofS ? sRoof / this.roofS : 0, rWall = sWall / this.wallS;
    this.rRoof = rRoof; this.rWall = rWall;   // for the pop meter: how close the roof / the wall is to giving way
    if (rWall > 1 && rWall >= rRoof && this.deep < 1) this.deepRupture(ctx, cover > this.P * 0.6 ? 'covered' : 'closed');
    else if (rRoof > 1) this.surfaceRupture(ctx, Rc);
    // punctum: thick keratin may squeeze through the tiny opening (DermNet) before the wall fails
    if (this.punctum && this.open.r <= 0 && this.qi < this.queue.length) {
      const c = this.cur();
      const Q = this.flowQ(c, this.P, this.punctum) * S.ooze;
      if (Q > 0) this.emitFlow(ctx, Q, dt, this.punctum, true);
    }
  } else if (this.open.r > 0 && !this.done) {
    this.rRoof = 0; this.rWall = 0;
    // with an opening: excess compression fragments a thin cyst wall (AAFP / StatPearls)
    if (this.sac && this.sac.integrity > 0.2) {
      const sWall = (this.P * Math.max(this.rc, 0.2)) / (2 * this.wallT);
      if (sWall > this.wallS * 1.6) {
        this.sac.integrity = Math.max(0.15, this.sac.integrity - dt * 0.8);
        if (!this._fragWarn) { this._fragWarn = 1; ctx.fx.toast('warn', 'Wall fragmenting', 'Excess compression is breaking up the cyst wall. Pieces left behind can let it recur (AAFP).'); }
      }
    }
    this.expel(dt, ctx);
  }
  // solid lesions: squeezing only inflames
  if (this.solid() && load.total > 6) {
    this.inflam = Math.min(1.4, this.inflam + dt * 0.02 * load.total);
  }
  // physiology over (time-lapsed) time
  this.slow(dt, ctx);
};

PP.Lesion.prototype.surfaceRupture = function (ctx, Rc) {
  const S = ctx.S;
  this.popped = true; this.state = 'open';
  this.open.r = PP.clamp(0.1 + this.R * 0.09, 0.12, 0.55);
  this.open.L = Math.max(this.roofT, 0.04);
  this.open.kind = 'tear';
  this.events.push('pop');
  const c = this.cur();
  ctx.fx.pop(this, this.P);
  // stored pressure + low viscosity -> burst jet; thick pus -> small blob
  if (c && (c.k === 'liquid' || c.k === 'paste')) {
    // thin contents burst out as a jet; thick pus only bulges out of the tear (it extrudes, it doesn't spray)
    const thin = c.k === 'liquid' && (c.mu || 1) < 400;
    const v = PP.jetSpeed(this.P) * (thin ? 1 : 0.018) * S.spurt;
    const vol = Math.min(c.vol, this.V0 * (thin ? 0.35 : 0.02) * S.spurt);
    if (vol > 0) this.spray(ctx, vol, v, thin ? 0.55 : 0.25, c);
  }
  ctx.fx.toast('good', 'Pop', 'The roof gave way at the apex: the thin-shell stress in the roof exceeded its strength before the wall did.');
};

// a fresh incision into a pressurised lesion: the stored pressure drives contents out at once
// (thin contents gush along the cut; thick ones bulge into it)
PP.Lesion.prototype.incisionRelease = function (ctx, kind) {
  const c = this.cur(); if (!c || c.vol <= 0 || this.T.mobile) return;
  const intrinsic = this.type === 'giant' ? 5 : this.type === 'furuncle' || this.type === 'carbuncle' ? 3 : this.type === 'pseudocyst' ? 2 : 0;
  const Pst = Math.max(this.P, intrinsic * this.fill());
  if (Pst < 1.5 || (c.k !== 'liquid' && c.k !== 'paste')) return;
  const thin = c.k === 'liquid' && (c.mu || 1) < 400;
  const frac = PP.clamp(0.04 + Pst / 40, 0.04, thin ? 0.4 : 0.12);
  const vol = Math.min(c.vol, this.V0 * frac * ctx.S.spurt);
  if (vol <= 0) return;
  this.spray(ctx, vol, PP.jetSpeed(Pst) * (thin ? 0.5 : 0.02) * ctx.S.spurt, thin ? 0.5 : 0.2, c);
  this.events.push('gush');
  ctx.fx.toast('', thin ? 'Gush' : 'Contents bulge', thin ? 'The incision released the stored pressure at once: contents gushed out along the cut.' : 'Thick contents bulged straight into the fresh incision.');
};

PP.Lesion.prototype.deepRupture = function (ctx, why) {
  this.deep = Math.min(1, this.deep + 1); this.state = 'ruptured';
  this.events.push('deep');
  this.inflam = Math.min(1.5, this.inflam + 0.55);
  this.R *= 1.12; this.H0 *= 1.1;
  if (this.queue.length) { const lost = this.V * 0.45; this.V -= lost; const c = this.cur(); if (c) c.vol = Math.max(0, c.vol - lost); }
  this.roofT *= 1.35; this.roofS *= 1.3;
  this.bad = true;
  ctx.fx.deep(this);
  const reason = why === 'covered'
    ? 'Pressing straight on top seals the exit, so pressure loads the follicle wall instead. Contents spilled into the dermis (AAD).'
    : this.solid()
      ? 'There is nothing to drain here. Squeezing pushed inflamed material deeper into the dermis (AAD).'
      : 'Squeezing a closed lesion loaded the follicle wall until it gave way under the skin. Contents spilled into the dermis (AAD).';
  ctx.fx.toast('bad', 'Ruptured under the skin', reason);
};

// spray droplets (Bernoulli jet speed; Plateau–Rayleigh breakup into drops ~1.9x jet radius)
PP.Lesion.prototype.spray = function (ctx, vol, v, cone, c) {
  const P = ctx.parts, cx = this.x + this.ox, cy = this.y + this.oy;
  const rj = Math.max(this.open.r, 0.12);
  let rd = PP.clamp(1.9 * rj, 0.12, 0.45);
  const vd = (4 / 3) * Math.PI * rd * rd * rd;
  let n = Math.min(260, Math.max(3, Math.round(vol / vd)));
  rd = Math.cbrt((vol / n) / ((4 / 3) * Math.PI));
  const ax = ctx.rng() - 0.5, ay = ctx.rng() - 0.5;
  const col = this.contentCol(c);
  for (let k = 0; k < n; k++) {
    const th = Math.acos(1 - ctx.rng() * (1 - Math.cos(cone)));
    const phi = ctx.rng() * Math.PI * 2;
    let dx = Math.sin(th) * Math.cos(phi) + ax * 0.5, dy = Math.sin(th) * Math.sin(phi) + ay * 0.5, dz = Math.cos(th);
    const nn = Math.hypot(dx, dy, dz); dx /= nn; dy /= nn; dz /= nn;
    const sp = v * (0.55 + 0.45 * ctx.rng());
    const i = P.spawn(cx + dx * 0.2, cy + dy * 0.2, this.domeH() + 0.1, rd * (0.7 + 0.6 * ctx.rng()), c.m === 1 ? PP.MAT.pusThin : c.m, col);
    if (i >= 0) P.setVel(i, dx * sp, dy * sp, dz * sp, 1 / 120);
  }
  c.vol = Math.max(0, c.vol - vol); this.V = Math.max(0, this.V - vol); this.ext += vol;
  ctx.fx.spurt(this, v);
};

PP.Lesion.prototype.contentCol = function (c) {
  if (!c) return PP.hex2lin('#e9dba4');
  if (c.m === 1 || c.m === 2) return this.pusCol;
  return PP.hex2lin(PP.MATCOL[c.m] || '#ffffff');
};

// flow through the current opening
PP.Lesion.prototype.expel = function (dt, ctx) {
  const S = ctx.S, T = this.T;
  const blocked = this.Pcov > this.P * 0.8 && this.Pcov > 2;
  const plugIn = this.plug && !this.plug.out;
  if (this.qi >= this.queue.length || (this.V <= this.V0 * 0.003 && !plugIn)) {
    if (!this.drained && this.queue.length) {
      this.drained = true; this.state = 'drained'; this.events.push('drained');
      if (!this.sac && !this.hair && !(T.contents[0] && T.contents[0].k === 'core')) this.done = !this.bad;
      if (!this.plug) ctx.fx.toast('good', 'Drained', 'Contents fully expressed: ' + PP.fmtVol(this.ext) + '.');
    }
    // squeezing an empty cavity: capillaries in the inflamed wall bleed; trauma deepens the crater
    if (this.Pext > 8) {
      this.bleedOpen = Math.min(1, this.bleedOpen + dt * 0.5);
      this.crater = Math.min(0.6, this.crater + dt * 0.02 * (this.Pext / 20));
      this.irrit = Math.min(1, this.irrit + dt * 0.05);
      if (this.crater > 0.35 && !this._scarWarn) { this._scarWarn = 1; this.bad = true; ctx.fx.toast('bad', 'Over-squeezed', 'Nothing left to come out. Continued pressure is only bruising the follicle and deepening the crater (scar risk).'); }
    }
    this.sacUpdate(dt, ctx);
    return;
  }
  const c = this.cur();
  if (blocked) return;
  const dP = this.P;
  if (c.k === 'liquid' || c.k === 'paste') {
    let Q = this.flowQ(c, dP) * S.ooze;
    if (this.pockets > 0) Q *= 0.25;        // loculated: most pus is walled off until the pockets are opened
    if (T.mobile) Q = 0;
    if (Q > 0) this.emitFlow(ctx, Q, dt, this.ropen(), false);
  } else if (c.k === 'plug') this.plugUpdate(dt, ctx);
  else if (c.k === 'pearl') {
    if (dP > 5 && !this.blockedPearl) {
      const P = ctx.parts;
      const i = P.spawn(this.x + this.ox, this.y + this.oy, this.domeH() + this.rc, this.rc * 0.95, PP.MAT.pearl);
      if (i >= 0) P.setVel(i, (ctx.rng() - 0.5) * 60, (ctx.rng() - 0.5) * 60, 90, 1 / 120);
      this.ext += this.V; this.V = 0; c.vol = 0; this.qi++;
      this.done = true; this.events.push('pearl');
      ctx.fx.pop(this, dP * 0.5);
      ctx.fx.toast('good', 'Kernel out', 'The keratin pearl popped out whole once the roof was opened.');
    }
  } else if (c.k === 'core') {
    // molluscum core: expressible once opened; boil core: needs forceps (spawned protruding)
    if (this.type === 'molluscum') {
      if (dP > 4) this.spawnCore(ctx, true);
    } else if (!this.coreOut && this.qi === this.queue.length - 1) this.spawnCore(ctx, false);
  } else if (c.k === 'lobule') this.lipomaUpdate(dt, ctx);
  this.sacUpdate(dt, ctx);
};

// emit liquid droplets or a paste strand at the opening, volume rate Q (µL/s)
PP.Lesion.prototype.emitFlow = function (ctx, Q, dt, ropen, viaPunctum) {
  const c = this.cur(); if (!c) return;
  let dV = Math.min(c.vol, Q * dt);
  if (dV <= 0) { this.qi++; return; }
  const P = ctx.parts, cx = this.x + this.ox, cy = this.y + this.oy;
  const top = Math.max(this.domeH() * 0.9, 0.02);
  const col = this.contentCol(c);
  if (c.k === 'paste') {
    // continuous strand ~ opening diameter (slight die swell), extruded along the surface normal
    const rs = PP.clamp(ropen * 1.12, 0.06, 1.6);
    const sp = rs * 0.62;
    const vol1 = Math.PI * rs * rs * sp;
    this.strandAcc = (this.strandAcc || 0) + dV;
    const v = Q / (Math.PI * rs * rs);
    let root = this.strandRoot;
    while (this.strandAcc >= vol1) {
      this.strandAcc -= vol1;
      // push the existing root up and insert a new particle under it
      const i = P.spawn(cx, cy, top, rs * (0.94 + 0.12 * ctx.rng()), c.m === 1 ? PP.MAT.pus : c.m, col);
      if (i < 0) break;
      if (c.m === PP.MAT.keratin) { const k = 0.9 + 0.15 * ctx.rng(); P.cr[i] *= k; P.cg[i] *= k; P.cb[i] *= k * 0.97; }
      P.pin[i] = 1;
      if (root != null && root >= 0 && P.alive[root] && P.pin[root]) {
        P.pin[root] = 0;
        P.z[root] = top + sp; P.pz[root] = P.z[root] - v / 120;
        const brk = c.m === PP.MAT.keratin ? 1.08 + 0.1 * ctx.rng() : 1.45;
        P.link(root, i, sp, c.m === PP.MAT.keratin ? 0.25 : 0.12, brk);
      } else if (root != null && root >= 0 && P.alive[root]) {
        P.link(root, i, sp, 0.12, 1.45);
      }
      root = i;
    }
    this.strandRoot = root;
  } else {
    // Newtonian: high exit velocity -> jet; otherwise welling droplets
    const v = Q / (Math.PI * ropen * ropen);
    if (v > 600) {
      const cone = 0.35;
      this.spray(ctx, dV, Math.min(v, PP.jetSpeed(this.P)), cone, c);
      return;
    }
    this.dropAcc = (this.dropAcc || 0) + dV;
    const rd = PP.clamp(ropen * 1.4, 0.1, 0.4);
    const vd = (4 / 3) * Math.PI * rd * rd * rd;
    while (this.dropAcc >= vd) {
      this.dropAcc -= vd;
      const a = ctx.rng() * Math.PI * 2, rr = ropen * 0.5 * ctx.rng();
      const mat = c.m === 1 ? PP.MAT.pusThin : c.m;
      const i = P.spawn(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr, top + rd, rd, mat, col);
      if (i >= 0) P.setVel(i, Math.cos(a) * 3, Math.sin(a) * 3, Math.min(v, 120), 1 / 120);
      if (c.hairs && ctx.rng() < 0.03) this.spawnHair(ctx, cx, cy, top, 3 + ctx.rng() * 3, true);
    }
  }
  c.vol -= dV; this.V = Math.max(0, this.V - dV); this.ext += dV;
  ctx.fx.extrude(this, dV / dt);
  if (c.vol <= 1e-6) {
    this.qi++;
    if (this.strandRoot != null && this.strandRoot >= 0 && P.alive[this.strandRoot]) P.pin[this.strandRoot] = 0;
    this.strandRoot = null;
  }
};

// blackhead / comedone plug: force balance with stick-slip friction; friction falls with temperature (sebum melts 30–35 °C)
PP.Lesion.prototype.plugUpdate = function (dt, ctx) {
  const pl = this.plug, P = ctx.parts;
  if (!pl || pl.out) { this.qi = this.queue.length; return; }
  const T = ctx.heatAt(this.x, this.y);
  const solid = PP.sebumSolid(T);
  const area = Math.PI * pl.r * pl.r;                    // mm^2
  const Fpush = this.P * 1e-3 * area;                    // N
  const base = (pl.stiff ? 0.009 : pl.soft ? 0.0007 : 0.0024) * (pl.r / 0.25);
  const Fs = base * (solid / 0.55) * (1 - 0.6 * (pl.ext / pl.L));
  const Fk = Fs * 0.55;
  this.plugF = Fs;
  if (!pl.moving && Fpush > Fs) { pl.moving = true; ctx.fx.creak(this); }
  if (pl.moving) {
    if (Fpush < Fk * 0.9) pl.moving = false;
    else {
      const v = PP.clamp(((Fpush - Fk) / Fs) * 3.5, 0, 6) * (pl.soft ? 1.5 : 1);  // mm/s
      const dl = Math.min(v * dt, pl.L - pl.ext);
      pl.ext += dl;
      const dV = area * dl;
      this.V = Math.max(0, this.V - dV); this.ext += dV; this.cur().vol = Math.max(0, this.cur().vol - dV);
      this.P *= 1 - Math.min(0.5, dl / pl.L);            // the cavity relaxes as the plug moves
      this.growPlug(ctx, dl);
      ctx.fx.extrude(this, dV / dt);
    }
  }
  if (pl.ext >= pl.L - 1e-3) {
    pl.out = true; this.qi = this.queue.length; this.V = 0;
    if (pl.chainRoot >= 0 && P.alive[pl.chainRoot]) P.pin[pl.chainRoot] = 0;
    this.done = !this.bad; this.events.push('plugOut');
    ctx.fx.toast('good', 'Plug out', 'Extracted a ' + pl.L.toFixed(1) + ' mm plug' + (pl.tip ? ' with its oxidised dark cap' : '') + (T > 34.5 ? '. The warmth softened the sebum.' : '.'));
    if (this.type === 'filament') this.refill = 1;
  }
};

PP.Lesion.prototype.growPlug = function (ctx, dl) {
  const pl = this.plug, P = ctx.parts, cx = this.x + this.ox, cy = this.y + this.oy;
  const sp = Math.max(pl.r * 0.55, 0.05);
  pl.acc = (pl.acc || 0) + dl;
  while (pl.acc >= sp) {
    pl.acc -= sp;
    const frac = pl.ext / pl.L;           // 0 = tip
    const bulb = frac > 0.75 ? 1 + 0.35 * (frac - 0.75) / 0.25 : 1 - 0.25 * Math.max(0, 0.15 - frac) / 0.15;
    let col;
    if (pl.tip && frac < 0.12) col = PP.hex2lin(frac < 0.05 ? '#1d1712' : '#4a3a2a');
    else if (this.type === 'dpow') col = PP.hex2lin(frac < 0.3 ? '#3b3128' : '#cfc3a8');
    else col = PP.hex2lin(pl.soft ? '#d9d2bf' : '#e8dcb4');
    const i = P.spawn(cx, cy, 0.0, pl.r * bulb, this.type === 'dpow' ? PP.MAT.keratin : PP.MAT.sebum, col);
    if (i < 0) return;
    P.pin[i] = 1;
    if (pl.chainRoot >= 0 && P.alive[pl.chainRoot]) {
      // advance the previous root up the follicle axis and link
      P.pin[pl.chainRoot] = 0;
      P.z[pl.chainRoot] = sp; P.pz[pl.chainRoot] = sp * 0.98;
      P.link(pl.chainRoot, i, sp, pl.stiff ? 1 : 0.85, 2.2);
    } else pl.chainTop = i;
    pl.chainRoot = i;
    if (pl.tuft && frac < 0.1 && !pl.tuftDone) {
      pl.tuftDone = 1;
      for (let k = 0; k < 9; k++) this.spawnHair(ctx, cx, cy, sp, 0.8 + ctx.rng() * 1.2, false, i);
    }
  }
};

PP.Lesion.prototype.spawnHair = function (ctx, x, y, z, len, free, attachTo) {
  const P = ctx.parts;
  const sp = 0.12, n = Math.max(3, Math.round(len / sp));
  const r = free ? 0.03 : 0.022;
  let prev = attachTo != null ? attachTo : -1;
  const a = ctx.rng() * Math.PI * 2, tilt = 0.4 + ctx.rng() * 0.6;
  for (let k = 0; k < n; k++) {
    const i = P.spawn(x + Math.cos(a) * k * sp * tilt, y + Math.sin(a) * k * sp * tilt, z + k * sp * 0.8, r, PP.MAT.hair, free ? PP.hex2lin('#3a2a1e') : PP.hex2lin('#6e5a44'));
    if (i < 0) return -1;
    if (prev >= 0) P.link(prev, i, sp, 0.9, 3.0);
    prev = i;
  }
  return prev;
};

PP.Lesion.prototype.spawnCore = function (ctx, express) {
  const P = ctx.parts, cx = this.x + this.ox, cy = this.y + this.oy;
  if (this.coreOut) return;
  this.coreOut = true;
  const c = this.cur();
  const isMoll = this.type === 'molluscum';
  const r = isMoll ? this.R * 0.32 : PP.clamp(this.open.r * 0.9, 0.3, 1.1);
  const n = isMoll ? 3 : 7;
  let prev = -1;
  for (let k = 0; k < n; k++) {
    const i = P.spawn(cx, cy, this.domeH() + r + k * r * 0.9, r * (1 - k * 0.05), isMoll ? PP.MAT.molluscum : PP.MAT.core);
    if (i < 0) break;
    if (!isMoll) { const kk = 0.85 + 0.25 * ctx.rng(); P.cr[i] *= kk; P.cg[i] *= kk; }
    if (prev >= 0) P.link(prev, i, r * 0.9, 0.8, 1.9);
    else if (!isMoll) { P.pin[i] = 1; this.coreChain = i; }   // root anchored in the cavity until pulled with forceps
    prev = i;
  }
  if (isMoll || express) {
    this.ext += c ? c.vol : 0; this.V = 0; if (c) c.vol = 0; this.qi = this.queue.length;
    this.done = !this.bad; this.events.push('core');
    if (P.alive[prev]) P.setVel(prev, 0, 0, 40, 1 / 120);
    ctx.fx.toast('good', 'Core out', isMoll ? 'The white molluscum body came out whole.' : 'Necrotic core released.');
  } else ctx.fx.toast('warn', 'Core visible', 'A fibrous necrotic core is wedged in the opening. Grip it with forceps and pull steadily.');
};

// lipoma: needs an incision ~1/4 of its diameter; side pressure extrudes lobules; ligaments hold large ones
PP.Lesion.prototype.lipomaUpdate = function (dt, ctx) {
  const inc = this.incLen || 0;
  const need = 0.22 * this.d;
  if (inc < need * 0.6) { if (this.P > 6 && !this._lipWarn) { this._lipWarn = 1; ctx.fx.toast('warn', 'Opening too small', 'Squeeze technique needs an incision about a quarter of the lipoma\'s diameter (' + (this.d / 4).toFixed(0) + ' mm).'); } return; }
  const fracOut = 1 - this.fill();
  if (this.lig && fracOut > 0.38) { if (!this._ligWarn) { this._ligWarn = 1; ctx.fx.toast('warn', 'Held by ligaments', 'Retaining ligaments anchor this large lipoma. Sweep the hemostat inside to free it.'); } return; }
  const Pneed = 6 * Math.pow(need / Math.max(inc, 0.1), 2);
  if (this.P < Pneed) return;
  this.lobAcc = (this.lobAcc || 0) + dt * (this.P - Pneed) * 0.08 * this.V0 * ctx.S.ooze;
  const P = ctx.parts, cx = this.x + this.ox + (this.incCx || 0), cy = this.y + this.oy + (this.incCy || 0);
  while (this.lobAcc > 0) {
    const r = PP.clamp(this.d * 0.05 * (0.7 + 0.6 * ctx.rng()), 0.9, 3.2);
    const v = (4 / 3) * Math.PI * r * r * r;
    this.lobAcc -= v;
    const i = P.spawn(cx + (ctx.rng() - 0.5), cy + (ctx.rng() - 0.5), 0.5, r, PP.MAT.fat);
    if (i >= 0) {
      const k = 0.92 + 0.12 * ctx.rng(); P.cr[i] *= k; P.cg[i] *= k;
      P.setVel(i, (ctx.rng() - 0.5) * 8, (ctx.rng() - 0.5) * 8, 25, 1 / 120);
      if (this.lastLob >= 0 && P.alive[this.lastLob] && ctx.rng() < 0.7) P.link(this.lastLob, i, r * 1.3, 0.1, 2.2);
      this.lastLob = i;
    }
    this.V = Math.max(0, this.V - v); this.ext += v; const c = this.cur(); c.vol = Math.max(0, c.vol - v);
    ctx.fx.extrude(this, v * 10);
    if (this.V <= 0) { this.done = !this.bad; this.events.push('lipomaOut'); ctx.fx.toast('good', 'Lipoma delivered', 'Lobulated fat expressed through the incision.'); break; }
  }
};

// cyst sac / wall removal
PP.Lesion.prototype.sacUpdate = function (dt, ctx) {
  const sac = this.sac; if (!sac || sac.done) return;
  if (!sac.ready && this.fill() < 0.12) {
    sac.ready = true;
    const P = ctx.parts, cx = this.x + this.ox, cy = this.y + this.oy;
    // membrane edge presents at the opening
    const n = 6; let prev = -1;
    for (let k = 0; k < n; k++) {
      const i = P.spawn(cx + (k - 2) * 0.15, cy, 0.15 + k * 0.05, 0.35, PP.MAT.sac);
      if (i < 0) break;
      if (prev >= 0) P.link(prev, i, 0.3, 0.2, 1.4 + sac.tear * 0.3);
      else { P.pin[i] = 1; sac.chain = i; }
      prev = i;
    }
    ctx.fx.toast('warn', 'Sac visible', 'The cyst wall is presenting in the opening. Grip it with the hemostat and deliver it slowly.');
  }
};

// called by tools while a gripped sac / core is being delivered. traction (N) = leftover stretch after the
// tissue released `delivered` mm this frame. Membranes tear when pulled faster than they can release.
PP.Lesion.prototype.pullAnchor = function (ctx, what, traction, delivered) {
  if (what === 'sac' && this.sac && this.sac.ready && !this.sac.done) {
    const sac = this.sac;
    const tearAt = 0.25 * sac.tear * sac.integrity;      // N (cal)
    if (traction > tearAt) {
      sac.frags++; sac.integrity *= 0.85;
      ctx.fx.toast('bad', 'Wall tore', 'The thin wall fragmented under fast traction. ' + sac.frags + ' piece(s) out; inspect for remnants (AAFP).');
      if (sac.frags >= 4) { sac.done = true; this.recur = true; this.done = true; this.bad = true; this.events.push('sacFragments'); }
      return 'tear';
    }
    sac.out += delivered;
    if (sac.out > this.rc * 1.6) {
      sac.done = true; this.done = !this.bad; this.recur = sac.frags > 0;
      this.events.push(sac.frags ? 'sacPieces' : 'sacWhole');
      ctx.fx.toast(sac.frags ? 'warn' : 'good', sac.frags ? 'Sac out in pieces' : 'Sac out whole', sac.frags ? 'Most of the wall is out; fragments left behind can let it recur.' : 'Complete cyst wall delivered: lowest recurrence risk.');
      return 'out';
    }
    return 'pulling';
  }
  if (what === 'core' && !this._coreDone) {
    this.coreOutLen = (this.coreOutLen || 0) + delivered;
    if (this.coreOutLen > 2.5) {
      this._coreDone = 1;
      const c = this.cur(); if (c) { this.ext += c.vol; this.V = Math.max(0, this.V - c.vol); c.vol = 0; }
      this.qi = this.queue.length; this.done = !this.bad; this.events.push('core');
      this.crater = Math.max(this.crater, 0.4);
      ctx.fx.toast('good', 'Core out', 'Necrotic core removed, leaving the typical yellow-grey crater (MSD).');
      return 'out';
    }
    return 'pulling';
  }
  return 'hold';
};

// slow physiology (runs every frame; dt may be large during time-lapse)
PP.Lesion.prototype.slow = function (dt, ctx) {
  // boils "point" with moist heat (MSD): roof thins over hours
  if (this.T.point && this.open.r <= 0) {
    const T = ctx.heatAt(this.x, this.y);
    const heat = PP.clamp((T - 33) / 6, 0, 1);
    this.pointing = PP.clamp(this.pointing + dt * (heat * 1 / 3600 + 1 / (36 * 3600)), 0, 1);
    if (this.pointing > 0.97 && this.type === 'furuncle' && !this.spont) {
      this.spont = 1; this.surfaceRupture(ctx, 2);
      ctx.fx.toast('good', 'Drained spontaneously', 'Moist heat brought the boil to a head and it ruptured on its own (MSD).');
    }
  }
  if (this.steroidT >= 0) {
    this.steroidT += dt;
    const k = PP.clamp(this.steroidT / (2 * 86400), 0, 1);
    this.inflam *= 1 - 0.9 * Math.min(1, dt / 86400);
    if (k >= 1 && !this.done && this.solid()) { this.done = true; this.events.push('flattened'); ctx.fx.toast('good', 'Flattened', 'The steroid injection settled the inflammation.'); }
  }
  if (this.spreadFlag && ctx.clock - this.spreadAt > 86400 && !this.spreadDone) {
    this.spreadDone = true; ctx.fx.spreadMolluscum(this);
  }
  if (this.refill && dt > 30) { this.refillT = (this.refillT || 0) + dt; }
  // healing: crater -> scab -> fade (days)
  if ((this.popped || this.open.r > 0) && dt > 1) {
    this.heal = PP.clamp(this.heal + dt / (5 * 86400), 0, 1);
    this.scab = this.heal < 0.15 ? this.heal / 0.15 : this.heal < 0.7 ? 1 : 1 - (this.heal - 0.7) / 0.3;
    this.inflam *= 1 - Math.min(0.5, dt / (3 * 86400));
  }
};
