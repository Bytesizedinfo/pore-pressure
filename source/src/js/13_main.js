'use strict';
/* Boot + main loop. */
PP.main = {
  W: null, R: null, UI: null,
  // switch the macro view to another area, keeping every area's state (blemishes, wounds, films)
  async switchArea(id) {
    const W = this.W;
    if (id === W.areaId && W.lesions) { if (this.UI) this.UI.$('area').value = id; return; }
    W.switching = true;
    W.tools.up(); W.tools.ptr.down = false;
    W.ensureAreas(); W.stashArea();
    W.setArea(id); W.setTone(W.toneIdx);
    try { await this.loadSets(); } finally { W.restoreArea(); W.switching = false; }
    if (this.UI) { this.UI.$('area').value = id; this.UI.renderTray(); this.UI.sel = null; }
  },
  async switchTone(i) {
    const W = this.W;
    W.setTone(i);
    await this.loadSets();
  },
  async loadSets() {
    const W = this.W, R = this.R, A = W.area;
    const name = W.toneIdx >= 4 ? A.deepSet : A.set;
    const [cur, det] = await Promise.all([R.loadSet(name), R.loadSet('body')]);
    W.curSet = cur; W.detSet = det;
    // deep-tone and fair photos were normalised to their own statistics; nothing else to change here
  },
};

