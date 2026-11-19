"""Build a head-and-shoulders bust from the MakeHuman base mesh (CC0 1.0, makehumancommunity/makehuman).
Usage: python -I build_body.py <base.obj> <out.json>
Output (mm, y up, face toward +z): base64 float32 positions/normals, uint32 indices, eye index range,
and per-area anchors (surface point, normal, tangent, bitangent) found by ray casting.
"""
import sys, json, base64
import numpy as np

src, out = sys.argv[1], sys.argv[2]
V, F, G = [], [], []
grp = None
for line in open(src):
    if line.startswith('v '):
        V.append([float(x) for x in line.split()[1:4]])
    elif line.startswith('g '):
        grp = line.split()[1]
    elif line.startswith('f ') and grp in ('body', 'helper-l-eye', 'helper-r-eye'):
        F.append([int(t.split('/')[0]) - 1 for t in line.split()[1:]])
        G.append(grp)
V = np.array(V, np.float64) * 100.0           # decimetres -> mm
F = np.array(F, np.int64); G = np.array(G)
ytop = V[:, 1].max()

# crop to a bust: above the chest in front, to mid-back behind, without the arms
def keep_face(f):
    p = V[f]
    z = p[:, 2].mean()
    ycut = ytop - (415 + 55 * np.tanh(-z / 40.0))
    return p[:, 1].min() > ycut and np.abs(p[:, 0]).max() < 215
body = np.array([g == 'body' and keep_face(f) for f, g in zip(F, G)])
eyes = G != 'body'
Fb, Fe = F[body], F[eyes]

def catmull_clark(P, Q):
    """One Catmull-Clark step on a quad mesh with boundaries. P: (n,3), Q: (m,4)."""
    m = len(Q)
    fp = P[Q].mean(1)
    edges = {}
    for fi, q in enumerate(Q):
        for k in range(4):
            a, b = int(q[k]), int(q[(k + 1) % 4])
            key = (a, b) if a < b else (b, a)
            edges.setdefault(key, []).append(fi)
    ekeys = list(edges.keys())
    eidx = {k: i for i, k in enumerate(ekeys)}
    ep = np.zeros((len(ekeys), 3))
    vf_sum = np.zeros_like(P); vf_n = np.zeros(len(P))
    ve_sum = np.zeros_like(P); ve_n = np.zeros(len(P))
    boundary = np.zeros(len(P), bool); bnb = np.zeros_like(P); bnn = np.zeros(len(P))
    for i, (a, b) in enumerate(ekeys):
        fs = edges[(a, b)]
        mid = (P[a] + P[b]) / 2
        if len(fs) == 2:
            ep[i] = (P[a] + P[b] + fp[fs[0]] + fp[fs[1]]) / 4
        else:
            ep[i] = mid
            boundary[a] = boundary[b] = True
            bnb[a] += P[b]; bnb[b] += P[a]; bnn[a] += 1; bnn[b] += 1
        for v in (a, b):
            ve_sum[v] += mid; ve_n[v] += 1
    for fi, q in enumerate(Q):
        for v in q:
            vf_sum[v] += fp[fi]; vf_n[v] += 1
    NP = P.copy()
    for v in range(len(P)):
        if vf_n[v] == 0:
            continue
        if boundary[v] and bnn[v] >= 2:
            NP[v] = 0.75 * P[v] + 0.25 * bnb[v] / bnn[v]
        elif not boundary[v]:
            n = vf_n[v]
            NP[v] = (vf_sum[v] / n + 2 * ve_sum[v] / ve_n[v] + (n - 3) * P[v]) / n
    nv = len(P)
    allP = np.vstack([NP, ep, fp])
    E0, F0 = nv, nv + len(ekeys)
    Q2 = []
    for fi, q in enumerate(Q):
        e = [eidx[(min(int(q[k]), int(q[(k + 1) % 4])), max(int(q[k]), int(q[(k + 1) % 4])))] + E0 for k in range(4)]
        c = F0 + fi
        for k in range(4):
            Q2.append([int(q[k]), e[k], c, e[(k - 1) % 4]])
    return allP, np.array(Q2)

def compact(P, Q):
    used = np.unique(Q)
    remap = -np.ones(len(P), np.int64); remap[used] = np.arange(len(used))
    return P[used], remap[Q]

