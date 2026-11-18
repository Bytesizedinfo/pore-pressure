'use strict';
/* DOM UI + input. */
PP.UI = function (W) {
  this.W = W;
  const $ = (id) => document.getElementById(id);
  this.$ = $;
  this.canvas = $('gl');
  this.sel = null;          // lesion pinned in the info card
  this.placeType = null;    // sandbox placement
  this.ptrs = new Map();
  this.pan = null;
  this.lastInfo = '';
  W.fx = this.fx();
  W.ctx.fx = W.fx;
  this.build();
  this.bindInput();
};

PP.UI.prototype.fx = function () {
  const W = this.W, ui = this, A = W.audio;
  return {
    toast: (k, t, b) => ui.toast(k, t, b),
    pop: (L, P) => { A.pop(P); W.stats.pops++; },
    deep: () => { A.deep(); W.stats.deep++; },
    spurt: (L, v) => A.spurt(v),
    extrude: (L, rate) => A.extrude(rate),
    creak: () => A.creak(),
    opened: (L, kind) => { if (kind === 'needle') A.tick(); else A.slice(); },
    click: () => A.click(),
    toolChanged: (id) => ui.renderTray(),
    patchChanged: () => { ui.renderChart(true); },
    spreadMolluscum: (L) => {
      const n = 1 + Math.floor(W.rng() * 3);
      for (let k = 0; k < n; k++) { const a = W.rng() * Math.PI * 2, r = 4 + W.rng() * 6; W.addLesion('molluscum', L.x + Math.cos(a) * r, L.y + Math.sin(a) * r, 1.4 + W.rng()); }
      ui.toast('bad', 'Molluscum spread', n + ' new papule' + (n > 1 ? 's' : '') + ' appeared nearby: squeezing with fingers spread the virus (autoinoculation, DermNet).');
    },
  };
};

PP.UI.prototype.build = function () {
  const W = this.W, $ = this.$;
  // areas
  const area = $('area');
  area.innerHTML = Object.entries(PP.AREAS).map(([k, a]) => `<option value="${k}">${a.name}</option>`).join('');
  area.value = W.areaId;
  area.addEventListener('change', async () => { await PP.main.switchArea(area.value); });
  // tones
  const tones = $('tones');
  tones.innerHTML = PP.TONES.map((t, i) => `<button role="radio" aria-label="${t.name}" title="${t.name}" style="background:${t.hex}" data-i="${i}"></button>`).join('');
  tones.addEventListener('click', async (e) => { const b = e.target.closest('button'); if (!b) return; await PP.main.switchTone(+b.dataset.i); this.renderTones(); });
  this.renderTones();
  $('newpatch').addEventListener('click', () => { W.newPatch(Math.floor(Math.random() * 1e9)); this.sel = null; });
  $('wait').addEventListener('click', () => { W.timelapse(+$('waitsel').value); });
  $('wipelens').addEventListener('click', () => { W.render.drops.length = 0; W._lensToast = 0; this.toast('', 'Lens wiped', ''); });
  const mute = $('mute');
  const setMute = () => { mute.classList.toggle('on', W.audio.on); mute.setAttribute('aria-pressed', W.audio.on ? 'true' : 'false'); };
  mute.addEventListener('click', () => { W.audio.setOn(!W.audio.on); setMute(); });
  setMute();
  $('settings').addEventListener('click', () => this.openSettings());
  // zoom controls
  $('zin').addEventListener('click', () => this.zoomBy(1.35));
  $('zout').addEventListener('click', () => this.zoomBy(1 / 1.35));
  $('zfit').addEventListener('click', () => { W.cam.zoom = PP.UI.ZMIN; this.zoomBy(1); });
  // add your own blemishes (any area)
  const add = $('addsel');
  const groups = {};
  for (const [k, t] of Object.entries(PP.LTYPES)) (groups[t.group] = groups[t.group] || []).push([k, t]);
  add.innerHTML = '<option value="">Add blemish…</option>' + Object.entries(groups).map(([g, list]) => `<optgroup label="${g}">${list.map(([k, t]) => `<option value="${k}">${t.name}</option>`).join('')}</optgroup>`).join('');
  add.addEventListener('change', () => this.setPlace(add.value || null));
  $('clearles').addEventListener('click', () => { W.clearPatch(); this.sel = null; this.toast('', 'Blank skin', 'Pick a blemish from the Add menu and click the skin to place it.'); });
  this.renderTray();
  this.renderChart(true);
  this.renderStats();
};

