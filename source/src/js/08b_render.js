'use strict';
/* Renderer: owns GL resources and runs the passes each frame. */
PP.Renderer = function (canvas, W) {
  const G = (this.G = new PP.GL(canvas));
  const gl = (this.gl = G.gl);
  this.W = W;
  this.canvas = canvas;
  const SH = PP.SH;
  this.P = {
    def: G.program('deform', SH.fsVS, SH.defFS),
    grad: G.program('grad', SH.fsVS, SH.gradFS),
    pref: G.program('prefilter', SH.fsVS, SH.prefFS),
    obj: G.program('objects', SH.objVS, SH.objFS),
    smooth: G.program('smooth', SH.fsVS, SH.smoothFS),
    phys: G.program('phys', SH.fsVS, SH.physFS),
    brush: G.program('brush', SH.brushVS, SH.brushFS),
    skin: G.program('skin', SH.fsVS, SH.skinFS),
    sss: G.program('sss', SH.fsVS, SH.sssFS),
    comp: G.program('comp', SH.fsVS, SH.compFS),
    post: G.program('post', SH.fsVS, SH.postFS),
  };
  this.scale = PP.TEST ? 0.75 : PP.Renderer.scaleFor(PP.storage.get('quality', 'high'));
  this.rt = {};
  this.instData = new Float32Array(16 * 9000);
  this.lesData = new Float32Array(6 * 64 * 4);
  this.lesTex = G.tex(6, 64, { ifmt: gl.RGBA32F, fmt: gl.RGBA, type: gl.FLOAT, filter: gl.NEAREST });
  this.gridN = 48;
  this.gridData = new Uint16Array(this.gridN * this.gridN * 4);
  this.gridTex = G.tex(this.gridN, this.gridN, { ifmt: gl.RGBA16UI, fmt: gl.RGBA_INTEGER, type: gl.UNSIGNED_SHORT, filter: gl.NEAREST });
  this.heatBytes = new Uint8Array(64 * 64);
  this.heatTex = G.tex(64, 64, { ifmt: gl.R8, fmt: gl.RED, type: gl.UNSIGNED_BYTE });
  this.dummy = G.tex(4, 4, { data: new Uint8Array(64) });
  this.dyn = 1; this.vsx = 1; this.vsy = 1; this.dbg = +(PP.params.get('dbg') || 0);
  this.physA = null; this.physB = null; this.film = null;
  this.brushes = [];
  this.drops = [];   // lens droplets
  this.initSSS();
};

PP.Renderer.prototype.initSSS = function () {
  // GPU Gems 3 ch.14 three-layer skin: variances (mm^2) and RGB weights
  const V = [0.0064, 0.0484, 0.187, 0.567, 1.99, 7.41];
  const Wt = [[0.233, 0.455, 0.649], [0.1, 0.336, 0.344], [0.118, 0.198, 0.0], [0.113, 0.007, 0.007], [0.358, 0.004, 0.0], [0.078, 0, 0]];
  const N = 12, Rmax = 4.2;
  const xs = [];
  for (let k = -N; k <= N; k++) xs.push(Math.sign(k) * Rmax * Math.pow(Math.abs(k) / N, 2));
  const off = new Float32Array(25), w = new Float32Array(75), sum = [0, 0, 0];
  for (let k = 0; k < 25; k++) {
    const x = xs[k];
    const dx = k === 0 ? xs[1] - xs[0] : k === 24 ? xs[24] - xs[23] : (xs[k + 1] - xs[k - 1]) / 2;
    off[k] = x;
    for (let c = 0; c < 3; c++) {
      let p = 0;
      for (let i = 0; i < 6; i++) p += (Wt[i][c] * Math.exp((-x * x) / (2 * V[i]))) / Math.sqrt(2 * Math.PI * V[i]);
      w[k * 3 + c] = p * dx; sum[c] += p * dx;
    }
  }
  for (let k = 0; k < 25; k++) for (let c = 0; c < 3; c++) w[k * 3 + c] /= sum[c];
  this.sssOff = off; this.sssW = w;
};

// canvas stays at full size; internal render targets use a resolution step (1, 0.75, 0.55)
PP.Renderer.prototype.resize = function (ds) {
  const G = this.G, gl = this.gl;
  const cw = Math.max(16, Math.floor(this.canvas.clientWidth * this.scale)), ch = Math.max(16, Math.floor(this.canvas.clientHeight * this.scale));
  if (this.canvas.width !== cw || this.canvas.height !== ch) { this.canvas.width = cw; this.canvas.height = ch; }
  this.cw = cw; this.ch = ch;
  const w = Math.max(16, Math.round(cw * (ds || 1))), h = Math.max(16, Math.round(ch * (ds || 1)));
  if (this.w === w && this.h === h) return;
  this.w = w; this.h = h;
  for (const k in this.rt) G.freeTarget(this.rt[k]);
  const F16 = { ifmt: gl.RGBA16F, fmt: gl.RGBA, type: gl.HALF_FLOAT };
  const F16N = { ifmt: gl.RGBA16F, fmt: gl.RGBA, type: gl.HALF_FLOAT, filter: gl.NEAREST };
  const hw = Math.max(8, w >> 1), hh = Math.max(8, h >> 1);
  this.rt.def = G.target(hw, hh, [F16, F16]);
  this.rt.obj = G.target(w, h, [F16N, { ifmt: gl.RGBA8, fmt: gl.RGBA, type: gl.UNSIGNED_BYTE, filter: gl.NEAREST }], true);
  this.rt.objS = G.target(w, h, [F16]);
  this.rt.skin = G.target(w, h, [F16, F16, F16]);
  this.rt.sssA = G.target(hw, hh, [F16]);
  this.rt.sssB = G.target(hw, hh, [F16]);
  this.rt.comp = G.target(w, h, [F16]);
};

