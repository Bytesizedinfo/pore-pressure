'use strict';
/* Instruments. Each frame the active tool turns pointer input into:
   - contacts (discs with normal force fn, tangential load q, or suction) for the skin mechanics,
   - actions (punctures, incisions, injections, grasping, wiping, heat),
   - render primitives (analytic shapes ray-traced from above in the object pass).
   Primitive instance: [Ax,Ay,Az,ra, Bx,By,Bz,rb, type,mat,p1,p2, r,g,b,a]
   type 0 sphere, 1 round cone A->B, 2 slab (A=centre, B=(hx,hy,hz,angle)), 3 blade (A tip, B heel, p1/p2 = spine xy, a = spine z) */
PP.MATOBJ = { nitrile: 30, cotton: 31, chrome: 32, glass: 33, gauze: 34, terry: 35, plastic: 36, hydro: 37, iodineSwab: 38, paper: 39, skinCore: 40 };

PP.Tools = function (W) {
  this.W = W;
  this.id = 'fingers';
  this.ptr = { down: false, x: 0, y: 0, x0: 0, y0: 0, t: 0, pressure: 0, moved: 0, shift: false, lx: 0, ly: 0, speed: 0 };
  this.touch = null;           // {a:{x,y}, b:{x,y}, d0}
  this.angle = 0; this.spread = { fingers: 4.6, swabs: 3.0 };
  this.loopR = 1.25; this.vacLevel = 1; this.vacLevels = [40, 52, 65];
  this.force = 0; this.forceN = 0;
  this.prims = new Float32Array(16 * 160); this.nPrim = 0;
  this.grab = null;            // {i, kind, lesion, ax, ay}
  this.stroke = 0;
  this.wet = 0;
  this.punchDepth = 0; this.punchRot = 0;
  this.lidoVol = 0;
};

PP.Tools.prototype.select = function (id) {
  this.release();
  this.id = id;
  this.W.fx.toolChanged(id);
};

PP.Tools.prototype.down = function (x, y, opt = {}) {
  const p = this.ptr;
  Object.assign(p, { down: true, x, y, x0: x, y0: y, lx: x, ly: y, t: 0, moved: 0, shift: !!opt.shift, pressure: opt.pressure || 0 });
  this.stroke++;
  const W = this.W;
  if (this.id === 'gauze' && opt.shift) { W.S.shield = !W.S.shield; W.fx.toast('', 'Splatter shield ' + (W.S.shield ? 'on' : 'off'), W.S.shield ? 'Gauze held loosely over the lesion catches spray (AAFP).' : ''); p.down = false; return; }
  if (this.id === 'forceps' || this.id === 'hemostat') this.tryGrab(x, y);
  if (this.id === 'steroid') this.steroid(x, y);
  if (this.id === 'patch') this.patch(x, y);
  if (this.id === 'needle') {
    this.needleStart = { x, y };
    const P = this.W.parts;
    const ci = P.nearest(x, y, 1.8, (k) => P.mat[k] === PP.MATOBJ.skinCore && P.pin[k]);
    if (ci >= 0) { P.pin[ci] = 0; P.setVel(ci, 0, 0, 60, 1 / 120); for (const h of this.W.wounds.holes) if (h.coreIdx === ci) h.core = false; this.needleStart = null; this.W.fx.toast('', 'Core lifted', 'The punched tissue core is out; the cyst wall is exposed beneath.'); }
  }
};
PP.Tools.prototype.move = function (x, y, opt = {}) {
  const p = this.ptr;
  const dx = x - p.x, dy = y - p.y;
  p.moved += Math.hypot(dx, dy);
  p.x = x; p.y = y;
  if (opt.pressure != null) p.pressure = opt.pressure;
};
PP.Tools.prototype.up = function () {
  const p = this.ptr, W = this.W;
  if (!p.down) return;
  if (this.id === 'needle') {
    const s = this.needleStart;
    if (s) {
      const drag = Math.hypot(p.x - s.x, p.y - s.y);
      if (drag < 0.6) W.wounds.addPuncture(s.x, s.y, 0.15 + 0.1 * W.rng());
      else this.liftHair(s, p);
    }
  }
  if (this.id === 'punch' && this.punchDepth > 0.15) {
    const hole = W.wounds.addPunch(p.x0, p.y0, 2.0, this.punchDepth);
    if (hole && hole.core) this.spawnTissueCore(hole);
    W.fx.toast('', 'Punch', 'Cut a 4 mm core, ' + this.punchDepth.toFixed(1) + ' mm deep. The hole relaxes into an oval along the tension lines. Lift the core out with the needle.');
  }
  this.punchDepth = 0; this.punchRot = 0;
  if (this.id === 'lido' && this.lidoVol > 0) {
    W.fx.toast('', 'Infiltrated ' + this.lidoVol.toFixed(1) + ' mL', 'Anaesthesia sets in within a minute or two; epinephrine blanching builds toward ~10 min. Use Wait.');
    this.lidoVol = 0;
  }
  this.release();
  p.down = false;
};
PP.Tools.prototype.release = function () {
  const W = this.W;
  if (this.grab) {
    const P = W.parts, i = this.grab.i;
    if (i >= 0 && P.alive[i] && !this.grab.wasPinned) P.pin[i] = 0;
    this.grab = null;
  }
  W.wounds.compress = null;
  for (const L of W.lesions) { if (L.spread) L.open.h = Math.max(L.open.h || 0, (L.open.h || 0) + L.spread * 0.35); L.spread = 0; }
};