PP.UI.prototype.renderTones = function () {
  [...this.$('tones').children].forEach((b, i) => { b.classList.toggle('on', i === this.W.toneIdx); b.setAttribute('aria-checked', i === this.W.toneIdx ? 'true' : 'false'); });
};

PP.UI.prototype.renderTray = function () {
  const W = this.W, tray = this.$('tray');
  const groups = {};
  for (const t of PP.TOOLS) (groups[t.group] = groups[t.group] || []).push(t);
  let html = '';
  for (const [g, list] of Object.entries(groups)) {
    html += `<h3>${g}</h3>`;
    for (const t of list) html += `<button class="tool${W.tools.id === t.id ? ' on' : ''}" data-id="${t.id}" title="${t.name} (${t.key})"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${PP.ICONS[t.id]}</svg><span>${t.name}</span><span class="k">${t.key}</span></button>`;
  }
  const cur = PP.TOOLS.find((t) => t.id === W.tools.id);
  html += `<div id="toolopt">${cur ? cur.opt : ''}</div>`;
  tray.innerHTML = html;
  tray.onclick = (e) => { const b = e.target.closest('.tool'); if (!b) return; W.tools.select(b.dataset.id); W.audio.start(); };
};

PP.UI.prototype.status = function (L) {
  if (L.recur) return ['bad', 'wall left'];
  if (L.deep) return ['bad', 'ruptured'];
  if (L.done) return ['done', L.type === 'nodule' || L.type === 'papule' ? 'settled' : 'done'];
  if (L.bad) return ['bad', 'trauma'];
  if (L.drained) return ['active', 'drained'];
  if (L.ext > 0) return ['active', PP.fmtVol(L.ext)];
  if (L.open.r > 0 && L.T.open !== 'open') return ['active', 'opened'];
  return ['', ''];
};
PP.UI.prototype.renderChart = function (rebuild) {
  const W = this.W, list = this.$('leslist');
  const Ls = W.lesions.filter((L) => L.type !== 'filament');
  const fil = W.lesions.filter((L) => L.type === 'filament');
  if (rebuild || list.childElementCount !== Ls.length + (fil.length ? 1 : 0)) {
    list.innerHTML = Ls.map((L) => `<div class="les" data-id="${L.id}"><span class="dot"></span><span>${L.T.name.replace(/ \(.*\)/, '')}</span><span class="st"></span></div>`).join('') +
      (fil.length ? `<div class="les" data-fil="1"><span class="dot"></span><span>Sebaceous filaments ×${fil.length}</span><span class="st"></span></div>` : '');
    list.onclick = (e) => {
      const row = e.target.closest('.les'); if (!row) return;
      const L = row.dataset.fil ? fil[0] : W.lesions[+row.dataset.id];
      if (!L) return;
      W.cam.x = L.x; W.cam.y = L.y; W.cam.zoom = Math.max(W.cam.zoom, PP.clamp(W.area.view / (L.R * 9), 1, 4));
      this.sel = L;
    };
  }
  [...list.children].forEach((row) => {
    if (row.dataset.fil) { const n = fil.filter((l) => l.done).length; row.className = 'les' + (n === fil.length ? ' done' : n ? ' active' : ''); row.querySelector('.st').textContent = n + '/' + fil.length; return; }
    const L = W.lesions[+row.dataset.id]; if (!L) return;
    const [cls, txt] = this.status(L);
    row.className = 'les' + (cls ? ' ' + cls : '');
    row.querySelector('.st').textContent = txt;
  });
};
PP.UI.prototype.renderStats = function () {
  const s = this.W.stats;
  const perfect = this.W.lesions.filter((L) => L.done && !L.bad && !L.recur).length;
  this.$('statlist').innerHTML = `<dt>Pops</dt><dd>${s.pops}</dd><dt>Extracted</dt><dd>${PP.fmtVol(s.vol)}</dd><dt>Clean extractions</dt><dd>${perfect}</dd><dt>Ruptured under skin</dt><dd>${s.deep}</dd><dt>Petechiae / flinches</dt><dd>${s.bruise} / ${s.flinch}</dd>`;
};

