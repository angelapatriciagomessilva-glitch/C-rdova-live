// anim.js — animações por keyframes sobre os parâmetros do rig.
//
// animation = { id, name, duration (s), fps, loop,
//               tracks: { [paramId]: [ { t, v, e }, ... ] } }      (chaves ordenadas por t)
// e = interpolação do trecho que SAI da chave:
//     'spline' (curva suave que passa pelas chaves, sem overshoot), 'linear', 'smooth' (ease in-out), 'hold' (degrau)
import { PARAM_MAP } from './params.js';

export const EASES = [['spline', 'Suave (spline)'], ['linear', 'Linear'], ['smooth', 'Ease in-out'], ['hold', 'Degrau']];
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const r3 = x => Math.round(x * 1000) / 1000;

export function newAnimation(name = 'Animação', duration = 4, fps = 30) {
  return { id: 'A' + Date.now().toString(36) + Math.floor(Math.random() * 1e4), name, duration, fps, loop: true, tracks: {} };
}

/** Aceita dados incompletos/antigos e devolve uma animação válida. */
export function normalizeAnim(a) {
  if (!a || typeof a !== 'object') return null;
  const out = newAnimation(String(a.name || 'Animação'), clamp(+a.duration || 4, 0.2, 600), clamp(Math.round(+a.fps || 30), 5, 120));
  out.id = String(a.id || out.id); out.loop = a.loop !== false;
  for (const [p, keys] of Object.entries(a.tracks || {})) {
    if (!PARAM_MAP[p] || !Array.isArray(keys)) continue;
    const ks = keys.filter(k => k && Number.isFinite(k.t) && Number.isFinite(k.v))
      .map(k => ({ t: clamp(k.t, 0, out.duration), v: k.v, e: EASES.some(x => x[0] === k.e) ? k.e : 'spline' }))
      .sort((x, y) => x.t - y.t);
    if (ks.length) out.tracks[p] = ks;
  }
  return out;
}

function tangent(keys, i) {
  const n = keys.length;
  if (n < 2) return 0;
  const a = keys[Math.max(0, i - 1)], b = keys[Math.min(n - 1, i + 1)], dt = b.t - a.t;
  return dt > 0 ? (b.v - a.v) / dt : 0;
}

function segment(keys, i, t) {
  const k0 = keys[i], k1 = keys[i + 1], dt = k1.t - k0.t || 1e-6, s = (t - k0.t) / dt;
  switch (k0.e || 'spline') {
    case 'hold': return k0.v;
    case 'linear': return k0.v + (k1.v - k0.v) * s;
    case 'smooth': return k0.v + (k1.v - k0.v) * (s * s * (3 - 2 * s));
    default: {                                   // Hermite cúbico com tangentes de Catmull-Rom (limitadas p/ não passar do alvo)
      const slope = (k1.v - k0.v) / dt;
      let m0 = tangent(keys, i), m1 = tangent(keys, i + 1);
      if (m0 * slope <= 0) m0 = 0;
      if (m1 * slope <= 0) m1 = 0;
      const s2 = s * s, s3 = s2 * s;
      return (2 * s3 - 3 * s2 + 1) * k0.v + (s3 - 2 * s2 + s) * dt * m0 + (-2 * s3 + 3 * s2) * k1.v + (s3 - s2) * dt * m1;
    }
  }
}

export function evalTrack(keys, t, param) {
  let v;
  if (!keys.length) return null;
  if (t <= keys[0].t) v = keys[0].v;
  else if (t >= keys[keys.length - 1].t) v = keys[keys.length - 1].v;
  else {
    let i = 0;
    while (i < keys.length - 2 && t > keys[i + 1].t) i++;
    v = segment(keys, i, t);
  }
  return param ? clamp(v, param.min, param.max) : v;
}

/** Valor de cada parâmetro animado no instante t. */
export function sampleAnim(a, t) {
  const out = {};
  for (const [p, keys] of Object.entries(a.tracks)) if (keys.length && PARAM_MAP[p]) out[p] = evalTrack(keys, t, PARAM_MAP[p]);
  return out;
}

/** Cria ou atualiza a chave de `param` no tempo t (chaves a menos de meio quadro são a mesma). */
export function setKey(a, param, t, v, e) {
  t = r3(clamp(t, 0, a.duration));
  const track = (a.tracks[param] ||= []);
  const hit = track.find(k => Math.abs(k.t - t) < 0.5 / a.fps);
  if (hit) { hit.v = v; if (e) hit.e = e; return hit; }
  const key = { t, v, e: e || 'spline' };
  track.push(key); track.sort((x, y) => x.t - y.t);
  return key;
}

export function removeKey(a, param, key) {
  const track = a.tracks[param];
  if (!track) return;
  a.tracks[param] = track.filter(k => k !== key);
  if (!a.tracks[param].length) delete a.tracks[param];
}

export function moveKey(a, param, key, t) {
  key.t = r3(clamp(t, 0, a.duration));
  a.tracks[param].sort((x, y) => x.t - y.t);
}

/** Copia o primeiro valor de cada trilha para o fim da animação (loop sem salto). */
export function closeLoop(a) {
  for (const [p, keys] of Object.entries(a.tracks)) {
    if (!keys.length) continue;
    setKey(a, p, a.duration, keys[0].v, keys[0].e);
  }
}

/** Ramer–Douglas–Peucker em (t, v): reduz amostras gravadas a poucas chaves mantendo o erro ≤ eps. */
export function simplify(samples, eps) {
  if (samples.length < 3) return samples.slice();
  const keep = new Uint8Array(samples.length);
  keep[0] = keep[samples.length - 1] = 1;
  const stack = [[0, samples.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    const A = samples[a], B = samples[b];
    let worst = -1, wi = -1;
    for (let i = a + 1; i < b; i++) {
      const s = (samples[i].t - A.t) / (B.t - A.t || 1e-6);
      const err = Math.abs(samples[i].v - (A.v + (B.v - A.v) * s));
      if (err > worst) { worst = err; wi = i; }
    }
    if (worst > eps) { keep[wi] = 1; stack.push([a, wi], [wi, b]); }
  }
  return samples.filter((_, i) => keep[i]);
}

/** Transforma amostras gravadas { param: [{t,v}] } em trilhas simplificadas dentro da animação. */
export function applyRecording(a, data, length) {
  let total = 0;
  for (const [p, samples] of Object.entries(data)) {
    const def = PARAM_MAP[p];
    if (!def || samples.length < 2) continue;
    const keys = simplify(samples, 0.01 * (def.max - def.min)).map(s => ({ t: r3(s.t), v: r3(s.v), e: 'spline' }));
    a.tracks[p] = keys; total += keys.length;
  }
  a.duration = clamp(Math.ceil(length * 10) / 10, 0.5, 600);
  for (const keys of Object.values(a.tracks)) for (const k of keys) k.t = Math.min(k.t, a.duration);
  return total;
}