PP.Tools.prototype.tryGrab = function (x, y) {
  const W = this.W, P = W.parts;
  const grabbable = (i) => { const m = P.mat[i]; return m === PP.MAT.hair || m === PP.MAT.core || m === PP.MAT.sac || m === PP.MAT.fat || m === PP.MAT.sebum || m === PP.MAT.keratin || m === PP.MAT.packing || m === PP.MAT.molluscum || m === PP.MATOBJ.skinCore || m === PP.MAT.pus || m === PP.MAT.pearl; };
  const anchored = (k) => { const m = P.mat[k]; return m === PP.MAT.sac || m === PP.MAT.core || m === PP.MAT.hair || m === PP.MATOBJ.skinCore; };
  let i;
  if (this.id === 'hemostat') {
    // the hemostat grips anchored structures; otherwise, inside an opening, it spreads / sweeps (blunt dissection)
    i = P.nearest(x, y, 1.3, anchored);
    if (i < 0 && !this.lesionAt(x, y, true)) i = P.nearest(x, y, 1.0, grabbable);
  } else i = P.nearest(x, y, 1.0, grabbable);
  if (i >= 0) {
    // find owning lesion anchor (pinned root of this chain)
    const chain = P.chainOf(i);
    const root = chain.find((k) => P.pin[k]);
    let L = null, kind = null;
    if (root != null) for (const l of W.lesions) {
      if (l.sac && l.sac.chain === root) { L = l; kind = 'sac'; }
      if (l.coreChain === root) { L = l; kind = 'core'; }
      if (l.hair && l.hair.chain === root) { L = l; kind = 'hair'; }
      if (l._coreHole && l._coreHole === root) { L = l; kind = 'tissue'; }
    }
    if (root != null && P.mat[root] === PP.MATOBJ.skinCore) kind = 'tissue';
    let anchor = null, slack = 0;
    if (root != null && kind) {
      anchor = { x: P.x[root], y: P.y[root], z: P.z[root] };
      const ch = P.chainOf(root); const k = Math.max(0, ch.indexOf(i));
      slack = k * (P.rest[root] || 0.3) + 0.4;
    }
    this.grab = { i, kind, L, root, wasPinned: !!P.pin[i] && !kind, ax: x, ay: y, t: 0, anchor, slack, released: false };
    P.pin[i] = 1;
    W.fx.click();
    return;
  }
  if (this.id === 'hemostat') {
    // inserted into an opening: spreading mode
    const L = this.lesionAt(x, y, true);
    if (L && L.open.r > 0) this.grab = { i: -1, kind: 'spread', L, ax: x, ay: y, sweep: 0 };
  }
};

PP.Tools.prototype.lesionAt = function (x, y, needOpen) {
  let best = null, bd = 1e9;
  for (const L of this.W.lesions) {
    const d = Math.hypot(x - L.x - L.ox, y - L.y - L.oy);
    if (d < Math.max(L.R, 1.0) * 1.15 && d < bd && (!needOpen || L.open.r > 0)) { bd = d; best = L; }
  }
  return best;
};

PP.Tools.prototype.liftHair = function (s, p) {
  const W = this.W;
  const L = this.lesionAt(s.x, s.y, false);
  if (!L || !L.hair) { W.wounds.addPuncture(s.x, s.y, 0.2); return; }
  if (L.hair.freed) return;
  const T = W.wounds.heatAt(L.x, L.y);
  // the curled tip springs out once the needle passes under the loop; warmth softens the keratin
  L.hair.freed = true; L.events.push('hairLifted');
  if (L.open.r <= 0) { L.open.r = 0.2; L.open.L = 0.05; L.popped = true; }
  const P = W.parts;
  const n = Math.round(L.hair.len / 0.15);
  let prev = -1;
  const a = L.hair.angle;
  for (let k = 0; k < n; k++) {
    const t = k / n;
    // stored curl: the free part springs into an arc
    const ang = a + t * 2.2;
    const rr = 0.8 + t * 2.5;
    const i = P.spawn(L.x + Math.cos(ang) * rr * t, L.y + Math.sin(ang) * rr * t, 0.05 + 0.35 * Math.sin(t * Math.PI), 0.035, PP.MAT.hair, PP.hex2lin('#2b1d14'));
    if (i < 0) break;
    if (prev >= 0) P.link(prev, i, 0.15, 0.95, 3.5);
    else { P.pin[i] = 1; L.hair.chain = i; }
    prev = i;
  }
  W.fx.toast('good', 'Tip freed', 'The embedded tip sprang out of the skin' + (T > 34 ? '; the warm compress softened it.' : '.') + ' Leave the root in. Plucking invites another ingrown hair.');
};

