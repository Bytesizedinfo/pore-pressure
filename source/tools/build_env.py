"""Convert a Radiance .hdr studio HDRI into a compact lighting package.

Usage: python -I build_env.py <in.hdr> <out_dir> <review.jpg> [yaw_deg]

Outputs
  env.bin   : float16 RGBA equirect radiance, 256x128 (the renderer GGX-prefilters it on the GPU)
  env.json  : SH9 irradiance coefficients (RGB), dominant light direction + colour, intensity scale
"""
import sys, os, json, re
import numpy as np
from PIL import Image

src, out_dir, review = sys.argv[1], sys.argv[2], sys.argv[3]
yaw = float(sys.argv[4]) if len(sys.argv) > 4 else 0.0
os.makedirs(out_dir, exist_ok=True)


def read_hdr(path):
    with open(path, "rb") as f:
        data = f.read()
    pos = 0
    # header
    while True:
        e = data.index(b"\n", pos)
        line = data[pos:e]
        pos = e + 1
        if line.strip() == b"":
            break
    e = data.index(b"\n", pos)
    res = data[pos:e].decode()
    pos = e + 1
    m = re.match(r"-Y (\d+) \+X (\d+)", res)
    H, W = int(m.group(1)), int(m.group(2))
    img = np.zeros((H, W, 4), np.uint8)
    buf = np.frombuffer(data, np.uint8)
    for y in range(H):
        if int(buf[pos]) == 2 and int(buf[pos + 1]) == 2 and ((int(buf[pos + 2]) << 8) | int(buf[pos + 3])) == W:
            pos += 4
            for c in range(4):
                x = 0
                row = img[y, :, c]
                while x < W:
                    n = int(buf[pos]); pos += 1
                    if n > 128:
                        n -= 128
                        row[x:x + n] = buf[pos]; pos += 1
                    else:
                        row[x:x + n] = buf[pos:pos + n]; pos += n
                    x += n
        else:  # flat
            img[y] = buf[pos:pos + W * 4].reshape(W, 4)
            pos += W * 4
    e = img[..., 3].astype(np.int32)
    f = np.where(e > 0, np.ldexp(1.0, e - 136), 0.0)
    return img[..., :3].astype(np.float32) * f[..., None].astype(np.float32)


rad = read_hdr(src)
H, W, _ = rad.shape
if yaw:
    rad = np.roll(rad, int(round(yaw / 360.0 * W)), axis=1)

# downsample to 256x128 (box filter keeps energy)
def down(a, w, h):
    H, W, C = a.shape
    return a.reshape(h, H // h, w, W // w, C).mean(axis=(1, 3))

small = down(rad, 256, 128)

# directions for equirect pixels (y up, -z forward); theta from +y
h, w = small.shape[:2]
v = (np.arange(h) + 0.5) / h
u = (np.arange(w) + 0.5) / w
th = v * np.pi
ph = u * 2 * np.pi
sinT = np.sin(th)[:, None]
dx = sinT * np.sin(ph)[None, :]
dy = np.cos(th)[:, None] * np.ones((1, w))
dz = -sinT * np.cos(ph)[None, :]
dA = (np.pi / h) * (2 * np.pi / w) * sinT * np.ones((1, w))

# SH9 projection
Y = [0.282095 * np.ones_like(dx), 0.488603 * dy, 0.488603 * dz, 0.488603 * dx,
     1.092548 * dx * dy, 1.092548 * dy * dz, 0.315392 * (3 * dz * dz - 1), 1.092548 * dx * dz,
     0.546274 * (dx * dx - dy * dy)]
sh = np.array([[np.sum(small[..., c] * Yi * dA) for c in range(3)] for Yi in Y])

# dominant light (brightest smoothed region)
lum = small @ np.array([0.2126, 0.7152, 0.0722])
idx = np.unravel_index(np.argmax(lum * sinT), lum.shape)
ldir = [float(dx[idx]), float(dy[idx]), float(dz[idx])]
lcol = small[idx].tolist()

rgba = np.concatenate([small, np.ones((h, w, 1), np.float32)], -1).astype(np.float16)
rgba.tofile(os.path.join(out_dir, "env.bin"))
json.dump({"width": w, "height": h, "sh9": sh.tolist(), "key_dir": ldir, "key_col": lcol,
           "mean_lum": float((lum * dA).sum() / dA.sum()), "source": os.path.basename(src), "yaw": yaw},
          open(os.path.join(out_dir, "env.json"), "w"), indent=1)

# review: tonemapped equirect
tm = small / (1 + small)
tm = np.clip(tm ** (1 / 2.2), 0, 1)
Image.fromarray((tm * 255).astype(np.uint8)).resize((768, 384), Image.NEAREST).save(review, quality=90)
print("ok", H, W, "key", ldir, "lum", float(lum.max()))
