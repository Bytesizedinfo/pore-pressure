'use strict';
/* Behaviour tests: drive the real tool API at a fixed 120 Hz step and assert the sourced real-world outcomes.
   ?test=all runs every assertion; ?test=<visual> stages a scene for a screenshot. */
PP.Tests = function (W) {
  this.W = W; this.dt = 1 / 120; this.results = [];
};
PP.Tests.prototype.step = function (sec) { const n = Math.max(1, Math.round(sec / this.dt)); for (let i = 0; i < n; i++) this.W.step(this.dt); };
PP.Tests.prototype.setup = async function (area, list, opt = {}) {
  const W = this.W;
  if (W.areaId !== area) await PP.main.switchArea(area, true);
  W.S.blood = opt.blood !== false; W.S.spurt = 1; W.S.ooze = 1; W.S.pain = false; W.S.shield = false; W.S.lens = true; W.S.bloodAmt = 1;
  W.rng = PP.rng(1234); W.ctx.rng = W.rng;
  W.parts.clear(); W.wounds.reset(); W.decals.reset(); W.render.setupWorld();
  W.lesions = []; W.clock = 0; W.ctx.clock = 0; W.stats = { pops: 0, vol: 0, perfect: 0, deep: 0, flinch: 0, bruise: 0 };
  W.tools.release(); W.tools.ptr.down = false; W.tools.spread = { fingers: 4.6, swabs: 3.0 }; W.tools.angle = 0; W.tools.wet = 0; W.painLevel = 0;
  const out = list.map(([t, x, y, d]) => W.addLesion(t, x, y, d));
  W.cam.x = opt.cx || 0; W.cam.y = opt.cy || 0; W.cam.zoom = opt.zoom || 1.5;
  W.render.resize(); W.cam.update(W.render.w, W.render.h);
  return out;
};
PP.Tests.prototype.hold = function (tool, x, y, sec, opt = {}) {
  const T = this.W.tools;
  T.select(tool);
  if (opt.spread != null && T.spread[tool] != null) T.spread[tool] = opt.spread;
  if (opt.angle != null) T.angle = opt.angle;
  T.ptr.x = x; T.ptr.y = y; T.ptr.lx = x; T.ptr.ly = y;
  T.down(x, y, { shift: !!opt.shift });
  if (opt.until) { const n = Math.round(sec / this.dt); for (let i = 0; i < n; i++) { this.W.step(this.dt); if (opt.until()) break; } }
  else this.step(sec);
  if (!opt.keep) { T.up(); this.step(0.02); }
};
PP.Tests.prototype.drag = function (tool, x0, y0, x1, y1, sec, opt = {}) {
  const T = this.W.tools;
  T.select(tool); T.ptr.x = x0; T.ptr.y = y0; T.ptr.lx = x0; T.ptr.ly = y0;
  T.down(x0, y0, { shift: !!opt.shift });
  const n = Math.max(2, Math.round(sec / this.dt));
  for (let i = 1; i <= n; i++) { T.move(x0 + ((x1 - x0) * i) / n, y0 + ((y1 - y0) * i) / n); this.W.step(this.dt); }
  if (!opt.keep) { T.up(); this.step(0.02); }
};
PP.Tests.prototype.ok = function (name, pass, info) { this.results.push({ name, pass: !!pass, info }); PP.diag.write((pass ? 'PASS ' : 'FAIL ') + name + ' ' + JSON.stringify(info)); };

