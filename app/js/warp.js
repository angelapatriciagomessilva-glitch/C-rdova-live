// warp.js — Warp Deformers (grades de deformação) para o rig 2D.
//
// Modelo de dados (guardado em layer.warp, serializável em JSON):
//   { cols, rows,            células da grade de controle → (cols+1)*(rows+1) pontos
//     interp: 'cr'|'bilinear',  interpolação da superfície entre os pontos
//     sub,                   subdivisões da malha de render por célula
//     rest:  [dx,dy,...],    deformação estática ("forma base") em relação à grade regular
//     forms: [{ param, keys:[{ v, d:[dx,dy,...] }, ...] }]   keyforms por parâmetro
//   }
// Posição final do ponto k = grade regular(k) + rest[k] + Σ forms interpoladas pelo valor do parâmetro.
// A superfície (e portanto cada vértice da textura) é interpolada a partir desses pontos.

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

export const nodeCount = w => (w.cols + 1) * (w.rows + 1);
export const nodeIJ = (w, k) => [k % (w.cols + 1), Math.floor(k / (w.cols + 1))];
export const nodeIndex = (w, i, j) => j * (w.cols + 1) + i;

/** Posição do ponto k na grade regular (sem deformação), em coordenadas do rig. */
export function gridPos(layer, w, k) {
  const [i, j] = nodeIJ(w, k), R = rectOf(layer);
  return [R.x + (R.w * i) / w.cols, R.y + (R.h * j) / w.rows];
}

/** Retângulo (coords do rig) coberto pela grade: a "caixa" do warp, ou a camada inteira. */
export function rectOf(layer) {
  const b = layer.warp?.box;
  return b ? b : { x: layer.x, y: layer.y, w: layer.w, h: layer.h };
}

/** Caixa do conteúdo visível da imagem (alfa > 2), com margem; null se vazia/igual à camada. */
export function contentBox(img, layer, pad = 4) {
  const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
  const g = c.getContext('2d', { willReadFrequently: true }); g.drawImage(img, 0, 0);
  const d = g.getImageData(0, 0, c.width, c.height).data, W = c.width, H = c.height;
  let x0 = W, y0 = H, x1 = -1, y1 = -1;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    if (d[(y * W + x) * 4 + 3] > 2) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  }
  if (x1 < 0) return null;
  x0 = Math.max(0, x0 - pad); y0 = Math.max(0, y0 - pad); x1 = Math.min(W, x1 + 1 + pad); y1 = Math.min(H, y1 + 1 + pad);
  if (x0 === 0 && y0 === 0 && x1 === W && y1 === H) return null;
  return { x: layer.x + x0, y: layer.y + y0, w: x1 - x0, h: y1 - y0 };
}

export function createWarp(cols = 4, rows = 4, interp = 'cr', sub = 3, box = null) {
  cols = clamp(cols | 0, 1, 16); rows = clamp(rows | 0, 1, 16);
  const w = { cols, rows, interp, sub, kmode: 'smooth', rest: new Array((cols + 1) * (rows + 1) * 2).fill(0), forms: [] };
  if (box) w.box = { ...box };
  return w;
}

/** Garante o formato atual (aceita objetos antigos/incompletos: vira uma grade sem deformação). */
export function normalizeWarp(w) {
  if (!w || typeof w !== 'object') return null;
  const cols = clamp(Number.isFinite(w.cols) ? w.cols | 0 : 4, 1, 16);
  const rows = clamp(Number.isFinite(w.rows) ? w.rows | 0 : 4, 1, 16);
  const n = (cols + 1) * (rows + 1) * 2;
  const okArr = a => Array.isArray(a) && a.length === n && a.every(Number.isFinite);
  w.cols = cols; w.rows = rows;
  const b = w.box;
  if (b && [b.x, b.y, b.w, b.h].every(Number.isFinite) && b.w > 0 && b.h > 0) w.box = { x: b.x, y: b.y, w: b.w, h: b.h }; else delete w.box;
  w.interp = w.interp === 'bilinear' ? 'bilinear' : 'cr';
  w.kmode = ['linear', 'smooth', 'cubic'].includes(w.kmode) ? w.kmode : 'linear';
  w.sub = clamp(Number.isFinite(w.sub) ? w.sub | 0 : 3, 1, 12);
  if (!okArr(w.rest)) w.rest = new Array(n).fill(0);
  w.bars = (Array.isArray(w.bars) ? w.bars : []).filter(b => b && (b.axis === 'h' || b.axis === 'v') && Number.isFinite(b.t))
    .map(b => ({ axis: b.axis, t: clamp(b.t, 0, 1), n: clamp(Number.isFinite(b.n) ? Math.round(b.n) : 3, 2, 7), w: clamp(Number.isFinite(b.w) ? b.w : 1.5, 0.5, 4) }));
  if (!w.bars.length) delete w.bars;
  w.forms = (Array.isArray(w.forms) ? w.forms : []).filter(f => f && f.param && Array.isArray(f.keys))
    .map(f => ({ param: f.param, keys: f.keys.filter(k => k && Number.isFinite(k.v) && okArr(k.d)).sort((a, b) => a.v - b.v) }))
    .filter(f => f.keys.length);
  return w;
}

