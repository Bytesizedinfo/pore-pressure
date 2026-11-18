"""Assemble site/index.html from src/index.html + src/js/*.js (inlined; the artifact frame only allows inline scripts).
Usage: python -I build_site.py <src_dir> <site_dir>
"""
import sys, os, glob

src, site = sys.argv[1], sys.argv[2]
local = "--local" in sys.argv
tpl = open(os.path.join(src, "index.html"), encoding="utf-8").read()
parts = []
for f in sorted(glob.glob(os.path.join(src, "js", "*.js"))):
    code = open(f, encoding="utf-8").read()
    if "</script" in code:
        raise SystemExit("'</script' found in " + f)
    parts.append("/* ---- " + os.path.basename(f) + " ---- */\n" + code)
out = tpl.replace("/*__JS__*/", "\n".join(parts))
if local:
    out = '<meta charset="utf-8">\n' + out
if "--web" in sys.argv:
    # standalone website: a real document skeleton (the artifact host otherwise supplies its own)
    icon = ("data:image/svg+xml,%3Csvg xmlns=%27http://www.w3.org/2000/svg%27 viewBox=%270 0 32 32%27%3E"
            "%3Cpath d=%27M16 3C16 3 6 15 6 21a10 10 0 0 0 20 0C26 15 16 3 16 3z%27 fill=%27%238f82f2%27/%3E%3C/svg%3E")
    head = ('<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n'
            '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n'
            '<meta name="description" content="Macro skin built from real photographs, with physics-based popping, '
            'cutting and extraction across 21 lesion types and 18 clinical instruments.">\n'
            '<link rel="icon" href="' + icon + '">\n')
    out = head + out + '\n</html>\n'
os.makedirs(site, exist_ok=True)
with open(os.path.join(site, "index.html"), "w", encoding="utf-8", newline="\n") as fh:
    fh.write(out)
print("index.html", len(out.encode("utf-8")), "bytes")
