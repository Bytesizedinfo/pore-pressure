import sys, json
from playwright.sync_api import sync_playwright
with sync_playwright() as p:
    b = p.chromium.launch(channel="chrome", headless=True, args=["--use-angle=swiftshader","--enable-unsafe-swiftshader","--ignore-gpu-blocklist","--mute-audio"])
    pg = b.new_page(viewport={"width":1280,"height":800})
    errs=[]; pg.on("pageerror", lambda e: errs.append(str(e)))
    pg.goto("http://localhost:8765/index.html?seed=11", wait_until="load")
    pg.wait_for_function("() => PP.main && PP.main.UI && document.getElementById('loading').hidden", timeout=120000)
    res = pg.evaluate("""() => {
      const W = PP.main.W, T = W.tools, out = {};
      const L = W.lesions.find(l => l.type !== 'filament') || {x:0,y:0};
      for (const id of ['fingers','loop','vacuum','needle','gauze']) {
        T.select(id); T.ptr.x = L.x; T.ptr.y = L.y; T.down(L.x, L.y);
        for (let i = 0; i < 5; i++) W.step(1/120);
        let t = performance.now(); for (let i = 0; i < 30; i++) W.step(1/120); const step = (performance.now() - t) / 30;
        const C = W.phys.contacts.length;
        t = performance.now(); for (let i = 0; i < 30; i++) W.buildHeightGrid(); const grid = (performance.now() - t) / 30;
        T.up(); for (let i = 0; i < 5; i++) W.step(1/120);
        out[id] = {stepMs: +step.toFixed(2), gridMs: +grid.toFixed(2), contacts: C};
      }
      let t = performance.now(); for (let i = 0; i < 30; i++) W.step(1/120); out.idleStepMs = +((performance.now()-t)/30).toFixed(2);
      // erase + zoom checks
      const n0 = W.lesions.length; PP.main.UI.setErase(true); PP.main.UI.eraseAt(L.x, L.y); PP.main.UI.setErase(false);
      out.erase = n0 + ' -> ' + W.lesions.length;
      PP.main.UI.zoomBy(0.01); out.minZoom = W.cam.zoom.toFixed(3) + ' view ' + W.cam.vw.toFixed(1) + ' mm of ' + W.area.size;
      return out; }""")
    print(json.dumps(res, indent=1)); print(errs[:3]); b.close()
