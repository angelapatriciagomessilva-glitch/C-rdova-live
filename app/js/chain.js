// chain.js — Física 2D por cadeia de pontos (pêndulo + mola) e deformação da malha por Linear Blend Skinning.
//
// Cada camada pode ter `layer.chain = { on, pts:[{x,y}…], swingIntensity, elasticity, damping, delay, freq, gravity, volume, softness }`.
// pts[0] é a raiz (âncora): acompanha a camada/pai. Os demais pontos seguem o anterior com mola:
//   • perpendicular ao segmento → balanço de pêndulo (inércia lateral/rotacional, efeito chicote);
//   • ao longo do segmento      → mola de Hooke + amortecimento (estica/comprime e volta com um leve quique).
// A simulação roda no espaço do mundo (a raiz é a camada transformada pelo rig); a deformação roda no espaço da camada.

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
export const MAX_CHAIN_POINTS = 24;

export const CHAIN_PRESETS = {
  cabelo:  { label: 'Cabelo longo',        swingIntensity: 1.2, elasticity: 0.5, damping: 0.3,  delay: 0.45, freq: 2.4, gravity: 0.5, volume: 0.3, softness: 1.0 },
  cilios:  { label: 'Cílios',              swingIntensity: 0.8, elasticity: 1.4, damping: 0.22, delay: 0.15, freq: 5.5, gravity: 0.1, volume: 0.5, softness: 0.9 },
  orelha:  { label: 'Orelha / acessório',  swingIntensity: 1.0, elasticity: 1.0, damping: 0.25, delay: 0.3,  freq: 3.6, gravity: 0.3, volume: 0.5, softness: 1.0 },
  ponta:   { label: 'Ponta de cabelo',     swingIntensity: 1.6, elasticity: 1.2, damping: 0.18, delay: 0.6,  freq: 3.2, gravity: 0.35, volume: 0.4, softness: 0.8 },
};

export function normalizeChain(c) {
  if (!c || typeof c !== 'object') return null;
  const n = (v, d, a, b) => clamp(Number.isFinite(+v) ? +v : d, a, b);
  const pts = (Array.isArray(c.pts) ? c.pts : []).filter(p => p && Number.isFinite(+p.x) && Number.isFinite(+p.y)).slice(0, MAX_CHAIN_POINTS).map(p => ({ x: +p.x, y: +p.y }));
  return {
    on: c.on !== false, pts, ver: (c.ver | 0) || 1,
    swingIntensity: n(c.swingIntensity, 1, 0, 4), elasticity: n(c.elasticity, 1, 0, 4), damping: n(c.damping, 0.3, 0.03, 2), delay: n(c.delay, 0.3, 0, 3),
    freq: n(c.freq, 3.5, 0.5, 9), gravity: n(c.gravity, 0.3, 0, 3), volume: n(c.volume, 0.5, 0, 1), softness: n(c.softness, 1, 0.3, 3),
  };
}
export const chainValid = c => !!(c && c.on && c.pts.length >= 2);

/** Cria o estado de simulação (posições/velocidades no espaço do mundo). W = DOMMatrix mundo da camada. */
export function chainInit(c, W) {
  const N = c.pts.length, P = new Float64Array(N * 2);
  for (let k = 0; k < N; k++) { const q = W.transformPoint({ x: c.pts[k].x, y: c.pts[k].y }); P[k * 2] = q.x; P[k * 2 + 1] = q.y; }
  return { n: N, ver: c.ver, P, V: new Float64Array(N * 2), R: [P[0], P[1]], active: false };
}