PP.Renderer.prototype.setupWorld = function () {
  const G = this.G, gl = this.gl;
  const F16 = { ifmt: gl.RGBA16F, fmt: gl.RGBA, type: gl.HALF_FLOAT };
  for (const k of ['physA', 'physB', 'film']) if (this[k]) G.freeTarget(this[k]);
  this.physA = G.target(512, 512, [F16]); this.physB = G.target(512, 512, [F16]);
  this.film = G.target(1024, 1024, [{ ifmt: gl.RGBA8, fmt: gl.RGBA, type: gl.UNSIGNED_BYTE }]);
  // perfusion starts at 1
  for (const t of [this.physA, this.physB]) { gl.bindFramebuffer(gl.FRAMEBUFFER, t.fb); gl.viewport(0, 0, 512, 512); gl.clearColor(1, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT); }
  gl.bindFramebuffer(gl.FRAMEBUFFER, this.film.fb); gl.viewport(0, 0, 1024, 1024); gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  this.drops.length = 0;
};

// ---------- assets ----------
PP.Renderer.scaleFor = (q) => (q === 'low' ? 0.6 : q === 'sharp' ? Math.min(window.devicePixelRatio || 1, 1.5) : Math.min(window.devicePixelRatio || 1, 1));
PP.Renderer.prototype.prefetchSet = function (name) {
  for (const k of ['_chromo.webp', '_hgt.webp', '_detail.webp']) this.loadImage('tex/' + name + k);
};
PP.Renderer.prototype.loadImage = function (url) {
  this._img = this._img || new Map();
  if (this._img.has(url)) return this._img.get(url);
  const pr = this._loadImage(url);
  this._img.set(url, pr);
  return pr;
};
PP.Renderer.prototype._loadImage = function (url) {
  return fetch(url).then((r) => { if (!r.ok) throw new Error('Failed to load ' + url + ' (' + r.status + ')'); return r.blob(); })
    .then((b) => createImageBitmap(b, { premultiplyAlpha: 'none', colorSpaceConversion: 'none' }));
};
PP.Renderer.prototype.loadSet = async function (name) {
  this.sets = this.sets || {};
  if (this.sets[name]) return this.sets[name];
  const G = this.G, gl = this.gl;
  const [ci, hi, di] = await Promise.all([this.loadImage('tex/' + name + '_chromo.webp'), this.loadImage('tex/' + name + '_hgt.webp'),
    this.loadImage('tex/' + name + '_detail.webp').catch(() => null)]);
  const chromo = G.texFromImage(ci);
  const detail = di ? G.texFromImage(di) : G.tex(4, 4, { data: new Uint8Array(64).fill(128), wrap: gl.REPEAT });
  const hraw = G.texFromImage(hi);
  // gradient texture (RGBA16F: d/du, d/dv, height, pore)
  const sz = hi.width;
  const rt = G.target(sz, sz, [{ ifmt: gl.RGBA16F, fmt: gl.RGBA, type: gl.HALF_FLOAT, wrap: gl.REPEAT, mip: false }]);
  gl.bindFramebuffer(gl.FRAMEBUFFER, rt.fb); gl.viewport(0, 0, sz, sz);
  gl.useProgram(this.P.grad.p);
  G.bindTex(0, hraw, this.P.grad.u.uH); gl.uniform1f(this.P.grad.u.uSize, sz);
  G.drawFS();
  gl.bindTexture(gl.TEXTURE_2D, rt.texs[0].t);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
  gl.generateMipmap(gl.TEXTURE_2D);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.deleteTexture(hraw.t);
  const set = { chromo, detail, nrm: rt.texs[0], meta: this.W.manifest.sets[name] };
  this.sets[name] = set;
  return set;
};
PP.Renderer.prototype.prefetchEnv = function () {
  this._envP = this._envP || fetch('env/env.json').then((r) => { if (!r.ok) throw new Error('env.json ' + r.status); return r.json(); });
  return this._envP;
};
PP.Renderer.prototype.loadEnv = async function () {
  const G = this.G, gl = this.gl;
  const meta = await this.prefetchEnv();
  this.envMeta = meta;
  // half-float RGBA radiance, base64 in the JSON (artifacts serve JSON but not raw binary)
  const bin = atob(meta.data_b64), bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const env = G.tex(meta.width, meta.height, { ifmt: gl.RGBA16F, fmt: gl.RGBA, type: gl.HALF_FLOAT, data: new Uint16Array(bytes.buffer), wrap: gl.REPEAT });
  const lw = 128, lh = 64;
  const atlas = G.target(lw, lh * 5, [{ ifmt: gl.RGBA16F, fmt: gl.RGBA, type: gl.HALF_FLOAT }]);
  gl.bindFramebuffer(gl.FRAMEBUFFER, atlas.fb);
  gl.useProgram(this.P.pref.p);
  G.bindTex(0, env, this.P.pref.u.uEnv);
  const rough = [0.05, 0.2, 0.38, 0.56, 0.74];
  for (let l = 0; l < 5; l++) {
    gl.viewport(0, l * lh, lw, lh);
    gl.uniform1f(this.P.pref.u.uRough, rough[l]);
    G.drawFS();
  }
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  this.envAtlas = atlas.texs[0];
  this.sh = new Float32Array(27);
  meta.sh9.forEach((c, i) => { this.sh[i * 3] = c[0]; this.sh[i * 3 + 1] = c[1]; this.sh[i * 3 + 2] = c[2]; });
  // normalise exposure: irradiance on a camera-facing surface -> ~0.82 (the HDRI's absolute scale is arbitrary)
  const yaw = this.W.envYaw;
  const n = [Math.sin(yaw) * 1, 0, Math.cos(yaw) * 1];   // toEnv((0,0,1))
  const s = meta.sh9, Y = (k) => s[k];
  const E = [0, 1, 2].map((c) => 0.886227 * Y(0)[c] + 1.023328 * (Y(1)[c] * n[1] + Y(2)[c] * n[2] + Y(3)[c] * n[0]) + 0.858086 * (Y(4)[c] * n[0] * n[1] + Y(5)[c] * n[1] * n[2] + Y(7)[c] * n[0] * n[2]) + 0.247708 * Y(6)[c] * (3 * n[2] * n[2] - 1) + 0.429043 * Y(8)[c] * (n[0] * n[0] - n[1] * n[1]));
  const lum = 0.2126 * E[0] + 0.7152 * E[1] + 0.0722 * E[2];
  this.W.exposure = 0.82 / Math.max(lum, 1e-3);
  this.W.envFront = E;
};

