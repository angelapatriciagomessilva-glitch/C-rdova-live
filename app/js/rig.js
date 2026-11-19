import { PARAMS, PARAM_MAP, setCustomParams, getCustomParams } from './params.js';
import { normalizeChain, chainValid, chainInit, chainStep, chainPose, applyChain, gridRest, CHAIN_PRESETS } from './chain.js';
import { cloneWarp, drawWarped, warpPoints, evalWarp, normalizeWarp, warpGeometry, contentBox, barPoint, barU } from './warp.js';
import { normalizeAnim } from './anim.js';
import { GL_APPROX_BLENDS } from './gl.js';
import { meshPositions, drawMeshLayer, drawMeshOverlay, hitVertex, normalizeMesh } from './mesh.js';

export const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

/** Curva multiponto [{p,o}] (p crescente): interpolação linear, constante fora da faixa. */
export function evalCurve(keys, v) {
  if (v <= keys[0].p) return keys[0].o;
  const n = keys.length;
  if (v >= keys[n - 1].p) return keys[n - 1].o;
  let i = 1; while (keys[i].p < v) i++;
  const a = keys[i - 1], b = keys[i], t = (v - a.p) / ((b.p - a.p) || 1);
  return a.o + (b.o - a.o) * t;
}

export function loadImage(src) {
  return new Promise((res, rej) => {
    const img = new Image();
    img.onload = () => res(img);
    img.onerror = () => rej(new Error('Falha ao carregar imagem'));
    img.src = src;
  });
}

let uid = 1;

export const BLENDS = [['source-over', 'Normal'], ['multiply', 'Multiplicar'], ['screen', 'Tela'], ['overlay', 'Sobrepor'],
  ['lighter', 'Somar (brilho)'], ['soft-light', 'Luz suave'], ['darken', 'Escurecer'], ['lighten', 'Clarear']];
export const OSC_PROPS = [['rot', 'Rotação (°)'], ['x', 'Mover X'], ['y', 'Mover Y'], ['sx', 'Escala X'], ['sy', 'Escala Y']];
/** Imagem 1×1 transparente usada pelos clips (grupos sem imagem própria). */
export const CLIP_SRC = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
/** Molengo (jelly): mola que segue o movimento do pivô e gera atraso, balanço e estica/achata. */
export const JELLY_PRESETS = {
  pupila: { label: 'Pupila (gelatina)', freq: 4.5, damp: 0.18, amt: 1, move: 0.5, stretch: 0.8, swing: 0, axis: 'xy' },
  cabelo: { label: 'Cabelo (balanço)',  freq: 2.2, damp: 0.22, amt: 1, move: 0.7, stretch: 0.25, swing: 1, axis: 'x' },
  corpo:  { label: 'Corpo (mole)',      freq: 2.8, damp: 0.3,  amt: 1, move: 0.35, stretch: 0.6, swing: 0.2, axis: 'y' },
  bochecha: { label: 'Bochecha / carne', freq: 3.6, damp: 0.2, amt: 1, move: 0.4, stretch: 1.2, swing: 0, axis: 'xy' },
};
export function normalizeJelly(j) {
  if (!j || typeof j !== 'object') return null;
  const n = (v, d, a, b) => clamp(Number.isFinite(+v) ? +v : d, a, b);
  return { on: j.on !== false, freq: n(j.freq, 3, 0.3, 12), damp: n(j.damp, 0.25, 0.03, 2), amt: n(j.amt, 1, 0, 3), move: n(j.move, 0.5, 0, 1.5),
    stretch: n(j.stretch, 0.8, 0, 3), swing: n(j.swing, 0, 0, 3), kick: n(j.kick, 1, 0, 4), invert: !!j.invert, axis: ['xy', 'x', 'y'].includes(j.axis) ? j.axis : 'xy', param: typeof j.param === 'string' ? j.param : '' };
}
/** Ordem de desenho por parâmetro: { param, keys:[{ p: valor do parâmetro, o: deslocamento na pilha (+ = mais à frente) }] }. */
export function normalizeZord(z) {
  if (!z || typeof z.param !== 'string' || !Array.isArray(z.keys)) return null;
  const keys = z.keys.filter(k => k && Number.isFinite(k.p) && Number.isFinite(k.o)).map(k => ({ p: k.p, o: clamp(k.o, -500, 500) })).sort((a, b) => a.p - b.p);
  return keys.length ? { param: z.param, keys } : null;
}
const jclone = o => JSON.parse(JSON.stringify(o));
const cloneBinding = b => jclone(b);
/** Cópia profunda de uma camada (sem imagens). */
export function cloneLayer(l) {
  return { ...l, bindings: l.bindings.map(cloneBinding), osc: (l.osc || []).map(o => ({ ...o })),
    warp: l.warp ? cloneWarp(l.warp) : null, mesh: l.mesh ? jclone(l.mesh) : null, jelly: l.jelly ? { ...l.jelly } : null, chain: l.chain ? { ...l.chain, pts: l.chain.pts.map(p => ({ ...p })) } : null };
}

/**
 * Rig 2D: camadas de imagem em hierarquia. Cada camada tem uma pose de repouso
 * (x, y = canto sup. esq.; px, py = pivô em coordenadas da tela) e uma lista de
 * bindings parâmetro → propriedade que deformam a camada (e as filhas).
 */
export class Rig {
  constructor() { this.reset(); }

