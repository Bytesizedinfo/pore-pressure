"""Build physically meaningful skin maps from real macro photographs.

Usage: python -I build_textures.py <assets_src_dir> <out_tex_dir> <review_dir>

Per texture set this produces
  <name>_chromo.webp : R = melanin density (normalised), G = hemoglobin density (normalised),
                       B = achromatic detail (shading/brightness high-pass, normalised)
  <name>_hgt.png     : R = micro-relief height (0..1 -> 0..height_mm), G = pore mask, B = furrow mask
and a manifest.json with scales and statistics.

Steps (see plan section 5):
  crop -> glint removal -> de-lighting -> Moisan periodic+smooth (seamless)
  -> optical-density chromophore decomposition (Tsumura et al. 2003 style, fixed absorption vectors)
  -> height from Hessian furrows + LoG pores + high-pass shading.
"""
import sys, os, json
import numpy as np
from PIL import Image
from scipy import ndimage

SRC, OUT, REV = sys.argv[1], sys.argv[2], sys.argv[3]
os.makedirs(OUT, exist_ok=True)
os.makedirs(REV, exist_ok=True)

# name, file, crop box (x, y, size), output px, source mm/px (estimated from pore / follicle spacing),
# relief height range in mm, pore radius (mm), furrow width (mm)
SETS = [
    dict(name="cheek", file="pexels_7479574.jpg", crop=(2560, 2400, 1280), out=1024, mmpx=0.013,
         hmm=0.10, pore_mm=0.07, furrow_mm=0.05, delight_mm=3.0),
    dict(name="nose", file="pexels_7479592.jpg", crop=(1250, 820, 1000), out=1024, mmpx=0.011,
         hmm=0.12, pore_mm=0.08, furrow_mm=0.05, delight_mm=3.0),
    dict(name="deep", file="pexels_7479507.jpg", crop=(800, 1500, 1000), out=1024, mmpx=0.016,
         hmm=0.10, pore_mm=0.07, furrow_mm=0.05, delight_mm=3.0),
    dict(name="body", file="pexels_4046567.jpg", crop=(700, 1400, 3200), out=2048, mmpx=0.0035,
         hmm=0.09, pore_mm=0.05, furrow_mm=0.035, delight_mm=2.5),
]

# Absorption directions in optical-density (OD = -ln reflectance) space for sRGB-ish bands
# R~620nm, G~540nm, B~460nm.
#  melanin: mu_a ~ lambda^-3.46 (Jacques)  -> (1, 1.61, 2.81)
#  hemoglobin (HbO2, Prahl extinction, path-length corrected for red): ~(0.10, 0.85, 0.52)
VM = np.array([1.0, 1.61, 2.81]); VM /= np.linalg.norm(VM)
VH = np.array([0.10, 0.85, 0.52]); VH /= np.linalg.norm(VH)
VS = np.ones(3) / np.sqrt(3.0)
BASIS = np.stack([VM, VH, VS], 1)          # columns
BINV = np.linalg.inv(BASIS)


def srgb_to_lin(c):
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)


def lin_to_srgb(c):
    c = np.clip(c, 0, 1)
    return np.where(c <= 0.0031308, c * 12.92, 1.055 * c ** (1 / 2.4) - 0.055)


def lum(x):
    return x @ np.array([0.2126, 0.7152, 0.0722], np.float32)