/** Avança a simulação dt segundos. Retorna true se ainda há movimento (para o laço de redesenho). */
export function chainStep(c, st, W, dt) {
  const N = st.n, pts = c.pts, P = st.P, V = st.V;
  const q0 = W.transformPoint({ x: pts[0].x, y: pts[0].y });
  if (Math.hypot(q0.x - st.R[0], q0.y - st.R[1]) > 900) return chainReset(c, st, W);
  const d = Math.min(dt, 0.05), steps = Math.max(1, Math.ceil(d * 120)), h = d / steps;
  const rvx = d > 0 ? (q0.x - st.R[0]) / d : 0, rvy = d > 0 ? (q0.y - st.R[1]) / d : 0;
  st.R[0] = q0.x; st.R[1] = q0.y;
  const gk = c.gravity * 0.08, zeta = c.damping;                      // gravidade: fração do comprimento do segmento (só a parte perpendicular → pendura sem alongar)
  let moving = Math.hypot(rvx, rvy) > 0.5;
  for (let s = 0; s < steps; s++) {
    const t = (s + 1) / steps;
    // raiz: posição interpolada no frame (sem saltos) e velocidade da raiz
    P[0] = q0.x - rvx * d * (1 - t); P[1] = q0.y - rvy * d * (1 - t); V[0] = rvx; V[1] = rvy;
    for (let k = 1; k < N; k++) {
      const dx = pts[k].x - pts[k - 1].x, dy = pts[k].y - pts[k - 1].y;
      const ax = W.a * dx + W.c * dy, ay = W.b * dx + W.d * dy, len0 = Math.hypot(ax, ay) || 1e-6, ux = ax / len0, uy = ay / len0;
      const ex = P[(k - 1) * 2] + ax - P[k * 2], ey = P[(k - 1) * 2 + 1] + ay - P[k * 2 + 1];
      const epar = ex * ux + ey * uy, epx = ex - epar * ux, epy = ey - epar * uy;
      const w = 2 * Math.PI * c.freq / (1 + c.delay * (k - 1)), ks = w * w;
      // velocidade relativa ao ponto anterior (movimento rígido do conjunto não é amortecido)
      const rx = V[k * 2] - V[(k - 1) * 2], ry = V[k * 2 + 1] - V[(k - 1) * 2 + 1];
      const rpar = rx * ux + ry * uy, rpx = rx - rpar * ux, rpy = ry - rpar * uy;
      const cp = 2 * zeta * w, ca = 2 * zeta * 0.45 * w;                    // axial: menos amortecimento → quique
      const kax = ks * 0.7;
      const accPar = kax * epar - ca * rpar;
      const gp = -uy * 0 + (1 - uy * uy) * 1, gx = -ux * uy;            // componente de (0,1) perpendicular a u
      const gacc = gk * ks * len0;
      V[k * 2] += (ks * epx - cp * rpx + accPar * ux + gacc * gx) * h;
      V[k * 2 + 1] += (ks * epy - cp * rpy + accPar * uy + gacc * gp) * h;
      P[k * 2] += V[k * 2] * h; P[k * 2 + 1] += V[k * 2 + 1] * h;
      // limite de esticamento
      const sx = P[k * 2] - P[(k - 1) * 2], sy = P[k * 2 + 1] - P[(k - 1) * 2 + 1], sl = Math.hypot(sx, sy), mx = len0 * 2.2, mn = len0 * 0.25;
      if (sl > mx || sl < mn) { const f = clamp(sl, mn, mx) / (sl || 1e-6); P[k * 2] = P[(k - 1) * 2] + sx * f; P[k * 2 + 1] = P[(k - 1) * 2 + 1] + sy * f; }
    }
  }
  for (let k = 1; k < N && !moving; k++) if (Math.hypot(V[k * 2] - V[(k - 1) * 2], V[k * 2 + 1] - V[(k - 1) * 2 + 1]) > 0.35) moving = true;
  // desvio em relação à pose de repouso (com a gravidade a pose assenta fora do repouso e para)
  st.active = moving;
  return moving;
}
function chainReset(c, st, W) { const n = chainInit(c, W); Object.assign(st, n); return false; }

/** Pose simulada no espaço da camada, já com amplificação de balanço/elasticidade. Retorna Float64Array [x,y…] ou null se igual ao repouso. */
export function chainPose(c, st, W) {
  const N = st.n, pts = c.pts, inv = W.inverse(), D = new Float64Array(N * 2);
  D[0] = pts[0].x; D[1] = pts[0].y;
  let dev = 0;
  for (let k = 1; k < N; k++) {
    const q = inv.transformPoint({ x: st.P[k * 2], y: st.P[k * 2 + 1] }), p = inv.transformPoint({ x: st.P[(k - 1) * 2], y: st.P[(k - 1) * 2 + 1] });
    const sx = q.x - p.x, sy = q.y - p.y;                                   // segmento simulado (espaço da camada)
    const rx = pts[k].x - pts[k - 1].x, ry = pts[k].y - pts[k - 1].y, len0 = Math.hypot(rx, ry) || 1e-6, ux = rx / len0, uy = ry / len0;
    const par = sx * ux + sy * uy, px = sx - par * ux, py = sy - par * uy;
    const L = len0 + (par - len0) * c.elasticity;                           // elasticidade: quanto estica/comprime
    const gx = ux * L + px * c.swingIntensity, gy = uy * L + py * c.swingIntensity;   // balanço lateral
    D[k * 2] = D[(k - 1) * 2] + gx; D[k * 2 + 1] = D[(k - 1) * 2 + 1] + gy;
    dev = Math.max(dev, Math.abs(D[k * 2] - pts[k].x), Math.abs(D[k * 2 + 1] - pts[k].y));
  }
  return dev < 0.03 ? null : D;
}