Pb, Qb = compact(V, Fb)
Pb, Qb = catmull_clark(Pb, Qb)
Pb, Qb = compact(Pb, Qb)
Pe, Qe = compact(V, Fe)
Pe, Qe = catmull_clark(Pe, Qe)
Pe, Qe = compact(Pe, Qe)

def tris(Q):
    return np.concatenate([Q[:, [0, 1, 2]], Q[:, [0, 2, 3]]])
Tb, Te = tris(Qb), tris(Qe) + len(Pb)
P = np.vstack([Pb, Pe]); T = np.vstack([Tb, Te])
# vertex normals (area weighted); flip so they point outward
fn = np.cross(P[T[:, 1]] - P[T[:, 0]], P[T[:, 2]] - P[T[:, 0]])
N = np.zeros_like(P)
for k in range(3):
    np.add.at(N, T[:, k], fn)
N /= np.linalg.norm(N, axis=1, keepdims=True) + 1e-12
cen = Pb.mean(0)
if np.mean(np.sum((Pb - cen) * N[:len(Pb)], 1)) < 0:
    N = -N; T = T[:, [0, 2, 1]]

# ray casting for anchors (Moller-Trumbore, vectorised over body triangles)
A0, A1, A2 = P[Tb[:, 0]], P[Tb[:, 1]], P[Tb[:, 2]]
def cast(o, d):
    o = np.array(o, float); d = np.array(d, float); d /= np.linalg.norm(d)
    e1, e2 = A1 - A0, A2 - A0
    pv = np.cross(d, e2); det = np.sum(e1 * pv, 1)
    ok = np.abs(det) > 1e-9
    inv = np.where(ok, 1 / np.where(ok, det, 1), 0)
    tv = o - A0
    u = np.sum(tv * pv, 1) * inv
    qv = np.cross(tv, e1)
    v = np.sum(d * qv, 1) * inv
    t = np.sum(e2 * qv, 1) * inv
    hit = ok & (u >= 0) & (v >= 0) & (u + v <= 1) & (t > 0)
    if not hit.any():
        raise SystemExit('ray missed: %s %s' % (o, d))
    i = np.argmin(np.where(hit, t, np.inf))
    p = o + d * t[i]
    # smoothed surface normal: area-weighted vertex normals within 10 mm
    w = np.exp(-np.sum((Pb - p) ** 2, 1) / (2 * 5.0 ** 2))
    n = (N[:len(Pb)] * w[:, None]).sum(0); n /= np.linalg.norm(n)
    if np.dot(n, d) > 0: n = -n
    return p, n

def frame(p, n, up=(0, 1, 0)):
    up = np.array(up, float)
    t = np.cross(up, n); t /= np.linalg.norm(t)
    b = np.cross(n, t)
    return {'p': p.round(2).tolist(), 'n': n.round(4).tolist(), 't': t.round(4).tolist(), 'b': b.round(4).tolist()}

# landmarks: nose tip = most forward point of the head
head = Pb[Pb[:, 1] > ytop - 260]
nose = head[np.argmax(head[:, 2])]
eyeC = [Pe[Pe[:, 0] > 0].mean(0), Pe[Pe[:, 0] < 0].mean(0)]
far = 600.0
def _hits(x, yy):
    try: cast([x, yy, 600], [0, 0, -1]); return True
    except SystemExit: return False
def aim(target, outdir):
    """Cast from far outside toward target along -outdir; returns the outermost surface hit."""
    d = np.array(outdir, float); d /= np.linalg.norm(d)
    return cast(np.array(target, float) + d * far, -d)
hc = np.array([0.0, nose[1] + 10, nose[2] - 95])
print('nose', nose, 'head centre', hc)
for yy in (nose[1] - 16, nose[1] - 50, nose[1] - 62):
    print('profile y', round(yy), [(x, round(float(cast([x, yy, 600], [0, 0, -1])[0][2]))) for x in range(0, 70, 8) if _hits(x, yy)])