PP.Tests.prototype.all = async function () {
  const W = this.W, T = W.tools, P = W.parts;
  let L, L2;
  // 1. opposed fingers pop an unopened pustule at the roof
  [L] = await this.setup('cheek', [['pustule', 0, 0, 3]]);
  this.hold('fingers', 0, 0, 2.5, { spread: 4.6 });
  const popP = L.Pmax;
  this.ok('pustule_roof_pop', L.events.includes('pop') && !L.events.includes('deep'), { events: L.events, Pmax: +popP.toFixed(1), ext: +L.ext.toFixed(2) });
  // 1b. needle-opened pustule drains at lower pressure than the popping pressure
  [L] = await this.setup('cheek', [['pustule', 0, 0, 3]]);
  this.hold('needle', 0, 0, 0.05);
  let firstP = null;
  this.hold('fingers', 0, 0, 2.5, { spread: 4.6, until: () => { if (L.ext > 0.05 && firstP == null) firstP = L.P; return false; } });
  this.ok('needle_lowers_pressure', firstP != null && firstP < popP && !L.events.includes('deep'), { firstFlowP: firstP && +firstP.toFixed(1), popP: +popP.toFixed(1), events: L.events });
  // 2. pressing straight on top seals the exit -> no surface pop (wall loads instead)
  [L] = await this.setup('cheek', [['pustule', 0, 0, 3]]);
  this.hold('fingers', 0, 0, 3, { spread: 0, shift: true });
  this.ok('covered_no_pop', !L.events.includes('pop'), { events: L.events, Pmax: +L.Pmax.toFixed(1), cover: +L.Pcov.toFixed(1) });
  // 3. nodule: squeezing ruptures deep, nothing drains
  [L] = await this.setup('cheek', [['nodule', 0, 0, 8]]);
  this.hold('fingers', 0, 0, 3, { spread: 6.5 });
  this.ok('nodule_deep_rupture', L.events.includes('deep') && L.ext === 0, { events: L.events, Pmax: +L.Pmax.toFixed(1) });
  // 4. epidermoid squeezed shut -> internal rupture, little comes out
  [L] = await this.setup('back', [['epidermoid', 0, 0, 18]]);
  this.hold('fingers', 0, 0, 3, { spread: 11, shift: true });
  this.ok('epidermoid_closed_ruptures', L.events.includes('deep') && L.ext < 0.15 * L.V0, { events: L.events, ext: +L.ext.toFixed(0), V0: +L.V0.toFixed(0), Pmax: +L.Pmax.toFixed(1) });
  // 5. blackhead: warm compress lowers plug friction; loop extracts the plug (stick-slip)
  [L] = await this.setup('nose', [['blackhead', 0, 0, 1.4]]);
  this.hold('loop', 0, 0, 0.3);
  const fCold = L.plugF;
  [L] = await this.setup('nose', [['blackhead', 0, 0, 1.4]]);
  this.hold('compress', 0, 0, 40);
  this.hold('loop', 0, 0, 0.3);
  const fWarm = L.plugF, Twarm = W.wounds.heatAt(0, 0);
  this.hold('loop', 0, 0, 4);
  this.ok('blackhead_heat_softens', fWarm < fCold * 0.7, { fCold, fWarm, T: +Twarm.toFixed(1) });
  this.ok('blackhead_plug_out', L.events.includes('plugOut'), { events: L.events, ext: L.plug && +L.plug.ext.toFixed(2) });
  // 6. paste strand ~ opening diameter; giant pustule jets
  [L] = await this.setup('cheek', [['pustule', 0, 0, 3.2]]);
  this.hold('fingers', 0, 0, 2.2, { spread: 4.6, keep: true });
  let chain = 0, rs = 0;
  for (let i = 0; i < P.hi; i++) if (P.alive[i] && P.mat[i] === PP.MAT.pus && P.next[i] >= 0) { chain++; rs = P.r[i]; }
  T.up(); this.step(0.05);
  this.ok('paste_strand', chain >= 5 && Math.abs(rs / L.ropen() - 1.12) < 0.25, { links: chain, strandR: +rs.toFixed(3), openR: +L.ropen().toFixed(3) });
  [L] = await this.setup('back', [['giant', 0, 0, 6.5]]);
  let vmax = 0, nd = 0;
  this.hold('fingers', 0, 0, 2.5, { spread: 7.5, until: () => { for (let i = 0; i < P.hi; i++) if (P.alive[i] && P.mat[i] === PP.MAT.pusThin) { const v = Math.hypot(P.x[i] - P.px[i], P.y[i] - P.py[i], P.z[i] - P.pz[i]) / (this.dt / 2); vmax = Math.max(vmax, v); } nd = Math.max(nd, P.count); return false; } });
  this.ok('giant_jet', vmax > 1000 && nd > 10, { vmax: +vmax.toFixed(0), particles: nd, events: L.events });
  // 7. epidermoid minimal-excision protocol: contents + whole sac with slow traction
  const cystRun = async (fast, type) => {
    const [C] = await this.setup('back', [[type || 'epidermoid', 0, 0, 16]]);
    this.drag('iodine', -6, 0, 6, 0, 0.6);
    this.hold('lido', -9, 0, 1.0); this.hold('lido', 9, 0, 1.0);
    W.timelapse(600);
    if (type === 'pilar') { this.hold('punch', 0, 0, 2.5); }
    else this.drag('blade11', 0, -1.2, 0, 1.3, 0.25);
    // hemostat in the opening, spread
    this.hold('hemostat', 0, 0, 0.01, { keep: true }); for (let i = 0; i < 40; i++) { T.move(i * 0.06, i * 0.03); W.step(this.dt); } T.up();
    this.hold('fingers', 0, 0, 7, { spread: 10 });
    this.hold('fingers', 0, 0, 5, { spread: 9 });
    const ready = C.sac && C.sac.ready;
    // grasp the sac and pull
    const si = C.sac ? C.sac.chain : -1;
    let res = 'none';
    if (si >= 0) {
      const sx = P.x[si], sy = P.y[si];
      T.select('hemostat'); T.down(sx, sy);
      const n = fast === 'mod' ? 150 : fast ? 30 : 840;   // fast ~70 mm/s; moderate ~15 mm/s; slow ~2.6 mm/s
      for (let i = 1; i <= n; i++) { T.move(sx + (i / n) * 18, sy + (i / n) * 4); W.step(this.dt); if (C.sac.done) break; }
      T.up(); this.step(0.05);
      res = C.events.find((e) => e.startsWith('sac')) || (C.sac.frags ? 'tore' : 'pulling');
    }
    return { C, ready, res };
  };
  let r = await cystRun(false);
  this.ok('cyst_protocol_slow_sac_whole', r.C.ext > 0.6 * r.C.V0 && r.ready && r.res === 'sacWhole', { ext: +r.C.ext.toFixed(0), V0: +r.C.V0.toFixed(0), ready: r.ready, res: r.res, events: r.C.events, frags: r.C.sac.frags });
  r = await cystRun(true);
  this.ok('cyst_fast_pull_tears', r.C.sac.frags > 0, { res: r.res, frags: r.C.sac.frags, events: r.C.events });
  r = await cystRun('mod', 'epidermoid');
  this.ok('epidermoid_moderate_pull_tears', r.C.sac.frags > 0, { res: r.res, frags: r.C.sac.frags });
  r = await cystRun('mod', 'pilar');
  this.ok('pilar_shells_out_whole', r.res === 'sacWhole', { res: r.res, frags: r.C.sac.frags, ext: +r.C.ext.toFixed(0), V0: +r.C.V0.toFixed(0) });
  [L] = await this.setup('scalp', [['pilar', 0, 0, 18]]);
  this.hold('fingers', 0, 0, 3, { spread: 11, shift: true });
  this.ok('pilar_closed_nothing', !L.events.includes('deep') && L.ext === 0, { events: L.events, Pmax: +L.Pmax.toFixed(1) });
  // 8. lipoma: needle hole fails; quarter-diameter incision + side pressure extrudes; large one sticks on ligaments
  [L] = await this.setup('back', [['lipoma', 0, 0, 26]]);
  this.hold('needle', 0, 0, 0.05);
  this.hold('fingers', 0, 0, 3, { spread: 15, shift: true });
  this.ok('lipoma_needle_fails', L.ext === 0, { ext: L.ext, events: L.events });
  [L] = await this.setup('back', [['lipoma', 0, 0, 26]]);
  for (let k = 0; k < 4; k++) this.drag('blade15', -3.5, 0, 3.5, 0, 0.5);
  this.hold('fingers', 0, 0, 6, { spread: 15, shift: true });
  this.ok('lipoma_incision_extrudes', L.ext > 0, { ext: +L.ext.toFixed(0), V0: +L.V0.toFixed(0), inc: L.incLen && +L.incLen.toFixed(1), open: L.open.r });
  [L] = await this.setup('back', [['lipoma', 0, 0, 36]]);
  for (let k = 0; k < 4; k++) this.drag('blade15', -5, 0, 5, 0, 0.5);
  this.hold('fingers', 0, 0, 10, { spread: 18, shift: true });
  const stuckFrac = L.ext / L.V0;
  this.hold('hemostat', 0, 0, 0.01, { keep: true }); for (let i = 0; i < 80; i++) { T.move(Math.sin(i * 0.2) * 3, Math.cos(i * 0.2) * 3); W.step(this.dt); } T.up();
  this.hold('fingers', 0, 0, 8, { spread: 18, shift: true });
  this.ok('large_lipoma_ligaments', stuckFrac < 0.45 && L.ext / L.V0 > stuckFrac + 0.05, { stuck: +stuckFrac.toFixed(2), after: +(L.ext / L.V0).toFixed(2) });
  // 9. incisions gape least along the tension lines; punch holes ovalise along them
  await this.setup('cheek', []);
  const a = (W.area.rstl * Math.PI) / 180;
  W.wounds.addCut(0, 0, Math.cos(a) * 4, Math.sin(a) * 4, 1.5, 'blade15', 901);
  W.wounds.addCut(10, 0, 10 - Math.sin(a) * 4, Math.cos(a) * 4, 1.5, 'blade15', 902);
  const gAlong = W.wounds.cuts[0].gape, gAcross = W.wounds.cuts[1].gape;
  this.ok('cut_gape_tension_lines', gAcross > gAlong * 1.5, { along: +gAlong.toFixed(3), across: +gAcross.toFixed(3) });
  const hole = W.wounds.addPunch(-10, 0, 2.0, 2);
  this.ok('punch_ovalises', hole.along / hole.across > 1.1, { along: +hole.along.toFixed(2), across: +hole.across.toFixed(2) });
  // 10. bleeding: epinephrine reduces it; gauze pressure speeds clotting; blood toggle respected
  await this.setup('cheek', []);
  W.wounds.bleedVol = 0; W.wounds.addCut(-4, 0, 0, 0, 1.4, 'blade15', 911); this.step(4);
  const bPlain = W.wounds.bleedVol;
  await this.setup('cheek', []);
  this.hold('lido', -2, 0, 1.2); W.timelapse(600);
  W.wounds.bleedVol = 0; W.wounds.addCut(-4, 0, 0, 0, 1.4, 'blade15', 912); this.step(4);
  const bEpi = W.wounds.bleedVol;
  this.ok('epinephrine_reduces_bleeding', bEpi < bPlain * 0.5, { plain: +bPlain.toFixed(2), epi: +bEpi.toFixed(2) });
  await this.setup('cheek', []);
  W.wounds.addCut(-4, 0, 0, 0, 1.4, 'blade15', 913); this.step(5); const clotFree = W.wounds.cuts[0].clot;
  await this.setup('cheek', []);
  W.wounds.addCut(-4, 0, 0, 0, 1.4, 'blade15', 914); this.hold('gauze', -2, 0, 5); const clotPress = W.wounds.cuts[0].clot;
  this.ok('gauze_pressure_clots_faster', clotPress > clotFree * 1.8, { free: +clotFree.toFixed(3), pressed: +clotPress.toFixed(3) });
  await this.setup('cheek', [], { blood: false });
  W.wounds.addCut(-4, 0, 0, 0, 1.4, 'blade15', 915); this.step(3);
  let nb = 0; for (let i = 0; i < P.hi; i++) if (P.alive[i] && P.mat[i] === PP.MAT.blood) nb++;
  this.ok('blood_toggle_off', nb === 0, { bloodParticles: nb });
  // 11. vacuum >3 s on one spot -> petechiae
  [L] = await this.setup('nose', [['filament', 0, 0, 0.5]]);
  T.vacLevel = 2; this.hold('vacuum', 0, 0, 4.5);
  this.ok('vacuum_petechiae', (W.decals.petechiae || 0) > 0, { petechiae: W.decals.petechiae || 0, events: L.events });
  // 12. molluscum spreads after finger squeezing; steroid flattens a nodule over days
  [L] = await this.setup('cheek', [['molluscum', 0, 0, 3]]);
  this.hold('fingers', 0, 0, 2, { spread: 4.6 });
  const n0 = W.lesions.length; W.timelapse(2 * 86400 + 100);
  this.ok('molluscum_autoinoculation', W.lesions.length > n0, { before: n0, after: W.lesions.length, events: L.events });
  [L] = await this.setup('cheek', [['nodule', 0, 0, 8]]);
  this.hold('steroid', 0, 0, 0.05); W.timelapse(2.2 * 86400);
  this.ok('steroid_flattens_nodule', L.events.includes('flattened') && L.domeH() < L.H0 * 0.5, { events: L.events, h: +L.domeH().toFixed(2), H0: +L.H0.toFixed(2) });
  // 13. ingrown hair: warm, lift with needle, free the tip with forceps
  [L] = await this.setup('beard', [['ingrown', 0, 0, 3]]);
  this.hold('compress', 0, 0, 20);
  this.drag('needle', 0, 0, 0.3, 1.2, 0.3);
  const hi = L.hair.chain;
  let tip = -1; if (hi >= 0) { const ch = P.chainOf(hi); tip = ch[ch.length - 1]; }
  if (tip >= 0) { const tx = P.x[tip], ty = P.y[tip]; T.select('forceps'); T.down(tx, ty); for (let i = 1; i <= 60; i++) { T.move(tx + i * 0.05, ty + i * 0.02); W.step(this.dt); } T.up(); }
  this.ok('ingrown_tip_freed', L.events.includes('hairLifted') && L.events.includes('hairFreed') && !L.events.includes('hairPlucked'), { events: L.events });
  // 14. boil points with moist heat over hours
  [L] = await this.setup('back', [['furuncle', 0, 0, 10]]);
  const pt0 = L.pointing; this.hold('compress', 0, 0, 30, { keep: true }); W.timelapse(3 * 3600); W.tools.up();
  this.ok('boil_points_with_heat', L.pointing > pt0 + 0.3, { before: +pt0.toFixed(2), after: +L.pointing.toFixed(2), events: L.events });

  const passed = this.results.filter((x) => x.pass).length;
  PP.diag.write('SUMMARY ' + passed + '/' + this.results.length + ' passed');
  document.title = 'TESTS ' + passed + '/' + this.results.length;
};