export const cloneWarp = w => normalizeWarp(JSON.parse(JSON.stringify(w)));

// ───────────────────────── interpolação ─────────────────────────

/** Valor (x ou y) do ponto (ii,jj) da grade; fora dela extrapola linearmente (mantém a grade regular exata). */
function P(arr, cols, rows, ii, jj, c) {
  if (ii < 0) return 2 * P(arr, cols, rows, 0, jj, c) - P(arr, cols, rows, 1, jj, c);
  if (ii > cols) return 2 * P(arr, cols, rows, cols, jj, c) - P(arr, cols, rows, cols - 1, jj, c);
  if (jj < 0) return 2 * P(arr, cols, rows, ii, 0, c) - P(arr, cols, rows, ii, 1, c);
  if (jj > rows) return 2 * P(arr, cols, rows, ii, rows, c) - P(arr, cols, rows, ii, rows - 1, c);
  return arr[(jj * (cols + 1) + ii) * 2 + c];
}

/** Pesos de Catmull-Rom (a curva passa pelos pontos de controle). */
function crWeights(t, o) {
  const t2 = t * t, t3 = t2 * t;
  o[0] = (-t3 + 2 * t2 - t) / 2;
  o[1] = (3 * t3 - 5 * t2 + 2) / 2;
  o[2] = (-3 * t3 + 4 * t2 + t) / 2;
  o[3] = (t3 - t2) / 2;
}
const WX = [0, 0, 0, 0], WY = [0, 0, 0, 0];

/**
 * Avalia a superfície da grade em (u,v) ∈ [0,1]². `arr` pode ser posições absolutas ou deltas.
 * Escreve [x,y] em `out`.
 */
export function sampleGrid(arr, cols, rows, u, v, interp, out) {
  const fx = clamp(u, 0, 1) * cols, fy = clamp(v, 0, 1) * rows;
  const i = Math.min(cols - 1, Math.floor(fx)), j = Math.min(rows - 1, Math.floor(fy));
  const tx = fx - i, ty = fy - j;
  if (interp === 'bilinear') {
    for (let c = 0; c < 2; c++) {
      const a = P(arr, cols, rows, i, j, c), b = P(arr, cols, rows, i + 1, j, c);
      const d = P(arr, cols, rows, i, j + 1, c), e = P(arr, cols, rows, i + 1, j + 1, c);
      out[c] = (a + (b - a) * tx) * (1 - ty) + (d + (e - d) * tx) * ty;
    }
    return out;
  }
  crWeights(tx, WX); crWeights(ty, WY);
  for (let c = 0; c < 2; c++) {
    let s = 0;
    for (let m = 0; m < 4; m++) {
      let row = 0;
      for (let n = 0; n < 4; n++) row += WX[n] * P(arr, cols, rows, i + n - 1, j + m - 1, c);
      s += WY[m] * row;
    }
    out[c] = s;
  }
  return out;
}

// ───────────────────────── keyforms ─────────────────────────