// ---------- per-frame data ----------
PP.Renderer.prototype.uploadLesions = function () {
  const W = this.W, d = this.lesData;
  d.fill(0);
  const Ls = W.lesions.slice(0, 64);
  Ls.forEach((L, i) => {
    const o = i * 24;
    const cx = L.x + L.ox, cy = L.y + L.oy;
    const T = L.T;
    const f = L.queue.length ? L.fill() : 1;
    const H = L.domeH();
    const plugExt = L.plug ? (L.plug.out ? 1 : L.plug.ext / L.plug.L) : (L.coreOut || (L.T.vis === 20 && L.done) ? 1 : 0);
    const headR = T.vis === 9 || T.vis === 10 ? L.R * (0.12 + 0.2 * L.pointing) : T.vis === 1 || T.vis === 2 ? L.R * 0.35 : L.R * 0.45;
    let openVis = L.open.r > 0 && (L.popped || L.open.kind === 'needle' || L.open.kind === 'tear') ? Math.min(L.ropen ? L.ropen() : L.open.r, L.R * 0.6) : 0;
    if (T.open === 'open') openVis = L.open.r;
    const cc = L.type === 'pustule' || L.type === 'giant' || L.type === 'ingrown' || L.type === 'furuncle' || L.type === 'carbuncle' ? L.pusCol : L.type === 'pseudocyst' ? PP.hex2lin('#b97f6a') : L.type === 'epidermoid' || L.type === 'pilar' ? PP.hex2lin('#efe2b8') : L.type === 'whitehead' || L.type === 'macrocomedone' ? PP.hex2lin('#f0ead8') : PP.hex2lin('#f2eee4');
    const vis = T.vis;
    const vals = [
      cx, cy, L.R, H,
      vis, L.inflam + L.deep * 0.4 + L.irrit * 0.5, headR, openVis,
      cc[0], cc[1], cc[2], L.type === 'furuncle' || L.type === 'carbuncle' ? 1 : f,
      L.depth, L.queue.length && L.open.r > 0 ? 1 - f : 0, L.crater, L.punctum || 0,
      L.seed, L.pointing, L.hematoma, plugExt,
      0, L.steroidT >= 0 ? PP.clamp(L.steroidT / 172800, 0, 1) : 0, L.scab, 0,
    ];
    d.set(vals, o);
  });
  const gl = this.gl;
  gl.bindTexture(gl.TEXTURE_2D, this.lesTex.t);
  gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 6, 64, gl.RGBA, gl.FLOAT, d);
  // culling grid in material (patch) coordinates
  const N = this.gridN, s = W.area.size, cell = s / N;
  const gd = this.gridData; gd.fill(0);
  const best = new Float32Array(N * N * 4).fill(1e9);
  Ls.forEach((L, i) => {
    const ext = L.R * (L.T.vis >= 15 && L.T.vis <= 18 ? 1.25 : 2.4) + 1.0 + Math.hypot(L.ox, L.oy);
    const cx = L.x + L.ox, cy = L.y + L.oy;
    const x0 = Math.max(0, Math.floor((cx - ext + s / 2) / cell)), x1 = Math.min(N - 1, Math.floor((cx + ext + s / 2) / cell));
    const y0 = Math.max(0, Math.floor((cy - ext + s / 2) / cell)), y1 = Math.min(N - 1, Math.floor((cy + ext + s / 2) / cell));
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      const mx = (x + 0.5) * cell - s / 2, my = (y + 0.5) * cell - s / 2;
      const dist = Math.hypot(mx - cx, my - cy) - L.R;
      const k = (y * N + x) * 4;
      // keep the 4 nearest (by edge distance)
      let slot = -1, worst = -1;
      for (let j = 0; j < 4; j++) { if (gd[k + j] === 0) { slot = j; break; } if (best[k + j] > worst) { worst = best[k + j]; slot = j; } }
      if (gd[k + slot] === 0 || best[k + slot] > dist) { gd[k + slot] = i + 1; best[k + slot] = dist; }
    }
  });
  gl.bindTexture(gl.TEXTURE_2D, this.gridTex.t);
  gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, N, N, gl.RGBA_INTEGER, gl.UNSIGNED_SHORT, gd);
  // heat
  const hb = this.heatBytes, ht = W.wounds.heat;
  for (let i = 0; i < hb.length; i++) hb[i] = PP.clamp(((ht[i] - 30) / 15) * 255, 0, 255);
  gl.bindTexture(gl.TEXTURE_2D, this.heatTex.t);
  gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 64, 64, gl.RED, gl.UNSIGNED_BYTE, hb);
};

