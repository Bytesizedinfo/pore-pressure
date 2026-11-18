'use strict';
/* Particle system for extruded contents. Position-based dynamics (Verlet + constraint projection).
   - Chains (pus worms, plugs, keratin ropes, hairs, cores, sacs, packing) keep link length (stretch), resist
     folding (bend) and break when over-stretched (paste rheology / tear strength).
   - Free droplets (blood, serum, thin pus, oil) merge with volume conservation, stick to skin by
     contact-angle pinning (small beads stay, big beads run) and leave trails in the film decal.
   Units: mm, s. */
PP.Particles = function (cap) {
  this.cap = cap;
  const F = (n) => new Float32Array(n), I = (n) => new Int32Array(n);
  this.x = F(cap); this.y = F(cap); this.z = F(cap);
  this.px = F(cap); this.py = F(cap); this.pz = F(cap);
  this.r = F(cap); this.cr = F(cap); this.cg = F(cap); this.cb = F(cap);
  this.mat = new Uint8Array(cap); this.alive = new Uint8Array(cap);
  this.pin = new Uint8Array(cap);     // 1 kinematic (root/grab)
  this.next = I(cap).fill(-1); this.prev = I(cap).fill(-1);
  this.rest = F(cap); this.bend = F(cap); this.brk = F(cap);
  this.age = F(cap); this.still = F(cap); this.owner = I(cap).fill(-1);
  this.onSkin = new Uint8Array(cap);
  this.free = []; for (let i = cap - 1; i >= 0; i--) this.free.push(i);
  this.count = 0;
  this.hi = 0;   // highest used index + 1

  this.spawn = function (x, y, z, r, mat, col) {
    if (!this.free.length) return -1;
    const i = this.free.pop();
    this.x[i] = this.px[i] = x; this.y[i] = this.py[i] = y; this.z[i] = this.pz[i] = z;
    this.r[i] = r; this.mat[i] = mat; this.alive[i] = 1; this.pin[i] = 0;
    this.next[i] = -1; this.prev[i] = -1; this.rest[i] = 0; this.bend[i] = 0; this.brk[i] = 1.6;
    this.age[i] = 0; this.still[i] = 0; this.owner[i] = -1; this.onSkin[i] = 0;
    const c = col || PP.hex2lin(PP.MATCOL[mat] || '#ffffff');
    this.cr[i] = c[0]; this.cg[i] = c[1]; this.cb[i] = c[2];
    this.count++;
    if (i + 1 > this.hi) this.hi = i + 1;
    return i;
  };
  this.kill = function (i) {
    if (!this.alive[i]) return;
    const n = this.next[i], p = this.prev[i];
    if (n >= 0) this.prev[n] = -1;
    if (p >= 0) this.next[p] = -1;
    this.alive[i] = 0; this.next[i] = this.prev[i] = -1; this.pin[i] = 0;
    this.free.push(i); this.count--;
  };
  this.link = function (a, b, rest, bend, brk) {
    this.next[a] = b; this.prev[b] = a; this.rest[a] = rest; this.bend[a] = bend || 0; this.brk[a] = brk || 1.6;
  };
  this.setVel = function (i, vx, vy, vz, dt) { this.px[i] = this.x[i] - vx * dt; this.py[i] = this.y[i] - vy * dt; this.pz[i] = this.z[i] - vz * dt; };

  const LIQ = new Set([PP.MAT.blood, PP.MAT.serum, PP.MAT.pusThin, PP.MAT.oil, PP.MAT.bloodyPus]);
  this.isLiquid = (m) => LIQ.has(m);
  // material properties: damping, skin friction, pinning radius (mm) for droplets, merge cap
  const MP = {};
  const def = (m, damp, fric, pinR, rmax) => (MP[m] = { damp, fric, pinR, rmax });
  def(1, 0.92, 0.85, 99, 0); def(2, 0.97, 0.45, 0.9, 1.1); def(3, 0.985, 0.25, 0.7, 1.0); def(4, 0.985, 0.3, 1.05, 1.7);
  def(5, 0.9, 0.9, 99, 0); def(6, 0.9, 0.9, 99, 0); def(7, 0.98, 0.25, 0.8, 1.3); def(8, 0.9, 0.7, 99, 0);
  def(9, 0.9, 0.85, 99, 0); def(10, 0.93, 0.5, 99, 0); def(11, 0.9, 0.8, 99, 0); def(12, 0.96, 0.15, 99, 0);
  def(13, 0.9, 0.85, 99, 0); def(14, 0.9, 0.9, 99, 0); def(15, 0.98, 0.35, 0.85, 1.2);
  this.MP = MP;

  // spatial hash (rebuilt each step) for droplet merging / separation
  const CS = 1.0;
  let gridW = 0, gridH = 0, ox = 0, oy = 0, head = null, link = new Int32Array(cap);
  const buildGrid = (W) => {
    const s = W.area.size;
    gridW = gridH = Math.ceil(s / CS) + 2; ox = -s / 2 - CS; oy = -s / 2 - CS;
    if (!head || head.length !== gridW * gridH) head = new Int32Array(gridW * gridH);
    head.fill(-1);
    for (let i = 0; i < this.hi; i++) {
      if (!this.alive[i] || this.next[i] >= 0 || this.prev[i] >= 0) continue;
      const gx = Math.floor((this.x[i] - ox) / CS), gy = Math.floor((this.y[i] - oy) / CS);
      if (gx < 0 || gy < 0 || gx >= gridW || gy >= gridH) continue;
      const c = gy * gridW + gx; link[i] = head[c]; head[c] = i;
    }
  };

  /* step: W provides skinH(x,y), gravity [gx,gy,gz] (mm/s^2), tool colliders, lensZ, callbacks. */
  this.step = function (dt, W) {
    const g = W.gravity;
    const hi = this.hi;
    // integrate
    for (let i = 0; i < hi; i++) {
      if (!this.alive[i]) continue;
      this.age[i] += dt;
      if (this.pin[i]) { this.px[i] = this.x[i]; this.py[i] = this.y[i]; this.pz[i] = this.z[i]; continue; }
      const mp = MP[this.mat[i]] || MP[1];
      const damp = this.onSkin[i] ? mp.damp * 0.97 : 0.999;
      let vx = (this.x[i] - this.px[i]) * damp, vy = (this.y[i] - this.py[i]) * damp, vz = (this.z[i] - this.pz[i]) * damp;
      this.px[i] = this.x[i]; this.py[i] = this.y[i]; this.pz[i] = this.z[i];
      const air = this.onSkin[i] ? 1 : 1; // (air drag negligible at these scales)
      this.x[i] += vx * air + g[0] * dt * dt; this.y[i] += vy * air + g[1] * dt * dt; this.z[i] += vz * air + g[2] * dt * dt;
    }
    // constraints
    const iters = 4;
    for (let it = 0; it < iters; it++) {
      for (let i = 0; i < hi; i++) {
        if (!this.alive[i]) continue;
        const j = this.next[i];
        if (j >= 0) {
          let dx = this.x[j] - this.x[i], dy = this.y[j] - this.y[i], dz = this.z[j] - this.z[i];
          const d = Math.sqrt(dx * dx + dy * dy + dz * dz) + 1e-9;
          const rest = this.rest[i];
          if (it === iters - 1 && d > rest * this.brk[i]) {
            // over-stretched: the strand tears here
            this.next[i] = -1; this.prev[j] = -1; if (W.onBreak) W.onBreak(i, j); continue;
          }
          const wi = this.pin[i] ? 0 : 1, wj = this.pin[j] ? 0 : 1, ws = wi + wj;
          if (ws > 0) {
            const k = ((d - rest) / d) / ws;
            this.x[i] += dx * k * wi; this.y[i] += dy * k * wi; this.z[i] += dz * k * wi;
            this.x[j] -= dx * k * wj; this.y[j] -= dy * k * wj; this.z[j] -= dz * k * wj;
          }
          // bending: keep i and next(next) apart (resists folding)
          const k2 = this.next[j];
          if (k2 >= 0 && this.bend[i] > 0) {
            dx = this.x[k2] - this.x[i]; dy = this.y[k2] - this.y[i]; dz = this.z[k2] - this.z[i];
            const d2 = Math.sqrt(dx * dx + dy * dy + dz * dz) + 1e-9;
            const target = rest * 2 * (0.55 + 0.45 * this.bend[i]);
            if (d2 < target) {
              const wk = this.pin[k2] ? 0 : 1, wsum = wi + wk;
              if (wsum > 0) {
                const s = (((d2 - target) / d2) / wsum) * this.bend[i] * 0.5;
                this.x[i] += dx * s * wi; this.y[i] += dy * s * wi; this.z[i] += dz * s * wi;
                this.x[k2] -= dx * s * wk; this.y[k2] -= dy * s * wk; this.z[k2] -= dz * s * wk;
              }
            }
          }
        }
      }
      // skin + tool collisions
      for (let i = 0; i < hi; i++) {
        if (!this.alive[i] || this.pin[i]) continue;
        const r = this.r[i];
        const sh = W.skinH(this.x[i], this.y[i]);
        const floor = sh + r * 0.82;
        if (this.z[i] < floor) {
          this.z[i] = floor;
          this.onSkin[i] = 1;
          if (it === iters - 1) {
            const mp = MP[this.mat[i]] || MP[1];
            // friction / contact-line pinning: beads smaller than pinR hold; larger ones slide
            let fr = mp.fric;
            if (this.isLiquid(this.mat[i])) fr = r < mp.pinR ? 0.97 : PP.clamp(0.75 - (r - mp.pinR) * 1.4, 0.05, 0.75);
            this.x[i] = PP.lerp(this.x[i], this.px[i], fr);
            this.y[i] = PP.lerp(this.y[i], this.py[i], fr);
          }
        } else if (it === iters - 1) this.onSkin[i] = this.z[i] < floor + 0.05 ? 1 : 0;
        if (W.colliders) for (const c of W.colliders) c(i, this);
      }
    }
    // droplet merging (liquids only)
    buildGrid(W);
    for (let i = 0; i < hi; i++) {
      if (!this.alive[i] || !this.isLiquid(this.mat[i]) || this.next[i] >= 0 || this.prev[i] >= 0) continue;
      const gx = Math.floor((this.x[i] - ox) / CS), gy = Math.floor((this.y[i] - oy) / CS);
      for (let yy = gy - 1; yy <= gy + 1; yy++) for (let xx = gx - 1; xx <= gx + 1; xx++) {
        if (xx < 0 || yy < 0 || xx >= gridW || yy >= gridH) continue;
        for (let j = head[yy * gridW + xx]; j >= 0; j = link[j]) {
          if (j <= i || !this.alive[j] || !this.alive[i]) continue;
          const mj = this.mat[j], mi = this.mat[i];
          if (!this.isLiquid(mj)) continue;
          const dx = this.x[j] - this.x[i], dy = this.y[j] - this.y[i], dz = this.z[j] - this.z[i];
          const d2 = dx * dx + dy * dy + dz * dz, rs = (this.r[i] + this.r[j]) * 0.75;
          if (d2 > rs * rs) continue;
          const cap2 = (MP[mi] || MP[4]).rmax;
          const vi = this.r[i] ** 3, vj = this.r[j] ** 3;
          const rn = Math.cbrt(vi + vj);
          if (rn > cap2) continue;
          const wi = vi / (vi + vj), wj = 1 - wi;
          this.x[i] = this.x[i] * wi + this.x[j] * wj; this.y[i] = this.y[i] * wi + this.y[j] * wj; this.z[i] = Math.max(this.z[i], this.z[j]);
          this.px[i] = this.px[i] * wi + this.px[j] * wj; this.py[i] = this.py[i] * wi + this.py[j] * wj; this.pz[i] = Math.max(this.pz[i], this.pz[j]);
          // blood dominates colour when mixed
          if (mj === PP.MAT.blood && mi !== mj) { this.mat[i] = mj; }
          this.cr[i] = this.cr[i] * wi + this.cr[j] * wj; this.cg[i] = this.cg[i] * wi + this.cg[j] * wj; this.cb[i] = this.cb[i] * wi + this.cb[j] * wj;
          this.r[i] = rn;
          this.kill(j);
        }
      }
    }
    // bookkeeping: lens hits, bounds, settling
    const half = W.area.size / 2 + 4;
    let mv = 0;
    for (let i = 0; i < hi; i++) {
      if (!this.alive[i]) continue;
      if (this.z[i] > W.lensZ) { if (W.onLens) W.onLens(i); this.kill(i); continue; }
      if (Math.abs(this.x[i]) > half || Math.abs(this.y[i]) > half || this.z[i] < -20) { this.kill(i); continue; }
      const sp = Math.abs(this.x[i] - this.px[i]) + Math.abs(this.y[i] - this.py[i]) + Math.abs(this.z[i] - this.pz[i]);
      this.still[i] = sp < 0.002 ? this.still[i] + dt : 0;
      if (sp > mv) mv = sp;
      if (this.onSkin[i] && this.isLiquid(this.mat[i]) && W.onTrail && sp > 0.01) W.onTrail(i);
      // settled small liquid droplets soak into the film decal (keeps the particle budget)
      if (this.isLiquid(this.mat[i]) && this.onSkin[i] && this.still[i] > 2.5 && this.r[i] < 0.45 && this.next[i] < 0) {
        if (W.onSettle) W.onSettle(i);
        this.kill(i);
      }
    }
    while (this.hi > 0 && !this.alive[this.hi - 1]) this.hi--;
    this.moving = mv > 0.0015;
  };

  this.nearest = function (x, y, maxD, filter) {
    let best = -1, bd = maxD * maxD;
    for (let i = 0; i < this.hi; i++) {
      if (!this.alive[i] || (filter && !filter(i))) continue;
      const dx = this.x[i] - x, dy = this.y[i] - y;
      const d = dx * dx + dy * dy;
      if (d < bd) { bd = d; best = i; }
    }
    return best;
  };
  this.chainOf = function (i) {
    let a = i; while (this.prev[a] >= 0) a = this.prev[a];
    const out = []; for (let k = a; k >= 0; k = this.next[k]) out.push(k);
    return out;
  };
  this.clear = function () { for (let i = 0; i < this.hi; i++) if (this.alive[i]) this.kill(i); this.hi = 0; };
};