PP.UI.prototype.stepDone = function (L, step) {
  const W = this.W, u = L.used || new Set();
  switch (step) {
    case 'compress': return (L.maxT || 0) > 34.5;
    case 'needle': return L.events.includes('opened:needle') || L.events.includes('hairLifted');
    case 'loop': return u.has('loop') && L.ext > 0;
    case 'squeeze': return (u.has('fingers') || u.has('swabs')) && L.ext > 0;
    case 'vacuum': return u.has('vacuum') && L.ext > 0;
    case 'lido': return W.wounds.anesth(L.x, L.y) > 0.3;
    case 'blade11': return L.events.some((e) => e === 'opened:blade11' || e === 'opened:punch');
    case 'blade15': return L.events.includes('opened:blade15');
    case 'hemostat': return u.has('hemostat');
    case 'forceps': return u.has('forceps') || L.events.includes('core') || L.events.includes('hairFreed');
    case 'iodine': return !!L.prepped;
    case 'gauze': return u.has('gauze');
    case 'steroid': return L.steroidT >= 0;
    case 'curette': return !!L.coreOut;
    case 'packing': return L.events.includes('packed');
  }
  return false;
};
const STEP_TXT = { compress: 'Warm compress', needle: 'Sterile needle', loop: 'Comedone loop', squeeze: 'Opposed pressure beside it', vacuum: 'Pore vacuum (low)', lido: 'Lidocaine + epi around and beneath', blade11: '#11 stab incision (or punch)', blade15: '#15 incision ~¼ of the diameter', hemostat: 'Hemostat: spread / deliver', forceps: 'Forceps', iodine: 'Povidone-iodine prep', gauze: 'Gauze pressure', steroid: 'Triamcinolone injection', curette: 'Curette', packing: 'Pack the cavity' };

PP.UI.prototype.renderInfo = function () {
  const W = this.W;
  const L = W.activeLesion || this.sel;
  if (!L) {
    const html = `<h4>${W.area.name}</h4><div class="sub">${W.lesions.length} lesions · patch ${W.area.size} mm · view ${W.cam.vw.toFixed(0)} mm</div><p>Hover a lesion to see what it is and how a clinician would treat it. Zoom with − / + (or scroll), right-drag to pan. Add your own from the Add blemish menu.</p><p class="sub">Simulation for entertainment and education. Don't pop at home; see a dermatologist.</p>`;
    if (html !== this.lastInfo) { this.$('info').innerHTML = html; this.lastInfo = html; }
    return;
  }
  const T = L.T;
  const srcs = T.src.map((k) => `<a href="${PP.SRC[k][1]}" target="_blank" rel="noopener">${PP.SRC[k][0]}</a>`).join(' · ');
  const steps = T.protocol.map((s) => `<li class="${this.stepDone(L, s) ? 'done' : ''}">${STEP_TXT[s]}</li>`).join('');
  const [, st] = this.status(L);
  const size = L.d >= 10 ? (L.d / 10).toFixed(1) + ' cm' : L.d.toFixed(1) + ' mm';
  const html = `<h4>${T.name}</h4><div class="sub">${size} · ${T.group}${st ? ' · ' + st : ''}${L.V0 > 0 && T.contents.length ? ' · contents ' + PP.fmtVol(L.V0) : ''}</div><p>${T.desc}</p><p><b>Technique:</b> ${T.hint}</p>${steps ? '<ol>' + steps + '</ol>' : ''}<div class="sub" style="margin-top:6px">${srcs}</div>`;
  if (html !== this.lastInfo) { this.$('info').innerHTML = html; this.lastInfo = html; }
};