PP.Renderer.prototype.contactUniforms = function (prog) {
  const gl = this.gl, C = this.W.phys.contacts;
  const n = Math.min(48, C.length);
  const a = this._c0 || (this._c0 = new Float32Array(48 * 4)), b = this._c1 || (this._c1 = new Float32Array(48 * 4));
  for (let i = 0; i < n; i++) {
    const c = C[i], o = i * 4;
    a[o] = c.x; a[o + 1] = c.y; a[o + 2] = c.a; a[o + 3] = c.fn || 0;
    b[o] = c.qx || 0; b[o + 1] = c.qy || 0; b[o + 2] = c.suction || 0; b[o + 3] = 0;
  }
  gl.uniform4fv(prog.u.uC0, a); gl.uniform4fv(prog.u.uC1, b); gl.uniform1i(prog.u.uNC, n);
};
PP.Renderer.prototype.woundUniforms = function (prog) {
  const gl = this.gl, Wd = this.W.wounds, clock = this.W.clock;
  const B = this._wb || (this._wb = { c0: new Float32Array(64), c1: new Float32Array(64), h0: new Float32Array(32), h1: new Float32Array(32), j0: new Float32Array(32), j1: new Float32Array(32), p0: new Float32Array(128) });
  const nc = Math.min(16, Wd.cuts.length), oc = Wd.cuts.length - nc;
  for (let i = 0; i < nc; i++) {
    const c = Wd.cuts[oc + i], o = i * 4;
    B.c0[o] = c.ax; B.c0[o + 1] = c.ay; B.c0[o + 2] = c.bx; B.c0[o + 3] = c.by;
    B.c1[o] = c.depth; B.c1[o + 1] = c.gape; B.c1[o + 2] = c.clot; B.c1[o + 3] = clock - c.t;
  }
  if (prog.u.uCut0) { gl.uniform4fv(prog.u.uCut0, B.c0); gl.uniform4fv(prog.u.uCut1, B.c1); gl.uniform1i(prog.u.uNCut, nc); }
  const nh = Math.min(8, Wd.holes.length), oh = Wd.holes.length - nh;
  for (let i = 0; i < nh; i++) {
    const h = Wd.holes[oh + i], o = i * 4;
    B.h0[o] = h.x; B.h0[o + 1] = h.y; B.h0[o + 2] = h.along; B.h0[o + 3] = h.across;
    B.h1[o] = h.depth; B.h1[o + 1] = h.core ? 1 : 0; B.h1[o + 2] = h.clot; B.h1[o + 3] = 0;
  }
  if (prog.u.uHole0) { gl.uniform4fv(prog.u.uHole0, B.h0); if (prog.u.uHole1) gl.uniform4fv(prog.u.uHole1, B.h1); gl.uniform1i(prog.u.uNH, nh); }
  const ni = Math.min(8, Wd.inj.length), oi = Wd.inj.length - ni;
  for (let i = 0; i < ni; i++) {
    const j = Wd.inj[oi + i], o = i * 4;
    const lido = j.kind === 'lido';
    const R = 5 + 4 * j.vol, age = clock - j.t;
    B.j0[o] = j.x; B.j0[o + 1] = j.y; B.j0[o + 2] = lido ? R * 0.55 : 1.5; B.j0[o + 3] = lido ? Wd.epi(j.x, j.y) : 0;
    B.j1[o] = lido ? Math.min(0.6, j.vol * 0.5) * Math.exp(-age / 900) : 0.05 * Math.exp(-age / 300);
  }
  if (prog.u.uInj) { gl.uniform4fv(prog.u.uInj, B.j0); gl.uniform4fv(prog.u.uInj2, B.j1); gl.uniform1i(prog.u.uNI, ni); }
  if (prog.u.uPun) {
    const np = Math.min(32, Wd.punct.length), op = Wd.punct.length - np;
    for (let i = 0; i < np; i++) { const p = Wd.punct[op + i], o = i * 4; B.p0[o] = p.x; B.p0[o + 1] = p.y; B.p0[o + 2] = p.r * (1 - 0.5 * p.clot); }
    gl.uniform4fv(prog.u.uPun, B.p0); gl.uniform1i(prog.u.uNP, np);
  }
};
PP.Renderer.prototype.camUniforms = function (prog, w, h) {
  const gl = this.gl, C = this.W.cam;
  gl.uniform2f(prog.u.uCam, C.x, C.y);
  gl.uniform2f(prog.u.uView, C.vw, C.vh);
  if (prog.u.uRes) gl.uniform2f(prog.u.uRes, w, h);
  if (prog.u.uPatch) gl.uniform1f(prog.u.uPatch, this.W.area.size);
  if (prog.u.uVSc) gl.uniform2f(prog.u.uVSc, this.vsx, this.vsy);
};