(async function boot() {
  const loading = document.getElementById('loading');
  const fail = (msg) => { loading.textContent = msg; loading.style.textTransform = 'none'; loading.style.letterSpacing = '0'; loading.style.padding = '24px'; loading.style.textAlign = 'center'; PP.diag.error(msg); };
  let W, R;
  try {
    W = new PP.World();
    R = new PP.Renderer(document.getElementById('gl'), W);
    W.render = R;
    PP.main.B = new PP.Body(R, W);
  } catch (e) {
    fail('This simulator needs WebGL2 with float render targets. ' + (e.message || e));
    return;
  }
  PP.main.W = W; PP.main.R = R;
  const tm = {}; const T0 = performance.now(); const mark = (k) => { tm[k] = Math.round(performance.now() - T0); };
  const say = (t) => { loading.textContent = t; };
  try {
    // start every download now; the GPU compiles shaders in parallel
    say('Downloading skin scans…');
    R.prefetchEnv();
    W.manifest = await fetch('tex/manifest.json').then((r) => { if (!r.ok) throw new Error('manifest ' + r.status); return r.json(); });
    W.setArea(W.areaId); W.setTone(W.toneIdx);
    const A = W.area; R.prefetchSet(W.toneIdx >= 4 ? A.deepSet : A.set); R.prefetchSet('body');
    mark('manifest');
    await R.G.finishAll(); mark('shaders');
    say('Preparing studio lighting…');
    await R.loadEnv(); mark('env');
    say('Building skin maps…');
    await PP.main.loadSets(); mark('sets');
  } catch (e) {
    fail('Could not load the skin scans: ' + (e.message || e));
    return;
  }
  R.resize();
  PP.main.UI = new PP.UI(W);
  W.newPatch(W.seed);
  R.warm(); mark('firstFrame');
  loading.hidden = true;
  if (PP.TEST) PP.diag.write('TIMING ' + JSON.stringify(tm));
  const B = PP.main.B;
  // after the first frame: fetch the face model and the other areas' scans, and draw the face once offscreen
  // so its shaders are fully compiled before the first zoom-out
  setTimeout(() => {
    for (const n of ['deep', 'nose', 'body']) R.loadSet(n).catch(() => {});
    B.load().then(() => { W.ensureAreas(); B.matrices(); B.render(); }).catch(() => {});
  }, PP.TEST ? 0 : 400);

  const dt = 1 / 120;
  let acc = 0, last = performance.now(), frozen = false;
  const origBuild = R.buildInstances.bind(R);
  R.buildInstances = function () {
    let n = origBuild();
    if (W._frozenPrims) { this.instData.set(W._frozenPrims, n * 16); n += W._frozenPrims.length / 16; }
    return n;
  };

  if (PP.TEST) {
    const tests = new PP.Tests(W);
    try {
      if (PP.TEST === 'all') { await tests.all(); }
      else await tests.visual(PP.TEST);
    } catch (e) { PP.diag.error('Test crashed: ' + (e.stack || e.message || e)); }
    frozen = true;
    PP.main.UI.update(0.3);
    PP.diag.write('RENDER ok ' + R.w + 'x' + R.h + ' particles=' + W.parts.count + ' lesions=' + W.lesions.length);
  }

  // Render on demand + dynamic resolution. While anything moves, render every frame and adapt the
  // internal resolution to hold ~60 fps (GPU timer when available). When everything is still, render a
  // full-resolution frame a few times a second (slow changes like redness fading) and re-present it otherwise.
  let goodN = 0, idleT = 9, lastFull = 0, pc = { x: NaN, y: NaN, z: NaN, w: 0, h: 0 };
  function frame(now) {
    const fdt = Math.min(0.05, (now - last) / 1000);
    last = now;
    PP.main.fps = PP.lerp(PP.main.fps || 60, 1 / Math.max(fdt, 1e-3), 0.05);
    if (!frozen) {
      acc += fdt;
      let n = 0;
      while (acc >= dt && n < 3) { W.step(dt); acc -= dt; n++; }
      if (n === 3) acc = 0;   // never snowball: a slow frame just runs the sim slower
      if (B.mode === 'macro') PP.main.UI.easeCamera(fdt);
    }
    const bMoved = B.update(fdt);
    if (W.switching) { R.present(); requestAnimationFrame(frame); return; }
    if (B.mode !== 'macro') {
      // face / body view; during a crossfade both views render and the body is blended over the macro composite
      if (B.fade < 1) { R.presentTex = null; R.onComposite = () => B.blendInto(); R.render(fdt); R.onComposite = null; }
      else {
        if (bMoved || B.dirty || frozen) B.render();
        R.presentTex = B.rt ? B.rt.texs[0] : null; R.present();
      }
      PP.main.UI.update(fdt);
      W.audio.vacuum(false, 0);
      requestAnimationFrame(frame);
      return;
    }
    R.presentTex = null;
    const C = W.cam;
    const camMoved = C.x !== pc.x || C.y !== pc.y || C.zoom !== pc.z || R.canvas.clientWidth !== pc.w || R.canvas.clientHeight !== pc.h;
    pc.x = C.x; pc.y = C.y; pc.z = C.zoom; pc.w = R.canvas.clientWidth; pc.h = R.canvas.clientHeight;
    const active = frozen || camMoved || W.phys.contacts.length > 0 || W.phys.ghosts.length > 0 || W.parts.moving || R.drops.length > 0 || R.brushes.length > 0 ||
      W.cam.shake > 0 || W.time < (W.activeUntil || 0) || W.tools.ptr.down;
    // camera shake on flinch
    const sh = W.cam.shake > 0 ? W.cam.shake * 0.6 : 0;
    const cx = C.x, cy = C.y;
    if (sh) { C.x += (Math.random() - 0.5) * sh; C.y += (Math.random() - 0.5) * sh; }
    if (active) {
      R.render(fdt);
      idleT = 0;
      if (PP.TEST) { R.dyn = +(PP.params.get('dyn') || 1); }
      else {
      const ms = R.gpuMs != null ? R.gpuMs : fdt * 1000;
      if (ms > 17.5) { R.dyn = Math.max(0.5, (R.dyn || 1) * 0.9); goodN = 0; }
      else if (ms < (R.gpuMs != null ? 11 : 17.4) && ++goodN > 25) { R.dyn = Math.min(1, (R.dyn || 1) + 0.05); goodN = 0; }
      }
    } else {
      idleT += fdt;
      if (idleT > 0.2 && now - lastFull > 250) { R.render(fdt); lastFull = now; }
      else R.present();
    }
    if (sh) { C.x = cx; C.y = cy; }
    PP.main.UI.update(fdt);
    W.audio.vacuum(W.tools.id === 'vacuum' && W.tools.ptr.down, W.tools.vacLevel / 2);
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
})();