PP.UI.prototype.toast = function (kind, title, body) {
  if (!title) return;
  const box = this.$('toasts');
  const el = document.createElement('div');
  el.className = 'toast' + (kind ? ' ' + kind : '');
  el.innerHTML = `<b>${title}</b>${body ? ' · ' + body : ''}`;
  box.prepend(el);
  while (box.childElementCount > 3) box.lastChild.remove();
  setTimeout(() => el.remove(), kind === 'bad' ? 7000 : 5000);
  if (PP.TEST) PP.diag.write('[toast] ' + title);
};

PP.UI.prototype.update = function (dt) {
  const W = this.W, T = W.tools;
  // meters
  const f = T.forceMax ? T.force / T.forceMax : 0;
  this.$('forcebar').firstChild.style.width = (PP.clamp(f, 0, 1) * 100).toFixed(0) + '%';
  this.$('painbar').firstChild.style.width = (PP.clamp(W.painLevel, 0, 1) * 100).toFixed(0) + '%';
  const L = W.activeLesion;
  let ro = '';
  if (T.force > 0) ro += (T.id === 'vacuum' ? (T.vacLevels[T.vacLevel] * PP.clamp(f, 0, 1)).toFixed(0) + ' kPa' : T.force.toFixed(1) + ' N');
  if (L && L.P > 0.5) ro += (ro ? ' · ' : '') + 'cavity ' + L.P.toFixed(0) + ' kPa';
  if (L) { const t = W.wounds.heatAt(L.x, L.y); L.maxT = Math.max(L.maxT || 0, t); if (t > 33.2) ro += (ro ? ' · ' : '') + t.toFixed(1) + ' °C'; }
  this.$('readout').textContent = ro || '—';
  const zt = W.cam.zoom.toFixed(1) + '×';
  if (this._zt !== zt) { this._zt = zt; this.$('zoomv').textContent = zt; }
  // ring at cursor
  const ring = this.$('ring');
  const show = T.ptr.down && T.forceMax;
  ring.classList.toggle('show', !!show);
  if (show) {
    ring.style.left = this.lastSX + 'px'; ring.style.top = this.lastSY + 'px';
    const c = 2 * Math.PI * 22;
    this.$('ringv').setAttribute('stroke-dasharray', (PP.clamp(f, 0, 1) * c).toFixed(1) + ' ' + c.toFixed(1));
  }
  // record tool use per lesion
  if (L && T.force > 0.3) { L.used = L.used || new Set(); L.used.add(T.id); }
  this._t = (this._t || 0) + dt;
  if (this._t > 0.25) { this._t = 0; this.renderChart(false); this.renderStats(); this.renderInfo(); this.$('clock').textContent = PP.fmtClock(W.clock); }
};