anchors = {
    'nose': frame(*aim([nose[0], nose[1] + 8, nose[2]], [0, 0, 1])),
    'cheek': frame(*aim([40, nose[1] - 16, 0], [0, 0, 1])),
    'beard': frame(*aim([33, nose[1] - 52, 0], [0, 0, 1])),
    'sandbox': frame(*aim([0, nose[1] + 72, hc[2]], [0, 0.15, 1])),
    'scalp': frame(*aim([0, hc[1] + 40, hc[2] - 20], [0, 1, -0.35])),
    'back': frame(*aim([0, ytop - 330, 0], [0, 0, -1])),
}
mouth = aim([0, nose[1] - 30, nose[2]], [0, 0, 1])[0]

# ambient occlusion per vertex: cosine-weighted visibility over 160 directions, from splatted depth maps
def fib_dirs(n):
    i = np.arange(n) + 0.5
    ph = np.arccos(1 - 2 * i / n); th = np.pi * (1 + 5 ** 0.5) * i
    return np.stack([np.cos(th) * np.sin(ph), np.sin(th) * np.sin(ph), np.cos(ph)], 1)
def bake_ao(P, N, T, n=160, cell=2.0):
    S = np.vstack([P, P[T].mean(1), (P[T[:, 0]] + P[T[:, 1]]) / 2, (P[T[:, 1]] + P[T[:, 2]]) / 2])
    vis = np.zeros(len(P)); ws = np.zeros(len(P))
    for d in fib_dirs(n):
        a = np.array([1.0, 0, 0]) if abs(d[0]) < 0.9 else np.array([0, 1.0, 0])
        u = np.cross(d, a); u /= np.linalg.norm(u); v = np.cross(d, u)
        su, sv, sd = S @ u, S @ v, S @ d
        u0, v0 = su.min(), sv.min()
        nu, nv = int((su.max() - u0) / cell) + 3, int((sv.max() - v0) / cell) + 3
        Z = np.full((nu, nv), -np.inf)
        np.maximum.at(Z, (((su - u0) / cell).astype(int) + 1, ((sv - v0) / cell).astype(int) + 1), sd)
        Zd = Z.copy()
        for du in (-1, 0, 1):
            for dv in (-1, 0, 1):
                Zd[1:-1, 1:-1] = np.maximum(Zd[1:-1, 1:-1], Z[1 + du:nu - 1 + du, 1 + dv:nv - 1 + dv])
        ip = ((P @ u - u0) / cell).astype(int) + 1; jp = ((P @ v - v0) / cell).astype(int) + 1
        c = N @ d; w = np.maximum(c, 0)
        bias = 1.0 + 2.83 * cell * np.sqrt(np.maximum(0, 1 - c * c)) / np.maximum(c, 0.15)
        occ = Zd[ip, jp] - P @ d > bias
        vis += w * (~occ); ws += w
    return vis / np.maximum(ws, 1e-6)
ao = bake_ao(P, N, T)
print('AO min/mean', ao.min().round(3), ao.mean().round(3))

# compact encoding: int16 positions (0.02 mm), int8 normals, uint8 AO, uint16 indices
off = (P.min(0) + P.max(0)) / 2; q = 0.02
assert np.abs((P - off) / q).max() < 32767 and len(P) < 65536
b64 = lambda a, t: base64.b64encode(np.ascontiguousarray(a, t).tobytes()).decode('ascii')
res = {
    'source': 'MakeHuman base mesh (CC0 1.0), cropped to a bust, one Catmull-Clark level, baked AO',
    'units': 'mm', 'nverts': int(len(P)), 'ntris': int(len(T)), 'eyeStart': int(len(Tb) * 3), 'eyeCount': int(len(Te) * 3),
    'posOff': off.round(3).tolist(), 'posQ': q,
    'pos': b64(np.round((P - off) / q), np.int16), 'nrm': b64(np.round(N * 127), np.int8), 'ao': b64(np.round(ao * 255), np.uint8),
    'idx': b64(T, np.uint16),
    'bbox': [P.min(0).round(1).tolist(), P.max(0).round(1).tolist()],
    'nose': nose.round(2).tolist(), 'eyes': [e.round(2).tolist() for e in eyeC], 'mouth': mouth.round(2).tolist(),
    'headCenter': hc.round(2).tolist(), 'anchors': anchors,
}
json.dump(res, open(out, 'w'))
print('verts', len(P), 'tris', len(T), 'eye tris', len(Te), 'bbox', res['bbox'])
for k, a in anchors.items(): print(k, a['p'], a['n'], a['t'])