export const KMODES = [['smooth', 'Suave (ease)'], ['cubic', 'Spline (curva contínua)'], ['linear', 'Linear']];
/** Posição de v entre as chaves: [índiceA, índiceB, t]. */
export function keySpan(keys, v) {
  const n = keys.length;
  if (n === 1 || v <= keys[0].v) return [0, 0, 0];
  if (v >= keys[n - 1].v) return [n - 1, n - 1, 0];
  let i = 1; while (keys[i].v < v) i++;
  return [i - 1, i, (v - keys[i - 1].v) / ((keys[i].v - keys[i - 1].v) || 1)];
}
/** Chama fn(chave, peso) para cada chave que contribui em v. Modos: linear | smooth (smoothstep) | cubic (Catmull-Rom). */
export function blendKeys(keys, v, mode, fn) {
  const [a, b, t] = keySpan(keys, v);
  if (a === b) return fn(keys[a], 1);
  if (mode === 'cubic' && keys.length > 2) {
    const k0 = keys[Math.max(0, a - 1)], k3 = keys[Math.min(keys.length - 1, b + 1)], t2 = t * t, t3 = t2 * t;
    fn(k0, -0.5 * t3 + t2 - 0.5 * t); fn(keys[a], 1.5 * t3 - 2.5 * t2 + 1); fn(keys[b], -1.5 * t3 + 2 * t2 + 0.5 * t); fn(k3, 0.5 * t3 - 0.5 * t2);
    return;
  }
  const u = mode === 'linear' || !mode ? t : t * t * (3 - 2 * t);
  fn(keys[a], 1 - u); fn(keys[b], u);
}
export function segment(keys, v) {
  if (keys.length === 1 || v <= keys[0].v) return [keys[0], keys[0], 0];
  const last = keys[keys.length - 1];
  if (v >= last.v) return [last, last, 0];
  for (let i = 0; i < keys.length - 1; i++) {
    const a = keys[i], b = keys[i + 1];
    if (v >= a.v && v <= b.v) return [a, b, (v - a.v) / (b.v - a.v || 1)];
  }
  return [last, last, 0];
}

/** Avalia forma + keyforms para os valores atuais dos parâmetros. */
export function evalWarp(layer, values) {
  const w = layer.warp, n = nodeCount(w);
  const delta = w.rest.slice();
  for (const f of w.forms) {
    const pv = values[f.param];
    if (!f.keys.length || pv === undefined) continue;   // parâmetro apagado: ignora
    blendKeys(f.keys, pv, w.kmode, (k, wt) => { if (wt) for (let i = 0; i < delta.length; i++) delta[i] += k.d[i] * wt; });
  }
  const pts = new Array(n * 2);
  for (let k = 0; k < n; k++) {
    const g = gridPos(layer, w, k);
    pts[k * 2] = g[0] + delta[k * 2]; pts[k * 2 + 1] = g[1] + delta[k * 2 + 1];
  }
  return { delta, pts };
}

export function ensureForm(warp, paramId, defValue) {
  let f = warp.forms.find(x => x.param === paramId);
  if (!f) {
    f = { param: paramId, keys: [{ v: defValue, d: new Array(warp.rest.length).fill(0) }] };
    warp.forms.push(f);
  }
  return f;
}

/** Garante uma chave no valor `v` (nova chave nasce com a deformação interpolada: sem saltos). */
export function ensureKey(form, v, eps) {
  v = Math.round(v * 1000) / 1000;
  const hit = form.keys.find(k => Math.abs(k.v - v) <= eps);
  if (hit) return hit;
  const [a, b, t] = segment(form.keys, v);
  const key = { v, d: a.d.map((x, i) => x + (b.d[i] - x) * t) };
  form.keys.push(key); form.keys.sort((p, q) => p.v - q.v);
  return key;
}

export function deleteKey(form, key) {
  form.keys = form.keys.filter(k => k !== key);
}

// ───────────────────────── edição por arrasto ─────────────────────────

/**
 * Arrasta o ponto `k` para `q` = [x,y] (espaço de repouso do rig).
 * target: { kind:'rest' } ou { kind:'param', param, value, def, range }
 * opts:   { radius (em células; 0 = só o ponto), sym (espelha no eixo vertical da grade) }
 * Pontos vizinhos acompanham com queda suave (cosseno) — edição proporcional.
 */