// ---------------------------------------------------------------- input
PP.UI.prototype.toWorld = function (sx, sy) {
  const r = this.canvas.getBoundingClientRect(), C = this.W.cam;
  return { x: C.x + ((sx - r.left) / r.width - 0.5) * C.vw, y: C.y + (0.5 - (sy - r.top) / r.height) * C.vh };
};
PP.UI.prototype.bindInput = function () {
  const W = this.W, cv = this.canvas, T = W.tools;
  cv.addEventListener('contextmenu', (e) => e.preventDefault());
  cv.addEventListener('pointerdown', (e) => {
    W.audio.start();
    cv.setPointerCapture(e.pointerId);
    this.ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY, type: e.pointerType });
    this.lastSX = e.clientX; this.lastSY = e.clientY;
    const p = this.toWorld(e.clientX, e.clientY);
    if (e.button === 2 || e.button === 1) { this.pan = { sx: e.clientX, sy: e.clientY, cx: W.cam.x, cy: W.cam.y }; return; }
    if (this.placeType) {
      const T = PP.LTYPES[this.placeType];
      const k = +this.$('addsize').value;
      const L = W.addLesion(this.placeType, p.x, p.y, PP.lerp(T.d[0], T.d[1], k));
      this.sel = L; W.audio.click();
      return;
    }
    if (this.ptrs.size === 2) {
      // second finger: pinch squeeze with fingers/swabs, otherwise pan/zoom
      T.up();
      const [a, b] = [...this.ptrs.values()];
      const wa = this.toWorld(a.x, a.y), wb = this.toWorld(b.x, b.y);
      if (T.id === 'fingers' || T.id === 'swabs') T.touch = { a: wa, b: wb, d0: Math.hypot(wb.x - wa.x, wb.y - wa.y) };
      else this.pinch = { d0: Math.hypot(a.x - b.x, a.y - b.y), z0: W.cam.zoom, cx: W.cam.x, cy: W.cam.y, mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 };
      return;
    }
    T.down(p.x, p.y, { shift: e.shiftKey, pressure: e.pointerType === 'pen' ? e.pressure : 0 });
  });
  cv.addEventListener('pointermove', (e) => {
    const pt = this.ptrs.get(e.pointerId);
    if (pt) { pt.x = e.clientX; pt.y = e.clientY; }
    this.lastSX = e.clientX; this.lastSY = e.clientY;
    if (this.pan) {
      const r = cv.getBoundingClientRect();
      W.cam.x = this.pan.cx - ((e.clientX - this.pan.sx) / r.width) * W.cam.vw;
      W.cam.y = this.pan.cy + ((e.clientY - this.pan.sy) / r.height) * W.cam.vh;
      this.clampCam(); return;
    }
    if (T.touch && this.ptrs.size === 2) {
      const [a, b] = [...this.ptrs.values()];
      T.touch.a = this.toWorld(a.x, a.y); T.touch.b = this.toWorld(b.x, b.y);
      return;
    }
    if (this.pinch && this.ptrs.size === 2) {
      const [a, b] = [...this.ptrs.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      W.cam.zoom = PP.clamp(this.pinch.z0 * (d / this.pinch.d0), PP.UI.ZMIN, PP.UI.ZMAX);
      const r = cv.getBoundingClientRect();
      const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
      W.cam.vw = W.area.view / W.cam.zoom;
      W.cam.x = this.pinch.cx - ((mx - this.pinch.mx) / r.width) * W.cam.vw;
      W.cam.y = this.pinch.cy + ((my - this.pinch.my) / r.height) * W.cam.vh;
      this.clampCam(); return;
    }
    const p = this.toWorld(e.clientX, e.clientY);
    if (!T.ptr.down) { T.ptr.x = p.x; T.ptr.y = p.y; T.ptr.lx = p.x; T.ptr.ly = p.y; }
    else T.move(p.x, p.y, { pressure: e.pointerType === 'pen' ? e.pressure : null });
  });
  const end = (e) => {
    this.ptrs.delete(e.pointerId);
    if (this.pan && this.ptrs.size === 0) { this.pan = null; return; }
    if (T.touch) { if (this.ptrs.size < 2) { T.touch = null; } return; }
    if (this.pinch) { if (this.ptrs.size < 2) this.pinch = null; return; }
    T.up();
  };
  cv.addEventListener('pointerup', end);
  cv.addEventListener('pointercancel', end);
  cv.addEventListener('wheel', (e) => {
    e.preventDefault();
    if (e.shiftKey) {
      const k = e.deltaY > 0 ? -1 : 1;
      if (T.id === 'fingers' || T.id === 'swabs') T.spread[T.id] = PP.clamp(T.spread[T.id] + k * 0.3, 1.5, 12);
      else if (T.id === 'loop') T.loopR = T.loopR > 1 ? 0.75 : 1.25;
      else if (T.id === 'vacuum') T.vacLevel = PP.clamp(T.vacLevel + k, 0, 2);
      return;
    }
    const before = this.toWorld(e.clientX, e.clientY);
    W.cam.zoom = PP.clamp(W.cam.zoom * Math.exp(-e.deltaY * 0.0015), PP.UI.ZMIN, PP.UI.ZMAX);
    W.cam.vw = W.area.view / W.cam.zoom; W.cam.vh = (W.cam.vw * W.cam.ch) / W.cam.cw;
    const after = this.toWorld(e.clientX, e.clientY);
    W.cam.x += before.x - after.x; W.cam.y += before.y - after.y;
    this.clampCam();
  }, { passive: false });
  window.addEventListener('keydown', (e) => {
    if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT')) return;
    const k = e.key.toUpperCase();
    const t = PP.TOOLS.find((x) => x.key === k);
    if (t) { T.select(t.id); return; }
    if (k === 'Q') T.angle += 0.2; else if (k === 'E') T.angle -= 0.2;
    else if (k === '[') { if (T.spread[T.id] != null) T.spread[T.id] = Math.max(1.5, T.spread[T.id] - 0.4); }
    else if (k === ']') { if (T.spread[T.id] != null) T.spread[T.id] = Math.min(12, T.spread[T.id] + 0.4); }
    else if (e.key === '+' || e.key === '=') this.zoomBy(1.35);
    else if (e.key === '-' || e.key === '_') this.zoomBy(1 / 1.35);
    else if (e.key === 'Escape') { this.setPlace(null); this.closeSettings(); }
  });
};
PP.UI.ZMIN = 0.6; PP.UI.ZMAX = 6;
PP.UI.prototype.clampCam = function () {
  const W = this.W, C = W.cam, s = W.area.size / 2;
  C.x = C.vw / 2 >= s ? 0 : PP.clamp(C.x, -s + C.vw / 2, s - C.vw / 2);
  C.y = C.vh / 2 >= s ? 0 : PP.clamp(C.y, -s + C.vh / 2, s - C.vh / 2);
};
PP.UI.prototype.zoomBy = function (k) {
  const W = this.W, C = W.cam;
  C.zoom = PP.clamp(C.zoom * k, PP.UI.ZMIN, PP.UI.ZMAX);
  C.vw = W.area.view / C.zoom; C.vh = (C.vw * C.ch) / C.cw;
  this.clampCam();
};
PP.UI.prototype.setPlace = function (type) {
  this.placeType = type;
  this.$('addsel').value = type || '';
  this.canvas.classList.toggle('placing', !!type);
  if (type) this.toast('', 'Click the skin to place', PP.LTYPES[type].name + '. Set its size with the slider; press Esc when done.');
};