  reset() {
    this.name = 'Novo modelo';
    this.w = 800; this.h = 1100;
    this.layers = [];
    this.animations = [];
    this.physics = [];       // molas: { id, name, input, output, freq, damp, gain }
    this.expressions = [];   // { id, name, values:{param:valor}, fade }
    this.exprW = {};         // runtime: peso atual/alvo de cada expressão
    this._phys = new Map();
    this._chain = new Map(); this.chainActive = false; this.chainEdit = null;
    this._jel = new Map(); this._jt = new Map(); this.jellyActive = false;
    this.time = 0;
    this.images = new Map();
    setCustomParams([]);
    this.values = {};
    for (const p of PARAMS) this.values[p.id] = p.def;
    this._alpha = new Map();
    this._meshPos = new Map();
    this._idxCache = new WeakMap();
    this.rev = (this.rev || 0) + 1;
  }

  /** Depois de mudar a lista de parâmetros: cria valores que faltam e remove os órfãos. */
  syncValues() {
    for (const p of PARAMS) if (!(p.id in this.values)) this.values[p.id] = p.def;
    for (const k of Object.keys(this.values)) if (!PARAM_MAP[k]) delete this.values[k];
  }

  /** Física (molas) + expressões, depois dos valores base. Chamar uma vez por quadro. */
  tick(dt) {
    this.time += dt;
    const V = this.values;
    const steps = Math.max(1, Math.ceil(dt * 120)), h = dt / steps;
    for (const ph of this.physics) {
      const inp = PARAM_MAP[ph.input], out = PARAM_MAP[ph.output];
      if (!inp || !out) continue;
      const n = (V[ph.input] - inp.def) / (((inp.max - inp.min) / 2) || 1);
      let st = this._phys.get(ph.id);
      if (!st) { st = { p: n, v: 0 }; this._phys.set(ph.id, st); }
      const w = 2 * Math.PI * clamp(ph.freq ?? 2, 0.2, 12), k = w * w, c = 2 * clamp(ph.damp ?? 0.35, 0.02, 2) * w;
      for (let i = 0; i < steps; i++) { st.v += (k * (n - st.p) - c * st.v) * h; st.p += st.v * h; }
      V[ph.output] = clamp((st.p - n) * (ph.gain ?? 2), out.min, out.max);
    }
    this._tickJelly(dt);
    for (const ex of this.expressions) {
      const e = this.exprW[ex.id]; if (!e) continue;
      const rate = dt / Math.max(0.02, ex.fade ?? 0.15);
      e.w += clamp(e.target - e.w, -rate, rate);
      if (e.w <= 0.001) continue;
      for (const [pid, val] of Object.entries(ex.values)) if (PARAM_MAP[pid]) V[pid] += (val - V[pid]) * e.w;
    }
    this._tickChains(dt);                    // por último: usa os parâmetros finais deste quadro
  }
  /** Molas do "molengo": cada camada com jelly persegue o pivô (espaço do mundo) com atraso e oscilação. */
  _tickJelly(dt) {
    let active = false;
    const d = Math.min(dt, 0.05), steps = Math.max(1, Math.ceil(d * 120)), h = d / steps;
    for (const l of this.layers) {
      const j = l.jelly;
      if (!j || !j.on) { this._jel.delete(l.id); continue; }
      const t = this._jt.get(l.id); if (!t) continue;
      let st = this._jel.get(l.id);
      const pr = j.param && PARAM_MAP[j.param];
      if (!st || Math.hypot(t.x - st.x, t.y - st.y) > 600) { st = { x: t.x, y: t.y, vx: 0, vy: 0, tx: t.x, ty: t.y, pv: pr ? this.values[j.param] : 0 }; this._jel.set(l.id, st); }
      const w = 2 * Math.PI * j.freq, k = w * w, c = 2 * j.damp * w;
      if (pr) {
        // Modo gatilho: ignora o movimento do pivô; só uma MUDANÇA do parâmetro escolhido dá o "tranco" na mola, que depois assenta e para.
        st.x += t.x - st.tx; st.y += t.y - st.ty;
        if (this._jelSync) st.pv = this.values[j.param];      // salto de tempo/aba/play: não dá “tranco”
        const dv = clamp((this.values[j.param] - st.pv) / (((pr.max - pr.min) || 1)), -0.4, 0.4);   // limita trancos enormes
        if (dv) {
          const size = Math.max(l.w, l.h, 40) * 0.25 * j.amt * (j.kick ?? 1) * w;
          const sgn = j.invert ? -1 : 1;
          if (j.axis !== 'y') st.vx += sgn * dv * size * 0.6;
          if (j.axis !== 'x') st.vy += sgn * dv * size;
        }
        st.pv = this.values[j.param]; st.tx = t.x; st.ty = t.y;
      }
      for (let i = 0; i < steps; i++) {
        st.vx += (k * (t.x - st.x) - c * st.vx) * h; st.vy += (k * (t.y - st.y) - c * st.vy) * h;
        st.x += st.vx * h; st.y += st.vy * h;
      }
      if (Math.abs(t.x - st.x) > 0.04 || Math.abs(t.y - st.y) > 0.04 || Math.abs(st.vx) > 0.4 || Math.abs(st.vy) > 0.4) active = true;
    }
    this._jelSync = false;
    this.jellyActive = active || this.chainActive;
  }
  /** Chame ao pular no tempo, trocar de aba, tocar/parar a animação: o molengo só reage a mudanças contínuas do parâmetro. */
  jellySync() { this._jelSync = true; }