const wcache = new WeakMap();
function weights(c, rest, key) {
  let e = wcache.get(c);
  if (e && e.key === key) return e;
  const pts = c.pts, B = pts.length - 1, nv = rest.length / 2;
  const W = new Float32Array(nv * B), A = new Float32Array(nv * B), Q = new Float32Array(nv * B);
  let avg = 0; for (let j = 1; j <= B; j++) avg += Math.hypot(pts[j].x - pts[j - 1].x, pts[j].y - pts[j - 1].y); avg /= B;
  const sig = Math.max(8, avg * c.softness * 0.9), inv2 = 1 / (sig * sig);
  for (let i = 0; i < nv; i++) {
    const vx = rest[i * 2], vy = rest[i * 2 + 1];
    let sum = 0, best = 0, bd = Infinity;
    for (let j = 1; j <= B; j++) {
      const ox = pts[j - 1].x, oy = pts[j - 1].y, dx = pts[j].x - ox, dy = pts[j].y - oy, l2 = dx * dx + dy * dy || 1e-6, len = Math.sqrt(l2);
      const a = ((vx - ox) * dx + (vy - oy) * dy) / len, b = (-(vx - ox) * dy + (vy - oy) * dx) / len;   // coords locais ao osso
      const t = clamp(a / len, 0, 1), cx = ox + dx * t, cy = oy + dy * t, d2 = (vx - cx) ** 2 + (vy - cy) ** 2;
      const k = i * B + (j - 1);
      A[k] = a; Q[k] = b;
      const wj = Math.exp(-d2 * inv2); W[k] = wj; sum += wj;
      if (d2 < bd) { bd = d2; best = j - 1; }
    }
    if (sum < 1e-4) { for (let j = 0; j < B; j++) W[i * B + j] = j === best ? 1 : 0; sum = 1; }
    for (let j = 0; j < B; j++) W[i * B + j] /= sum;
  }
  e = { key, W, A, Q, B };
  wcache.set(c, e);
  return e;
}

/** Deforma `pos` (flat [x,y…], mesmo espaço da camada) somando o deslocamento LBS calculado a partir de `rest` (flat). */
export function applyChain(c, D, pos, rest, key) {
  const { W, A, Q, B } = weights(c, rest, key + '|' + c.ver + '|' + c.softness), pts = c.pts, nv = rest.length / 2;
  // transformação de cada osso: origem deformada, eixo deformado, escalas (estica ao longo / comprime na perpendicular)
  const ox = new Float64Array(B), oy = new Float64Array(B), ux = new Float64Array(B), uy = new Float64Array(B), sa = new Float64Array(B), sp = new Float64Array(B);
  for (let j = 0; j < B; j++) {
    const rx = pts[j + 1].x - pts[j].x, ry = pts[j + 1].y - pts[j].y, len0 = Math.hypot(rx, ry) || 1e-6;
    const dx = D[(j + 1) * 2] - D[j * 2], dy = D[(j + 1) * 2 + 1] - D[j * 2 + 1], len = Math.hypot(dx, dy) || 1e-6;
    ox[j] = D[j * 2]; oy[j] = D[j * 2 + 1]; ux[j] = dx / len; uy[j] = dy / len;
    sa[j] = len / len0; sp[j] = Math.pow(len / len0, -c.volume);
  }
  for (let i = 0; i < nv; i++) {
    let x = 0, y = 0;
    for (let j = 0; j < B; j++) {
      const w = W[i * B + j]; if (w < 1e-4) continue;
      const a = A[i * B + j] * sa[j], b = Q[i * B + j] * sp[j];
      x += w * (ox[j] + ux[j] * a - uy[j] * b); y += w * (oy[j] + uy[j] * a + ux[j] * b);
    }
    pos[i * 2] += x - rest[i * 2]; pos[i * 2 + 1] += y - rest[i * 2 + 1];
  }
}

/** Posições de repouso de uma grade (nx×ny) sobre o retângulo R. */
export function gridRest(R, nx, ny) {
  const out = new Float32Array((nx + 1) * (ny + 1) * 2);
  for (let j = 0; j <= ny; j++) for (let i = 0; i <= nx; i++) { const o = (j * (nx + 1) + i) * 2; out[o] = R.x + R.w * i / nx; out[o + 1] = R.y + R.h * j / ny; }
  return out;
}

/** Gera uma cadeia vertical automática dentro de `box` (raiz no topo, n pontos). */
export function autoChain(box, n = 5) {
  const pts = []; for (let k = 0; k < n; k++) pts.push({ x: Math.round(box.x + box.w / 2), y: Math.round(box.y + box.h * (0.04 + 0.92 * k / (n - 1))) });
  return pts;
}