// brush ops into the film decal texture: kind -> channel colour
PP.Renderer.prototype.brush = function (x, y, r, rgba, mode) { if (this.brushes.length < 40000) this.brushes.push({ x, y, r, c: rgba, mode: mode || 'add' }); };

// GPU timing (when the browser exposes it) for the dynamic-resolution controller
PP.Renderer.prototype.timerBegin = function () {
  const gl = this.gl;
  if (this.tq === undefined) { this.tq = gl.getExtension('EXT_disjoint_timer_query_webgl2'); this.tqPool = []; }
  if (!this.tq || this.tqActive) return;
  const q = gl.createQuery(); gl.beginQuery(this.tq.TIME_ELAPSED_EXT, q); this.tqActive = q;
};
PP.Renderer.prototype.timerEnd = function () {
  const gl = this.gl;
  if (!this.tqActive) return;
  gl.endQuery(this.tq.TIME_ELAPSED_EXT); this.tqPool.push(this.tqActive); this.tqActive = null;
  while (this.tqPool.length) {
    const q = this.tqPool[0];
    if (!gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE)) break;
    const disjoint = gl.getParameter(this.tq.GPU_DISJOINT_EXT);
    if (!disjoint) this.gpuMs = gl.getQueryParameter(q, gl.QUERY_RESULT) / 1e6;
    gl.deleteQuery(q); this.tqPool.shift();
  }
  if (this.tqPool.length > 6) { gl.deleteQuery(this.tqPool.shift()); }
};

/* Full frame. Render targets are allocated once at the maximum size; dynamic resolution renders
   into a scaled sub-viewport (no reallocation hitches) and every screen-space read is scaled by uVS. */
