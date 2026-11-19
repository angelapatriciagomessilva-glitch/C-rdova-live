// mesh.js — malha livre ("art mesh"): vértices e triângulos que seguem a forma real da imagem.
//
// layer.mesh = {
//   verts: [x,y,...]   posição de repouso de cada vértice (coordenadas do rig, sobre a textura).
//                      A textura é mapeada por estas posições: (x - layer.x, y - layer.y) = pixel da imagem.
//   tris:  [a,b,c,...] índices dos triângulos (Delaunay, só dentro da forma)
//   rest:  [dx,dy,...] deformação estática ("forma base")
//   forms: [{ param, keys:[{ v, d:[dx,dy,...] }] }]   keyforms por parâmetro (mesma lógica do warp)
// }
// Posição final = verts + rest + Σ keyforms + deslocamento herdado (warp próprio e warps ancestrais).
import { dispAt, drawTri, segment, blendKeys } from './warp.js';

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

// ───────────────────────── máscara de alfa ─────────────────────────
const maskCache = new WeakMap();

function alphaMask(img, maxSide = 160) {
  let m = maskCache.get(img);
  if (m) return m;
  const k = Math.min(1, maxSide / Math.max(img.width, img.height));
  const w = Math.max(2, Math.round(img.width * k)), h = Math.max(2, Math.round(img.height * k));
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const g = c.getContext('2d', { willReadFrequently: true });
  g.imageSmoothingQuality = 'high'; g.drawImage(img, 0, 0, w, h);
  const d = g.getImageData(0, 0, w, h).data, raw = new Uint8Array(w * h);
  for (let i = 0; i < raw.length; i++) raw[i] = d[i * 4 + 3] > 12 ? 1 : 0;
  m = { w, h, sx: img.width / w, sy: img.height / h, raw, wide: dilate(raw, w, h, 2), edge: dilate(raw, w, h, 1) };
  maskCache.set(img, m);
  return m;
}

function dilate(src, w, h, r) {
  let cur = src;
  for (let it = 0; it < r; it++) {
    const out = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      if (cur[y * w + x]) { out[y * w + x] = 1; continue; }
      if ((x > 0 && cur[y * w + x - 1]) || (x < w - 1 && cur[y * w + x + 1]) || (y > 0 && cur[(y - 1) * w + x]) || (y < h - 1 && cur[(y + 1) * w + x])) out[y * w + x] = 1;
    }
    cur = out;
  }
  return cur;
}

/** px,py em pixels da imagem → está dentro da forma (com folga)? */
function inside(mask, px, py) {
  const x = Math.floor(px / mask.sx), y = Math.floor(py / mask.sy);
  return x >= 0 && y >= 0 && x < mask.w && y < mask.h && mask.wide[y * mask.w + x] === 1;
}

// ───────────────────────── Delaunay (Bowyer–Watson) ─────────────────────────
function delaunay(P) {
  const n = P.length;
  if (n < 3) return [];
  let x0 = 1e18, y0 = 1e18, x1 = -1e18, y1 = -1e18;
  for (const [x, y] of P) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
  const d = Math.max(x1 - x0, y1 - y0, 1) * 20, cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  const pts = P.concat([[cx - d, cy - d], [cx, cy + d], [cx + d, cy - d]]);
  const circ = (a, b, c) => {
    const [ax, ay] = pts[a], [bx, by] = pts[b], [qx, qy] = pts[c];
    const D = 2 * (ax * (by - qy) + bx * (qy - ay) + qx * (ay - by));
    if (Math.abs(D) < 1e-12) return null;
    const a2 = ax * ax + ay * ay, b2 = bx * bx + by * by, c2 = qx * qx + qy * qy;
    const ux = (a2 * (by - qy) + b2 * (qy - ay) + c2 * (ay - by)) / D, uy = (a2 * (qx - bx) + b2 * (ax - qx) + c2 * (bx - ax)) / D;
    return { x: ux, y: uy, r2: (ax - ux) ** 2 + (ay - uy) ** 2 };
  };
  let tris = [{ v: [n, n + 1, n + 2], c: circ(n, n + 1, n + 2) }];
  for (let i = 0; i < n; i++) {
    const [px, py] = pts[i], bad = [], keep = [];
    for (const t of tris) (t.c && (px - t.c.x) ** 2 + (py - t.c.y) ** 2 < t.c.r2 - 1e-9 ? bad : keep).push(t);
    const count = new Map(), edges = [];
    for (const t of bad) for (let e = 0; e < 3; e++) {
      const a = t.v[e], b = t.v[(e + 1) % 3], key = a < b ? a + ',' + b : b + ',' + a;
      count.set(key, (count.get(key) || 0) + 1); edges.push([a, b, key]);
    }
    for (const [a, b, key] of edges) if (count.get(key) === 1) { const c = circ(a, b, i); if (c) keep.push({ v: [a, b, i], c }); }
    tris = keep;
  }
  return tris.filter(t => t.v.every(v => v < n)).map(t => t.v);
}

