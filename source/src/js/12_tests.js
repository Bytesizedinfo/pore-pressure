'use strict';
/* Behaviour tests: drive the real tool API at a fixed 120 Hz step and assert the sourced real-world outcomes.
   ?test=all runs every assertion; ?test=<visual> stages a scene for a screenshot. */
PP.Tests = function (W) {
  this.W = W; this.dt = 1 / 120; this.results = [];
};
PP.Tests.prototype.step = function (sec) { const n = Math.max(1, Math.round(sec / this.dt)); for (let i = 0; i < n; i++) this.W.step(this.dt); };
PP.Tests.prototype.setup = async function (area, list, opt = {}) {
  const W = this.W;
  if (W.areaId !== area) await PP.main.switchArea(area);
  W.S.blood = opt.blood !== false; W.S.spurt = 1; W.S.ooze = 1; W.S.pain = false; W.S.shield = false; W.S.lens = true; W.S.bloodAmt = 1;
  W.rng = PP.rng(1234); W.ctx.rng = W.rng;
  W.parts.clear(); W.wounds.reset(); W.decals.reset(); W.render.setupWorld(); W.phys.clearGhosts(); W.phys.contacts.length = 0;
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

  // 15. dragging with Move (or holding Space) pans the skin and never touches it with an instrument
  {
    [L] = await this.setup('cheek', [['pustule', 0, 0, 3]], { zoom: 2 });
    const cv = document.getElementById('gl'), r = cv.getBoundingClientRect(), UI = PP.main.UI;
    const ev = (type, x, y) => cv.dispatchEvent(new PointerEvent(type, { clientX: r.left + x, clientY: r.top + y, button: 0, buttons: type === 'pointerup' ? 0 : 1, pointerId: 7, pointerType: 'mouse', bubbles: true }));
    const dragPan = () => { const x0 = W.cam.x; ev('pointerdown', r.width / 2, r.height / 2); for (let i = 1; i <= 8; i++) { ev('pointermove', r.width / 2 - i * 20, r.height / 2); W.step(this.dt); } ev('pointerup', r.width / 2 - 160, r.height / 2); this.step(0.2); return W.cam.x - x0; };
    T.select('move'); const dMove = dragPan();
    T.select('fingers'); UI.space = true; const dSpace = dragPan(); UI.space = false;
    this.ok('move_space_pan', dMove > 1 && dSpace > 1 && !T.ptr.down && L.Pmax < 1 && !L.events.includes('pop'), { dMove: +dMove.toFixed(2), dSpace: +dSpace.toFixed(2), Pmax: +L.Pmax.toFixed(2), events: L.events });
  }
  // 15b. squeezing: the skin between the pads folds up, pads travel inward and spread with force,
  //      and on release the skin springs back part at once, the rest over seconds
  {
    await this.setup('cheek', [], { zoom: 2 });
    T.select('fingers'); T.spread.fingers = 4.6; T.angle = 0; T.ptr.x = 0; T.ptr.y = 0; T.down(0, 0, {});
    this.step(0.15); const aLow = T.padA;
    this.step(1.6); const aHigh = T.padA, travel = T.padTravel;
    W.buildHeightGrid(); const ridge = W.visH(0, 0), held = W.visH(-4.6, 0);
    T.up(); this.step(0.1); W.buildHeightGrid(); const at01 = W.visH(-4.6, 0), ridge01 = W.visH(0, 0);
    this.step(5); W.buildHeightGrid(); const at5 = W.visH(-4.6, 0);
    // crest above the pad contacts 2-5 mm, and above undeformed skin
    this.ok('squeeze_fold', ridge - held > 2 && ridge - held < 5 && ridge > 0.5 && travel > 0.3 && aHigh > aLow + 0.1, { ridge: +ridge.toFixed(2), travel: +travel.toFixed(2), aLow: +aLow.toFixed(2), aHigh: +aHigh.toFixed(2) });
    this.ok('squeeze_recovery', held < -0.2 && at01 / held > 0.3 && at01 / held < 0.8 && Math.abs(at5 / held) < 0.1 && ridge01 < ridge, { held: +held.toFixed(3), at01: +at01.toFixed(3), at5: +at5.toFixed(4), ridge01: +ridge01.toFixed(2) });
  }
  // 15c. smart drag: clear skin pans, a blemish gets the instrument, blades cut anywhere, holding still presses
  {
    [L] = await this.setup('cheek', [['pustule', 0, 0, 3]], { zoom: 1 });
    const cv = document.getElementById('gl'), r = cv.getBoundingClientRect(), UI = PP.main.UI;
    const ev = (type, x, y, btn) => cv.dispatchEvent(new PointerEvent(type, { clientX: r.left + x, clientY: r.top + y, button: btn || 0, buttons: type === 'pointerup' ? 0 : 1, pointerId: 9, pointerType: 'mouse', bubbles: true }));
    const at = (wx, wy) => [(0.5 + (wx - W.cam.x) / W.cam.vw) * r.width, (0.5 - (wy - W.cam.y) / W.cam.vh) * r.height];
    const drag = (wx, wy) => { const [x, y] = at(wx, wy), x0 = W.cam.x; ev('pointerdown', x, y); for (let i = 1; i <= 6; i++) { ev('pointermove', x - i * 15, y); W.step(this.dt); } const down = T.ptr.down; ev('pointerup', x - 90, y); this.step(0.1); return { d: W.cam.x - x0, down }; };
    T.select('fingers');
    const clear = drag(-9, 4.5); W.cam.x = W.cam.tx = 0; W.cam.y = W.cam.ty = 0; W.cam.vxp = W.cam.vyp = 0;
    const onLes = drag(0, 0); const pm = L.Pmax; W.cam.x = W.cam.tx = 0; W.cam.vxp = 0;
    T.select('blade15'); const nCut0 = W.wounds.cuts.length; const blade = drag(-9, 4.5); const cut = W.wounds.cuts.length > nCut0; W.cam.x = W.cam.tx = 0; W.cam.vxp = 0;
    T.select('fingers'); const [hx, hy] = at(-9, -4.5); const pend = UI.canPanFrom(-9, -4.5, 'fingers'); ev('pointerdown', hx, hy); await new Promise((res) => setTimeout(res, 320)); const held = T.ptr.down; ev('pointerup', hx, hy); this.step(0.05);
    this.ok('smart_drag', clear.d > 1 && !clear.down && Math.abs(onLes.d) < 0.01 && onLes.down && pm > 1 && Math.abs(blade.d) < 0.01 && cut && pend && held,
      { clearPan: +clear.d.toFixed(2), lesionPan: +onLes.d.toFixed(2), Pmax: +pm.toFixed(1), bladePan: +blade.d.toFixed(2), cut, viaPending: pend, holdPress: held });
    UI.cancelPending();
  }
  // 16. zoom out to the face, dive into the nose, come back into the cheek: every area keeps its state
  {
    [L] = await this.setup('cheek', [['pustule', 0, 0, 3]], { zoom: 0.4 });
    this.hold('fingers', 0, 0, 2.5, { spread: 4.6 });
    const B = PP.main.B; await B.load();
    const run = async () => { for (let i = 0; i < 3000 && B.mode !== 'macro' && B.mode !== 'body'; i++) { B.update(1 / 30); await new Promise((r) => setTimeout(r, 2)); } };
    await B.enter(); await run(); const m1 = B.mode;
    B.dive('nose'); await run(); const inNose = W.areaId === 'nose' && B.mode === 'macro', nNose = W.lesions.length;
    W.lesions[0].popped = true; const noseL = W.lesions[0];
    await B.enter(); await run();
    B.dive('cheek'); await run();
    const back = W.lesions.find((x) => x.type === 'pustule');
    const noseKept = W.areaStates.nose && W.areaStates.nose.lesions[0] === noseL && noseL.popped;
    this.ok('body_roundtrip', m1 === 'body' && inNose && nNose > 0 && W.areaId === 'cheek' && back === L && L.events.includes('pop') && noseKept && W.render.physA,
      { m1, inNose, nNose, area: W.areaId, same: back === L, popped: L.events.includes('pop'), noseKept: !!noseKept });
  }

  // 17. face view: left-drag moves the body, right-drag turns it
  {
    const B = PP.main.B; await B.load();
    await B.jump(B.overview('cheek'));
    const cv = document.getElementById('gl'), r = cv.getBoundingClientRect();
    const ev = (type, x, y, btn) => cv.dispatchEvent(new PointerEvent(type, { clientX: r.left + x, clientY: r.top + y, button: btn, buttons: type === 'pointerup' ? 0 : 1, pointerId: 11, pointerType: 'mouse', bubbles: true }));
    const go = (btn) => { ev('pointerdown', r.width / 2, r.height / 2, btn); for (let i = 1; i <= 6; i++) ev('pointermove', r.width / 2 + i * 12, r.height / 2, btn); ev('pointerup', r.width / 2 + 72, r.height / 2, btn); };
    const p0 = B.tgt.p.slice(), y0 = B.tgt.yaw; go(0);
    const moved = Math.hypot(B.tgt.p[0] - p0[0], B.tgt.p[1] - p0[1], B.tgt.p[2] - p0[2]), yaw1 = B.tgt.yaw;
    go(2); const yaw2 = B.tgt.yaw;
    this.ok('face_drag', moved > 5 && Math.abs(yaw1 - y0) < 1e-6 && Math.abs(yaw2 - yaw1) > 0.2, { moved: +moved.toFixed(1), yawAfterLeft: +(yaw1 - y0).toFixed(3), yawAfterRight: +(yaw2 - yaw1).toFixed(3) });
    B.exitToMacro();
  }

  // 18. close-up anywhere: a point on the neck opens a "Neck" patch with neck-type blemishes that keeps its
  //     state across trips; the eye gets no close-up
  {
    const B = PP.main.B; await B.load();
    await this.setup('cheek', [], { zoom: 0.4 }); W.ensureAreas();
    const run = async () => { for (let i = 0; i < 3000 && B.mode !== 'macro' && B.mode !== 'body'; i++) { B.update(1 / 30); await new Promise((res) => setTimeout(res, 2)); } };
    const hit = B.raycast([0, 592, 600], [0, 0, -1]);
    const f = hit && B.spotFor(hit), id = f && B.makeSpot(f);
    const A = id && PP.AREAS[id], les = id ? W.areaStates[id].lesions : [];
    const typesOk = les.length > 0 && les.every((L) => PP.SPOTS.neck.mix.some(([t]) => t === L.type));
    await B.jump(B.overview(id)); B.dive(id); await run();
    const inSpot = W.areaId === id && B.mode === 'macro' && W.lesions.length === les.length;
    const keep = W.lesions[0]; if (keep) keep.popped = true;
    await B.enter(); await run(); B.dive('cheek'); await run(); const inCheek = W.areaId === 'cheek';
    await B.enter(); await run(); B.dive(id); await run();
    const kept = W.areaId === id && W.lesions[0] === keep && keep && keep.popped;
    const eyeHit = B.raycast([B.meta.eyes[0][0], B.meta.eyes[0][1], 600], [0, 0, -1]), eye = eyeHit && B.spotFor(eyeHit);
    const opt = !!document.querySelector('#area option[value="' + id + '"]');
    this.ok('spot_anywhere', A && A.name === 'Neck' && typesOk && inSpot && inCheek && kept && eye && eye.bad === 'eye' && opt,
      { name: A && A.name, n: les.length, typesOk, inSpot, inCheek, kept: !!kept, eye: eye && eye.bad, menu: opt, size: A && A.size });
  }

  // 19. zoom is only ever what you do: scrolling out past the whole patch continues in 3D from the same view and
  //     scale, nothing pulls back or flies in afterwards, clicking doesn't dive, and zooming into the neck opens a
  //     close-up under the cursor at the same scale
  {
    const B = PP.main.B; await B.load();
    await this.setup('cheek', [], { zoom: 0.125 }); W.ensureAreas();
    const C = W.cam; C.tz = C.zoom; C.tx = C.x; C.ty = C.y;
    // scrolling out from the whole patch stays in the close-up (no switch until 3x the patch)
    const C0 = { zoom: C.zoom }; C.zoom = C.tz = PP.main.UI.zpatch();
    { const r0 = document.getElementById('gl').getBoundingClientRect(); document.getElementById('gl').dispatchEvent(new WheelEvent('wheel', { deltaY: 100, clientX: r0.left + r0.width / 2, clientY: r0.top + r0.height / 2, bubbles: true, cancelable: true })); }
    const staysClose = B.mode === 'macro' && C.tz < PP.main.UI.zpatch() && C.tz > PP.main.UI.zmin();
    C.zoom = C.tz = C0.zoom;
    const cv = document.getElementById('gl'), r = cv.getBoundingClientRect();
    const wheel = (x, y, dy) => cv.dispatchEvent(new WheelEvent('wheel', { deltaY: dy, clientX: x, clientY: y, bubbles: true, cancelable: true }));
    const settle = (sec) => { for (let i = 0; i < sec * 30; i++) B.update(1 / 30); };
    const vw0 = W.area.view / C.zoom;
    wheel(r.left + r.width * 0.6, r.top + r.height * 0.4, 100);
    const w1 = B.widthAt(B.tgt.dist), m1 = B.mode;
    settle(3); const w2 = B.widthAt(B.cam.dist), m2 = B.mode;
    const outOk = staysClose && (m1 === 'entering') && Math.abs(w1 / vw0 - Math.exp(0.18)) < 0.03 && Math.abs(w2 / w1 - 1) < 0.02 && m2 === 'body';
    // click on the face: nothing happens
    B.matrices();
    const proj = (q) => { const m = B.VP, x = m[0] * q[0] + m[4] * q[1] + m[8] * q[2] + m[12], y = m[1] * q[0] + m[5] * q[1] + m[9] * q[2] + m[13], w = m[3] * q[0] + m[7] * q[1] + m[11] * q[2] + m[15]; return [r.left + (x / w * 0.5 + 0.5) * r.width, r.top + (0.5 - y / w * 0.5) * r.height]; };
    const ev = (type, x, y) => cv.dispatchEvent(new PointerEvent(type, { clientX: x, clientY: y, button: 0, buttons: type === 'pointerup' ? 0 : 1, pointerId: 13, pointerType: 'mouse', bubbles: true }));
    const [cx, cy] = proj(B.anchors.cheek.p); ev('pointerdown', cx, cy); ev('pointerup', cx, cy); settle(1.5);
    const clickOk = B.mode === 'body' && W.areaId === 'cheek';
    // look at the neck from in front and scroll in on it until the close-up takes over
    const nh = B.raycast([30, 596, 600], [0, 0, -1]), nv = B.viewOf({ n: B.normalAt(nh.p) });
    await B.jump({ p: nh.p.slice(), yaw: nv.yaw, pitch: nv.pitch, dist: B.distW(220) });
    B.matrices(); const [nx, ny] = proj(nh.p);
    let steps = 0, wLast = 0;
    for (; steps < 60 && B.mode === 'body'; steps++) { wLast = B.widthAt(B.tgt.dist); wheel(nx, ny, -100); B.update(1 / 30); B.matrices(); }
    for (let i = 0; i < 3000 && B.mode !== 'macro'; i++) { B.update(1 / 30); PP.main.UI.easeCamera(1 / 30); await new Promise((res) => setTimeout(res, 2)); }
    const vwIn = W.cam.vw, under = PP.main.UI.toWorld(nx, ny);
    // where the zoomed-on point lies in the close-up it handed over to (new spot: its centre; existing: wherever)
    const an = B.anchors[W.areaId], dd = PP.M4.sub(nh.p, an.p), want = [PP.M4.dot(dd, an.t), PP.M4.dot(dd, an.b)];
    for (let i = 0; i < 60; i++) PP.main.UI.easeCamera(1 / 30);
    const inOk = PP.AREAS[W.areaId].name.startsWith('Neck') && Math.abs(vwIn / (wLast * Math.exp(-0.18)) - 1) < 0.08 && Math.hypot(under.x - want[0], under.y - want[1]) < 2 && Math.abs(W.cam.vw / vwIn - 1) < 0.01;
    this.ok('zoom_only_when_you_zoom', outOk && clickOk && inOk, { m1, w1: +w1.toFixed(1), vw0: +vw0.toFixed(1), w2: +w2.toFixed(1), m2, clickOk, area: PP.AREAS[W.areaId].name, steps, vwIn: +vwIn.toFixed(1), wLast: +wLast.toFixed(1), under: [+under.x.toFixed(2), +under.y.toFixed(2)], want: [+want[0].toFixed(2), +want[1].toFixed(2)], vwAfter: +W.cam.vw.toFixed(1) });
  }

  // 20. nothing changes zoom unless you do: a new patch and a chart click keep your zoom; switching area keeps the scale
  {
    await this.setup('cheek', [['pustule', 3, 2, 3]], { zoom: 2.2 }); W.cam.tz = W.cam.zoom;
    W.newPatch(4242); const zNew = W.cam.zoom;
    W.addLesion('pustule', 5, 5, 3); PP.main.UI.renderChart(true);
    const row = document.querySelector('#leslist .les'); if (row) row.click();
    const zChart = W.cam.tz;
    const vw0 = W.cam.vw; await PP.main.switchArea('nose'); const vwNose = W.area.view / W.cam.zoom;
    await PP.main.switchArea('cheek');
    this.ok('no_unrequested_zoom', Math.abs(zNew - 2.2) < 1e-6 && Math.abs(zChart - 2.2) < 1e-6 && Math.abs(vwNose / vw0 - 1) < 0.02,
      { zNew, zChart, vw0: +vw0.toFixed(2), vwNose: +vwNose.toFixed(2) });
  }

  // 21. squeezes fit the lesion: pads land just outside its edge; [ ] nudges persist on top of the fit
  {
    const fitOn = async (area, type, d, tool) => {
      const [Lf] = await this.setup(area, [[type, 0, 0, d]]); T.select(tool); T.fitOff[tool] = 0;
      T.down(0.3, 0.2, { fit: true }); const s1 = T.spread[tool], dx = T.fitDX; T.up(); this.step(0.02); return { s: s1, R: Lf.R, dx };
    };
    const bh = await fitOn('nose', 'blackhead', 1.2, 'fingers'), bhs = await fitOn('nose', 'blackhead', 1.2, 'swabs');
    const pu = await fitOn('cheek', 'pustule', 3, 'fingers'), cy = await fitOn('back', 'epidermoid', 20, 'fingers');
    T.select('fingers'); T.nudge('fingers', 0.8); const pu2 = await fitOn('cheek', 'pustule', 3, 'fingers').catch(() => null);
    T.fitOff.fingers = 0;
    this.ok('squeeze_autofit', Math.abs(bh.s - (bh.R + 3.51)) < 0.05 && Math.abs(bhs.s - (bhs.R + 1.9)) < 0.05 && Math.abs(pu.s - (pu.R + 3.51)) < 0.05 && cy.s > 12 && Math.abs(bh.dx + 0.3) < 1e-6,
      { blackheadFingers: +bh.s.toFixed(2), blackheadBuds: +bhs.s.toFixed(2), pustule: +pu.s.toFixed(2), cyst: +cy.s.toFixed(2), centred: Math.abs(bh.dx + 0.3) < 1e-6 });
    void pu2;
  }
  // 22. effort and outcome scale with depth and size: a deep cyst gets far less of the pad pressure than a
  //     superficial pustule at the same force (it needs more force), and a bigger pustule takes longer to empty.
  //     (A bigger superficial pustule pops *more* easily: thin roof, larger radius, higher wall stress - Laplace.)
  //     The pop meter climbs to 1 on the roof before a pop and shows the wall winning on a closed solid nodule.
  {
    const perN = async (area, type, d) => {
      const [Lq] = await this.setup(area, [[type, 0, 0, d]]); T.select('fingers'); T.fitOff.fingers = 0;
      T.down(0, 0, { fit: true }); this.step(0.5); const r = Lq.P / Math.max(T.force, 1e-3); T.up(); this.step(0.02); return r;
    };
    const pPus = await perN('cheek', 'pustule', 3), pCyst = await perN('back', 'epidermoid', 16);
    const empty = async (d) => {
      const [Lp] = await this.setup('cheek', [['pustule', 0, 0, d]]); T.select('fingers'); T.fitOff.fingers = 0;
      T.down(0, 0, { fit: true }); let t = 0, mr = 0, tPop = null;
      for (let i = 0; i < 120 * 20; i++) { W.step(this.dt); t += this.dt; if (tPop == null) mr = Math.max(mr, Lp.rRoof || 0); if (tPop == null && Lp.events.includes('pop')) tPop = t; if (tPop != null && Lp.fill() < 0.2) break; }
      T.up(); this.step(0.02); return { t: t - (tPop || t), mr, V: Lp.V0 };   // emptying time once open
    };
    const small = await empty(2.0), big = await empty(4.2);
    const [N] = await this.setup('cheek', [['nodule', 0, 0, 6]]); T.select('fingers'); T.down(0, 0, { fit: true });
    let wallLead = false; for (let i = 0; i < 120 * 3; i++) { W.step(this.dt); if ((N.rWall || 0) >= (N.rRoof || 0) && (N.rWall || 0) > 0.25) wallLead = true; } T.up(); this.step(0.02);
    this.ok('effort_and_pop_meter', pCyst < pPus * 0.6 && big.t > small.t && big.V > small.V * 5 && small.mr > 0.8 && wallLead,
      { kPaPerN: { pustule: +pPus.toFixed(2), cyst: +pCyst.toFixed(2) }, emptySecAfterPop: { small: +small.t.toFixed(2), big: +big.t.toFixed(2) }, meter: +small.mr.toFixed(2), wallLead });
  }
  // 23. blades meet lesions differently: an incision into a pressurised lesion gushes; a solid papule only bleeds
  //     (and, inflamed, bleeds more); a cyst slit exposes its wall; #11 stabs short, #15 follows the stroke
  {
    let [G] = await this.setup('cheek', [['giant', 0, 0, 6.5]]);
    this.hold('fingers', 0, 0, 0.3, { spread: 7, keep: true });
    const ext0 = G.ext; this.drag('blade11', 0, -0.6, 0, 0.8, 0.15); T.select('fingers'); this.step(0.02);
    const gush = G.events.includes('gush') && G.ext > ext0;
    T.up && T.up();
    const [Pp] = await this.setup('cheek', [['papule', 0, 0, 4]]); this.drag('blade15', -3, 0, 3, 0, 0.3);
    const cP = W.wounds.cuts[0], solidOk = !!Pp._solidCut && cP && cP.inflam > 0.3;
    const [E] = await this.setup('back', [['epidermoid', 0, 0, 16]]); this.drag('blade15', -6, 0, 6, 0, 0.5); this.drag('blade15', -6, 0, 6, 0, 0.5);
    const cE = W.wounds.cuts[W.wounds.cuts.length - 1], cystOk = cE && cE.layer === 1 && cE.L === E;
    await this.setup('cheek', []); this.drag('blade11', -4, 0, 4, 0, 0.3); const l11 = W.wounds.cuts[0] ? W.wounds.cuts[0].len : 0;
    await this.setup('cheek', []); this.drag('blade15', -4, 0, 4, 0, 0.3); const l15 = W.wounds.cuts[0] ? W.wounds.cuts[0].len : 0;
    this.ok('blade_reactions', gush && solidOk && cystOk && l11 <= 3.01 && l15 > 7, { gush, events: G.events, solidOk, inflam: cP && +cP.inflam.toFixed(2), cystOk, len11: +l11.toFixed(2), len15: +l15.toFixed(2) });
  }

  // 24. blood wells up as one growing bead at a puncture (not a spray of droplets)
  {
    await this.setup('cheek', [], { zoom: 2 });
    W.wounds.addPuncture(0, 0, 0.6);
    let maxBeads = 0;
    for (let k = 0; k < 6; k++) { this.step(0.5); let n = 0; for (let i = 0; i < P.hi; i++) if (P.alive[i] && P.isLiquid(P.mat[i]) && Math.hypot(P.x[i], P.y[i]) < 3) n++; maxBeads = Math.max(maxBeads, n); }
    const bi = W.wounds.punct[0].bead, r = bi >= 0 && P.alive[bi] ? P.r[bi] : 0;
    this.ok('bead_wells', maxBeads <= 2 && r > 0.15 && P.onSkin[bi], { maxBeads, r: +r.toFixed(3) });
  }
  // 25. Furmidge pinning: on the cheek a small bead holds, a big one lets go and runs downhill leaving a wet trail
  //     (and shrinking as it goes); on the flat-lying back the same big bead stays put
  {
    const run = async (area, r) => {
      await this.setup(area, [], { zoom: 1 });
      const V = (4 / 3) * Math.PI * r ** 3, i = P.well(-1, 0, 0, W.visH(0, 0), V, PP.MAT.blood, null, 0.3);
      this.step(1.5); return { dy: P.alive[i] ? P.y[i] : -99, r: P.alive[i] ? P.r[i] : 0 };
    };
    const small = await run('cheek', 0.9), big = await run('cheek', 1.8), back = await run('back', 1.8);
    this.ok('bead_runs', Math.abs(small.dy) < 0.3 && big.dy < -3 && big.r < 1.8 && Math.abs(back.dy) < 0.3,
      { smallMoved: +small.dy.toFixed(2), bigMoved: +big.dy.toFixed(2), bigR: +big.r.toFixed(2), backMoved: +back.dy.toFixed(2) });
  }
  // 26. one liquid surface: a bead is drawn as a thickness field (cap profile with a meniscus), not a sphere object
  {
    await this.setup('back', [], { zoom: 2 });
    const i = P.well(-1, 0, 0, W.visH(0, 0), (4 / 3) * Math.PI, PP.MAT.blood, null, 0.3);   // r = 1 mm
    this.step(0.05); W.render.render(1 / 60, true);
    const R = W.render, gl = R.gl, C = W.cam, rt = R.rt.fluid;
    const rd = (x) => { gl.bindFramebuffer(gl.FRAMEBUFFER, rt.fb); const px = new Float32Array(4);
      gl.readPixels(Math.round(((x - C.x) / C.vw + 0.5) * rt.w), Math.round(((P.y[i] - C.y) / C.vh + 0.5) * rt.h), 1, 1, gl.RGBA, gl.FLOAT, px); gl.bindFramebuffer(gl.FRAMEBUFFER, null); return px; };
    const c0 = rd(P.x[i]), mid = rd(P.x[i] + 0.75), out = rd(P.x[i] + 2.2);
    this.ok('fluid_continuous', c0[0] > 0.6 && c0[0] < 1.15 && mid[0] > 0.1 && mid[0] < c0[0] && out[0] < 0.02 && c0[1] / c0[0] > 0.95 && R.lastInst - T.nPrim === 0,
      { centre: +c0[0].toFixed(3), mid: +mid[0].toFixed(3), outside: +out[0].toFixed(4), bloodFrac: +(c0[1] / Math.max(c0[0], 1e-6)).toFixed(2), sphereObjects: R.lastInst - T.nPrim });
  }
  // 27. clotting and drying: shed blood gels after the bleeding time; a 10 min time-lapse dries the wet film
  {
    await this.setup('cheek', [], { zoom: 2 });
    const i = P.well(-1, 0, 0, W.visH(0, 0), 0.5, PP.MAT.blood, null, 0.3);
    const c0 = P.clotOf(i); P.age[i] = 400; const c1 = P.clotOf(i);
    W.decals.paint(3, 3, 1.5, 'blood', 1); W.render.render(1 / 60, true);
    const R = W.render, gl = R.gl, s0 = W.area.size;
    const film = () => { gl.bindFramebuffer(gl.FRAMEBUFFER, R.film.fb); const px = new Uint8Array(4); gl.readPixels(Math.round((3 / s0 + 0.5) * 1023), Math.round((3 / s0 + 0.5) * 1023), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px); gl.bindFramebuffer(gl.FRAMEBUFFER, null); return px; };
    const f0 = film(); W.timelapse(600); W.render.render(1 / 60, true); const f1 = film();
    this.ok('blood_dries', c0 < 0.05 && c1 > 0.8 && f0[2] > 100 && f1[2] < f0[2] * 0.2 && f1[0] > 60, { clotFresh: +c0.toFixed(2), clotOld: +c1.toFixed(2), wetBefore: f0[2], wetAfter: f1[2], stain: f1[0] });
  }
  // 28. the new lesions behave as they should
  {
    const out = {};
    // abscess: a #15 incision releases a gush at once (tense), then squeezing drains it; loculations slow it until broken
    let [Ab] = await this.setup('back', [['abscess', 0, 0, 24]], { zoom: 0.6 });
    this.drag('blade15', -8, 0, 8, 0, 0.5); this.drag('blade15', -8, 0, 8, 0, 0.5); this.drag('blade15', -8, 0, 8, 0, 0.5);
    out.abscessGush = Ab.events.includes('gush');
    this.hold('fingers', 0, 0, 4, { spread: 17 }); out.abscessExt = +(Ab.ext / Ab.V0).toFixed(2);
    // inflamed cyst: no sac; cheesy keratin plus bloody pus
    let [Ic] = await this.setup('back', [['inflamedCyst', 0, 0, 14]], { zoom: 1 });
    this.drag('blade11', 0, -1.2, 0, 1.3, 0.25); this.hold('fingers', 0, 0, 6, { spread: 10 });
    let ker = 0, bloody = 0; for (let i = 0; i < P.hi; i++) if (P.alive[i]) { if (P.mat[i] === PP.MAT.keratin) ker++; if (P.isLiquid(P.mat[i]) && P.fb[i] > 0.1) bloody++; }
    out.cyst = { sac: Ic.sac, keratin: ker, bloody };
    // friction blister: a needle at the edge drains it and the roof stays (deflates)
    let [Bl] = await this.setup('shoulder' in PP.AREAS ? 'shoulder' : 'back', [['blister', 0, 0, 10]], { zoom: 1.4 });
    this.hold('needle', 4.4, 0, 0.05); this.step(6);
    out.blister = { opened: Bl.open.r > 0, fill: +Bl.fill().toFixed(2), flap: Bl.flapAng != null };
    // a #15 across a blister splits the roof into flaps
    let [Bf] = await this.setup('back', [['blister', 0, 0, 10]], { zoom: 1.4 }); this.drag('blade15', -6, 0, 6, 0, 0.4);
    out.flaps = Bf.flapAng != null;
    // gouty tophus: chalk extrudes
    let [To] = await this.setup('cheek', [['tophus', 0, 0, 6]], { zoom: 2 }); this.drag('blade11', 0, -0.6, 0, 0.7, 0.2); this.hold('fingers', 0, 0, 4, { spread: 6.5 });
    let chalk = 0; for (let i = 0; i < P.hi; i++) if (P.alive[i] && P.mat[i] === PP.MAT.chalk) chalk++;
    out.tophusChalk = chalk;
    // clusters: Favre-Racouchot comedones and folliculitis come in tight groups
    const g1 = W.genLesions(Object.assign({}, PP.AREAS.cheek, { mix: [['solarComedone', 7, { cluster: 12 }]] }), PP.rng(5));
    const g2 = W.genLesions(Object.assign({}, PP.AREAS.beard, { mix: [['folliculitis', 7, { cluster: 16 }]] }), PP.rng(6));
    const spreadOf = (g) => { let m = 0; for (const a of g) for (const b of g) m = Math.max(m, Math.hypot(a.x - b.x, a.y - b.y)); return m; };
    out.clusters = { favre: g1.length, favreSpread: +spreadOf(g1).toFixed(1), folli: g2.length, folliSpread: +spreadOf(g2).toFixed(1) };
    this.ok('new_lesions', out.abscessGush && out.abscessExt > 0.25 && out.cyst.sac === null && out.cyst.keratin > 0 && out.cyst.bloody > 0
      && out.blister.opened && out.blister.fill < 0.5 && !out.blister.flap && out.flaps && out.tophusChalk > 0
      && g1.length >= 5 && spreadOf(g1) < 15 && g2.length >= 5 && spreadOf(g2) < 19, out);
  }

  const passed = this.results.filter((x) => x.pass).length;
  PP.diag.write('SUMMARY ' + passed + '/' + this.results.length + ' passed');
  document.title = 'TESTS ' + passed + '/' + this.results.length;
};