PP.Tools.prototype.spawnTissueCore = function (hole) {
  const P = this.W.parts;
  const i = P.spawn(hole.x, hole.y, 0.2, 1.7, PP.MATOBJ.skinCore, this.W.skinColLin());
  if (i >= 0) { P.pin[i] = 1; hole.coreIdx = i; }
};

PP.Tools.prototype.steroid = function (x, y) {
  const W = this.W, L = this.lesionAt(x, y, false);
  if (!L) return;
  W.wounds.inject(x, y, 'steroid', 0.1);
  W.wounds.addPuncture(x, y, 0.8);
  if (['nodule', 'papule', 'pseudocyst', 'epidermoid', 'sebhyper'].includes(L.type)) {
    if (L.steroidT < 0) { L.steroidT = 0; L.events.push('steroid'); }
    W.fx.toast('good', 'Triamcinolone injected', 'Intralesional steroid settles inflamed nodules and cysts over the following days. Use Wait (2 days).');
  } else W.fx.toast('warn', 'Steroid not indicated', 'Steroid injections are for inflamed nodules, cysts and papules, not this.');
};

PP.Tools.prototype.patch = function (x, y) {
  const W = this.W, L = this.lesionAt(x, y, false);
  W.decals.patches.push({ x, y, r: 6, t: W.clock });
  if (L) { L.patched = true; L.events.push('patched'); }
  W.fx.toast('', 'Hydrocolloid patch', 'Covers the wound and absorbs exudate; it whitens as it swells.');
};