  /** Física em cadeia: avança as molas de cada camada com chain, usando a transformação de mundo atual da camada. */
  _tickChains(dt) {
    let any = false, act = false;
    for (const l of this.layers) {
      const c = l.chain;
      if (!chainValid(c) || !l.visible) { this._chain.delete(l.id); continue; }
      if (!any) { any = true; this._cw = this.computeWorld(); }
      const W = this._cw.get(l.id)?.m; if (!W) continue;
      let st = this._chain.get(l.id);
      if (!st || st.n !== c.pts.length || st.ver !== c.ver) { st = chainInit(c, W); this._chain.set(l.id, st); }
      if (chainStep(c, st, W, dt)) act = true;
    }
    this.chainActive = act;
    this.jellyActive = this.jellyActive || act;
  }

  /** Função que deforma os vértices da camada pela cadeia (ou null se não há movimento/cadeia). */
  _chainPost(l, W, rest) {
    const c = l.chain; if (!chainValid(c)) return null;
    const st = this._chain.get(l.id); if (!st || st.n !== c.pts.length) return null;
    const D = chainPose(c, st, W); if (!D) return null;
    return (pos, nx, ny, R) => applyChain(c, D, pos, rest ? rest : gridRest(R, nx, ny), rest ? 'm' + rest.length + ':' + (rest[0] || 0) + ':' + (rest[rest.length - 1] || 0) : `g${nx}x${ny}:${R.x},${R.y},${R.w},${R.h}`);
  }

  toggleExpression(id, on) {
    const e = this.exprW[id] ||= { w: 0, target: 0 };
    e.target = on ?? (e.target ? 0 : 1);
    return e.target;
  }

  newId() { return 'L' + Date.now().toString(36) + (uid++); }
  byId(id) { return this.layers.find(l => l.id === id) || null; }
  /** Camadas na ordem de desenho atual: a pilha da lista, ajustada pelas “ordens por parâmetro” (zord). */
  drawOrder() {
    if (!this.layers.some(l => l.zord)) return this.layers;
    const V = this.values, pos = new Map();
    this.layers.forEach((l, i) => { const p = l.zord && PARAM_MAP[l.zord.param]; pos.set(l.id, i + (p ? evalCurve(l.zord.keys, V[l.zord.param] ?? p.def) : 0)); });
    return this.layers.map((l, i) => [l, i]).sort((a, b) => pos.get(a[0].id) - pos.get(b[0].id) || a[1] - b[1]).map(x => x[0]);
  }
  children(id) { return this.layers.filter(l => l.parent === id); }

  descendants(id) {
    const out = [];
    const walk = pid => { for (const c of this.children(pid)) { out.push(c); walk(c.id); } };
    walk(id);
    return out;
  }

  depth(l) {
    let d = 0, cur = l, guard = 0;
    while (cur && cur.parent && guard++ < 50) { cur = this.byId(cur.parent); d++; }
    return d;
  }

  async addLayer({ name, src, x, y, parent = null, bindings = [], pivot, id, warp = null, mesh = null, osc = [], opacity = 1, blend = 'source-over', clip = false, jelly = null, chain = null, mask = null, zord = null, w: cw, h: ch }) {
    const img = await loadImage(src);
    id = id || this.newId();
    this.images.set(id, img);
    let w = img.naturalWidth, h = img.naturalHeight;
    if (clip) { w = Math.max(1, +cw || 1); h = Math.max(1, +ch || 1); }
    x = x ?? Math.round((this.w - w) / 2);
    y = y ?? Math.round((this.h - h) / 2);
    const layer = {
      id, name: name || id, src, x, y, w, h,
      px: pivot ? pivot[0] : x + w / 2,
      py: pivot ? pivot[1] : y + h / 2,
      parent, visible: true, bindings: bindings.map(b => ({ ...b })),
      warp: warp ? cloneWarp(warp) : null,
      mesh: mesh ? normalizeMesh(jclone(mesh)) : null,
      osc: (Array.isArray(osc) ? osc : []).filter(o => o && OSC_PROPS.some(q => q[0] === o.prop)).map(o => ({ prop: o.prop, amp: +o.amp || 0, freq: +o.freq || 0.5, phase: +o.phase || 0 })),
      opacity: clamp(+opacity || 0, 0, 1) || (opacity === 0 ? 0 : 1),
      blend: BLENDS.some(b => b[0] === blend) ? blend : 'source-over',
      jelly: normalizeJelly(jelly),
      chain: normalizeChain(chain),
    };
    if (clip) layer.clip = true;
    if (mask && typeof mask === 'string' && !clip) layer.mask = mask;
    { const z = !clip && normalizeZord(zord); if (z) layer.zord = z; }
    this.layers.push(layer);
    return layer;
  }

