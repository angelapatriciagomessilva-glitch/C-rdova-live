import { clamp } from './rig.js';

const MP_VERSION = '0.10.14';
const MP_BASE = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MP_VERSION}`;
const MODEL_URL = 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task';

/** Filtro One-Euro: suaviza sem criar latência perceptível em movimentos rápidos. */
class OneEuro {
  constructor() { this.x = null; this.dx = 0; this.t = 0; }
  static alpha(cut, dt) { const tau = 1 / (2 * Math.PI * cut); return 1 / (1 + tau / dt); }
  filter(v, t, minCut, beta) {
    if (this.x === null) { this.x = v; this.t = t; return v; }
    const dt = Math.max((t - this.t) / 1000, 1 / 240);
    this.t = t;
    const rawDx = (v - this.x) / dt;
    this.dx += OneEuro.alpha(1, dt) * (rawDx - this.dx);
    const cut = minCut + beta * Math.abs(this.dx);
    this.x += OneEuro.alpha(cut, dt) * (v - this.x);
    return this.x;
  }
  reset() { this.x = null; }
}

export const DEFAULT_SETTINGS = {
  mirror: true, smooth: 0.55,
  headGain: 1.0, eyeGain: 1.0, mouthGain: 1.0, browGain: 1.0, gazeGain: 1.0,
  invX: false, invY: false, invZ: false,
  blinkLo: 0.25, blinkHi: 0.65, linkEyes: false,
  camId: '', camRes: 360, trackFps: 30, autoPerf: true,
};

const smoothstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };

// ───────────────────────── câmera: permissão, diagnóstico e mensagens ─────────────────────────
/** Mensagem clara (em português) para cada tipo de erro de câmera. */
export function explainCameraError(e) {
  const framed = window.top !== window ? ' (o app está dentro de outra página/visualizador: abra-o direto no navegador)' : '';
  switch (e?.name) {
    case 'NotAllowedError': case 'PermissionDeniedError':
      return 'Permissão da câmera negada. Toque no cadeado (ou ícone de câmera) ao lado do endereço → Permissões → Câmera → Permitir, e tente de novo.' + framed;
    case 'NotFoundError': case 'DevicesNotFoundError': return 'Nenhuma câmera encontrada neste aparelho.';
    case 'NotReadableError': case 'TrackStartError': return 'A câmera está em uso por outro app ou aba. Feche-o e tente de novo.';
    case 'OverconstrainedError': return 'A câmera escolhida não suporta essa configuração. Escolha “Automática” na lista de câmeras.';
    case 'SecurityError': return 'O navegador bloqueou a câmera: abra o app por HTTPS (ou localhost).' + framed;
    case 'AbortError': return 'O navegador interrompeu o acesso à câmera. Tente de novo.';
  }
  return e?.message || 'Erro ao iniciar a câmera';
}

/** Abre a câmera (frontal por padrão). Tenta de novo com restrições mais simples se o aparelho recusar as primeiras. */
export async function openCameraStream(deviceId = '', res = 480) {
  if (!window.isSecureContext) throw Object.assign(new Error('Câmera bloqueada: o app precisa estar em HTTPS (ou localhost). Veja “Como liberar” abaixo.'), { name: 'SecurityError' });
  if (!navigator.mediaDevices?.getUserMedia) throw Object.assign(new Error('Este navegador não oferece acesso à câmera.'), { name: 'NotFoundError' });
  const base = { width: { ideal: res }, height: { ideal: Math.round(res * 0.75) }, frameRate: { ideal: 30, max: 30 } };
  const tries = [
    deviceId ? { ...base, deviceId: { exact: deviceId } } : { ...base, facingMode: 'user' },
    { facingMode: 'user' }, true,
  ];
  let last;
  for (const video of tries) {
    try { return await navigator.mediaDevices.getUserMedia({ video, audio: false }); }
    catch (e) { last = e; if (!['OverconstrainedError', 'NotFoundError', 'AbortError'].includes(e.name)) throw e; }
  }
  throw last;
}

/** Pede a permissão agora (precisa ser chamado por um toque do usuário) e libera a câmera em seguida. */
export async function requestCameraAccess(deviceId = '') {
  const st = await openCameraStream(deviceId, 480);
  st.getTracks().forEach(t => t.stop());
}

/** Estado atual: contexto seguro, permissão e câmeras disponíveis. */
export async function cameraDiagnostics() {
  const d = { secure: !!window.isSecureContext, api: !!navigator.mediaDevices?.getUserMedia, framed: window.top !== window, perm: 'unknown', devices: [], status: null };
  try {
    d.status = await navigator.permissions.query({ name: 'camera' });
    d.perm = d.status.state;                                  // granted | denied | prompt
  } catch { /* Safari/Firefox não expõem esta permissão */ }
  try {
    const list = await navigator.mediaDevices.enumerateDevices();
    d.devices = list.filter(x => x.kind === 'videoinput').map((x, i) => ({ id: x.deviceId, label: x.label || `Câmera ${i + 1}` }));
  } catch { /* sem lista */ }
  return d;
}

export class Tracker {
  constructor(video, settings) {
    this.video = video;
    this.s = settings;
    this.running = false;
    this.landmarker = null;
    this.filters = {};
    this.neutral = { AngleX: 0, AngleY: 0, AngleZ: 0, gx: 0, gy: 0 };
    this.bs = {};           // blendshapes brutos do último quadro (monitor)
    this.lm = null;         // landmarks do último quadro (prévia)
    this.hasFace = false;
    this.raw = { yaw: 0, pitch: 0, roll: 0 };
    this.out = null;        // últimos valores de parâmetros rastreados
    this.lastSeen = 0;
    this.fps = 0;
    this.inferMs = 0;       // custo médio (ms) de cada análise: base do ritmo adaptativo
    this.gapMs = 33;        // intervalo atual entre análises
    this.rateCap = 99;      // teto de análises/s imposto pelo ajuste automático de desempenho
    this.onStatus = () => {};
    this._lastVideoTime = -1;
  }

  /** @param ext  (opcional) câmera já aberta pelo app (compartilhada com fontes de vídeo): o rastreador não a abre nem a fecha. */
  async start(ext) {
    this.onStatus('Pedindo acesso à câmera…');
    this._ext = !!ext;
    if (ext) { this.stream = ext; if (this.video.paused) await this.video.play().catch(() => {}); }
    else {
      this.stream = await openCameraStream(this.s.camId || '', this.s.camRes || 480);
      this.video.srcObject = this.stream;
      await this.video.play();
    }

    if (!this.landmarker) {
      this.onStatus('Baixando modelo de rastreamento (≈4 MB, só na 1ª vez)…');
      try {
        const { FaceLandmarker, FilesetResolver } = await import(`${MP_BASE}/vision_bundle.mjs`);
        const fileset = await FilesetResolver.forVisionTasks(`${MP_BASE}/wasm`);
        const make = delegate => FaceLandmarker.createFromOptions(fileset, {
          baseOptions: { modelAssetPath: MODEL_URL, delegate },
          runningMode: 'VIDEO', numFaces: 1,
          outputFaceBlendshapes: true, outputFacialTransformationMatrixes: true,
        });
        try { this.landmarker = await make('GPU'); }
        catch (e) { console.warn('GPU indisponível, usando CPU', e); this.landmarker = await make('CPU'); }
      } catch (e) {
        console.error(e);
        if (!this._ext) { this.stream?.getTracks().forEach(t => t.stop()); this.video.srcObject = null; } this.stream = null;
        throw new Error('A câmera foi liberada, mas não consegui baixar o modelo de rastreamento (precisa de internet na 1ª vez; verifique a conexão ou bloqueadores).');
      }
    }
    this.running = true;
    this.onStatus('Rastreando');
    this._loop();
  }

  stop() {
    this.running = false;
    if (!this._ext) { this.stream?.getTracks().forEach(t => t.stop()); this.video.srcObject = null; }
    this.stream = null;
    this.out = null;
    Object.values(this.filters).forEach(f => f.reset());
    this.onStatus('Parado');
  }

  _loop() {
    if (!this.running) return;
    const v = this.video;
    const nowT = performance.now();
    // Ritmo adaptativo: a análise nunca ocupa mais de ~55% do tempo; sem rosto, só ~9×/s (procurar rosto é mais caro).
    const gap = this.gapMs = Math.max(1000 / Math.max(5, Math.min(this.s.trackFps || 24, this.rateCap)), this.inferMs * 1.8, this.hasFace ? 0 : 110);
    if (v.readyState >= 2 && v.currentTime !== this._lastVideoTime && !document.hidden && nowT - (this._lastDet || 0) >= gap * 0.85) {
      this._lastVideoTime = v.currentTime;
      const now = this._lastDet = nowT;
      try {
        const res = this.landmarker.detectForVideo(v, now);
        const t1 = performance.now(); this.inferMs += (t1 - now - this.inferMs) * 0.15;
        this.process(res, now);
      } catch (e) { console.warn(e); }
      this.fps = this.fps * 0.9 + (1000 / Math.max(1, performance.now() - (this._t0 || now - 33))) * 0.1;
      this._t0 = now;
    }
    if (v.requestVideoFrameCallback) v.requestVideoFrameCallback(() => this._loop());
    else requestAnimationFrame(() => this._loop());
  }

  calibrate() {
    this.neutral = { AngleX: this.raw.yaw, AngleY: this.raw.pitch, AngleZ: this.raw.roll, gx: this.raw.gx || 0, gy: this.raw.gy || 0 };
  }

  _f(key, v, t, kind) {
    const f = this.filters[key] || (this.filters[key] = new OneEuro());
    const s = this.s.smooth;
    const minCut = 8 * (1 - s) + 0.4;
    return f.filter(v, t, minCut, kind === 'angle' ? 0.04 : 0.8);
  }

  /** Converte o resultado do MediaPipe em valores de parâmetros do rig. */
  process(res, t) {
    if (!res?.faceLandmarks?.length) { this.out = null; this.hasFace = false; this.lm = null; return; }
    this.hasFace = true; this.lm = res.faceLandmarks[0];
    this.lastSeen = t;
    const s = this.s;

    // ---- pose da cabeça (matriz 4x4 coluna-major) ----
    const d = res.facialTransformationMatrixes?.[0]?.data;
    let yaw = 0, pitch = 0, roll = 0;
    if (d) {
      const R = 180 / Math.PI;
      yaw = Math.asin(clamp(d[8], -1, 1)) * R;
      pitch = Math.atan2(-d[9], d[10]) * R;
      roll = Math.atan2(-d[4], d[0]) * R;
      if (pitch > 90) pitch -= 180; else if (pitch < -90) pitch += 180;
    }
    this.raw = { yaw, pitch, roll, gx: 0, gy: 0 };
    const sgn = (inv) => (inv ? -1 : 1) * (s.mirror ? 1 : -1);
    const angle = (key, val, neutral, inv, mirrorsToo) => {
      const k = (mirrorsToo ? sgn(inv) : (inv ? -1 : 1));
      return this._f(key, (val - neutral) * k * s.headGain, t, 'angle');
    };
    const AngleX = angle('ax', yaw, this.neutral.AngleX, s.invX, true);
    const AngleY = angle('ay', pitch, this.neutral.AngleY, s.invY, false);
    const AngleZ = angle('az', roll, this.neutral.AngleZ, s.invZ, true);

    // ---- blendshapes ----
    const bs = {};
    for (const c of res.faceBlendshapes?.[0]?.categories || []) bs[c.categoryName] = c.score;
    this.bs = bs;
    const g = n => bs[n] || 0;
    // No modo espelho, o olho "E" do modelo (esquerda da tela) = olho esquerdo do usuário.
    const L = s.mirror ? 'Left' : 'Right', Rr = s.mirror ? 'Right' : 'Left';
    const open = side => 1 - smoothstep(s.blinkLo, s.blinkHi, g('eyeBlink' + side) * s.eyeGain);
    const lk = () => (g('eyeLookOutRight') + g('eyeLookInLeft') - g('eyeLookInRight') - g('eyeLookOutLeft')) / 2;
    const brow = side => clamp(((g('browOuterUp' + side) + g('browInnerUp') * 0.5) * 1.6 - g('browDown' + side) * 1.6) * s.browGain, -1, 1);

    // olhar: positivo = para a direita da tela
    const lookRight = (g('eyeLookOutRight') + g('eyeLookInLeft') - g('eyeLookInRight') - g('eyeLookOutLeft')) / 2;
    const lookUp = (g('eyeLookUpLeft') + g('eyeLookUpRight') - g('eyeLookDownLeft') - g('eyeLookDownRight')) / 2;
    const smile = (g('mouthSmileLeft') + g('mouthSmileRight')) / 2;
    const frown = (g('mouthFrownLeft') + g('mouthFrownRight')) / 2;
    const jaw = clamp(g('jawOpen') * 1.5 * s.mouthGain, 0, 1);
    const pucker = g('mouthPucker');

    const out = {
      AngleX, AngleY, AngleZ,
      EyeLOpen: this._f('eL', open(L), t, 'bs'),
      EyeROpen: this._f('eR', open(Rr), t, 'bs'),
      EyeBallX: this._f('bx', clamp((lookRight - this.neutral.gx) * 1.6 * (s.mirror ? 1 : -1) * s.gazeGain, -1, 1), t, 'bs'),
      EyeBallY: this._f('by', clamp((lookUp - this.neutral.gy) * 1.6 * s.gazeGain, -1, 1), t, 'bs'),
      BrowLY: this._f('bl', brow(L), t, 'bs'),
      BrowRY: this._f('br', brow(Rr), t, 'bs'),
      MouthOpen: this._f('mo', jaw, t, 'bs'),
      MouthForm: this._f('mf', clamp((smile * 2.2 - frown * 2 - pucker * 0.6) * s.mouthGain, -1, 1), t, 'bs'),
      Cheek: this._f('ch', clamp(smile * 2.5 - 0.2, 0, 1), t, 'bs'),
    };
    // Extras para o pacote de boca (só são usados se o parâmetro existir no modelo)
    const funnel = g('mouthFunnel'), stretch = (g('mouthStretchLeft') + g('mouthStretchRight')) / 2;
    const mx = (s.mirror ? 1 : -1) * (g('mouthRight') - g('mouthLeft'));
    out.MouthU = this._f('mu', clamp((pucker * 1.8 - funnel * 0.3) * s.mouthGain, 0, 1), t, 'bs');
    out.MouthO = this._f('mO', clamp((funnel * 1.8 + jaw * 0.2) * s.mouthGain, 0, 1), t, 'bs');
    out.MouthI = this._f('mi', clamp((stretch * 2.2 + smile * 0.6) * s.mouthGain, 0, 1), t, 'bs');
    out.TongueOut = this._f('tg', clamp(g('tongueOut') * 1.8, 0, 1), t, 'bs');
    out.MouthX = this._f('mx', clamp(mx * 2.2, -1, 1), t, 'bs');
    out.CheekPuff = this._f('cp', clamp(g('cheekPuff') * 1.8, 0, 1), t, 'bs');
    this.raw.gx = lookRight; this.raw.gy = lookUp;
    if (s.linkEyes) { const m = (out.EyeLOpen + out.EyeROpen) / 2; out.EyeLOpen = out.EyeROpen = m; }
    out.BodyX = clamp(AngleX / 3, -10, 10);
    for (const k of ['EyeLOpen', 'EyeROpen', 'MouthOpen', 'Cheek']) out[k] = clamp(out[k], 0, 1);
    this.out = out;
  }

  get active() { return this.running && !!this.out && performance.now() - this.lastSeen < 400; }
}