/** Triangula os vértices e mantém só os triângulos dentro da forma da imagem. */
function triangulate(img, layer, verts) {
  const mask = alphaMask(img), P = [];
  for (let i = 0; i < verts.length; i += 2) P.push([verts[i] - layer.x, verts[i + 1] - layer.y]);
  const out = [];
  for (const [a, b, c] of delaunay(P)) {
    const A = P[a], B = P[b], C = P[c];
    const area = Math.abs((B[0] - A[0]) * (C[1] - A[1]) - (C[0] - A[0]) * (B[1] - A[1])) / 2;
    if (area < 0.5) continue;
    const probes = [[(A[0] + B[0] + C[0]) / 3, (A[1] + B[1] + C[1]) / 3], [(A[0] + B[0]) / 2, (A[1] + B[1]) / 2],
      [(B[0] + C[0]) / 2, (B[1] + C[1]) / 2], [(C[0] + A[0]) / 2, (C[1] + A[1]) / 2]];
    if (probes.every(([x, y]) => inside(mask, x, y))) out.push(a, b, c);
  }
  return out;
}

// ───────────────────────── geração e edição da topologia ─────────────────────────

/** Gera a malha seguindo o contorno da imagem (pontos na borda + pontos internos). density ≈ pontos por lado maior. */
export function generateMesh(layer, img, { density = 12 } = {}) {
  const mask = alphaMask(img), spacing = clamp(Math.max(img.width, img.height) / density, 8, 220);
  const { w, h } = mask, E = mask.edge, pts = [];
  const minD = spacing * 0.8;
  // contorno: células de borda da forma (levemente expandida), escolhidas com distância mínima
  const border = [];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (!E[y * w + x]) continue;
    if (x === 0 || y === 0 || x === w - 1 || y === h - 1 || !E[y * w + x - 1] || !E[y * w + x + 1] || !E[(y - 1) * w + x] || !E[(y + 1) * w + x]) border.push([x, y]);
  }
  // ordena por ângulo em torno do centro para espaçar o contorno de forma mais uniforme
  let mx = 0, my = 0; for (const [x, y] of border) { mx += x; my += y; }
  mx /= border.length || 1; my /= border.length || 1;
  border.sort((a, b) => Math.atan2(a[1] - my, a[0] - mx) - Math.atan2(b[1] - my, b[0] - mx));
  for (const [x, y] of border) {
    const px = (x + 0.5) * mask.sx, py = (y + 0.5) * mask.sy;
    if (pts.every(q => Math.hypot(q[0] - px, q[1] - py) >= minD)) pts.push([px, py]);
  }
  // pontos internos em grade, afastados do contorno
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5);
  for (let gy = spacing / 2; gy < img.height; gy += spacing) for (let gx = spacing / 2; gx < img.width; gx += spacing) {
    const x = gx + rnd() * spacing * 0.12, y = gy + rnd() * spacing * 0.12;
    const ix = Math.floor(x / mask.sx), iy = Math.floor(y / mask.sy);
    if (ix < 0 || iy < 0 || ix >= w || iy >= h || !mask.raw[iy * w + ix]) continue;
    if (pts.every(q => Math.hypot(q[0] - x, q[1] - y) >= spacing * 0.65)) pts.push([x, y]);
  }
  if (pts.length < 3) pts.push([0, 0], [img.width, 0], [0, img.height], [img.width, img.height]);
  const verts = []; for (const [x, y] of pts) verts.push(layer.x + x, layer.y + y);
  return { verts, tris: triangulate(img, layer, verts), rest: new Array(verts.length).fill(0), forms: [], kmode: 'smooth' };
}

export function retriangulate(layer, img, mesh) { mesh.tris = triangulate(img, layer, mesh.verts); }

export function addVertex(layer, img, mesh, x, y) {
  mesh.verts.push(x, y); mesh.rest.push(0, 0);
  for (const f of mesh.forms) for (const k of f.keys) k.d.push(0, 0);
  retriangulate(layer, img, mesh);
  return mesh.verts.length / 2 - 1;
}