PP.Renderer.prototype.render = function (dt, fullRes) {
  const G = this.G, gl = this.gl, W = this.W, P = this.P;
  // pick a resolution step; change it at most every 1.5 s so targets are rarely reallocated
  const want = fullRes ? 1 : (this.dyn || 1) >= 0.9 ? 1 : (this.dyn || 1) >= 0.68 ? 0.75 : 0.55;
  const now = performance.now();
  if (this.step === undefined) this.step = want;
  if (want !== this.step && (now - (this.stepT || 0) > 1500 || fullRes)) { this.step = want; this.stepT = now; }
  this.resize(this.step);
  const w = this.w, h = this.h;
  this.aw = w; this.ah = h; this.vsx = 1; this.vsy = 1; this.lastDs = this.step;
  const dw = this.rt.def.w, dh = this.rt.def.h, sw = this.rt.sssA.w, sh = this.rt.sssA.h;
  W.cam.update(w, h);
  this.uploadLesions();
  const A = W.area;
  const ph = W.phys;
  this.timerBegin();

  // 1. physiology field (ping-pong)
  gl.disable(gl.BLEND); gl.disable(gl.DEPTH_TEST);
  gl.bindFramebuffer(gl.FRAMEBUFFER, this.physB.fb); gl.viewport(0, 0, 512, 512);
  gl.useProgram(P.phys.p); this.camUniforms(P.phys, 512, 512);
  G.bindTex(0, this.physA.texs[0], P.phys.u.uPrev);
  gl.uniform1f(P.phys.u.uDt, Math.min(this.timelapseDt || dt, 1e7)); this.timelapseDt = 0;
  this.contactUniforms(P.phys); this.woundUniforms(P.phys);
  G.drawFS();
  [this.physA, this.physB] = [this.physB, this.physA];

  // 2. film decals (brushes)
  if (this.brushes.length) {
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.film.fb); gl.viewport(0, 0, 1024, 1024);
    gl.useProgram(P.brush.p); this.camUniforms(P.brush, 1024, 1024);
    gl.enable(gl.BLEND);
    for (const mode of ['add', 'sub']) {
      let n = 0; const d = this.instData;
      gl.blendEquation(mode === 'add' ? gl.FUNC_ADD : gl.FUNC_REVERSE_SUBTRACT); gl.blendFunc(gl.ONE, gl.ONE);
      for (const b of this.brushes) {
        if (b.mode !== mode) continue;
        const o = n * 16;
        d[o] = b.x; d[o + 1] = b.y; d[o + 2] = b.r; d[o + 3] = 0; d[o + 4] = b.c[0]; d[o + 5] = b.c[1]; d[o + 6] = b.c[2]; d[o + 7] = b.c[3];
        n++;
        if (n === 8000) { G.drawInstances(d, n); n = 0; }
      }
      if (n) G.drawInstances(d, n);
    }
    gl.blendEquation(gl.FUNC_ADD); gl.disable(gl.BLEND);
    this.brushes.length = 0;
  }

  // 3. deformation (half res)
  gl.bindFramebuffer(gl.FRAMEBUFFER, this.rt.def.fb); gl.viewport(0, 0, dw, dh);
  gl.useProgram(P.def.p); this.camUniforms(P.def, dw, dh);
  this.contactUniforms(P.def); this.woundUniforms(P.def);
  gl.uniform1f(P.def.u.uNu, ph.nu); gl.uniform1f(P.def.u.uEn, ph.En); gl.uniform1f(P.def.u.uG, ph.G); gl.uniform1f(P.def.u.uLd, ph.Ld); gl.uniform1f(P.def.u.uHeff, ph.Heff);
  gl.uniform2f(P.def.u.uT, ph.tx, ph.ty);
  G.drawFS();

  // 4. objects (particles + instruments)
  gl.bindFramebuffer(gl.FRAMEBUFFER, this.rt.obj.fb); gl.viewport(0, 0, w, h);
  gl.clearColor(0, 0, 0, 0); gl.clearDepth(1); gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
  const n = this.buildInstances();
  if (n) {
    gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.LESS);
    gl.useProgram(P.obj.p); this.camUniforms(P.obj, w, h);
    G.drawInstances(this.instData, n);
    gl.disable(gl.DEPTH_TEST);
  }
  this.lastInst = n;

  // 5. fluid smoothing
  gl.bindFramebuffer(gl.FRAMEBUFFER, this.rt.objS.fb); gl.viewport(0, 0, w, h);
  gl.useProgram(P.smooth.p); this.camUniforms(P.smooth, w, h);
  G.bindTex(0, this.rt.obj.texs[0], P.smooth.u.uObj); gl.uniform1f(P.smooth.u.uPxMm, w / W.cam.vw);
  G.drawFS();

  // 6. skin + object shading
  const set = W.curSet, det = W.detSet;
  gl.bindFramebuffer(gl.FRAMEBUFFER, this.rt.skin.fb); gl.viewport(0, 0, w, h);
  const S = P.skin; gl.useProgram(S.p); this.camUniforms(S, w, h);
  G.bindTex(0, set.chromo, S.u.uChromo); G.bindTex(1, set.nrm, S.u.uNrm); G.bindTex(2, det.nrm, S.u.uDet);
  G.bindTex(3, this.rt.def.texs[0], S.u.uDef0); G.bindTex(4, this.rt.def.texs[1], S.u.uDef1);
  G.bindTex(5, this.rt.objS.texs[0], S.u.uObj); G.bindTex(6, this.rt.obj.texs[1], S.u.uObjCol);
  G.bindTex(7, this.physA.texs[0], S.u.uPhys); G.bindTex(8, this.film.texs[0], S.u.uFilm); G.bindTex(9, this.dummy, S.u.uMarks);
  G.bindTex(10, this.envAtlas, S.u.uEnvP); G.bindTex(11, this.heatTex, S.u.uHeat); G.bindTex(12, this.lesTex, S.u.uLes);
  G.bindTex(14, set.detail, S.u.uDetail);
  gl.activeTexture(gl.TEXTURE13); gl.bindTexture(gl.TEXTURE_2D, this.gridTex.t); gl.uniform1i(S.u.uLGrid, 13);
  gl.uniform1i(S.u.uGridN, this.gridN); gl.uniform1i(S.u.uLSlots, 4); gl.uniform1i(S.u.uHasObj, n ? 1 : 0);
  gl.uniform1f(S.u.uTile, set.meta.tile_mm); gl.uniform1f(S.u.uHmm, set.meta.height_mm * W.reliefK);
  gl.uniform1f(S.u.uDetTile, det.meta.tile_mm * W.detScale); gl.uniform1f(S.u.uDetAmt, W.detAmt);
  gl.uniform1f(S.u.uPxMm, w / W.cam.vw); gl.uniform1f(S.u.uTime, W.time);
  gl.uniform1f(S.u.uOil, A.oil); gl.uniform1f(S.u.uRedBase, A.red); gl.uniform1f(S.u.uHair, A.hair);
  gl.uniform3fv(S.u.uTone, W.tone.mean); gl.uniform3fv(S.u.uToneA, W.tone.amp);
  gl.uniform3fv(S.u.uVM, W.manifest.basis.melanin); gl.uniform3fv(S.u.uVH, W.manifest.basis.hemoglobin); gl.uniform3fv(S.u.uVS, W.manifest.basis.shade);
  gl.uniform3fv(S.u.uSH, this.sh); gl.uniform1f(S.u.uYaw, W.envYaw); gl.uniform1f(S.u.uExposure, W.exposure); gl.uniform1f(S.u.uRing, W.S.ring ? 1 : 0);
  gl.uniform3fv(S.u.uKey, W.keyDir);
  gl.uniform2f(S.u.uT, ph.tx, ph.ty); gl.uniform1f(S.u.uDermis, A.dermis); gl.uniform1f(S.u.uEpi, A.epi);
  gl.uniform1f(S.u.uBloodOn, W.S.blood ? 1 : 0);
  gl.uniform1i(S.u.uDbg, this.dbg);
  // the face scan comes from deep-toned skin; its pore pigment contrast is toned down for lighter skin
  gl.uniform1f(S.u.uDetK, W.curSet === (this.sets && this.sets.deep) ? 0.55 + 0.09 * W.toneIdx : 0.85);
  this.woundUniforms(S);
  const pd = this._pd || (this._pd = new Float32Array(32)); const np = Math.min(8, W.decals.patches.length), opp = W.decals.patches.length - np;
  for (let i = 0; i < np; i++) { const q = W.decals.patches[opp + i], o = i * 4; pd[o] = q.x; pd[o + 1] = q.y; pd[o + 2] = q.r; pd[o + 3] = PP.clamp((W.clock - q.t) / 86400, 0, 1); }
  gl.uniform4fv(S.u.uPatchD, pd); gl.uniform1i(S.u.uNPatch, np);
  G.drawFS();

  // 7. subsurface scattering (separable, half resolution: scattered light is smooth)
  const pxmm = w / W.cam.vw;
  gl.useProgram(P.sss.p);
  gl.uniform1fv(P.sss.u.uOff, this.sssOff); gl.uniform3fv(P.sss.u.uW, this.sssW);
  gl.uniform2f(P.sss.u.uVSc, this.vsx, this.vsy); gl.uniform1f(P.sss.u.uPxMm, pxmm);
  gl.bindFramebuffer(gl.FRAMEBUFFER, this.rt.sssA.fb); gl.viewport(0, 0, sw, sh);
  G.bindTex(0, this.rt.skin.texs[0], P.sss.u.uIrr); gl.uniform2f(P.sss.u.uDir, 1 / w, 0); gl.uniform2f(P.sss.u.uRes, w, h);
  G.drawFS();
  gl.bindFramebuffer(gl.FRAMEBUFFER, this.rt.sssB.fb);
  G.bindTex(0, this.rt.sssA.texs[0], P.sss.u.uIrr); gl.uniform2f(P.sss.u.uDir, 0, 1 / h); gl.uniform2f(P.sss.u.uRes, sw, sh);
  G.drawFS();

  // 8. composite
  gl.bindFramebuffer(gl.FRAMEBUFFER, this.rt.comp.fb); gl.viewport(0, 0, w, h);
  gl.useProgram(P.comp.p); gl.uniform2f(P.comp.u.uVSc, this.vsx, this.vsy); gl.uniform2f(P.comp.u.uRes, w, h); gl.uniform1i(P.comp.u.uDbgC, this.dbg);
  G.bindTex(0, this.rt.sssB.texs[0], P.comp.u.uSss); G.bindTex(1, this.rt.skin.texs[1], P.comp.u.uAlb); G.bindTex(2, this.rt.skin.texs[2], P.comp.u.uSpec);
  G.bindTex(3, this.rt.skin.texs[0], P.comp.u.uIrr0);
  G.drawFS();

  // 9. post to screen
  this.present(true);
  this.timerEnd();
};

