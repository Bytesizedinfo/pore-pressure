"""Drive installed Chrome headlessly (SwiftShader WebGL2) to screenshot a scenario and print the diag panel.
Usage: python -I pw.py "<query>" <out.png> [width] [height] [timeout_s]
"""
import sys, time
from playwright.sync_api import sync_playwright

q, out = sys.argv[1], sys.argv[2]
w = int(sys.argv[3]) if len(sys.argv) > 3 else 1280
h = int(sys.argv[4]) if len(sys.argv) > 4 else 800
tmo = float(sys.argv[5]) if len(sys.argv) > 5 else 240
url = "http://localhost:8765/index.html?" + q

with sync_playwright() as p:
    b = p.chromium.launch(channel="chrome", headless=True,
                          args=["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist", "--mute-audio"])
    pg = b.new_page(viewport={"width": w, "height": h}, device_scale_factor=1)
    logs = []
    pg.on("console", lambda m: logs.append(("console." + m.type, m.text)) if m.type in ("error", "warning") else None)
    pg.on("pageerror", lambda e: logs.append(("pageerror", str(e))))
    t0 = time.time()
    pg.goto(url, wait_until="load")
    try:
        pg.wait_for_function("() => { const d = document.getElementById('diag'); return d && /RENDER ok|SUMMARY|ERROR/.test(d.textContent || ''); }", timeout=tmo * 1000)
    except Exception as e:
        logs.append(("timeout", str(e)[:200]))
    pg.wait_for_timeout(1500)
    pg.screenshot(path=out, timeout=180000, animations="disabled")
    diag = pg.evaluate("() => (document.getElementById('diag')||{}).textContent || ''")
    print("TIME %.1fs" % (time.time() - t0))
    print("DIAG:\n" + diag[:9000])
    for k, v in logs[:20]:
        print(k, ":", v[:400])
    b.close()