export function removeVertex(layer, img, mesh, i) {
  if (mesh.verts.length / 2 <= 3) return false;
  mesh.verts.splice(i * 2, 2); mesh.rest.splice(i * 2, 2);
  for (const f of mesh.forms) for (const k of f.keys) k.d.splice(i * 2, 2);
  retriangulate(layer, img, mesh);
  return true;
}

/** Aceita malhas incompletas/antigas; devolve null se não houver como aproveitar. */
export function normalizeMesh(m) {
  if (!m || !Array.isArray(m.verts) || m.verts.length < 6 || m.verts.length % 2 || !m.verts.every(Number.isFinite)) return null;
  const n2 = m.verts.length, nv = n2 / 2;
  m.tris = (Array.isArray(m.tris) ? m.tris : []).filter(Number.isInteger);
  m.tris.length -= m.tris.length % 3;
  if (m.tris.some(i => i < 0 || i >= nv)) m.tris = [];
  m.kmode = ['linear', 'smooth', 'cubic'].includes(m.kmode) ? m.kmode : 'linear';
  if (!Array.isArray(m.rest) || m.rest.length !== n2) m.rest = new Array(n2).fill(0);
  m.forms = (Array.isArray(m.forms) ? m.forms : []).filter(f => f && f.param && Array.isArray(f.keys))
    .map(f => ({ param: f.param, keys: f.keys.filter(k => k && Number.isFinite(k.v) && Array.isArray(k.d) && k.d.length === n2).sort((a, b) => a.v - b.v) }))
    .filter(f => f.keys.length);
  return m;
}

// ───────────────────────── avaliação ─────────────────────────

/** Posições finais dos vértices (rest + keyforms + deslocamento herdado). ancs = [{layer, ev}] (inclui o warp da própria camada). */
export function meshPositions(layer, mesh, values, ancs = []) {
  const n2 = mesh.verts.length, delta = mesh.rest.slice(), pos = new Float64Array(n2), d = [0, 0];
  for (const f of mesh.forms) {
    const pv = values[f.param];
    if (pv === undefined || !f.keys.length) continue;
    blendKeys(f.keys, pv, mesh.kmode, (k, wt) => { if (wt) for (let i = 0; i < n2; i++) delta[i] += k.d[i] * wt; });
  }
  for (let i = 0; i < n2; i += 2) {
    const vx = mesh.verts[i], vy = mesh.verts[i + 1];
    let x = vx + delta[i], y = vy + delta[i + 1];
    for (const a of ancs) { dispAt(a.layer, a.ev, vx, vy, d); x += d[0]; y += d[1]; }
    pos[i] = x; pos[i + 1] = y;
  }
  return pos;
}

/** Desenha os triângulos texturizados. M = (view × mundo) da camada. */
export function drawMeshLayer(ctx, img, layer, mesh, pos, M) {
  const n2 = pos.length, sp = new Float64Array(n2);
  for (let i = 0; i < n2; i += 2) { sp[i] = M.a * pos[i] + M.c * pos[i + 1] + M.e; sp[i + 1] = M.b * pos[i] + M.d * pos[i + 1] + M.f; }
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  const V = mesh.verts, T = mesh.tris;
  for (let t = 0; t < T.length; t += 3) {
    const a = T[t] * 2, b = T[t + 1] * 2, c = T[t + 2] * 2;
    drawTri(ctx, img,
      [V[a] - layer.x, V[a + 1] - layer.y, V[b] - layer.x, V[b + 1] - layer.y, V[c] - layer.x, V[c + 1] - layer.y],
      [sp[a], sp[a + 1], sp[b], sp[b + 1], sp[c], sp[c + 1]]);
  }
}

// ───────────────────────── interação ─────────────────────────

/** Arrasta o vértice k até q = [x,y] (espaço de repouso). radius (px do rig) = queda suave nos vizinhos. */
export function dragMesh(layer, mesh, values, ancs, target, k, q, radius = 0, ensure) {
  const pos = meshPositions(layer, mesh, values, ancs);
  const dx = q[0] - pos[k * 2], dy = q[1] - pos[k * 2 + 1];
  const arr = target.kind === 'topo' ? mesh.verts : target.kind === 'rest' ? mesh.rest : ensure(mesh, target);
  const kx = mesh.verts[k * 2], ky = mesh.verts[k * 2 + 1];
  for (let i = 0; i < mesh.verts.length / 2; i++) {
    const d = Math.hypot(mesh.verts[i * 2] - kx, mesh.verts[i * 2 + 1] - ky);
    const wt = i === k ? 1 : radius <= 0 || d >= radius ? 0 : 0.5 * (1 + Math.cos((Math.PI * d) / radius));
    if (!wt) continue;
    arr[i * 2] += dx * wt; arr[i * 2 + 1] += dy * wt;
  }
}