  /** Retângulo (coords do rig) do conteúdo visível de uma camada. */
  _rect(l) {
    if (l.clip) return { x: l.x, y: l.y, w: l.w, h: l.h };
    const img = this.images.get(l.id);
    return (img && contentBox(img, l, 0)) || { x: l.x, y: l.y, w: l.w, h: l.h };
  }
  _union(list) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const l of list) { if (l.clip && !l.w) continue; const r = this._rect(l); x0 = Math.min(x0, r.x); y0 = Math.min(y0, r.y); x1 = Math.max(x1, r.x + r.w); y1 = Math.max(y1, r.y + r.h); }
    return Number.isFinite(x0) ? { x: Math.floor(x0), y: Math.floor(y0), w: Math.max(1, Math.ceil(x1 - x0)), h: Math.max(1, Math.ceil(y1 - y0)) } : null;
  }

  /** Cria um clip (grupo sem imagem) que passa a ser o pai das camadas indicadas. Retorna o clip. */
  async createClip(ids, name = 'Clip') {
    const set = new Set(ids), mem = this.layers.filter(l => set.has(l.id));
    if (mem.length < 1) return null;
    const tops = mem.filter(l => !l.parent || !set.has(l.parent));
    const b = this._union(mem) || { x: 0, y: 0, w: 1, h: 1 };
    const clip = await this.addLayer({ name, src: CLIP_SRC, x: b.x, y: b.y, w: b.w, h: b.h, clip: true, parent: tops[0]?.parent || null, pivot: [Math.round(b.x + b.w / 2), Math.round(b.y + b.h / 2)] });
    this.layers.pop();
    this.layers.splice(Math.min(...mem.map(l => this.layers.indexOf(l))), 0, clip);
    for (const t of tops) t.parent = clip.id;
    let cur = clip.parent ? this.byId(clip.parent) : null, g = 0;
    while (cur && g++ < 60) { if (cur.id === clip.id) { clip.parent = null; break; } cur = cur.parent ? this.byId(cur.parent) : null; }
    this.rev++;
    return clip;
  }

  /** Recalcula os limites do clip a partir das camadas dentro dele. */
  recalcClip(id) {
    const c = this.byId(id); if (!c?.clip) return;
    const b = this._union(this.descendants(id)); if (!b) return;
    c.x = b.x; c.y = b.y; c.w = b.w; c.h = b.h;
    if (c.warp?.box) c.warp.box = { ...b };
    this._alpha.delete(id); this.rev++;
  }

  /** Clip mais próximo acima de uma camada (ou null). */
  clipOf(id) {
    let cur = this.byId(id), g = 0;
    while (cur?.parent && g++ < 60) { cur = this.byId(cur.parent); if (cur?.clip) return cur; }
    return null;
  }

  duplicateLayer(id) {
    const l = this.byId(id), img = this.images.get(id);
    if (!l || !img) return null;
    const c = cloneLayer(l); c.id = this.newId(); c.name = l.name + ' cópia';
    this.images.set(c.id, img);
    this.layers.splice(this.layers.indexOf(l) + 1, 0, c);
    return c;
  }

  removeLayer(id) {
    const l = this.byId(id);
    if (!l) return;
    for (const c of this.children(id)) c.parent = l.parent;
    this.layers = this.layers.filter(x => x.id !== id);   // a imagem fica em cache p/ o undo
    for (const x of this.layers) if (x.mask === id) delete x.mask;
  }

  moveZ(id, dir) {
    const i = this.layers.findIndex(l => l.id === id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= this.layers.length) return;
    [this.layers[i], this.layers[j]] = [this.layers[j], this.layers[i]];
  }

  setParent(id, parentId) {
    if (parentId === id) return;
    // impede ciclos
    if (parentId && this.descendants(id).some(d => d.id === parentId)) return;
    const l = this.byId(id);
    if (l) l.parent = parentId || null;
  }

  // ---- deformação ---------------------------------------------------------
  _deform(l, pm) {
    let rot = 0, x = 0, y = 0, sx = 1, sy = 1, op = l.opacity ?? 1, sq = 0, skx = 0, sky = 0;
    for (const b of l.bindings) {
      const p = PARAM_MAP[b.param];
      if (!p) continue;
      let v;
      if (b.keys && b.keys.length >= 2) v = evalCurve(b.keys, this.values[b.param]);
      else {
        const lo = b.pmin ?? p.min, hi = b.pmax ?? p.max;
        const t = hi === lo ? 0 : clamp((this.values[b.param] - lo) / (hi - lo), 0, 1);
        v = b.from + (b.to - b.from) * t;
      }
      switch (b.prop) {
        case 'rot': rot += v; break;
        case 'x': x += v; break;
        case 'y': y += v; break;
        case 'sx': sx *= v; break;
        case 'sy': sy *= v; break;
        case 'op': op *= v; break;
        case 'sq': sq += v; break;
        case 'skx': skx += v; break;
        case 'sky': sky += v; break;
      }
    }
    if (l.osc?.length) for (const o of l.osc) {
      const v = o.amp * Math.sin(2 * Math.PI * (o.freq * this.time + o.phase));
      switch (o.prop) { case 'rot': rot += v; break; case 'x': x += v; break; case 'y': y += v; break; case 'sx': sx *= 1 + v; break; case 'sy': sy *= 1 + v; break; }
    }
    const piv = { x: l.px + x, y: l.py + y };       // pivô sem o molengo (alvo da mola)
    const j = l.jelly;
    if (j?.on) {
      const st = this._jel.get(l.id);
      if (st) {
        const t = this._jt.get(l.id) || piv;
        let lx = t.x - st.x, ly = t.y - st.y;                    // atraso no espaço do mundo
        const inv = pm ? pm.inverse() : null;
        let ax = inv ? inv.a * lx + inv.c * ly : lx, ay = inv ? inv.b * lx + inv.d * ly : ly;
        if (j.axis === 'y') ax = 0; else if (j.axis === 'x') ay = 0;
        const k = j.amt;
        const cap = Math.max(20, Math.max(l.w, l.h) * 0.4), soft = v => cap * Math.tanh(v / cap);
        x -= soft(ax * j.move * k); y -= soft(ay * j.move * k);
        const qx = clamp(-ax * j.stretch * k / Math.max(l.w, 40) * 0.5, -0.5, 0.5), qy = clamp(-ay * j.stretch * k / Math.max(l.h, 40), -0.5, 0.5);
        sx *= (1 + qx) / (1 + qy); sy *= (1 + qy) / (1 + qx);
        rot += -ax * 0.12 * j.swing * k;
      }
    }
    if (sq) { const f = clamp(1 + sq, 0.2, 3); sy *= f; sx /= f; }
    const m = new DOMMatrix().translate(x, y).translate(l.px, l.py).rotate(rot);
    if (skx) m.skewXSelf(skx);
    if (sky) m.skewYSelf(sky);
    m.scaleSelf(sx, sy).translateSelf(-l.px, -l.py);
    return { m, op: clamp(op, 0, 1), piv };
  }

  /** Calcula matriz de mundo e opacidade acumulada de cada camada. */
  computeWorld() {
    const world = new Map();
    const visit = (l, depth) => {
      if (world.has(l.id)) return world.get(l.id);
      const parent = l.parent && depth < 50 ? this.byId(l.parent) : null;
      const pw = parent ? visit(parent, depth + 1) : null;
      const d = this._deform(l, pw ? pw.m : null);
      let W = d.m, op = d.op;
      if (pw) { W = pw.m.multiply(d.m); op *= pw.op; }
      if (l.jelly?.on) this._jt.set(l.id, pw ? pw.m.transformPoint(d.piv) : d.piv);
      const r = { m: W, op };
      world.set(l.id, r);
      return r;
    };
    for (const l of this.layers) visit(l, 0);
    return world;
  }

  /** Deformadores (warp) ancestrais de uma camada, do mais próximo ao mais distante. */
  _warpAncestors(l) {
    const out = [];
    let cur = l.parent ? this.byId(l.parent) : null, guard = 0;
    while (cur && guard++ < 50) {
      if (cur.warp) {
        normalizeWarp(cur.warp);
        let ev = this._evCache?.get(cur.id);
        if (!ev) { ev = evalWarp(cur, this.values); this._evCache?.set(cur.id, ev); }
        out.push({ layer: cur, ev });
      }
      cur = cur.parent ? this.byId(cur.parent) : null;
    }
    return out;
  }

  /** Camada usada como corte (máscara) de `l`: só aparece o que está dentro da forma dela. null se não houver/for inválida. */
  _maskOf(l) {
    if (!l.mask || l.mask === l.id) return null;
    const m = this.byId(l.mask);
    return m && !m.clip && this.images.get(m.id) ? m : null;
  }

  /** Geometria + desenho GPU de uma camada (alpha/mistura dados). */
  _glDraw(gr, l, w, view, alpha, blend, forMask = false) {
    const img = this.images.get(l.id), tex = gr.getTex(img);
    if (!tex) return;
    const M = view.multiply(w.m);
    const ancs = this._warpAncestors(l);
    const hasMesh = !!(l.mesh && l.mesh.tris.length), post = l.chain ? this._chainPost(l, w.m, hasMesh ? l.mesh.verts : null) : null;
    if (hasMesh) {
      const pos = meshPositions(l, l.mesh, this.values, this.meshAncestors(l));
      if (post) post(pos);
      this._meshPos.set(l.id, pos);
      const V = l.mesh.verts, n = V.length, src = this._srcScratch = (this._srcScratch?.length >= n ? this._srcScratch : new Float32Array(n));
      for (let i = 0; i < n; i += 2) { src[i] = V[i] - l.x; src[i + 1] = V[i + 1] - l.y; }
      let idx = this._idxCache.get(l.mesh.tris);
      if (!idx) this._idxCache.set(l.mesh.tris, (idx = new Uint32Array(l.mesh.tris)));
      gr.drawTris(tex, pos, src, idx, M, alpha, blend);
    } else if (l.warp || ancs.length || post) {
      const wire = !forMask && !!(this.wireLayer && this.wireLayer === l.id);
      const g = warpGeometry(l, l.warp, this.values, ancs, img, wire, post);
      if (!g) gr.drawQuad(tex, l.x, l.y, M, alpha, blend);
      else { gr.drawTris(tex, g.verts, g.src, g.idx, M, alpha, blend); if (wire) this._wire = { g, M }; }
    } else gr.drawQuad(tex, l.x, l.y, M, alpha, blend);
  }

  /** view: DOMMatrix da tela do rig → pixels do canvas. */
  /** Desenha com o renderizador GPU (gl.js). Mesma lógica de render(), sem overlay (use drawOverlay). */
  renderGL(gr, view) {
    this._evCache = new Map();
    const world = this.computeWorld();
    this._lastWorld = world; this._lastView = view; this._wire = null;
    gr.begin();
    for (const l of this.drawOrder()) {
      if (!l.visible || (this.solo && this.solo !== l.id)) continue;
      const w = world.get(l.id), img = this.images.get(l.id);
      if (l.clip || !img || w.op <= 0.001) continue;
      if (!gr.getTex(img)) continue;
      const blend = l.blend || 'source-over';
      if (GL_APPROX_BLENDS.has(blend) && !this._warnedBlend) { this._warnedBlend = true; this.onNotice?.(`Modo de mistura “${blend}” é aproximado no modo rápido (GPU). Para exibição exata, use Extras → Renderizador → Compatível.`); }
      const mk = this._maskOf(l);
      if (mk) {                                   // corte: desenha a forma da máscara (deformada) num buffer e recorta a camada por ela
        if (gr.maskKey !== mk.id) { gr.beginMask(); this._glDraw(gr, mk, world.get(mk.id), view, 1, 'source-over', true); gr.endMask(); gr.maskKey = mk.id; }
        gr.useMask(true);
      }
      this._glDraw(gr, l, w, view, w.op, blend);
      if (mk) gr.useMask(false);
    }
    if ((this._sweepN = (this._sweepN || 0) + 1) % 120 === 0) gr.sweep(new Set(this.images.values()));
  }
  drawOverlay(ctx, view, selected) { if (this._lastWorld && selected) this._drawOverlay(ctx, view, this._lastWorld, selected); }

  /** Desenha uma camada (CPU) com a matriz do mundo; alpha e mistura são definidos por quem chama. */
  _paintCPU(ctx, l, w, view, forMask = false) {
    const img = this.images.get(l.id);
    ctx.setTransform(view.multiply(w.m));
    const ancs = this._warpAncestors(l);          // filhos herdam a deformação do warp-pai
    const hasMesh = !!(l.mesh && l.mesh.tris.length), post = l.chain ? this._chainPost(l, w.m, hasMesh ? l.mesh.verts : null) : null;
    if (hasMesh) {
      const pos = meshPositions(l, l.mesh, this.values, this.meshAncestors(l));
      if (post) post(pos);
      this._meshPos.set(l.id, pos);
      drawMeshLayer(ctx, img, l, l.mesh, pos, view.multiply(w.m));
    } else if (l.warp || ancs.length || post) drawWarped(ctx, img, l, l.warp, this.values, 1, ancs, !forMask && !!(this.wireLayer && this.wireLayer === l.id), post);
    else ctx.drawImage(img, l.x, l.y);
  }

  /** Camada com corte, no modo CPU: camada ∩ forma da máscara, só na região da máscara (economiza fill-rate). */
  _paintMasked(ctx, l, w, mk, world, view) {
    const cw = ctx.canvas.width, ch = ctx.canvas.height, mw = world.get(mk.id);
    const M = view.multiply(mw.m), xs = [], ys = [];
    for (const [x, y] of [[mk.x, mk.y], [mk.x + mk.w, mk.y], [mk.x + mk.w, mk.y + mk.h], [mk.x, mk.y + mk.h]]) { const p = M.transformPoint({ x, y }); xs.push(p.x); ys.push(p.y); }
    const bx = Math.min(...xs), by = Math.min(...ys), bw = Math.max(...xs) - bx, bh = Math.max(...ys) - by, pad = Math.max(bw, bh) * 0.3 + 8;
    const rx = Math.max(0, Math.floor(bx - pad)), ry = Math.max(0, Math.floor(by - pad));
    const rw = Math.min(cw, Math.ceil(bx + bw + pad)) - rx, rh = Math.min(ch, Math.ceil(by + bh + pad)) - ry;
    if (rw <= 0 || rh <= 0) return;
    const mkc = k => { let c = this[k]; if (!c || c.width !== cw || c.height !== ch) { c = this[k] = document.createElement('canvas'); c.width = cw; c.height = ch; } return c.getContext('2d'); };
    const g = mkc('_mcL'), gm = mkc('_mcM');
    for (const [q, shape, lw] of [[g, l, w], [gm, mk, mw]]) {
      q.setTransform(1, 0, 0, 1, 0, 0); q.globalAlpha = 1; q.globalCompositeOperation = 'source-over'; q.clearRect(rx, ry, rw, rh);
      q.save(); q.beginPath(); q.rect(rx, ry, rw, rh); q.clip(); this._paintCPU(q, shape, lw, view, true); q.restore();
    }
    g.setTransform(1, 0, 0, 1, 0, 0); g.globalCompositeOperation = 'destination-in'; g.drawImage(gm.canvas, rx, ry, rw, rh, rx, ry, rw, rh); g.globalCompositeOperation = 'source-over';
    ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.globalAlpha = w.op; ctx.globalCompositeOperation = l.blend || 'source-over';
    ctx.drawImage(g.canvas, rx, ry, rw, rh, rx, ry, rw, rh);
  }

  render(ctx, view, { selected = null, overlay = false } = {}) {
    this._evCache = new Map();
    const world = this.computeWorld();
    this._lastWorld = world;
    this._lastView = view;
    for (const l of this.drawOrder()) {
      if (!l.visible || (this.solo && this.solo !== l.id)) continue;
      const w = world.get(l.id);
      const img = this.images.get(l.id);
      if (l.clip || !img || w.op <= 0.001) continue;
      const mk = this._maskOf(l);
      if (mk) { this._paintMasked(ctx, l, w, mk, world, view); continue; }
      ctx.globalAlpha = w.op;
      ctx.globalCompositeOperation = l.blend || 'source-over';
      this._paintCPU(ctx, l, w, view);
    }
    ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
    if (overlay && selected) this._drawOverlay(ctx, view, world, selected);
  }

  _drawOverlay(ctx, view, world, id) {
    const l = this.byId(id), w = world.get(id);
    if (!l || !w) return;
    const M = view.multiply(w.m);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    const pts = [[l.x, l.y], [l.x + l.w, l.y], [l.x + l.w, l.y + l.h], [l.x, l.y + l.h]]
      .map(([x, y]) => M.transformPoint({ x, y }));
    ctx.strokeStyle = '#4de2c5'; ctx.lineWidth = 2; ctx.setLineDash([6, 4]);
    ctx.beginPath(); pts.forEach((p, i) => i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y));
    ctx.closePath(); ctx.stroke(); ctx.setLineDash([]);
    const c = M.transformPoint({ x: l.px, y: l.py });
    ctx.strokeStyle = '#ff5d8f'; ctx.fillStyle = '#ff5d8f'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(c.x, c.y, 8, 0, 7); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(c.x - 13, c.y); ctx.lineTo(c.x + 13, c.y);
    ctx.moveTo(c.x, c.y - 13); ctx.lineTo(c.x, c.y + 13); ctx.stroke();
    this._drawChainOverlay(ctx, M, l);
  }

  /** Pontos e segmentos da cadeia de física (pose de repouso); com a ferramenta Cadeia ativa os pontos ficam maiores. */
  _drawChainOverlay(ctx, M, l) {
    const c = l.chain, ed = this.chainEdit; if (!c || !c.pts.length) return;
    const P = c.pts.map(p => M.transformPoint({ x: p.x, y: p.y })), big = ed?.active;
    ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.lineWidth = 2; ctx.strokeStyle = c.on ? '#ffd166' : '#888';
    ctx.beginPath(); P.forEach((p, i) => i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)); ctx.stroke();
    P.forEach((p, i) => {
      const r = (big ? 9 : 5) * (ed?.dpr || 1), sel = ed?.active && ed.sel === i;
      ctx.fillStyle = i === 0 ? '#ff5d8f' : sel ? '#fff' : '#ffd166'; ctx.strokeStyle = '#1b1f2a'; ctx.lineWidth = 2;
      ctx.beginPath(); if (i === 0) ctx.rect(p.x - r, p.y - r, r * 2, r * 2); else ctx.arc(p.x, p.y, r, 0, 7);
      ctx.fill(); ctx.stroke();
    });
    ctx.restore();
  }

  // ---- seleção por toque --------------------------------------------------
  _alphaAt(l, lx, ly) {
    let c = this._alpha.get(l.id);
    if (!c) {
      c = document.createElement('canvas'); c.width = l.w; c.height = l.h;
      const cx = c.getContext('2d', { willReadFrequently: true });
      cx.drawImage(this.images.get(l.id), 0, 0);
      this._alpha.set(l.id, c);
    }
    return c.getContext('2d', { willReadFrequently: true })
      .getImageData(clamp(lx | 0, 0, l.w - 1), clamp(ly | 0, 0, l.h - 1), 1, 1).data[3];
  }

  /** Converte ponto da tela do rig p/ espaço de repouso da camada. */
  toRest(id, x, y) {
    const w = (this._lastWorld || this.computeWorld()).get(id);
    const p = w.m.inverse().transformPoint({ x, y });
    return { x: p.x, y: p.y };
  }

  pick(x, y) {
    const world = this._lastWorld || this.computeWorld();
    const ord = this.drawOrder();
    for (let i = ord.length - 1; i >= 0; i--) {
      const l = ord[i];
      if (!l.visible || l.clip) continue;
      const p = world.get(l.id).m.inverse().transformPoint({ x, y });
      const lx = p.x - l.x, ly = p.y - l.y;
      if (lx < 0 || ly < 0 || lx >= l.w || ly >= l.h) continue;
      if (this._alphaAt(l, lx, ly) > 20) return l.id;
    }
    return null;
  }

  // ---- warp: hit-test e overlay --------------------------------------------
  /** Índice do ponto de controle mais próximo de (x,y) [espaço do rig], ou -1. */
  warpHit(id, x, y, maxDist) {
    const l = this.byId(id), w = this._lastWorld?.get(id);
    if (!l?.warp || !w) return -1;
    let best = -1, bd = maxDist;
    warpPoints(l, l.warp, this.values).forEach((p, i) => {
      const q = w.m.transformPoint({ x: p.x, y: p.y });
      const d = Math.hypot(q.x - x, q.y - y);
      if (d < bd) { bd = d; best = i; }
    });
    return best;
  }

  /** Barras: acha a alça (h = índice) ou a linha (h = null) mais próxima de (x,y) [espaço do rig]. → { bi, h } | null */
  barHit(id, x, y, maxDist) {
    const l = this.byId(id), w = this._lastWorld?.get(id);
    if (!l?.warp?.bars || !w) return null;
    const wp = l.warp, pts = evalWarp(l, this.values).pts, tmp = [0, 0];
    let best = null, bd = maxDist;
    const toRig = (u, bar) => { barPoint(wp, bar, u, pts, tmp); return w.m.transformPoint({ x: tmp[0], y: tmp[1] }); };
    wp.bars.forEach((bar, bi) => { for (let h = 0; h < bar.n; h++) { const q = toRig(barU(bar, h), bar), d = Math.hypot(q.x - x, q.y - y); if (d < bd) { bd = d; best = { bi, h }; } } });
    if (best) return best;
    bd = maxDist * 0.7;
    wp.bars.forEach((bar, bi) => {
      let p = toRig(0, bar);
      for (let s = 1; s <= 24; s++) {
        const q = toRig(s / 24, bar), vx = q.x - p.x, vy = q.y - p.y, L2 = vx * vx + vy * vy || 1, t = Math.max(0, Math.min(1, ((x - p.x) * vx + (y - p.y) * vy) / L2));
        const d = Math.hypot(p.x + vx * t - x, p.y + vy * t - y); if (d < bd) { bd = d; best = { bi, h: null }; } p = q;
      }
    });
    return best;
  }

  // ---- malha livre: hit-test e overlay -----------------------------------------
  /** Deslocamentos aplicados aos vértices da malha: warp da própria camada (se houver) + warps dos ancestrais. */
  meshAncestors(l) {
    const out = this._warpAncestors(l);
    if (l.warp) { normalizeWarp(l.warp); out.unshift({ layer: l, ev: evalWarp(l, this.values) }); }
    return out;
  }
  meshHit(id, x, y, maxDist) {
    const l = this.byId(id), w = this._lastWorld?.get(id), pos = this._meshPos.get(id);
    if (!l?.mesh || !w || !pos) return -1;
    return hitVertex(pos, w.m, x, y, maxDist);
  }
  drawMeshOverlay(ctx, view, id, opts) {
    const l = this.byId(id), w = this._lastWorld?.get(id), pos = this._meshPos.get(id);
    if (!l?.mesh || !w || !pos) return;
    drawMeshOverlay(ctx, view.multiply(w.m), l.mesh, pos, opts);
  }

  drawWarpOverlay(ctx, view, id, { radius = 0, active = -1, barSel = -1, barsOn = false } = {}) {
    const l = this.byId(id), w = this._lastWorld?.get(id);
    if (!l?.warp || !w) return;
    const M = view.multiply(w.m), wp = l.warp, W = wp.cols + 1;
    const pts = warpPoints(l, wp, this.values).map(p => M.transformPoint({ x: p.x, y: p.y }));
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.lineWidth = 1.2; ctx.strokeStyle = '#4de2c5cc';
    ctx.beginPath();
    for (let b = 0; b <= wp.rows; b++) for (let a = 0; a <= wp.cols; a++) {
      const p = pts[b * W + a];
      if (a < wp.cols) { const q = pts[b * W + a + 1]; ctx.moveTo(p.x, p.y); ctx.lineTo(q.x, q.y); }
      if (b < wp.rows) { const q = pts[(b + 1) * W + a]; ctx.moveTo(p.x, p.y); ctx.lineTo(q.x, q.y); }
    }
    ctx.stroke();
    const ga = active >= 0 ? active % W : -1, gb = active >= 0 ? (active / W) | 0 : -1;
    pts.forEach((p, i) => {
      const a = i % W, b = (i / W) | 0;
      let r = 5, fill = '#14111f';
      if (active >= 0 && radius > 0) {
        const wt = Math.exp(-((Math.hypot(a - ga, b - gb) / radius) ** 2));
        if (wt > 0.05) { r = 5 + 4 * wt; fill = `rgba(255,93,143,${0.25 + 0.6 * wt})`; }
      }
      if (i === active) fill = '#ff5d8f';
      ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, 7); ctx.fillStyle = fill; ctx.fill();
      ctx.strokeStyle = '#4de2c5'; ctx.stroke();
    });
    if (wp.bars?.length) {                         // barras-guia (verdes): linha + alças quadradas
      const raw = evalWarp(l, this.values).pts, tmp = [0, 0], P = (u, bar) => { barPoint(wp, bar, u, raw, tmp); return M.transformPoint({ x: tmp[0], y: tmp[1] }); };
      wp.bars.forEach((bar, bi) => {
        const sel = bi === barSel; ctx.lineWidth = sel ? 3 : 2; ctx.strokeStyle = sel ? '#b6ff6e' : '#38d66b'; ctx.globalAlpha = barsOn ? 1 : 0.55;
        ctx.beginPath(); for (let s = 0; s <= 24; s++) { const q = P(s / 24, bar); s ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y); } ctx.stroke();
        for (let hh = 0; hh < bar.n; hh++) { const q = P(barU(bar, hh), bar), s2 = sel ? 7 : 6; ctx.fillStyle = sel ? '#b6ff6e' : '#38d66b'; ctx.strokeStyle = '#0d2b17'; ctx.lineWidth = 1.5; ctx.fillRect(q.x - s2, q.y - s2, s2 * 2, s2 * 2); ctx.strokeRect(q.x - s2, q.y - s2, s2 * 2, s2 * 2); }
      });
      ctx.globalAlpha = 1;
    }
  }

  // ---- histórico (undo/redo) ----------------------------------------------
  snapshot() {
    return {
      name: this.name, w: this.w, h: this.h,
      animations: jclone(this.animations), physics: jclone(this.physics), expressions: jclone(this.expressions),
      customParams: getCustomParams(),
      layers: this.layers.map(cloneLayer),
    };
  }

  restore(snap) {
    this.name = snap.name; this.w = snap.w; this.h = snap.h;
    this.animations = jclone(snap.animations || []);
    this.physics = jclone(snap.physics || []); this.expressions = jclone(snap.expressions || []);
    setCustomParams(snap.customParams || []); this.syncValues();
    this.layers = snap.layers.map(cloneLayer);
    this.rev++;
  }

  // ---- (de)serialização ---------------------------------------------------
  toJSON() {
    return {
      format: 'vtuber-rigger', version: 1, name: this.name, w: this.w, h: this.h,
      animations: this.animations, customParams: getCustomParams(), physics: this.physics, expressions: this.expressions,
      layers: this.layers.map(l => ({
        id: l.id, name: l.name, src: l.src, x: l.x, y: l.y, px: l.px, py: l.py,
        parent: l.parent, visible: l.visible, bindings: l.bindings, osc: l.osc, opacity: l.opacity, blend: l.blend,
        warp: l.warp ? cloneWarp(l.warp) : null, mesh: l.mesh || null,
        ...(l.clip ? { clip: true, w: l.w, h: l.h } : {}), ...(l.jelly ? { jelly: l.jelly } : {}), ...(l.chain ? { chain: l.chain } : {}), ...(l.mask ? { mask: l.mask } : {}), ...(l.zord ? { zord: l.zord } : {}),
      })),
    };
  }

  async fromJSON(data) {
    if (!data || data.format !== 'vtuber-rigger') throw new Error('Arquivo de modelo inválido');
    this.reset();
    this.name = data.name || 'Modelo'; this.w = data.w; this.h = data.h;
    setCustomParams(data.customParams || []); this.syncValues();
    this.physics = (Array.isArray(data.physics) ? data.physics : []).filter(p => p && p.id && p.input && p.output);
    this.expressions = (Array.isArray(data.expressions) ? data.expressions : []).filter(e => e && e.id && e.values && typeof e.values === 'object');
    this.animations = (Array.isArray(data.animations) ? data.animations : []).map(normalizeAnim).filter(Boolean);
    for (const l of data.layers) {
      const layer = await this.addLayer({ ...l, pivot: [l.px, l.py] });
      layer.visible = l.visible !== false;
    }
  }
}
