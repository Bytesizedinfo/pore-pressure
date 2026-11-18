'use strict';
/* Boot + main loop. */
PP.main = {
  W: null, R: null, UI: null,
  async switchArea(id, quiet) {
    const W = this.W;
    W.setArea(id); W.setTone(W.toneIdx);
    await this.loadSets();
    if (this.UI) { this.UI.$('area').value = id; this.UI.renderTray(); }
    if (!quiet) { W.newPatch(Math.floor(Math.random() * 1e9)); if (this.UI) this.UI.sel = null; }
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
  R.render(1 / 60); mark('firstFrame');
  loading.hidden = true;
  if (PP.TEST) PP.diag.write('TIMING ' + JSON.stringify(tm));

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

  let fpsAcc = 0, fpsN = 0, lowered = false;
  function frame(now) {
    const fdt = Math.min(0.05, (now - last) / 1000);
    last = now;
    if (!frozen) {
      acc += fdt;
      let n = 0;
      while (acc >= dt && n < 6) { W.step(dt); acc -= dt; n++; }
      if (n === 6) acc = 0;
    }
    // camera shake on flinch
    const sh = W.cam.shake > 0 ? W.cam.shake * 0.6 : 0;
    const cx = W.cam.x, cy = W.cam.y;
    if (sh) { W.cam.x += (Math.random() - 0.5) * sh; W.cam.y += (Math.random() - 0.5) * sh; }
    R.render(fdt);
    if (sh) { W.cam.x = cx; W.cam.y = cy; }
    PP.main.UI.update(fdt);
    W.audio.vacuum(W.tools.id === 'vacuum' && W.tools.ptr.down, W.tools.vacLevel / 2);
    // auto-lower quality on slow GPUs
    if (!PP.TEST && !lowered) {
      fpsAcc += fdt; fpsN++;
      if (fpsN === 90) { if (fpsAcc / fpsN > 0.034 && PP.storage.get('quality', 'high') === 'high') { R.scale = Math.max(0.55, R.scale * 0.7); lowered = true; PP.main.UI.toast('', 'Lowered render resolution', 'This GPU was below ~30 fps. Change it in Settings.'); } fpsAcc = 0; fpsN = 0; }
    }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
})();