/** Vértice mais próximo de (x,y) no espaço do rig (W = matriz de mundo da camada), ou -1. */
export function hitVertex(pos, W, x, y, maxDist) {
  let best = -1, bd = maxDist;
  for (let i = 0; i < pos.length; i += 2) {
    const q = W.transformPoint({ x: pos[i], y: pos[i + 1] }), d = Math.hypot(q.x - x, q.y - y);
    if (d < bd) { bd = d; best = i / 2; }
  }
  return best;
}

export function drawMeshOverlay(ctx, M, mesh, pos, { active = -1, radius = 0, topology = false } = {}) {
  const n2 = pos.length, sp = new Float64Array(n2);
  for (let i = 0; i < n2; i += 2) { sp[i] = M.a * pos[i] + M.c * pos[i + 1] + M.e; sp[i + 1] = M.b * pos[i] + M.d * pos[i + 1] + M.f; }
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.lineWidth = 1; ctx.strokeStyle = topology ? 'rgba(255,200,87,.8)' : 'rgba(77,226,197,.7)';
  ctx.beginPath();
  const T = mesh.tris;
  for (let t = 0; t < T.length; t += 3) {
    const a = T[t] * 2, b = T[t + 1] * 2, c = T[t + 2] * 2;
    ctx.moveTo(sp[a], sp[a + 1]); ctx.lineTo(sp[b], sp[b + 1]); ctx.lineTo(sp[c], sp[c + 1]); ctx.closePath();
  }
  ctx.stroke();
  const scale = Math.hypot(M.a, M.b);
  if (active >= 0 && radius > 0) {
    ctx.beginPath(); ctx.arc(sp[active * 2], sp[active * 2 + 1], radius * scale, 0, 7);
    ctx.strokeStyle = 'rgba(255,93,143,.6)'; ctx.setLineDash([5, 5]); ctx.stroke(); ctx.setLineDash([]);
  }
  for (let i = 0; i < n2; i += 2) {
    const on = i / 2 === active;
    ctx.beginPath(); ctx.arc(sp[i], sp[i + 1], on ? 7 : 4.5, 0, 7);
    ctx.fillStyle = on ? '#ff5d8f' : '#14111f'; ctx.fill();
    ctx.lineWidth = 1.5; ctx.strokeStyle = on ? '#fff' : (topology ? '#ffc857' : '#4de2c5'); ctx.stroke();
  }
}

// ───────────────────────── keyforms da malha ─────────────────────────

/** Devolve o array de deltas da chave de `pid` em `v` (cria a chave, e a chave neutra em `def`, se preciso). */
export function ensureMeshKey(mesh, pid, v, def, eps = 1e-3) {
  const n2 = mesh.verts.length;
  let f = mesh.forms.find(q => q.param === pid);
  if (!f) { f = { param: pid, keys: [] }; mesh.forms.push(f); }
  let k = f.keys.find(q => Math.abs(q.v - v) <= eps);
  if (!k) {
    let d = new Array(n2).fill(0);
    if (f.keys.length) { const [a, b, t] = segment(f.keys, v); d = d.map((_, i) => a.d[i] + (b.d[i] - a.d[i]) * t); }
    k = { v, d }; f.keys.push(k);
    if (!f.keys.some(q => Math.abs(q.v - def) <= eps)) f.keys.push({ v: def, d: new Array(n2).fill(0) });
    f.keys.sort((a, b) => a.v - b.v);
  }
  return k.d;
}
export function deleteMeshKey(mesh, pid, key) {
  const f = mesh.forms.find(q => q.param === pid);
  if (!f) return;
  f.keys = f.keys.filter(k => k !== key);
  if (!f.keys.length) mesh.forms = mesh.forms.filter(q => q !== f);
}
export function resetMeshTarget(mesh, target, eps = 1e-3) {
  if (target.kind === 'rest') mesh.rest.fill(0);
  else if (target.kind === 'param') {
    const f = mesh.forms.find(q => q.param === target.param), k = f?.keys.find(q => Math.abs(q.v - target.value) <= eps);
    if (k) k.d.fill(0);
  }
}