// ---------------------------------------------------------------- settings modal
PP.UI.prototype.openSettings = function () {
  const W = this.W, S = W.S, m = this.$('modal');
  const tog = (id, label, on) => `<label class="set"><span>${label}</span><input type="checkbox" id="${id}" ${on ? 'checked' : ''}></label>`;
  const sld = (id, label, v, lo, hi, st) => `<label class="set"><span>${label} <span class="lbl" id="${id}v">${(+v).toFixed(1)}×</span></span><input type="range" id="${id}" min="${lo}" max="${hi}" step="${st}" value="${v}"></label>`;
  const src = Object.values(PP.SRC).map(([t, u]) => `<li><a href="${u}" target="_blank" rel="noopener">${t}</a></li>`).join('');
  m.innerHTML = `<div class="panel" role="dialog" aria-modal="true" aria-labelledby="sett">
    <h2 id="sett">Settings</h2>
    <h3>Gross level</h3>
    <div class="row"><button data-preset="mild" class="${S.preset === 'mild' ? 'on' : ''}">Mild</button><button data-preset="real" class="${S.preset === 'real' ? 'on' : ''}">Realistic</button><button data-preset="max" class="${S.preset === 'max' ? 'on' : ''}">Maximum gross</button></div>
    ${tog('s_blood', 'Blood', S.blood)}${tog('s_lens', 'Lens splatter', S.lens)}${tog('s_surg', 'Surgical lesions (cysts, lipomas, boils)', S.surgical)}${tog('s_pain', 'Pain and flinching', S.pain)}${tog('s_ring', 'Clinic ring light', S.ring)}
    ${sld('s_spurt', 'Spurt intensity', S.spurt, 0, 2.5, 0.1)}${sld('s_ooze', 'Ooze amount', S.ooze, 0.5, 3, 0.1)}${sld('s_bamt', 'Bleeding', S.bloodAmt, 0, 2, 0.1)}
    <label class="set"><span>Render quality</span><select id="s_q"><option value="sharp">Sharp (slower on high-DPI screens)</option><option value="high">Standard</option><option value="low">Low (fastest)</option></select></label>
    <h3>About the simulation</h3>
    <p>Skin is rebuilt from real macro photographs, split into melanin, hemoglobin and relief maps and relit with a studio HDRI and subsurface scattering. Interactions are not scripted. Contact forces load each lesion's cavity through elastic-solid stress solutions. The roof or the wall fails by thin-shell stress, and contents leave according to their measured or modelled flow behaviour. Cuts gape and punch holes turn oval along the relaxed tension lines.</p>
    <p class="lbl" style="text-transform:none;letter-spacing:0">Entertainment and education only. Squeezing at home risks scarring and infection (AAD). See a dermatologist.</p>
    <h3>Sources</h3><ul>${src}</ul>
    <h3>Credits</h3><ul>${PP.CREDITS.map(([t, u]) => `<li>${t} <a href="${u}" target="_blank" rel="noopener">Licence</a></li>`).join('')}</ul>
    <div class="row" style="justify-content:flex-end;margin-top:12px"><button id="s_close" class="on">Done</button></div></div>`;
  m.hidden = false;
  const q = this.$('s_q'); q.value = PP.storage.get('quality', 'high');
  const save = () => { PP.storage.set('settings', Object.assign({}, S, { shield: false })); };
  const bind = (id, key) => this.$(id).addEventListener('change', (e) => { S[key] = e.target.checked; S.preset = 'custom'; save(); });
  bind('s_blood', 'blood'); bind('s_lens', 'lens'); bind('s_surg', 'surgical'); bind('s_pain', 'pain'); bind('s_ring', 'ring');
  const bindS = (id, key) => this.$(id).addEventListener('input', (e) => { S[key] = +e.target.value; this.$(id + 'v').textContent = (+e.target.value).toFixed(1) + '×'; S.preset = 'custom'; save(); });
  bindS('s_spurt', 'spurt'); bindS('s_ooze', 'ooze'); bindS('s_bamt', 'bloodAmt');
  q.addEventListener('change', () => { PP.storage.set('quality', q.value); W.render.scale = PP.Renderer.scaleFor(q.value); });
  m.querySelectorAll('[data-preset]').forEach((b) => b.addEventListener('click', () => {
    const p = b.dataset.preset;
    const P = { mild: { blood: false, lens: false, spurt: 0.3, ooze: 0.8, bloodAmt: 0.5, surgical: false }, real: { blood: true, lens: true, spurt: 1, ooze: 1, bloodAmt: 1, surgical: true }, max: { blood: true, lens: true, spurt: 1.6, ooze: 1.4, bloodAmt: 1.3, surgical: true } }[p];
    Object.assign(S, P, { preset: p }); save(); this.openSettings();
  }));
  this.$('s_close').addEventListener('click', () => this.closeSettings());
  m.onclick = (e) => { if (e.target === m) this.closeSettings(); };
  this.$('s_close').focus();
};
PP.UI.prototype.closeSettings = function () { this.$('modal').hidden = true; };