// post pass only (cheap): re-present the last composite (film grain keeps moving)
PP.Renderer.prototype.present = function (inFrame) {
  const G = this.G, gl = this.gl, W = this.W, P = this.P;
  if (!this.aw) return;
  gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.viewport(0, 0, this.cw, this.ch);
  const PO = P.post; gl.useProgram(PO.p); this.camUniforms(PO, this.aw, this.ah);
  G.bindTex(0, this.rt.comp.texs[0], PO.u.uC);
  gl.uniform1f(PO.u.uTime, W.time); gl.uniform1f(PO.u.uDof, (this.aw / W.cam.vw) * 0.022);
  gl.uniform1f(PO.u.uAspect, this.cw / this.ch);
  const d0 = this._d0 || (this._d0 = new Float32Array(96)), d1 = this._d1 || (this._d1 = new Float32Array(96));
  const nd = Math.min(24, this.drops.length), od = this.drops.length - nd;
  for (let i = 0; i < nd; i++) { const d = this.drops[od + i], o = i * 4; d0[o] = d.u; d0[o + 1] = d.v; d0[o + 2] = d.r; d0[o + 3] = d.a; d1[o] = d.m; }
  gl.uniform4fv(PO.u.uDrop, d0); gl.uniform4fv(PO.u.uDrop2, d1); gl.uniform1i(PO.u.uND, nd);
  G.drawFS();
};

// draw every program once with representative data so drivers finish lazy compilation during loading
PP.Renderer.prototype.warm = function () {
  const W = this.W, T = W.tools, P = W.parts;
  W.phys.contacts.push({ x: 0, y: 0, a: 4, fn: 1, qx: 1, qy: 0 }, { x: 3, y: 0, a: 2, suction: 40 });
  T.nPrim = 0;
  T.primRaw([0, 0, 1, 1, 0, 0, 1, 1, 0, PP.MATOBJ.chrome, 0, 0, 0.8, 0.8, 0.8, 0]);
  T.primRaw([0, 0, 1, 1, 5, 5, 6, 1.5, 1, PP.MATOBJ.nitrile, 0, 0, 0.3, 0.2, 0.6, 0]);
  T.primRaw([0, 0, 1, 0, 3, 3, 0.5, 0.2, 2, PP.MATOBJ.gauze, 0, 0, 0.9, 0.9, 0.9, 0.3]);
  T.primRaw([0, 0, 0.5, 0.08, 4, 0, 2, 0, 3, PP.MATOBJ.chrome, 3, 1, 2.2, 0, 0, 0]);
  const a = P.spawn(1, 1, 0.3, 0.3, PP.MAT.blood), b = P.spawn(1.5, 1, 0.3, 0.3, PP.MAT.pus), c = P.spawn(1.8, 1, 0.3, 0.3, PP.MAT.pus);
  if (b >= 0 && c >= 0) P.link(b, c, 0.3, 0.1, 2);
  this.brush(0, 0, 1, [0, 0, 0.001, 0], 'add');
  this.drops.push({ u: 0.5, v: 0.5, r: 0.001, a: 0.01, m: 0, vy: 0 });
  this.render(1 / 60, true);
  W.phys.contacts.length = 0; T.nPrim = 0; P.clear(); this.drops.length = 0;
  this.render(1 / 60, true);
};