def remove_glints(lin, size):
    """Inpaint specular glints: bright, low-saturation outliers vs local median."""
    L = lum(lin)
    med = ndimage.median_filter(L, size=size)
    resid = L - med
    sd = np.sqrt(ndimage.uniform_filter(resid ** 2, size * 4)) + 1e-4
    mx = lin.max(-1); mn = lin.min(-1)
    sat = (mx - mn) / (mx + 1e-4)
    satmed = ndimage.median_filter(sat, size=size)
    mask = (resid > 1.6 * sd) & (resid > 0.015) & (sat < satmed * 0.98)
    mask = ndimage.binary_dilation(mask, iterations=max(1, size // 6))
    m = ndimage.gaussian_filter(mask.astype(np.float32), max(0.8, size / 8))
    m = np.clip(m * 1.5, 0, 1)
    fill = np.stack([ndimage.median_filter(lin[..., c], size=size * 2 + 1) for c in range(3)], -1)
    return lin * (1 - m[..., None]) + fill * m[..., None], float(mask.mean())


def delight(lin, sigma):
    """Remove low-frequency illumination (keeps chroma ratios)."""
    L = lum(lin)
    Lb = ndimage.gaussian_filter(L, sigma, mode="reflect")
    return lin * (L.mean() / np.maximum(Lb, 1e-4))[..., None]


def periodic(u):
    """Moisan periodic + smooth decomposition: returns the periodic component."""
    M, N = u.shape
    v = np.zeros_like(u, dtype=np.float64)
    v[0, :] += u[-1, :] - u[0, :]
    v[-1, :] += u[0, :] - u[-1, :]
    v[:, 0] += u[:, -1] - u[:, 0]
    v[:, -1] += u[:, 0] - u[:, -1]
    q = np.arange(M).reshape(M, 1)
    r = np.arange(N).reshape(1, N)
    den = 2 * np.cos(2 * np.pi * q / M) + 2 * np.cos(2 * np.pi * r / N) - 4
    den[0, 0] = 1
    sh = np.fft.fft2(v) / den
    sh[0, 0] = 0
    s = np.real(np.fft.ifft2(sh))
    return (u - s).astype(np.float32)


def gblur_wrap(x, s):
    return ndimage.gaussian_filter(x, s, mode="wrap")


def hessian_valley(x, s):
    """Strength of dark-line (valley in reflectance == ridge in OD) structures at scale s."""
    xx = ndimage.gaussian_filter(x, s, order=(0, 2), mode="wrap")
    yy = ndimage.gaussian_filter(x, s, order=(2, 0), mode="wrap")
    xy = ndimage.gaussian_filter(x, s, order=(1, 1), mode="wrap")
    tmp = np.sqrt(((xx - yy) * 0.5) ** 2 + xy ** 2)
    l1 = (xx + yy) * 0.5 + tmp
    l2 = (xx + yy) * 0.5 - tmp   # most negative = bright ridge in x (x is OD -> dark line in photo)
    ridge = np.where(np.abs(l2) > np.abs(l1), -l2, 0)
    return np.clip(ridge * s * s, 0, None)


def norm01(x, lo=1.0, hi=99.0):
    a, b = np.percentile(x, lo), np.percentile(x, hi)
    return np.clip((x - a) / (b - a + 1e-9), 0, 1)


ONLY = set(sys.argv[4:])
manifest = {"basis": {"melanin": VM.tolist(), "hemoglobin": VH.tolist(), "shade": VS.tolist()}, "sets": {}}

_mp = os.path.join(OUT, "manifest.json")
if ONLY and os.path.exists(_mp):
    manifest = json.load(open(_mp))
for S in SETS:
    if ONLY and S["name"] not in ONLY:
        continue
    x, y, sz = S["crop"]
    im = Image.open(os.path.join(SRC, S["file"])).convert("RGB").crop((x, y, x + sz, y + sz))
    im = im.resize((S["out"], S["out"]), Image.LANCZOS)
    mmpx = S["mmpx"] * sz / S["out"]
    lin = srgb_to_lin(np.asarray(im, np.float32) / 255.0)

    glint_px = max(5, int(round(0.10 / mmpx)) | 1)
    lin, gfrac = remove_glints(lin, glint_px)
    lin = delight(lin, S["delight_mm"] / mmpx)
    lin = np.stack([periodic(lin[..., c]) for c in range(3)], -1)
    lin = np.clip(lin, 1e-3, 1)

    # photographic high-frequency detail: multiplicative ratio to the 0.8 mm blur (pores, flakes, furrow shading)
    dsig = 0.8 / mmpx
    det = lin / np.maximum(np.stack([gblur_wrap(lin[..., c], dsig) for c in range(3)], -1), 1e-3)
    det = np.clip(det, 0.25, 1.95)
    Image.fromarray((np.clip(det / 2.0, 0, 1) * 255 + 0.5).astype(np.uint8)).save(
        os.path.join(OUT, f"{S['name']}_detail.webp"), quality=95, method=6)

    OD = -np.log(lin)
    coef = OD @ BINV.T                       # (..., 3): melanin, hemoglobin, shade
    m, h, s = coef[..., 0], coef[..., 1], coef[..., 2]
    stats = {k: [float(v.mean()), float(v.std())] for k, v in (("m", m), ("h", h), ("s", s))}

    # achromatic high-pass (shading + grey albedo detail)
    s_hp = s - gblur_wrap(s, 0.6 / mmpx)

    # height: pores (LoG blobs, dark in photo -> high OD) + furrows (Hessian) + fine shading
    sp = S["pore_mm"] / mmpx
    pore = -ndimage.gaussian_laplace(s, sp, mode="wrap") * sp * sp
    pore = norm01(np.clip(pore, 0, None), 50, 99.7)
    pore = np.where(pore > 0.25, pore, pore * 0.3)
    fw = S["furrow_mm"] / mmpx
    fur = hessian_valley(s, fw) + 0.6 * hessian_valley(s, fw * 2.0)
    fur = norm01(fur, 40, 99.5)
    fine = norm01(-(s - gblur_wrap(s, 0.15 / mmpx)), 1, 99)
    hgt = 0.55 + 0.25 * (fine - 0.5) - 0.45 * fur - 0.55 * pore
    hgt = gblur_wrap(hgt, 0.6)
    hgt = norm01(hgt, 0.5, 99.5)

    # keep fine pigment detail (pores, freckles); keep only 35% of mm-scale mottling (mostly de-lighting residue)
    sig = 1.0 / mmpx
    mb, hb = gblur_wrap(m, sig), gblur_wrap(h, sig)
    m = (m - mb) + 0.35 * (mb - m.mean()) + m.mean()
    h = (h - hb) + 0.35 * (hb - h.mean()) + h.mean()
    stats["m"][1] = float(m.std()); stats["h"][1] = float(h.std())

    def enc(v, k=3.0):
        return np.clip(v / k * 0.5 + 0.5, 0, 1)

    chromo = np.stack([enc((m - stats["m"][0]) / (stats["m"][1] + 1e-6)),
                       enc((h - stats["h"][0]) / (stats["h"][1] + 1e-6)),
                       enc(s_hp / (s_hp.std() + 1e-6))], -1)
    Image.fromarray((chromo * 255 + 0.5).astype(np.uint8)).save(
        os.path.join(OUT, f"{S['name']}_chromo.webp"), quality=94, method=6)
    hg = np.stack([hgt, pore, fur], -1)
    Image.fromarray((hg * 255 + 0.5).astype(np.uint8)).save(os.path.join(OUT, f"{S['name']}_hgt.png"), optimize=True)

    manifest["sets"][S["name"]] = {
        "size_px": S["out"], "mm_per_px": mmpx, "tile_mm": mmpx * S["out"], "height_mm": S["hmm"],
        "stats": stats, "s_hp_std": float(s_hp.std()), "glint_fraction": gfrac,
        "source": S["file"],
    }

    # --- review sheet: original crop | de-lit periodic | albedo from m,h only | height | pores | furrows
    rec = np.exp(-(m[..., None] * VM + h[..., None] * VH + stats["s"][0] * VS))
    tiles = [np.asarray(im, np.float32) / 255.0, lin_to_srgb(lin), lin_to_srgb(rec),
             np.repeat(hgt[..., None], 3, -1), np.repeat(pore[..., None], 3, -1), np.repeat(fur[..., None], 3, -1)]
    tw = 340
    sheet = Image.new("RGB", (tw * 3, tw * 2))
    for i, t in enumerate(tiles):
        ti = Image.fromarray((np.clip(t, 0, 1) * 255).astype(np.uint8)).resize((tw, tw), Image.LANCZOS)
        sheet.paste(ti, ((i % 3) * tw, (i // 3) * tw))
    sheet.save(os.path.join(REV, f"review_{S['name']}.jpg"), quality=88)
    # 1:1 detail of the de-lit albedo (centre 400px)
    c = S["out"] // 2
    det = lin_to_srgb(rec[c - 200:c + 200, c - 200:c + 200])
    Image.fromarray((det * 255).astype(np.uint8)).save(os.path.join(REV, f"detail_{S['name']}.jpg"), quality=90)
    print(S["name"], "mm/px %.4f tile %.1fmm glint %.3f" % (mmpx, mmpx * S["out"], gfrac), stats)

with open(os.path.join(OUT, "manifest.json"), "w") as f:
    json.dump(manifest, f, indent=1)
print("ok")