export function dragNode(layer, values, target, k, q, opts = {}) {
  const w = layer.warp;
  const cur = evalWarp(layer, values).pts;
  const dx = q[0] - cur[k * 2], dy = q[1] - cur[k * 2 + 1];
  let arr;
  if (target.kind === 'rest') arr = w.rest;
  else arr = ensureKey(ensureForm(w, target.param, target.def), target.value, 1e-3 * (target.range || 1)).d;

  const [ik, jk] = nodeIJ(w, k);
  const radius = opts.radius || 0;
  const km = nodeIndex(w, w.cols - ik, jk);          // ponto espelhado de k
  const onAxis = km === k;
  const fall = d => (radius <= 0 ? (d === 0 ? 1 : 0) : d >= radius ? 0 : 0.5 * (1 + Math.cos((Math.PI * d) / radius)));
  const ddx = opts.sym && onAxis ? 0 : dx;           // ponto no eixo de simetria só anda em Y
  for (let m = 0; m < nodeCount(w); m++) {
    const [i, j] = nodeIJ(w, m);
    const w1 = fall(Math.hypot(i - ik, j - jk));
    if (!opts.sym) { if (w1) { arr[m * 2] += ddx * w1; arr[m * 2 + 1] += dy * w1; } continue; }
    // simetria: cada ponto obedece à fonte mais próxima (k ou seu espelho), sem somar as duas
    const w2 = onAxis ? 0 : fall(Math.hypot(i - (w.cols - ik), j - jk));
    if (w1 >= w2 && w1) { arr[m * 2] += ddx * w1; arr[m * 2 + 1] += dy * w1; }
    else if (w2) { arr[m * 2] += -ddx * w2; arr[m * 2 + 1] += dy * w2; }
  }
}


// ───────────────────────── barras (linhas-guia estilo Live2D) ─────────────────────────
// Uma barra é uma linha da grade (horizontal 'h' ou vertical 'v') na posição t∈[0,1] com `n` alças (pontas + meio…).
// Arrastar uma alça move suavemente os pontos ao longo da linha (queda em cosseno entre alças vizinhas) e, perpendicular a ela,
// até `w` células (queda em cosseno). Serve só para editar: o render continua sendo a grade.
export const newBar = (axis, t = 0.5) => ({ axis, t: clamp(t, 0, 1), n: 3, w: 1.5 });

/** Ponto da superfície (interpolação bilinear dos pontos atuais `pts`) na posição u ao longo da barra. */
export function barPoint(w, bar, u, pts, out = [0, 0]) {
  const gi = (bar.axis === 'h' ? u : bar.t) * w.cols, gj = (bar.axis === 'h' ? bar.t : u) * w.rows;
  const i = Math.min(w.cols - 1, Math.floor(gi)), j = Math.min(w.rows - 1, Math.floor(gj)), tx = gi - i, ty = gj - j, W = w.cols + 1;
  for (let c = 0; c < 2; c++) {
    const a = pts[(j * W + i) * 2 + c], b = pts[(j * W + i + 1) * 2 + c], d = pts[((j + 1) * W + i) * 2 + c], e = pts[((j + 1) * W + i + 1) * 2 + c];
    out[c] = (a + (b - a) * tx) * (1 - ty) + (d + (e - d) * tx) * ty;
  }
  return out;
}
export const barU = (bar, h) => (h == null ? 0.5 : h / (bar.n - 1));
/** Posição atual (espaço de repouso da camada) da alça h (ou do meio da barra, se h == null). */
export function barHandlePos(layer, values, bar, h) { return barPoint(layer.warp, bar, barU(bar, h), evalWarp(layer, values).pts); }

/** Peso de cada ponto da grade para a alça h (null = barra inteira). */
function barWeights(w, bar, h) {
  const out = new Float64Array(nodeCount(w)), R = bar.w, cs = bar.axis === 'h' ? w.cols : w.rows, ac = bar.axis === 'h' ? w.rows : w.cols;
  const p = h == null ? 0 : h / (bar.n - 1), hw = 1 / (bar.n - 1), cosf = (d, r) => (d >= r ? 0 : 0.5 * (1 + Math.cos((Math.PI * d) / r)));
  for (let m = 0; m < out.length; m++) {
    const [i, j] = nodeIJ(w, m), a = (bar.axis === 'h' ? i : j) / cs, d = Math.abs((bar.axis === 'h' ? j : i) - bar.t * ac);
    out[m] = cosf(d, R) * (h == null ? 1 : cosf(Math.abs(a - p), hw));
  }
  return out;
}