// particles + tool primitives -> instance buffer
PP.Renderer.prototype.buildInstances = function () {
  const W = this.W, P = W.parts, d = this.instData;
  let n = 0;
  const maxN = 9000;
  const put = (ax, ay, az, ar, bx, by, bz, br, ty, m, cr, cg, cb) => {
    const o = n * 16;
    d[o] = ax; d[o + 1] = ay; d[o + 2] = az; d[o + 3] = ar; d[o + 4] = bx; d[o + 5] = by; d[o + 6] = bz; d[o + 7] = br;
    d[o + 8] = ty; d[o + 9] = m; d[o + 10] = 0; d[o + 11] = 0; d[o + 12] = cr; d[o + 13] = cg; d[o + 14] = cb; d[o + 15] = 0;
    n++;
  };
  for (let i = 0; i < P.hi && n < maxN - 200; i++) {
    if (!P.alive[i]) continue;
    const j = P.next[i], m = P.mat[i];
    if (j >= 0 && P.alive[j]) put(P.x[i], P.y[i], P.z[i], P.r[i], P.x[j], P.y[j], P.z[j], P.r[j], 1, m, P.cr[i], P.cg[i], P.cb[i]);
    else if (P.prev[i] < 0) {
      // free particle: liquids flatten into a sessile bead on the skin
      const r = P.r[i], z = P.onSkin[i] && P.isLiquid(m) ? P.z[i] - r * 0.55 : P.z[i];
      put(P.x[i], P.y[i], z, r, P.x[i], P.y[i], z, r, 0, m, P.cr[i], P.cg[i], P.cb[i]);
    }
  }
  const T = W.tools;
  if (T.nPrim) { d.set(T.prims.subarray(0, T.nPrim * 16), n * 16); n += T.nPrim; }
  // draped splatter shield (loose gauze) over the active lesion while squeezing
  if (W.S.shield && W.phys.contacts.length && W.activeLesion) {
    const L = W.activeLesion, g = W.decals.gauzeCol, e = Math.max(L.R * 2.2, 6);
    put(L.x, L.y, 9, 0, e, e, 0.4, 0.3, 2, PP.MATOBJ.gauze, g[0], g[1], g[2]);
    d[(n - 1) * 16 + 15] = 0.6;
  }
  return n;
};

/* Decals (film texture) + patches + suction dose + gauze stain. */
PP.Decals = function (W) {
  this.W = W; this.patches = []; this.gauzeCol = [0.95, 0.95, 0.93]; this.dose = new Map();
};
PP.Decals.prototype.reset = function () { this.patches.length = 0; this.gauzeCol = [0.95, 0.95, 0.93]; this.dose.clear(); };
PP.Decals.prototype.paint = function (x, y, r, kind, amt) {
  const R = this.W.render;
  const c = kind === 'blood' ? [0.6 * amt, 0, 0.7 * amt, 0] : kind === 'pus' ? [0, 0.5 * amt, 0.5 * amt, 0] : kind === 'serum' ? [0, 0, 0.7 * amt, 0] : kind === 'iodine' ? [0, 0, 0.25 * amt, 0.35 * amt] : [0, 0, 0, 0];
  R.brush(x, y, r, c, 'add');
};
PP.Decals.prototype.wipe = function (x, y, r, W) {
  this.W.render.brush(x, y, r, [0.12, 0.15, 0.25, 0.05], 'sub');
  // smear: a little of what was wiped is dragged along
  if (W.rng() < 0.3) this.W.render.brush(x + (W.rng() - 0.5) * r, y + (W.rng() - 0.5) * r, r * 0.6, [0.03, 0.0, 0.05, 0], 'add');
};
PP.Decals.prototype.suction = function (x, y, a, s, dt) {
  // the GPU physiology field draws the congestion / petechiae; the CPU tracks dose per 1 mm cell so
  // the simulation (and tests) know when a spot passed the makers' ~3 s limit at >=40 kPa
  if (s > 30 && this.W.rng() < dt * 4) this.W.render.brush(x, y, a + 0.5, [0, 0, 0.05, 0], 'add');
  if (s < 30) return;   // cupping data: ~-30 kPa ruptured capillaries, -20 kPa did not
  const key = Math.round(x) + ',' + Math.round(y);
  const d = (this.dose.get(key) || 0) + dt * (s / 52);
  this.dose.set(key, d);
  if (d > 3 && !this['_pet' + key]) {
    this['_pet' + key] = 1; this.W.stats.bruise++; this.petechiae = (this.petechiae || 0) + 1;
    this.W.fx.toast('bad', 'Petechiae', 'Suction held on one spot for more than ~3 s broke superficial capillaries (pinpoint bleeding, bruising).');
  }
};
PP.Decals.prototype.stain = function (rgb) {
  const g = this.gauzeCol;
  for (let k = 0; k < 3; k++) g[k] = PP.lerp(g[k], rgb[k] * 0.9 + 0.05, 0.08);
};