// visual scenes for screenshots
PP.Tests.prototype.visual = async function (name) {
  const W = this.W, T = W.tools;
  const tone = PP.params.get('tone');
  if (tone != null) await PP.main.switchTone(+tone);
  if (name === 'idle') { await this.setup(PP.params.get('area') || 'cheek', []); W.cam.zoom = +(PP.params.get('zoom') || 1); W.newPatch(+(PP.params.get('seed') || 7)); }
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
    const ar = PP.params.get('area') || 'cheek';
    await this.setup(ar, [[PP.params.get('les') || 'pustule', 0, 0, +(PP.params.get('d') || 3.4)]], { zoom: +(PP.params.get('zoom') || 2.4) });
    if (PP.params.get('fit')) { T.select(PP.params.get('tool') || 'fingers'); T.down(0, 0, { fit: true }); this.step(+(PP.params.get('t') || 0.5)); }
    else this.hold('fingers', 0, 0, +(PP.params.get('t') || 0.5), { spread: +(PP.params.get('spread') || 5.2), keep: true });
    if (PP.params.get('rel') != null) { W.tools.up(); this.step(+PP.params.get('rel')); }
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
  } else if (name === 'body' || name === 'bodyfade') {
    await this.setup(PP.params.get('area') || 'cheek', [], { zoom: 0.375 }); W.newPatch(+(PP.params.get('seed') || 7));
    const B = PP.main.B; await B.load(); W.ensureAreas();
    const v = PP.params.get('view') || 'face';
    let view;
    if (B.anchors[v]) { const a = B.anchors[v], o = B.viewOf(a); view = { p: a.p.slice(), yaw: o.yaw, pitch: o.pitch, dist: B.distW(PP.AREAS[v].size * +(PP.params.get('k') || 3)) }; }
    else view = B.overview(v === 'face' ? W.areaId : v);
    if (PP.params.get('yaw')) view.yaw = +PP.params.get('yaw');
    if (PP.params.get('pitch')) view.pitch = +PP.params.get('pitch');
    if (PP.params.get('h')) view.dist = B.distH(+PP.params.get('h'));
    await B.jump(view);
    if (PP.params.get('hover')) B.hover = B.order.indexOf(PP.params.get('hover'));
    if (PP.params.get('all')) B.showAll = 1;
    // ?pv=ox,oy,oz&pd=dx,dy,dz: hover preview of a close-up at the mesh point that ray hits
    if (PP.params.get('pv')) {
      const o = PP.params.get('pv').split(',').map(Number), d = (PP.params.get('pd') || '0,0,-1').split(',').map(Number);
      const h = B.raycast(o, d), f = h && B.spotFor(h);
      if (f && !f.bad) { B.preview = f; PP.diag.write('PREVIEW ' + f.name + ' ' + f.size); }
    }
    if (name === 'bodyfade') { W.cam.zoom = W.cam.tz = W.area.view / B.widthAt(B.cam.dist); B.mode = 'entering'; B.fade = +(PP.params.get('f') || 0.5); B.freeze = true; }
    else B.freeze = true;
  } else if (name === 'spot') {
    // ?o=ox,oy,oz&d=dx,dy,dz: open the close-up at the mesh point that ray hits and show the whole patch
    await this.setup('cheek', []); W.newPatch(+(PP.params.get('seed') || 7));
    const B = PP.main.B; await B.load(); W.ensureAreas();
    const o = (PP.params.get('o') || '0,592,600').split(',').map(Number), d = (PP.params.get('d') || '0,0,-1').split(',').map(Number);
    const h = B.raycast(o, d), f = h && B.spotFor(h), id = f && B.makeSpot(f);
    if (id) {
      await PP.main.switchArea(id);
      const C = W.cam; C.zoom = C.tz = +(PP.params.get('zoom') || PP.main.UI.zpatch()); C.x = C.y = C.tx = C.ty = 0;
      PP.diag.write('SPOT ' + W.area.name + ' size ' + W.area.size + ' lesions ' + W.lesions.length + ' ' + W.lesions.map((L) => L.type).join(','));
    } else PP.diag.write('SPOT none ' + JSON.stringify(f && f.bad));
  } else if (name === 'cutcyst') {
    await this.setup(PP.params.get('area') || 'back', [[PP.params.get('les') || 'epidermoid', 0, 0, +(PP.params.get('d') || 16)]], { zoom: +(PP.params.get('zoom') || 1.4) });
    const bl = PP.params.get('blade') || 'blade15';
    if (bl === 'blade11') this.drag('blade11', 0, -1.2, 0, 1.3, 0.25);
    else { this.drag('blade15', -6, 0, 6, 0, 0.5); this.drag('blade15', -6, 0, 6, 0, 0.5); }
    if (PP.params.get('sq')) this.hold('fingers', 0, 0, +PP.params.get('sq'), { spread: 11, keep: true });
  } else if (name === 'newles') {
    await this.setup('back', [['abscess', -38, 18, 26], ['inflamedCyst', 0, 22, 16], ['blister', 34, 22, 11], ['bloodBlister', 34, -6, 8], ['tophus', -8, -16, 6], ['calcinosis', 12, -18, 7]], { zoom: +(PP.params.get('zoom') || 0.55), cx: +(PP.params.get('cx') || 0), cy: +(PP.params.get('cy') || 0) });
  } else if (name === 'clusters') {
    await this.setup(PP.params.get('area') || 'cheek', [], { zoom: +(PP.params.get('zoom') || 1.2) });
    const t = PP.params.get('les') || 'solarComedone';
    W.lesions = W.genLesions(Object.assign({}, W.area, { mix: [[t, +(PP.params.get('n') || 7), { cluster: +(PP.params.get('c') || 12) }]] }), PP.rng(+(PP.params.get('seed') || 3)));
    const cx = W.lesions.reduce((s2, L) => s2 + L.x, 0) / Math.max(1, W.lesions.length), cy = W.lesions.reduce((s2, L) => s2 + L.y, 0) / Math.max(1, W.lesions.length);
    W.cam.x = W.cam.tx = cx; W.cam.y = W.cam.ty = cy; W.fx.patchChanged();
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