/** Move a alça h da barra em (dx,dy) (espaço de repouso). A alça acompanha exatamente o deslocamento pedido. */
export function dragBar(layer, target, bar, h, dx, dy) {
  const w = layer.warp;
  const arr = target.kind === 'rest' ? w.rest : ensureKey(ensureForm(w, target.param, target.def), target.value, 1e-3 * (target.range || 1)).d;
  const W = barWeights(w, bar, h), u = barU(bar, h);
  const gi = (bar.axis === 'h' ? u : bar.t) * w.cols, gj = (bar.axis === 'h' ? bar.t : u) * w.rows;
  const i = Math.min(w.cols - 1, Math.floor(gi)), j = Math.min(w.rows - 1, Math.floor(gj)), tx = gi - i, ty = gj - j, cw = w.cols + 1;
  const s = W[j * cw + i] * (1 - tx) * (1 - ty) + W[j * cw + i + 1] * tx * (1 - ty) + W[(j + 1) * cw + i] * (1 - tx) * ty + W[(j + 1) * cw + i + 1] * tx * ty;
  if (s < 1e-4) return;
  const k = 1 / s;
  for (let m = 0; m < W.length; m++) if (W[m]) { arr[m * 2] += dx * W[m] * k; arr[m * 2 + 1] += dy * W[m] * k; }
}

export function resetTarget(layer, target, eps = 1e-3) {
  const w = layer.warp;
  if (target.kind === 'rest') w.rest.fill(0);
  else {
    const f = w.forms.find(x => x.param === target.param);
    const key = f && f.keys.find(k => Math.abs(k.v - target.value) <= eps);
    if (key) key.d.fill(0);
  }
}

// ───────────────────────── deslocamento herdado pelos filhos ─────────────────────────

/** Deslocamento que um deformador-pai impõe a um ponto de repouso (x,y), com queda suave fora da grade. */
export function dispAt(layer, ev, x, y, out) {
  const w = layer.warp, R = rectOf(layer);
  const u = (x - R.x) / R.w, v = (y - R.y) / R.h;
  sampleGrid(ev.delta, w.cols, w.rows, u, v, w.interp, out);
  const du = u < 0 ? -u : u > 1 ? u - 1 : 0, dv = v < 0 ? -v : v > 1 ? v - 1 : 0;
  if (du || dv) {
    const dist = Math.hypot(du * R.w, dv * R.h), margin = 0.35 * Math.max(R.w, R.h);
    const f = clamp(1 - dist / margin, 0, 1);
    out[0] *= f * f * (3 - 2 * f); out[1] *= f * f * (3 - 2 * f);
  }
  return out;
}

// ───────────────────────── malha ─────────────────────────

let QS = 1;
/** Qualidade da malha de render (desempenho): 'high' | 'med' | 'low'. */
export function setQuality(q) { QS = { high: 1, med: 0.65, low: 0.4 }[q] ?? 1; }
/** Resolução da malha de render. */
export function meshRes(layer) {
  if (layer.warp) {
    const s = layer.warp.sub || 4;
    return [clamp(Math.round(layer.warp.cols * s * QS), 2, 48), clamp(Math.round(layer.warp.rows * s * QS), 2, 48)];
  }
  return [clamp(Math.ceil(layer.w / 40), 4, 20), clamp(Math.ceil(layer.h / 40), 4, 20)];
}
/** Resolução para a região da caixa do warp (células ~ 12 px de tela do rig, limitado). */
export function regionRes(layer) {
  const [cx, cy] = meshRes(layer), R = rectOf(layer);
  if (!layer.warp?.box) return [cx, cy];
  const s = layer.warp.sub || 4;
  return [clamp(Math.round(Math.max(layer.warp.cols * s, Math.ceil(R.w / 14)) * QS), 2, 48), clamp(Math.round(Math.max(layer.warp.rows * s, Math.ceil(R.h / 14)) * QS), 2, 48)];
}