// ------------------------------------------------------------------------------------------------
PP.Tools.prototype.update = function (dt) {
  const W = this.W, p = this.ptr, ph = W.phys;
  ph.contacts.length = 0;
  W.wounds.press.length = 0;
  this.nPrim = 0;
  this.force = 0;
  if (p.down) p.t += dt;
  const sp = Math.hypot(p.x - p.lx, p.y - p.ly) / Math.max(dt, 1e-4);
  p.speed = PP.lerp(p.speed, sp, 0.3);
  const id = this.id;
  const ramp = (tau, Fmax) => Fmax * (1 - Math.exp(-p.t / tau)) * (p.pressure > 0 ? 0.3 + 1.4 * p.pressure : 1);
  // lesion-specific suction reset
  for (const L of W.lesions) L.suck = 0;

  if (id === 'fingers' || id === 'swabs') {
    const isF = id === 'fingers';
    let c1, c2, F = 0;
    const a = isF ? 4.2 : 2.0;
    if (this.touch) {
      c1 = this.touch.a; c2 = this.touch.b;
      const d = Math.hypot(c2.x - c1.x, c2.y - c1.y);
      F = PP.clamp((this.touch.d0 - d) * (isF ? 1.6 : 0.9) + 0.6, 0, isF ? 9 : 4);
    } else if (p.down) {
      const s = this.spread[id];
      const ax = Math.cos(this.angle), ay = Math.sin(this.angle);
      c1 = { x: p.x - ax * s, y: p.y - ay * s }; c2 = { x: p.x + ax * s, y: p.y + ay * s };
      F = ramp(0.9, isF ? (p.shift ? 10 : 6) : 3);
    }
    if (c1 && c2) {
      // wet gloves lose grip: lower friction (cal 0.8 dry -> 0.25 wet) and the pads slide inward
      const mu = isF ? PP.lerp(0.8, 0.25, PP.clamp(this.wet, 0, 1)) : 0.6;
      if (isF && this.wet > 0.5 && F > 3 && !this.touch) this.spread.fingers = Math.max(2.2, this.spread.fingers - dt * 0.6 * this.wet);
      const dx = c2.x - c1.x, dy = c2.y - c1.y, d = Math.hypot(dx, dy) + 1e-6, ux = dx / d, uy = dy / d;
      ph.contacts.push({ x: c1.x, y: c1.y, a, fn: 0.45 * F, qx: ux * F * mu, qy: uy * F * mu });
      ph.contacts.push({ x: c2.x, y: c2.y, a, fn: 0.45 * F, qx: -ux * F * mu, qy: -uy * F * mu });
      this.force = F; this.forceMax = isF ? 10 : 4;
      const zOf = (c) => W.skinH(c.x, c.y);
      if (isF) {
        for (const [c, sgn] of [[c1, -1], [c2, 1]]) {
          // distal fingertip: ~9 mm wide at the tip, widening toward the knuckle, rising out of frame
          const z0 = zOf(c) + 3.9;
          this.prim([c.x + ux * sgn * 1.2, c.y + uy * sgn * 1.2, z0, 4.4, c.x + ux * sgn * 24, c.y + uy * sgn * 24 + 5, z0 + 24, 7.0], 1, PP.MATOBJ.nitrile, [0.24, 0.2, 0.62, this.wet]);
        }
      } else {
        for (const [c, sgn] of [[c1, -1], [c2, 1]]) {
          const z0 = zOf(c) + 1.7;
          this.prim([c.x - ux * sgn * 0.6, c.y - uy * sgn * 0.6, z0, 1.9, c.x + ux * sgn * 3.2, c.y + uy * sgn * 3.2, z0 + 1.4, 2.0], 1, PP.MATOBJ.cotton, this.swabStain || [0.86, 0.85, 0.82, 0]);
          this.prim([c.x + ux * sgn * 4.5, c.y + uy * sgn * 4.5, z0 + 1.6, 0.9, c.x + ux * sgn * 40, c.y + uy * sgn * 40, z0 + 26, 0.9], 1, PP.MATOBJ.paper, [0.9, 0.9, 0.88, 0]);
        }
      }
    }
  } else if (id === 'loop') {
    const R = this.loopR;
    const F = p.down ? ramp(0.6, 2.6) : 0;
    const zr = W.skinH(p.x, p.y);
    if (p.down) {
      // ring load as 16 small discs; friction + Poisson effect drives tissue inward under the wire
      const tilt = PP.clamp((p.x - p.lx) * 0.0, -1, 1);
      const rx = PP.clamp((p.x - p.x0) * 0.4, -0.6, 0.6), ry = PP.clamp((p.y - p.y0) * 0.4, -0.6, 0.6); // rocking
      for (let k = 0; k < 16; k++) {
        const an = (k / 16) * Math.PI * 2, cx = Math.cos(an), cy = Math.sin(an);
        const bias = 1 + 0.8 * (cx * rx + cy * ry);
        ph.contacts.push({ x: p.x + cx * R, y: p.y + cy * R, a: 0.32, fn: (F / 16) * bias, qx: -cx * F * 0.04 * bias, qy: -cy * F * 0.04 * bias });
      }
      this.force = F; this.forceMax = 4;
    }
    // ring (12 capsule segments) + shank + handle
    const zc = zr + (p.down ? 0.05 : 0.8) + 0.22;
    for (let k = 0; k < 12; k++) {
      const a0 = (k / 12) * Math.PI * 2, a1 = ((k + 1) / 12) * Math.PI * 2;
      this.prim([p.x + Math.cos(a0) * R, p.y + Math.sin(a0) * R, zc, 0.22, p.x + Math.cos(a1) * R, p.y + Math.sin(a1) * R, zc, 0.22], 1, PP.MATOBJ.chrome, [0.8, 0.8, 0.82, 0]);
    }
    this.prim([p.x - R * 0.7, p.y + R * 0.7, zc, 0.3, p.x - 9, p.y + 9, zc + 9, 1.0], 1, PP.MATOBJ.chrome, [0.78, 0.78, 0.8, 0]);
    this.prim([p.x - 9, p.y + 9, zc + 9, 1.6, p.x - 40, p.y + 40, zc + 30, 2.2], 1, PP.MATOBJ.chrome, [0.7, 0.7, 0.72, 0]);
  } else if (id === 'vacuum') {
    const a = 3.5, dP = this.vacLevels[this.vacLevel];
    const s = p.down ? dP * (1 - Math.exp(-p.t / 0.3)) : 0;
    const zr = W.skinH(p.x, p.y);
    if (p.down) {
      ph.contacts.push({ x: p.x, y: p.y, a, suction: s });
      const Fr = s * 1e-3 * Math.PI * a * a;
      for (let k = 0; k < 16; k++) { const an = (k / 16) * Math.PI * 2; ph.contacts.push({ x: p.x + Math.cos(an) * (a + 0.6), y: p.y + Math.sin(an) * (a + 0.6), a: 0.6, fn: Fr / 16 }); }
      W.decals.suction(p.x, p.y, a, s, dt);
      for (const L of W.lesions) {
        const d = Math.hypot(L.x - p.x, L.y - p.y);
        if (d < a && L.open.r > 0) L.suck = s * 0.35 * (1 - d / a);
      }
      this.force = s / 65; this.forceMax = 1;
    }
    const zc = zr + (p.down ? 0.2 : 1.2);
    for (let k = 0; k < 16; k++) {
      const a0 = (k / 16) * Math.PI * 2, a1 = ((k + 1) / 16) * Math.PI * 2;
      this.prim([p.x + Math.cos(a0) * (a + 0.6), p.y + Math.sin(a0) * (a + 0.6), zc + 0.6, 0.6, p.x + Math.cos(a1) * (a + 0.6), p.y + Math.sin(a1) * (a + 0.6), zc + 0.6, 0.6], 1, PP.MATOBJ.glass, [0.9, 0.95, 1, 0.75]);
    }
    this.prim([p.x, p.y, zc + 6, a + 1.0, p.x + 10, p.y + 14, zc + 34, a + 3], 1, PP.MATOBJ.glass, [0.92, 0.96, 1, 0.8]);
    this.prim([p.x + 12, p.y + 17, zc + 36, 6, p.x + 40, p.y + 60, zc + 70, 8], 1, PP.MATOBJ.plastic, [0.93, 0.93, 0.95, 0]);
  } else if (id === 'needle') {
    const zr = W.skinH(p.x, p.y);
    const tipz = zr + (p.down ? 0.0 : 0.6);
    this.prim([p.x, p.y, tipz + 0.05, 0.03, p.x + 6, p.y + 4, tipz + 5, 0.24], 1, PP.MATOBJ.chrome, [0.82, 0.82, 0.85, 0]);
    this.prim([p.x + 6, p.y + 4, tipz + 5, 0.26, p.x + 30, p.y + 20, tipz + 25, 0.26], 1, PP.MATOBJ.chrome, [0.82, 0.82, 0.85, 0]);
    this.prim([p.x + 30, p.y + 20, tipz + 25, 2.2, p.x + 50, p.y + 34, tipz + 40, 2.4], 1, PP.MATOBJ.plastic, [0.2, 0.55, 0.85, 0]);
    if (p.down && this.needleStart && W.lesions.some((L) => L.hair && Math.hypot(L.x - p.x, L.y - p.y) < L.R * 1.5)) this.force = 0.3;
  } else if (id === 'blade11' || id === 'blade15') {
    const zr = W.skinH(p.x, p.y);
    let dx = p.x - p.lx, dy = p.y - p.ly;
    if (Math.hypot(dx, dy) < 1e-4) { dx = this.bdx || 1; dy = this.bdy || 0; } else { const n = Math.hypot(dx, dy); this.bdx = dx / n; this.bdy = dy / n; dx /= n; dy /= n; }
    if (p.down) {
      const stab = id === 'blade11';
      const sx = p.x0, sy = p.y0;
      let ex = p.x, ey = p.y;
      if (stab) { const L = Math.hypot(ex - sx, ey - sy); if (L > 3) { ex = sx + ((ex - sx) / L) * 3; ey = sy + ((ey - sy) / L) * 3; } }
      const segLen = Math.hypot(p.x - p.lx, p.y - p.ly);
      if (segLen > 0.05 || p.t < dt * 1.5) {
        const depth = stab ? W.area.dermis * 0.9 + 0.4 + Math.min(p.t, 1.5) * 0.4 : 0.55 + 0.45 * (p.pressure || 0.6);
        if (stab) W.wounds.addCut(sx, sy, ex, ey, depth, id, this.stroke);
        else W.wounds.addCut(p.lx, p.ly, p.x, p.y, depth, id, this.stroke);
      }
    }
    const tz = zr + (p.down ? -0.3 : 0.8);
    const bx = -dx, by = -dy;   // blade trails behind the motion
    const nx = -by, ny = bx;
    const tip = [p.x, p.y, tz];
    const heel = [p.x + bx * 7, p.y + by * 7, tz + 3];
    const spine = [p.x + bx * 5 + nx * 2.6, p.y + by * 5 + ny * 2.6, tz + 3.4];
    if (id === 'blade15') { spine[0] = p.x + bx * 4 + nx * 3; spine[1] = p.y + by * 4 + ny * 3; }
    this.primRaw([tip[0], tip[1], tip[2], 0.08, heel[0], heel[1], heel[2], 0, 3, PP.MATOBJ.chrome, spine[0], spine[1], spine[2], 0, 0, 0]);
    this.prim([heel[0], heel[1], heel[2] + 0.3, 1.2, heel[0] + bx * 30, heel[1] + by * 30, heel[2] + 26, 1.6], 1, PP.MATOBJ.chrome, [0.68, 0.68, 0.7, 0]);
  } else if (id === 'punch') {
    const zr = W.skinH(p.x, p.y);
    if (p.down) {
      this.punchRot += dt * 6;
      const lim = W.wounds.depthLimits();
      const anes = W.wounds.anesth(p.x0, p.y0);
      this.punchDepth = Math.min(lim.dermis + 2.5, this.punchDepth + dt * 1.4);
      if (anes < 0.5) W.pain(p.x0, p.y0, dt * 0.8);
      ph.contacts.push({ x: p.x0, y: p.y0, a: 2.2, fn: 0.8 });
      this.force = this.punchDepth / (lim.dermis + 2.5); this.forceMax = 1;
    }
    const cx = p.down ? p.x0 : p.x, cy = p.down ? p.y0 : p.y;
    for (let k = 0; k < 14; k++) {
      const a0 = (k / 14) * Math.PI * 2 + this.punchRot, a1 = ((k + 1) / 14) * Math.PI * 2 + this.punchRot;
      this.prim([cx + Math.cos(a0) * 2.1, cy + Math.sin(a0) * 2.1, zr + 0.4, 0.18, cx + Math.cos(a1) * 2.1, cy + Math.sin(a1) * 2.1, zr + 0.4, 0.18], 1, PP.MATOBJ.chrome, [0.85, 0.85, 0.88, 0]);
    }
    this.prim([cx, cy, zr + 3, 2.4, cx, cy + 3, zr + 14, 2.4], 1, PP.MATOBJ.chrome, [0.8, 0.8, 0.82, 0]);
    this.prim([cx, cy + 3, zr + 14, 4, cx + 2, cy + 20, zr + 50, 4.5], 1, PP.MATOBJ.plastic, [0.92, 0.92, 0.94, 0]);
  } else if (id === 'hemostat' || id === 'forceps') {
    const zr = W.skinH(p.x, p.y);
    const g = this.grab;
    let open = 0.25;
    if (g && g.kind === 'spread' && p.down) {
      const d = Math.hypot(p.x - g.ax, p.y - g.ay);
      const sprd = PP.clamp(d * 0.9, 0, 3);
      g.L.spread = sprd; open = 0.25 + sprd * 0.5;
      g.sweep += Math.hypot(p.x - p.lx, p.y - p.ly);
      if (g.L.pockets > 0 && sprd > 1.2 && g.sweep > 6) { g.sweep = 0; g.L.pockets--; W.fx.toast('good', 'Pocket opened', 'The hemostat sweep broke a loculation; trapped pus can drain. ' + (g.L.pockets ? g.L.pockets + ' left.' : 'All pockets open.')); }
      if (g.L.lig && g.sweep > 10) { g.L.lig = false; W.fx.toast('good', 'Ligaments freed', 'Blunt dissection released the retaining ligaments.'); }
      if (W.wounds.anesth(g.ax, g.ay) < 0.5) W.pain(g.ax, g.ay, dt * sprd * 0.3);
    } else if (g && g.i >= 0 && p.down) {
      const P = W.parts, i = g.i;
      if (!P.alive[i]) this.grab = null;
      else {
        P.x[i] = p.x; P.y[i] = p.y; P.z[i] = Math.max(zr + 0.6, Math.min(P.z[i] + dt * 25, zr + 0.6 + Math.min(p.t, 2) * 2.5));
        g.t += dt;
        if (g.anchor && !g.released) {
          // traction ~ how far the grip is beyond the slack of the strand back to its anchored root
          const dd = Math.hypot(P.x[i] - g.anchor.x, P.y[i] - g.anchor.y, P.z[i] - g.anchor.z);
          const freeRoot = () => { g.released = true; if (g.root !== i) P.pin[g.root] = 0; else g.wasPinned = false; };
          if ((g.kind === 'sac' || g.kind === 'core') && g.L) {
            // the wall/core slides out as fast as the tissue releases it; pulling faster builds traction
            const excess = Math.max(0, dd - g.slack);
            const vdel = g.kind === 'sac' ? 2.6 * g.L.sac.tear * g.L.sac.integrity + 0.8 : 2.5;   // mm/s (cal)
            const deliver = Math.min(excess, vdel * dt);
            if (deliver > 0) {
              const k = deliver / (dd + 1e-6);
              g.anchor.x += (P.x[i] - g.anchor.x) * k; g.anchor.y += (P.y[i] - g.anchor.y) * k; g.anchor.z += (P.z[i] - g.anchor.z) * k;
              if (g.root !== i && P.alive[g.root]) { P.x[g.root] = g.anchor.x; P.y[g.root] = g.anchor.y; P.z[g.root] = g.anchor.z; }
            }
            const res = g.L.pullAnchor(this.W.ctx, g.kind, (excess - deliver) * 0.08, deliver);
            if (res === 'out') { freeRoot(); if (g.kind === 'sac') g.L.sac.chain = -1; else g.L.coreChain = -1; }
            if (res === 'tear') {
              // the gripped piece comes away; the rest of the wall stays anchored inside
              if (g.root !== i) { const pv = P.prev[i]; if (pv >= 0) { P.next[pv] = -1; P.prev[i] = -1; } }
              else { const nx = P.next[i]; if (nx >= 0) { P.next[i] = -1; P.prev[nx] = -1; P.pin[nx] = 1; if (g.L.sac) g.L.sac.chain = nx; } g.wasPinned = false; }
              g.released = true;
            }
          } else if (g.kind === 'hair' && g.L) {
            if (dd > g.L.hair.len * 0.85 && !g.L.hair.out) {
              g.L.hair.out = true; freeRoot(); g.L.events.push('hairPlucked'); g.L.done = true;
              W.fx.toast('warn', 'Plucked', 'You pulled the whole hair out by the root. Freeing the tip is enough; plucking invites regrowth into the skin.');
            } else if (dd > 1.2 && !g.L._tipOk) { g.L._tipOk = 1; g.L.done = true; g.L.events.push('hairFreed'); W.fx.toast('good', 'Hair freed', 'The ingrown tip is out of the skin; the inflammation can settle.'); }
          } else if (g.kind === 'tissue') {
            if (dd > 1.5) { freeRoot(); for (const h of W.wounds.holes) if (h.coreIdx === g.root) h.core = false; W.fx.toast('', 'Core lifted', 'The punched tissue core is out; the cavity beneath is exposed.'); }
          }
        }
      }
      open = 0.05;
    }
    const jaw = this.id === 'forceps' ? 0.22 : 0.32;
    const ax = Math.cos(0.7), ay = Math.sin(0.7);
    const nx = -ay, ny = ax;
    const tz = zr + 0.3;
    for (const s of [-1, 1]) {
      const ox = nx * s * open, oy = ny * s * open;
      this.prim([p.x + ox, p.y + oy, tz, jaw * 0.6, p.x + ox * 2 + ax * 9, p.y + oy * 2 + ay * 9, tz + 8, jaw * 1.8], 1, PP.MATOBJ.chrome, [0.8, 0.8, 0.83, 0]);
      this.prim([p.x + ox * 2 + ax * 9, p.y + oy * 2 + ay * 9, tz + 8, jaw * 1.8, p.x + ax * 45 + nx * s * 4, p.y + ay * 45 + ny * s * 4, tz + 40, jaw * 2.6], 1, PP.MATOBJ.chrome, [0.74, 0.74, 0.77, 0]);
    }
  } else if (id === 'curette') {
    const zr = W.skinH(p.x, p.y);
    if (p.down && p.moved > 0.5) {
      const L = this.lesionAt(p.x, p.y, false);
      if (L && L.type === 'molluscum' && !L.coreOut) {
        L.open.r = Math.max(L.open.r, L.R * 0.5);
        L.spawnCore(this.W.ctx, true);
        W.wounds.addPuncture(L.x, L.y, 0.35);
      } else if (p.moved > 2 && !this._scr) { this._scr = 1; W.wounds.addPuncture(p.x, p.y, 0.15); }
      ph.contacts.push({ x: p.x, y: p.y, a: 1.0, fn: 0.5 });
    } else this._scr = 0;
    this.prim([p.x, p.y, zr + 0.5, 0.9, p.x + 4, p.y + 4, zr + 3, 0.5], 1, PP.MATOBJ.chrome, [0.82, 0.82, 0.85, 0]);
    this.prim([p.x + 4, p.y + 4, zr + 3, 0.5, p.x + 40, p.y + 30, zr + 30, 1.6], 1, PP.MATOBJ.chrome, [0.75, 0.75, 0.78, 0]);
  } else if (id === 'lido' || id === 'steroid') {
    const zr = W.skinH(p.x, p.y);
    if (id === 'lido' && p.down) {
      const v = dt * 0.35;
      this.lidoVol += v;
      W.wounds.inject(p.x, p.y, 'lido', v);
      if (p.t < dt * 1.5) W.wounds.addPuncture(p.x, p.y, 0.6);
      W.pain(p.x, p.y, dt * 0.15);
      // into a cyst lumen? (AAFP: infiltrate around and beneath, never into the cyst)
      for (const L of W.lesions) {
        if (L.group === undefined && (L.T.group === 'Cyst') && L.open.r <= 0 && Math.hypot(L.x - p.x, L.y - p.y) < L.rc * 0.55) {
          L.V += v * 1000 * 0.2; L.P += 3;
          if (!L._lumen) { L._lumen = 1; L.events.push('lumenInjection'); W.fx.toast('bad', 'Injected into the cyst', 'Anaesthetic belongs around and beneath the cyst, not in its lumen. It raises the pressure and can burst the wall (AAFP).'); }
        }
      }
    }
    this.prim([p.x, p.y, zr + 0.2, 0.08, p.x + 6, p.y + 6, zr + 6, 0.2], 1, PP.MATOBJ.chrome, [0.82, 0.82, 0.85, 0]);
    this.prim([p.x + 6, p.y + 6, zr + 6, 2.6, p.x + 40, p.y + 40, zr + 40, 2.6], 1, PP.MATOBJ.plastic, [0.95, 0.95, 0.97, 0]);
  } else if (id === 'compress') {
    const zr = W.skinH(p.x, p.y);
    if (p.down) { W.wounds.compress = { x: p.x, y: p.y, r: 10 }; ph.contacts.push({ x: p.x, y: p.y, a: 9, fn: 0.6 }); }
    this.primRaw([p.x, p.y, zr + (p.down ? 1.2 : 4), 0, 11, 9, 1.2, -0.2, 2, PP.MATOBJ.terry, 0, 0, 0.9, 0.9, 0.92, 0]);
  } else if (id === 'iodine') {
    const zr = W.skinH(p.x, p.y);
    if (p.down) { W.decals.paint(p.x, p.y, 2.8, 'iodine', 1); for (const L of W.lesions) if (Math.hypot(L.x - p.x, L.y - p.y) < L.R + 2) { if (!L.prepped) { L.prepped = true; L.events.push('iodine'); } } }
    this.prim([p.x, p.y, zr + 2.4, 2.4, p.x + 3, p.y + 2, zr + 6, 2.6], 1, PP.MATOBJ.iodineSwab, [0.42, 0.16, 0.04, 0.6]);
    this.prim([p.x + 3, p.y + 2, zr + 6, 0.9, p.x + 40, p.y + 30, zr + 34, 0.9], 1, PP.MATOBJ.paper, [0.9, 0.9, 0.88, 0]);
  } else if (id === 'gauze') {
    const zr = W.skinH(p.x, p.y);
    if (p.down) {
      if (p.speed > 4) W.decals.wipe(p.x, p.y, 6, this.W);
      else if (p.t > 0.25) { W.wounds.press.push({ x: p.x, y: p.y, r: 6.5, k: 1 }); ph.contacts.push({ x: p.x, y: p.y, a: 6, fn: 1.2 }); }
      W.absorb(p.x, p.y, 6.5, zr + 3);
    }
    this.primRaw([p.x, p.y, zr + (p.down ? 0.6 : 3), 0, 9, 9, 0.6, 0.15, 2, PP.MATOBJ.gauze, 0, 0, W.decals.gauzeCol[0], W.decals.gauzeCol[1], W.decals.gauzeCol[2], 0.35]);
  } else if (id === 'packing') {
    const zr = W.skinH(p.x, p.y);
    if (p.down) {
      const L = this.lesionAt(p.x, p.y, true);
      if (L && L.drained && (L.type === 'furuncle' || L.type === 'carbuncle' || L.type === 'pseudocyst')) {
        L.packed = Math.min(1, (L.packed || 0) + dt * 0.4);
        if (L.packed >= 1 && !L._pk) { L._pk = 1; L.events.push('packed'); W.fx.toast('good', 'Cavity packed', 'Ribbon gauze keeps the abscess walls apart so it keeps draining.'); }
      }
    }
    this.prim([p.x, p.y, zr + 1, 0.6, p.x + 10, p.y + 2, zr + 3, 0.6], 1, PP.MATOBJ.gauze, [0.95, 0.93, 0.85, 0]);
  } else if (id === 'patch') {
    const zr = W.skinH(p.x, p.y);
    this.primRaw([p.x, p.y, zr + 1.5, 0, 6, 6, 0.2, 0, 2, PP.MATOBJ.hydro, 0, 0, 0.86, 0.74, 0.62, 0.5]);
  }

  // wetness of gloves/swabs from nearby liquids
  if ((id === 'fingers' || id === 'swabs') && ph.contacts.length) {
    const P = W.parts;
    let wetHits = 0;
    for (const c of ph.contacts) for (let i = 0; i < P.hi; i++) {
      if (!P.alive[i]) continue;
      const m = P.mat[i];
      if (m === PP.MAT.bone) continue;
      if (Math.abs(P.x[i] - c.x) < c.a && Math.abs(P.y[i] - c.y) < c.a && P.z[i] < 3) {
        if (P.isLiquid(m) || m === PP.MAT.pus || m === PP.MAT.oil) wetHits++;
        if (id === 'swabs' && (P.isLiquid(m) || m === PP.MAT.pus)) {
          this.swabStain = [P.cr[i] * 0.5 + 0.43, P.cg[i] * 0.5 + 0.42, P.cb[i] * 0.5 + 0.4, 0.3];
          P.kill(i);
        }
      }
    }
    this.wet = PP.clamp(this.wet + wetHits * 0.02 - dt * 0.05, 0, 1);
  } else this.wet = Math.max(0, this.wet - dt * 0.1);

  this.forceN = this.force;
  p.lx = p.x; p.ly = p.y;
};

PP.Tools.prototype.prim = function (ab, type, mat, col) {
  this.primRaw([ab[0], ab[1], ab[2], ab[3], ab[4], ab[5], ab[6], ab[7], type, mat, 0, 0, col[0], col[1], col[2], col[3] || 0]);
};
PP.Tools.prototype.primRaw = function (v) {
  if (this.nPrim >= 160) return;
  this.prims.set(v, this.nPrim * 16);
  this.nPrim++;
};
