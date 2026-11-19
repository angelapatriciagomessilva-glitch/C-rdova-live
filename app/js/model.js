// model.js — o modelo VTuber ativo: rig + renderizador (GPU, com plano B em CPU) + parâmetros vindos do rastreio.
import { PARAMS, PARAM_MAP } from './params.js';
import { Rig, clamp } from './rig.js';
import { GLRenderer } from './gl.js';
import { buildDemo } from './demo.js';
import { sampleAnim } from './anim.js';

export class ModelRT {
  constructor() {
    this.rig = new Rig(); this.name = ''; this.id = '';
    this.cv = document.createElement('canvas'); this.ctx = this.cv.getContext('2d');
    this.gr = null; this.mode = 'cpu';
    try { const c = document.createElement('canvas'); this.gr = new GLRenderer(c, { maxTexture: 2048 }); this.mode = 'gpu'; } catch (e) { console.warn('GPU indisponível — CPU:', e.message); }
    this.sm = {}; this.lostW = 0; this.anim = null; this.hair = { a: 0, v: 0 }; this.prevAx = 0; this.nextBlink = 2500; this.blinkT = 0; this.last = null;
    this.s = { blink: true, breath: true, hair: true, lost: 'neutral', paramSmooth: 0.02 };
  }
  get ready() { return this.rig.layers.length > 0; }
  get aspect() { return this.rig.w / this.rig.h; }

  async load(json, id) { await this.rig.fromJSON(json); this.rig.syncValues(); this.id = id || ''; this.name = this.rig.name; this.sm = {}; this.anim = null; }
  async loadDemo() { await buildDemo(this.rig); this.rig.syncValues(); this.id = 'demo'; this.name = this.rig.name; this.sm = {}; }

  /** Valores rastreados (ou nulos) → parâmetros do modelo, com piscar/respiração automáticos, animações, suavização e física. */
  step(now, dt, tracker) {
    const rig = this.rig, S = this.s, raw = tracker.active ? tracker.out : null;
    if (raw) this.last = raw;
    const lost = tracker.running && !raw;
    this.lostW = lost && S.lost === 'neutral' ? Math.min(1, this.lostW + dt / 0.9) : Math.max(0, this.lostW - dt / 0.15);
    const V = rig.values, tracking = !!this.last && tracker.running;
    for (const p of PARAMS) {
      const tv = tracking && p.id in this.last ? clamp(this.last[p.id], p.min, p.max) : undefined;
      V[p.id] = tv === undefined ? p.def : tv + (p.def - tv) * this.lostW;
    }
    const A = this.anim, animKeys = A ? new Set(Object.keys(A.an.tracks)) : new Set();
    if (S.breath && !animKeys.has('Breath')) V.Breath = (Math.sin(now / 1000 * 1.7) + 1) / 2;
    if (S.blink && (!tracking || this.lostW > 0.5) && !animKeys.has('EyeLOpen')) {
      this.nextBlink -= dt * 1000;
      if (this.nextBlink <= 0) { this.blinkT = 0.16; this.nextBlink = 2000 + Math.random() * 3500; }
      if (this.blinkT > 0) { this.blinkT -= dt; const k = Math.abs(this.blinkT / 0.16 - 0.5) * 2; V.EyeLOpen *= k; V.EyeROpen *= k; }
    }
    if (S.hair && PARAM_MAP.HairSway) {
      const vel = (V.AngleX - this.prevAx) / Math.max(dt, 1e-3) / 30;
      this.hair.v += (-70 * this.hair.a - 7 * this.hair.v - 16 * vel) * dt; this.hair.a = clamp(this.hair.a + this.hair.v * dt, -1, 1); V.HairSway = this.hair.a;
    }
    this.prevAx = V.AngleX;
    if (A) {
      A.t += dt;
      if (A.t >= A.an.duration) { if (A.loop) A.t %= A.an.duration; else A.ending = true; }
      A.w = clamp(A.w + (A.ending ? -dt : dt) / 0.2, 0, 1);
      if (A.ending && A.w <= 0) this.anim = null;
      else for (const [id, v] of Object.entries(sampleAnim(A.an, Math.min(A.t, A.an.duration)))) V[id] += (v - V[id]) * A.w;
    }
    const tau = Math.max(S.paramSmooth ?? 0.02, tracker.active ? Math.min(0.06, tracker.gapMs / 1000 * 0.4) : 0), a = tau > 0 ? 1 - Math.exp(-dt / tau) : 1, liveSm = tracking || !!this.anim;
    for (const p of PARAMS) {
      if (!liveSm || tau <= 0 || this.sm[p.id] === undefined) this.sm[p.id] = V[p.id];
      else { this.sm[p.id] += (V[p.id] - this.sm[p.id]) * a; V[p.id] = this.sm[p.id]; }
    }
    rig.tick(dt);
  }
  playAnim(an) { this.anim = { an, t: 0, w: 0, loop: an.loop !== false }; }
  stopAnim() { if (this.anim) this.anim.ending = true; }

  /** Desenha o modelo em w×h pixels e devolve o canvas (válido até o próximo draw). */
  draw(w, h) {
    w = Math.max(2, Math.round(w)); h = Math.max(2, Math.round(h));
    const rig = this.rig, s = Math.min(w / rig.w, h / rig.h), view = new DOMMatrix().translate(w / 2, h / 2).scale(s, s).translate(-rig.w / 2, -rig.h / 2);
    if (this.gr && !this.gr.lost) {
      try {
        if (this.gr.canvas.width !== w || this.gr.canvas.height !== h) this.gr.resize(w, h);
        rig.renderGL(this.gr, view); return this.gr.canvas;
      } catch (e) { console.error('Falha na GPU; usando CPU', e); this.gr = null; this.mode = 'cpu'; }
    }
    if (this.cv.width !== w || this.cv.height !== h) { this.cv.width = w; this.cv.height = h; }
    this.ctx.setTransform(1, 0, 0, 1, 0, 0); this.ctx.clearRect(0, 0, w, h); rig.render(this.ctx, view, {});
    return this.cv;
  }
}