const occCache = new WeakMap();
/** Malha automática por alfa: marca as células que têm algum pixel visível (as vazias não são desenhadas). */
export function occupancy(img, nx, ny, sr = null) {
  let m = occCache.get(img);
  if (!m) occCache.set(img, (m = new Map()));
  const key = nx + 'x' + ny + (sr ? '@' + [sr.x, sr.y, sr.w, sr.h].join(',') : '');
  if (m.has(key)) return m.get(key);
  const S = 4, c = document.createElement('canvas');
  c.width = nx * S; c.height = ny * S;
  const g = c.getContext('2d', { willReadFrequently: true });
  g.imageSmoothingQuality = 'high';
  if (sr) g.drawImage(img, sr.x, sr.y, sr.w, sr.h, 0, 0, c.width, c.height); else g.drawImage(img, 0, 0, c.width, c.height);
  const d = g.getImageData(0, 0, c.width, c.height).data, occ = new Uint8Array(nx * ny);
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    let any = 0;
    for (let y = 0; y < S && !any; y++) for (let x = 0; x < S; x++) {
      if (d[((j * S + y) * c.width + i * S + x) * 4 + 3] > 3) { any = 1; break; }
    }
    occ[j * nx + i] = any;
  }
  m.set(key, occ);
  return occ;
}

/**
 * Vértices da malha em espaço de repouso: superfície do próprio warp (se houver) +
 * deslocamento herdado dos deformadores ancestrais.
 * ancs: [{ layer, ev }]
 */
export function buildVerts(layer, ev, ancs, nx, ny) {
  const verts = new Float32Array((nx + 1) * (ny + 1) * 2), p = [0, 0], d = [0, 0];
  const w = layer.warp, R = rectOf(layer);
  for (let j = 0; j <= ny; j++) for (let i = 0; i <= nx; i++) {
    const u = i / nx, v = j / ny, o = (j * (nx + 1) + i) * 2;
    const rx = R.x + u * R.w, ry = R.y + v * R.h;
    if (w) sampleGrid(ev.pts, w.cols, w.rows, u, v, w.interp, p); else { p[0] = rx; p[1] = ry; }
    let x = p[0], y = p[1];
    for (const a of ancs) { dispAt(a.layer, a.ev, rx, ry, d); x += d[0]; y += d[1]; }
    verts[o] = x; verts[o + 1] = y;
  }
  return verts;
}

/** Desenha um triângulo texturizado (mapeamento afim origem→destino) com leve expansão para esconder frestas. */
export function drawTri(ctx, img, s, d) {
  const [s0x, s0y, s1x, s1y, s2x, s2y] = s, [d0x, d0y, d1x, d1y, d2x, d2y] = d;
  const det = (s1x - s0x) * (s2y - s0y) - (s1y - s0y) * (s2x - s0x);
  if (Math.abs(det) < 1e-9) return;
  const a = ((d1x - d0x) * (s2y - s0y) - (d2x - d0x) * (s1y - s0y)) / det;
  const c = ((d2x - d0x) * (s1x - s0x) - (d1x - d0x) * (s2x - s0x)) / det;
  const b = ((d1y - d0y) * (s2y - s0y) - (d2y - d0y) * (s1y - s0y)) / det;
  const e = ((d2y - d0y) * (s1x - s0x) - (d1y - d0y) * (s2x - s0x)) / det;
  const tx = d0x - a * s0x - c * s0y, ty = d0y - b * s0x - e * s0y;

  // infla o triângulo ~0.9px (cada aresta anda para fora) para os vizinhos se sobreporem e não aparecerem frestas
  const cx = (d0x + d1x + d2x) / 3, cy = (d0y + d1y + d2y) / 3, E = 0.9;
  const edgeN = (ax, ay, bx, by) => {
    let nx = by - ay, ny = ax - bx; const l = Math.hypot(nx, ny) || 1; nx /= l; ny /= l;
    if (nx * ((ax + bx) / 2 - cx) + ny * ((ay + by) / 2 - cy) < 0) { nx = -nx; ny = -ny; }
    return [nx, ny];
  };
  const n01 = edgeN(d0x, d0y, d1x, d1y), n12 = edgeN(d1x, d1y, d2x, d2y), n20 = edgeN(d2x, d2y, d0x, d0y);
  const infl = (x, y, na, nb) => {
    const k = E / Math.max(0.35, 1 + na[0] * nb[0] + na[1] * nb[1]);
    return [x + (na[0] + nb[0]) * k, y + (na[1] + nb[1]) * k];
  };
  const g0 = infl(d0x, d0y, n20, n01), g1 = infl(d1x, d1y, n01, n12), g2 = infl(d2x, d2y, n12, n20);

  const x0 = Math.max(0, Math.floor(Math.min(s0x, s1x, s2x)) - 1), y0 = Math.max(0, Math.floor(Math.min(s0y, s1y, s2y)) - 1);
  const x1 = Math.min(img.width, Math.ceil(Math.max(s0x, s1x, s2x)) + 1), y1 = Math.min(img.height, Math.ceil(Math.max(s0y, s1y, s2y)) + 1);
  if (x1 <= x0 || y1 <= y0) return;

  ctx.save();
  ctx.beginPath(); ctx.moveTo(g0[0], g0[1]); ctx.lineTo(g1[0], g1[1]); ctx.lineTo(g2[0], g2[1]); ctx.closePath();
  ctx.clip();
  ctx.setTransform(a, b, c, e, tx, ty);
  ctx.drawImage(img, x0, y0, x1 - x0, y1 - y0, x0, y0, x1 - x0, y1 - y0);
  ctx.restore();
}

