'use strict';
/* Skin mechanics (CPU mirror of the GLSL in 08_render.js).
   Skin + subcutis is treated as a nearly incompressible elastic body (nu = 0.48) with closed-form
   surface solutions superposed per contact (linear elasticity):
     - Boussinesq: uniform pressure on a disc -> vertical surface displacement (dent / suction dome)
     - Cerruti: tangential (friction) load -> in-plane displacement (skin dragged by the fingers)
     - incompressible layer thickening: w += -Heff * div(u)   (skin bulges between pinching fingers)
     - finite tissue depth: all fields decay as exp(-r / Ld)
     - prestress along relaxed-skin-tension lines: Griffith/Westergaard crack opening for incisions,
       Kirsch hole for punches (holes ovalise along the lines).
   Stress reaching a buried cavity: Boussinesq sigma_z at depth + lateral compression from the strain field. */

PP.Phys = function () {
  this.nu = 0.48;
  this.contacts = [];
  /* Squeezing beyond small-strain elasticity (deformation only: blanching and cavity loads use the live contacts):
     - pinch fold: pads that grip and drag the skin toward each other shorten the surface between them by the
       approach delta; the stiff surface layer cannot shorten that much, so the excess rises as a fold. Arc length of a
       cos^2 bump of span L gives h = (2/pi) sqrt(L delta); 0.66 of that (the rest is in-plane compression of soft
       tissue) is a calibrated estimate.
     - pile-up: nearly incompressible tissue displaced by a soft pad rises in a low rim around it (~12% of the dent,
       calibrated estimate).
     - viscoelastic recovery: on release, loads become decaying ghosts; about half the deformation returns at once and
       the rest creeps back (tau ~1.5 s, calibrated), the Cutometer split into immediate retraction and slow recovery. */
  this.pinch = null; this.ghosts = []; this.pinchGhost = null; this.ghostT = 0;
  this.ghostK = function () { const t = this.ghostT; return 0.5 * Math.exp(-t / 0.08) + 0.5 * Math.exp(-t / 1.5); };
  this.release = function (prev) {
    this.ghosts = prev.slice(0, 32).map((c) => Object.assign({}, c));
    this.pinchGhost = this.pinch ? Object.assign({}, this.pinch) : null;
    this.ghostT = 0;
  };
  this.stepGhosts = function (dt) {
    if (!this.ghosts.length && !this.pinchGhost) return;
    this.ghostT += dt;
    if (this.ghostK() < 0.02) { this.ghosts.length = 0; this.pinchGhost = null; }
  };
  this.clearGhosts = function () { this.ghosts.length = 0; this.pinchGhost = null; this.pinch = null; };
  // the fold currently shaping the skin (live pinch, or a relaxing one) with its scale
  this.foldNow = function () { return this.pinch ? { P: this.pinch, k: 1 } : this.pinchGhost ? { P: this.pinchGhost, k: this.ghostK() } : null; };
  this.foldW = function (x, y, P) {
    const dx = x - P.mx, dy = y - P.my, s = dx * P.ux + dy * P.uy, q = -dx * P.uy + dy * P.ux;
    if (Math.abs(s) >= P.Ls * 0.5) return 0;
    const c = Math.cos((Math.PI * s) / P.Ls);
    return P.h * c * c * Math.exp(-(q * q) / (0.3 * P.wp * P.wp));
  };
  // distance used for a pad's dent: pads are flagged with pad=1
  this.pileUp = function (c, r) { const a = c.aV || c.a; return c.pad ? 0.12 * this.dentW(c.fn, a, 0) * -1 * Math.exp(-Math.pow((r - 1.25 * a) / (0.45 * a), 2)) : 0; };
  this.setArea = function (A) {
    this.A = A;
    this.Ek = A.E;                // kPa
    this.En = A.E * 1e-3;         // N/mm^2
    this.G = this.En / (2 * (1 + this.nu));
    this.Ld = A.Ld;
    this.Heff = A.Heff;
    const th = (A.rstl * Math.PI) / 180;
    this.tx = Math.cos(th); this.ty = Math.sin(th);
    this.s1 = A.s1; this.s2 = A.s2;
  };

  // --- per-contact closed forms --------------------------------------------------------
  // vertical displacement (mm) at distance r from a disc load fn (N, + = pressing in) of radius a
  this.dentW = function (fn, a, r) {
    const nu = this.nu;
    const w0 = (2 * (1 - nu * nu) * fn) / (Math.PI * a * this.En);
    const p = r / a;
    const f = p < 1 ? 1 - (1 - 2 / Math.PI) * p * p : 1 / (2 * p) + (2 / Math.PI - 0.5) / (p * p * p);
    return -w0 * f * Math.exp(-r / this.Ld);
  };
  // in-plane displacement from tangential load (qx,qy) N at offset (dx,dy) mm, contact radius a
  this.cerruti = function (qx, qy, a, dx, dy, out) {
    const nu = this.nu;
    const r2 = dx * dx + dy * dy + a * a;
    const r = Math.sqrt(r2);
    const k = 1 / (2 * Math.PI * this.G * r);
    const qr = (qx * dx + qy * dy) / r2;
    const dec = Math.exp(-Math.sqrt(dx * dx + dy * dy) / this.Ld);
    out[0] += k * ((1 - nu) * qx + nu * qr * dx) * dec;
    out[1] += k * ((1 - nu) * qy + nu * qr * dy) * dec;
  };

  // contacts: {x,y,a,fn,qx,qy,ring(optional radius),suction(kPa)}
  this.uAt = function (x, y, out) {
    out[0] = 0; out[1] = 0;
    for (const c of this.contacts) {
      if (c.qx || c.qy) this.cerruti(c.qx, c.qy, c.a, x - c.x, y - c.y, out);
    }
    return out;
  };
  const tmp = [0, 0], tmp2 = [0, 0];
  this.strain = function (x, y) {
    const h = 0.12;
    this.uAt(x + h, y, tmp); const uxp = tmp[0], uyp = tmp[1];
    this.uAt(x - h, y, tmp2); const uxm = tmp2[0], uym = tmp2[1];
    this.uAt(x, y + h, tmp); const vxp = tmp[0], vyp = tmp[1];
    this.uAt(x, y - h, tmp2); const vxm = tmp2[0], vym = tmp2[1];
    const exx = (uxp - uxm) / (2 * h), eyy = (vyp - vym) / (2 * h);
    const exy = 0.5 * ((uyp - uym) / (2 * h) + (vxp - vxm) / (2 * h));
    return { exx, eyy, exy, div: exx + eyy };
  };
  // vertical surface displacement from all contacts (dents, suction domes, thickening)
  this.wAt = function (x, y) {
    let w = 0;
    for (const c of this.contacts) {
      const r = Math.hypot(x - c.x, y - c.y);
      if (c.ring) {
        // ring load: average of the disc solution over the ring
        const rr = Math.abs(r - c.ring);
        w += this.dentW(c.fn, c.a, rr) * 0.9;
      } else if (c.fn) w += this.dentW(c.fn, c.a, r);
      if (c.suction) w += -this.dentW((c.suction * 1e-3) * Math.PI * c.a * c.a, c.a, r) * 0.5; // dome up (Cutometer-calibrated)
    }
    let th = 0;
    if (this.contacts.some((c) => c.qx || c.qy)) th = -this.Heff * this.strain(x, y).div;
    w += th;
    const F = this.foldNow();
    if (F) w += Math.max(0, F.k * this.foldW(x, y, F.P) - Math.max(0, th));
    for (const c of this.contacts) if (c.pad && c.fn) w += this.pileUp(c, Math.hypot(x - c.x, y - c.y));
    return w;
  };

  // vertical stress (kPa) at a buried point from all normal loads (Boussinesq), plus lateral compression
  // sigma_z (kPa) at depth z, horizontal offset r, from load F (N) on a disc of radius a:
  // on the axis the exact uniform-disc solution p[1 - z^3/(a^2+z^2)^1.5]; far away the Boussinesq point load.
  this.sigmaZ = function (F, a, r, z) {
    const p = F / (Math.PI * a * a);
    const axis = p * (1 - (z * z * z) / Math.pow(a * a + z * z, 1.5));
    const R2 = r * r + z * z;
    const point = (3 * F * z * z * z) / (2 * Math.PI * Math.pow(R2, 2.5) + 1e-12);
    const inner = axis * (1 - PP.smooth(0.55 * a, 1.35 * a, r));
    return Math.max(inner, Math.min(point, p)) * 1000;
  };
  this.cavityLoad = function (x, y, z) {
    // contacts further than ~6 decay lengths have no measurable effect
    if (!this.contacts.some((c) => Math.hypot(x - c.x, y - c.y) < 6 * this.Ld + c.a)) return { sz: 0, lat: 0, total: 0 };
    let sz = 0;
    for (const c of this.contacts) {
      const r = Math.hypot(x - c.x, y - c.y);
      // suction pulls tissue up: negative stress transmitted to the cavity
      if (c.suction) sz -= this.sigmaZ(c.suction * 1e-3 * Math.PI * c.a * c.a, c.a, r, z) * 0.6;
      if (c.fn > 0) sz += this.sigmaZ(c.fn, c.a, r, z);
    }
    let lat = 0;
    if (this.contacts.some((c) => c.qx || c.qy)) {
      const e = this.strain(x, y);
      lat = this.Ek * 2.0 * Math.max(0, -e.div) * Math.exp(-z / (2 * this.Heff));
    }
    return { sz, lat, total: sz + lat };
  };

  // contact pressure (kPa) pressing on the roof disc (centre x,y radius R): blocks surface rupture
  this.roofCover = function (x, y, R) {
    let p = 0;
    for (const c of this.contacts) {
      if (!c.fn || c.ring) continue;
      const d = Math.hypot(x - c.x, y - c.y);
      if (d > c.a + R) continue;
      // overlap fraction of the roof disc covered by the contact disc (approx.)
      const ov = PP.clamp((c.a + R - d) / (2 * Math.min(c.a, R)), 0, 1);
      p += (c.fn / (Math.PI * c.a * c.a)) * 1000 * ov;
    }
    return p;
  };

  // --- prestress: incisions and holes --------------------------------------------------
  // normal stress across a cut with direction (dx,dy) (unit)
  this.sigmaAcross = function (dx, dy) {
    const nx = -dy, ny = dx;
    const c = nx * this.tx + ny * this.ty;   // projection of the cut normal on the tension-line direction
    return this.s2 + (this.s1 - this.s2) * c * c;
  };
  // total opening (mm) at the centre of a through-dermis cut of half-length cl (Griffith: 4 sigma c / E)
  this.cutGape = function (dx, dy, cl, depthFrac) {
    return ((4 * this.sigmaAcross(dx, dy) * cl) / this.Ek) * Math.sqrt(PP.clamp(depthFrac, 0, 1));
  };
  // punch hole radius along / across the tension lines (Kirsch, plane stress) with mild recoil
  this.holeRadii = function (a) {
    const s1 = this.s1, s2 = this.s2, E = this.Ek;
    return { along: a * (1 + (3 * s1 - s2) / E) * 0.9, across: a * (1 + (3 * s2 - s1) / E) * 0.9 };
  };
};

/* Rheology: volumetric flow (mm^3/s = µL/s) through an opening of radius r (mm), channel length L (mm),
   driving pressure dP (kPa). Newtonian: Hagen–Poiseuille. Paste: Bingham onset at dP_y = 2 ty L / r. */
PP.flow = function (k, dP, r, L, mu, ty) {
  if (dP <= 0 || r <= 0) return 0;
  const LL = Math.max(L, 0.02);
  let drive = dP;
  if (k === 'paste') { const dPy = (2 * (ty || 0) * LL) / r; drive = dP - dPy; if (drive <= 0) return 0; }
  return (Math.PI * Math.pow(r, 4) * drive * 1e6) / (8 * mu * LL);
};
// jet exit speed (mm/s) for low-viscosity contents: Bernoulli v = sqrt(2 dP / rho), rho ~ 1.03 g/mL
PP.jetSpeed = (dP) => Math.sqrt((2 * dP * 1000) / 1030) * 1000;

// Sebum solid fraction vs tissue temperature (melting range ~30–35 °C, SCC):
PP.sebumSolid = (T) => PP.clamp((40 - T) / 10, 0.12, 1);