// visual scenes for screenshots
PP.Tests.prototype.visual = async function (name) {
  const W = this.W, T = W.tools;
  const tone = PP.params.get('tone');
  if (tone != null) await PP.main.switchTone(+tone);
  if (name === 'idle') { await this.setup(PP.params.get('area') || 'cheek', []); W.newPatch(+(PP.params.get('seed') || 7)); W.cam.zoom = +(PP.params.get('zoom') || 1); }
  else if (name === 'skin') { await this.setup(PP.params.get('area') || 'cheek', [], { zoom: +(PP.params.get('zoom') || 2) }); }
  else if (name === 'lesions') {
    const types = Object.keys(PP.LTYPES).filter((t) => PP.LTYPES[t].d[1] < 10);
    const list = types.map((t, i) => [t, ((i % 5) - 2) * 9, (1.5 - Math.floor(i / 5)) * 9, null]);
    await this.setup('sandbox', list, { zoom: 0.6 });
    W.cam.zoom = +(PP.params.get('zoom') || 0.62); W.cam.x = +(PP.params.get('cx') || 0); W.cam.y = +(PP.params.get('cy') || 0);
  } else if (name === 'cysts') {
    await this.setup('back', [['epidermoid', -30, 12, 18], ['lipoma', 22, 10, 30], ['furuncle', -22, -18, 12], ['carbuncle', 14, -20, 24], ['steatocystoma', 0, 2, 7]], { zoom: 0.9 });
  } else if (name === 'pop') {
    await this.setup('cheek', [['pustule', 0, 0, 3.4], ['papule', 7, 4, 3], ['whitehead', -6, -4, 2]], { zoom: 2.4 });
    this.hold('fingers', 0, 0, +(PP.params.get('t') || 1.6), { spread: 4.6, keep: true });
  } else if (name === 'squeeze') {
    await this.setup('cheek', [['pustule', 0, 0, 3.4]], { zoom: 2.4 });
    this.hold('fingers', 0, 0, 0.5, { spread: 5.2, keep: true });
  } else if (name === 'blackhead') {
    await this.setup('nose', [['blackhead', 0, 0, 1.6], ['blackhead', 3, 2, 1.2], ['filament', -3, 1, 0.5], ['filament', -2, -2, 0.5], ['dpow', 4, -3, 3]], { zoom: 2.2 });
    this.hold('compress', 0, 0, 30); this.hold('loop', 0, 0, +(PP.params.get('t') || 2.5), { keep: true });
  } else if (name === 'cyst') {
    const [C] = await this.setup('back', [['epidermoid', 0, 0, 16]], { zoom: 2.2 });
    this.drag('iodine', -8, -3, 8, 3, 0.8); this.hold('lido', -9, 0, 1); this.hold('lido', 9, 0, 1); W.timelapse(600);
    this.drag('blade11', 0, -1.2, 0, 1.3, 0.25);
    this.hold('hemostat', 0, 0, 0.01, { keep: true }); for (let i = 0; i < 40; i++) { T.move(i * 0.06, i * 0.03); W.step(this.dt); } T.up();
    this.hold('fingers', 0, 0, +(PP.params.get('t') || 4), { spread: 10, keep: true });
  } else if (name === 'giant') {
    await this.setup('back', [['giant', 0, 0, 6.5]], { zoom: 1.6 });
    this.hold('fingers', 0, 0, +(PP.params.get('t') || 1.4), { spread: 7.5, keep: true });
  } else if (name === 'cut') {
    await this.setup('cheek', [], { zoom: 2.5 });
    const a = (W.area.rstl * Math.PI) / 180;
    W.wounds.addCut(-3, 1, -3 + Math.cos(a) * 4, 1 + Math.sin(a) * 4, 1.4, 'blade15', 1); W.wounds.addCut(3, -1, 3 - Math.sin(a) * 4, -1 + Math.cos(a) * 4, 1.4, 'blade15', 2);
    W.wounds.addPunch(0, -4, 2, 1.5); for (const h of W.wounds.holes) h.core = false;
    this.step(+(PP.params.get('t') || 3));
  } else if (name === 'tools') {
    await this.setup('cheek', [['pustule', 0, 0, 3]], { zoom: 1.0 });
    const ids = ['fingers', 'loop', 'vacuum', 'needle', 'blade11', 'punch', 'hemostat', 'gauze', 'compress'];
    const all = []; let k = 0;
    for (const id of ids) {
      T.select(id); const x = ((k % 3) - 1) * 8, y = (1 - Math.floor(k / 3)) * 6; T.ptr.x = x; T.ptr.y = y; T.ptr.lx = x - 0.1; T.ptr.ly = y; T.ptr.down = false;
      T.update(this.dt); all.push(T.prims.slice(0, T.nPrim * 16)); k++;
    }
    T.select('fingers');
    const merged = new Float32Array(all.reduce((s, a) => s + a.length, 0)); let o = 0; for (const a of all) { merged.set(a, o); o += a.length; }
    W._frozenPrims = merged;
  }
};