/**
 * Desenha a textura deformada. M = DOMMatrix (rig → pixels do canvas).
 * Retorna as posições dos vértices em pixels (para overlay).
 */
export function drawMesh(ctx, img, layer, verts, nx, ny, M, { wire = false } = {}) {
  const R = rectOf(layer), sr = { x: R.x - layer.x, y: R.y - layer.y, w: R.w, h: R.h };
  const occ = occupancy(img, nx, ny, sr), n = (nx + 1) * (ny + 1), sp = new Float32Array(n * 2);
  for (let i = 0; i < n; i++) {
    const x = verts[i * 2], y = verts[i * 2 + 1];
    sp[i * 2] = M.a * x + M.c * y + M.e; sp[i * 2 + 1] = M.b * x + M.d * y + M.f;
  }
  const W = R.w, H = R.h, OX = sr.x, OY = sr.y;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    if (!occ[j * nx + i]) continue;
    const a = j * (nx + 1) + i, b = a + 1, c = a + nx + 1, d = c + 1;
    const su = [OX + (i / nx) * W, OY + (j / ny) * H], sr2 = [OX + ((i + 1) / nx) * W, OY + (j / ny) * H];
    const sl = [OX + (i / nx) * W, OY + ((j + 1) / ny) * H], sd = [OX + ((i + 1) / nx) * W, OY + ((j + 1) / ny) * H];
    const P2 = v => [sp[v * 2], sp[v * 2 + 1]];
    drawTri(ctx, img, [...su, ...sr2, ...sl], [...P2(a), ...P2(b), ...P2(c)]);
    drawTri(ctx, img, [...sr2, ...sd, ...sl], [...P2(b), ...P2(d), ...P2(c)]);
  }
  if (wire) {
    ctx.strokeStyle = 'rgba(77,226,197,.55)'; ctx.lineWidth = 1; ctx.beginPath();
    for (let j = 0; j <= ny; j++) for (let i = 0; i <= nx; i++) {
      const a = j * (nx + 1) + i;
      if (i < nx) { ctx.moveTo(sp[a * 2], sp[a * 2 + 1]); ctx.lineTo(sp[(a + 1) * 2], sp[(a + 1) * 2 + 1]); }
      if (j < ny) { ctx.moveTo(sp[a * 2], sp[a * 2 + 1]); ctx.lineTo(sp[(a + nx + 1) * 2], sp[(a + nx + 1) * 2 + 1]); }
    }
    ctx.stroke();
  }
}


// ───────────────────────── API usada pelo rig.js ─────────────────────────

/** Pontos de controle atuais como [{x,y}] (espaço de repouso da camada), linha a linha. */
export function warpPoints(layer, warp, values = {}) {
  const w = normalizeWarp(warp);
  const ev = evalWarp({ ...layer, warp: w }, values), out = [];
  for (let k = 0; k < ev.pts.length; k += 2) out.push({ x: ev.pts[k], y: ev.pts[k + 1] });
  return out;
}

