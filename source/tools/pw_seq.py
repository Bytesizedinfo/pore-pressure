"""Drive the real UI: scroll out of the macro patch into the face view, hover and click an area, dive back in.
Usage: python -I pw_seq.py <out_prefix> [base_url]
"""
import sys, time
from playwright.sync_api import sync_playwright

pre = sys.argv[1]
base = sys.argv[2] if len(sys.argv) > 2 else "http://localhost:8765/index.html"
W, H = 1280, 800

def state(pg):
    return pg.evaluate("() => ({mode: PP.main.B.mode, fade: +PP.main.B.fade.toFixed(2), area: PP.main.W.areaId, zoom: +PP.main.W.cam.zoom.toFixed(3), "
                       "les: PP.main.W.lesions.length, hover: PP.main.B.hover, fps: +(PP.main.fps||0).toFixed(1)})")

def wait_mode(pg, modes, tmo=60):
    t0 = time.time()
    while time.time() - t0 < tmo:
        s = state(pg)
        if s["mode"] in modes:
            return s
        pg.wait_for_timeout(250)
    return state(pg)

with sync_playwright() as p:
    b = p.chromium.launch(channel="chrome", headless=True,
                          args=["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist", "--mute-audio"])
    pg = b.new_page(viewport={"width": W, "height": H}, device_scale_factor=1)
    logs = []
    pg.on("console", lambda m: logs.append(("console." + m.type, m.text)) if m.type in ("error", "warning") else None)
    pg.on("pageerror", lambda e: logs.append(("pageerror", str(e))))
    pg.goto(base + "?seed=7&area=cheek", wait_until="load")
    pg.wait_for_function("() => document.getElementById('loading').hidden", timeout=240000)
    pg.wait_for_timeout(1500)
    cx, cy = W // 2, H // 2 + 40
    pg.mouse.move(cx, cy)
    # scroll out to the whole patch, then past it
    for k in range(12):
        pg.mouse.wheel(0, 240); pg.wait_for_timeout(120)
    pg.wait_for_timeout(2500)
    print("after scroll-out", state(pg))
    pg.screenshot(path=pre + "1_patch.png", timeout=180000)
    for k in range(3):
        pg.mouse.wheel(0, 120); pg.wait_for_timeout(150)
    s = wait_mode(pg, ("body",), 90)
    print("entered", s)
    pg.wait_for_timeout(6000)
    pg.screenshot(path=pre + "2_face.png", timeout=180000)
    # hover the nose: find its screen position from the anchor
    pos = pg.evaluate("""() => { const B = PP.main.B; B.matrices(); const a = B.raycast([36, 598, 600], [0, 0, -1]).p, m = B.VP;
        const x = m[0]*a[0]+m[4]*a[1]+m[8]*a[2]+m[12], y = m[1]*a[0]+m[5]*a[1]+m[9]*a[2]+m[13], w = m[3]*a[0]+m[7]*a[1]+m[11]*a[2]+m[15];
        const r = B.R.canvas.getBoundingClientRect(); return [r.left + (x/w*0.5+0.5)*r.width, r.top + (0.5-y/w*0.5)*r.height]; }""")
    pg.mouse.move(pos[0] - 3, pos[1] - 3); pg.wait_for_timeout(300); pg.mouse.move(pos[0], pos[1]); pg.wait_for_timeout(2500)
    lab = pg.evaluate("() => { const e = document.getElementById('bodylabel'); return e.hidden ? '' : e.textContent; }")
    print("hover label:", lab, state(pg))
    pg.screenshot(path=pre + "3_hover.png", timeout=180000)
    t0 = time.time()
    pg.mouse.down(); pg.mouse.up(); pg.wait_for_timeout(1500)
    print("after click (should stay in 3D):", state(pg))
    for k in range(30):
        if state(pg)["mode"] != "body": break
        pg.mouse.wheel(0, -120); pg.wait_for_timeout(150)
    s = wait_mode(pg, ("leaving", "macro"), 120)
    print("diving->", s, "%.1fs" % (time.time() - t0))
    s = wait_mode(pg, ("macro",), 120)
    pg.wait_for_timeout(2500)
    print("back in macro", state(pg), pg.evaluate("() => PP.main.W.area.name"))
    pg.screenshot(path=pre + "4_nose.png", timeout=180000)
    # zoom back out with the - key and return to the cheek through the area menu
    for k in range(8):
        pg.keyboard.press("-"); pg.wait_for_timeout(200)
    s = wait_mode(pg, ("body",), 90); print("key zoom-out ->", s)
    pg.select_option("#area", "cheek")
    s = wait_mode(pg, ("macro",), 120); pg.wait_for_timeout(2000)
    print("menu dive cheek ->", state(pg))
    pg.screenshot(path=pre + "5_cheek.png", timeout=180000)
    for k, v in logs[:20]:
        print(k, ":", v[:300])
    b.close()