/**
 * Desenha a camada com malha deformada. O ctx já está com a matriz (view × mundo) da camada.
 * `ancs` = deformadores ancestrais [{layer, ev}] cujo deslocamento é herdado (pode ser vazio).
 */
const gridCache = new WeakMap();
/** Parte estática (coordenadas de origem e triângulos das células ocupadas) de uma malha em grade. */
function gridStatic(img, nx, ny, sr) {
  let m = gridCache.get(img);
  if (!m) gridCache.set(img, (m = new Map()));
  const key = nx + 'x' + ny + '@' + [sr.x, sr.y, sr.w, sr.h].join(',');
  let g = m.get(key);
  if (g) return g;
  const occ = occupancy(img, nx, ny, sr), src = new Float32Array((nx + 1) * (ny + 1) * 2), idx = [];
  for (let j = 0; j <= ny; j++) for (let i = 0; i <= nx; i++) { const o = (j * (nx + 1) + i) * 2; src[o] = sr.x + (i / nx) * sr.w; src[o + 1] = sr.y + (j / ny) * sr.h; }
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    if (!occ[j * nx + i]) continue;
    const a = j * (nx + 1) + i, b = a + 1, c = a + nx + 1, d = c + 1;
    idx.push(a, b, c, b, d, c);
  }
  g = { src, idx: new Uint32Array(idx) };
  m.set(key, g);
  return g;
}
/** Geometria para o renderizador GPU: null = sem deformação (basta um quadrilátero). */
export function warpGeometry(layer, warp, values, ancs, img, force = false, post = null) {
  const L = warp ? { ...layer, warp: normalizeWarp(warp) } : layer;
  const ev = warp ? evalWarp(L, values) : null;
  const flat = a => a.every(x => Math.abs(x) < 1e-6);
  if (!force && !post && (!ev || flat(ev.delta)) && ancs.every(a => flat(a.ev.delta))) return null;
  const [nx, ny] = regionRes(L), R = rectOf(L);
  const st = gridStatic(img, nx, ny, { x: R.x - layer.x, y: R.y - layer.y, w: R.w, h: R.h });
  const verts = buildVerts(L, ev, ancs, nx, ny);
  if (post) post(verts, nx, ny, R);
  return { verts, nx, ny, src: st.src, idx: st.idx };
}
/** Linhas da malha (para o modo "mostrar malha") sobre o canvas 2D. M = view × mundo. */
export function drawWireLines(ctx, verts, nx, ny, M) {
  const sp = i => [M.a * verts[i * 2] + M.c * verts[i * 2 + 1] + M.e, M.b * verts[i * 2] + M.d * verts[i * 2 + 1] + M.f];
  ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.strokeStyle = 'rgba(77,226,197,.55)'; ctx.lineWidth = 1; ctx.beginPath();
  for (let j = 0; j <= ny; j++) for (let i = 0; i <= nx; i++) {
    const a = j * (nx + 1) + i, A = sp(a);
    if (i < nx) { ctx.moveTo(A[0], A[1]); const B = sp(a + 1); ctx.lineTo(B[0], B[1]); }
    if (j < ny) { ctx.moveTo(A[0], A[1]); const B = sp(a + nx + 1); ctx.lineTo(B[0], B[1]); }
  }
  ctx.stroke();
}
export function drawWarped(ctx, img, layer, warp, values, _scale, ancs = [], wire = false, post = null) {
  const M = ctx.getTransform();
  const L = warp ? { ...layer, warp: normalizeWarp(warp) } : layer;
  const ev = warp ? evalWarp(L, values) : null;
  // neutro: sem deformação própria nem herdada → caminho rápido (e sem emendas de malha)
  const flat = a => a.every(x => Math.abs(x) < 1e-6);
  if ((!ev || flat(ev.delta)) && ancs.every(a => flat(a.ev.delta)) && !wire && !post) {
    ctx.drawImage(img, layer.x, layer.y);
    return;
  }
  const [nx, ny] = regionRes(L);
  const verts = buildVerts(L, ev, ancs, nx, ny);
  if (post) post(verts, nx, ny, rectOf(L));
  drawMesh(ctx, img, layer, verts, nx, ny, M, { wire });
}
