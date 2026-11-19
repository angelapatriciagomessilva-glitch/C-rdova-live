// Live VTuber — app de transmissão estilo OBS: cenas, fontes (modelo VTuber, câmera, tela, imagem, texto, cor), mixer, gravação e RTMP.
import { Tracker, DEFAULT_SETTINGS, explainCameraError, openCameraStream } from './tracker.js';
import { ModelRT } from './model.js';
import { Mixer } from './audio.js';
import { Recorder, RtmpStreamer, PLATFORMS } from './output.js';
import { bridge, parseModelFile } from './bridge.js';
import { $, h, slider, check, select, toast, clamp } from './ui.js';

// ───────────────────────── projeto (cenas) — salvo no aparelho ─────────────────────────
const RES = { '1280x720': [1280, 720], '1920x1080': [1920, 1080], '854x480': [854, 480], '720x1280': [720, 1280], '1080x1920': [1080, 1920] };
const uid = () => Math.random().toString(36).slice(2, 9);
const newScene = name => ({ id: uid(), name, items: [] });
const P = { w: 1280, h: 720, fps: 30, bg: '#000000', modelId: '', scenes: [newScene('Cena 1')], cur: '', kbps: 2800, platform: 'twitch', url: PLATFORMS[0][2], rememberKey: false };
P.cur = P.scenes[0].id;
const TS = { ...DEFAULT_SETTINGS, camRes: 480 };          // ajustes do rastreador
let streamKey = '';
const LS = 'live-project-v1';
try { const j = JSON.parse(localStorage.getItem(LS) || 'null'); if (j?.scenes?.length) { Object.assign(P, j.P); P.scenes = j.scenes; Object.assign(TS, j.TS || {}); streamKey = j.key || ''; if (!P.scenes.some(s => s.id === P.cur)) P.cur = P.scenes[0].id; } } catch { /* novo projeto */ }
let saveT = 0;
const save = () => { clearTimeout(saveT); saveT = setTimeout(() => { try { localStorage.setItem(LS, JSON.stringify({ P: { ...P, scenes: undefined }, scenes: P.scenes, TS, key: P.rememberKey ? streamKey : '' })); } catch { /* ok */ } }, 400); };

const scene = () => P.scenes.find(s => s.id === P.cur) || P.scenes[0];
let selId = null;
const sel = () => scene().items.find(i => i.id === selId) || null;

// ───────────────────────── recursos: imagens, câmera, tela, modelo ─────────────────────────
const imgs = new Map();                                       // assetId → HTMLImageElement
const idb = (() => {
  let p; const open = () => p || (p = new Promise((res, rej) => { const r = indexedDB.open('live-assets', 1); r.onupgradeneeded = () => r.result.createObjectStore('a'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }));
  return {
    put: async (k, v) => { const db = await open(); return new Promise((res, rej) => { const t = db.transaction('a', 'readwrite'); t.objectStore('a').put(v, k); t.oncomplete = res; t.onerror = () => rej(t.error); }); },
    get: async k => { const db = await open(); return new Promise((res, rej) => { const q = db.transaction('a').objectStore('a').get(k); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); }); },
  };
})();
const loadImgBlob = blob => new Promise((res, rej) => { const im = new Image(); im.onload = () => res(im); im.onerror = () => rej(new Error('Imagem inválida')); im.src = URL.createObjectURL(blob); });
async function restoreImages() { for (const s of P.scenes) for (const it of s.items) if (it.type === 'image' && !imgs.has(it.asset)) { try { const b = await idb.get(it.asset); if (b) imgs.set(it.asset, await loadImgBlob(b)); } catch { /* ok */ } } }

const camVideo = document.createElement('video'); camVideo.playsInline = true; camVideo.muted = true;
const camMgr = {
  users: new Set(), stream: null, opening: null,
  async use(k) { this.users.add(k); if (!this.stream) await (this.opening ||= this._open()); },
  release(k) { this.users.delete(k); if (!this.users.size && this.stream) { this.stream.getTracks().forEach(t => t.stop()); this.stream = null; camVideo.srcObject = null; } },
  async _open() { try { await nativePerms(['CAMERA']); this.stream = await openCameraStream(TS.camId || '', TS.camRes || 480); camVideo.srcObject = this.stream; await camVideo.play(); } finally { this.opening = null; } },
};
async function nativePerms(names) {
  const Pm = window.cordova?.plugins?.permissions; if (!Pm) return true;
  return new Promise(res => Pm.requestPermissions(names.map(n => Pm[n]).filter(Boolean), r => res(!!r.hasPermission), () => res(false)));
}
const screens = new Map();                                    // itemId → { stream, video }

const model = new ModelRT();
const mixer = new Mixer();
const tracker = new Tracker(camVideo, TS);
const recorder = new Recorder();
const streamer = new RtmpStreamer(mixer);
const state = { tab: 'items', lib: [], status: 'Parado' };
tracker.onStatus = s => { state.status = s; };

// ───────────────────────── saída: canvas de composição ─────────────────────────
const out = $('#out'), octx = out.getContext('2d'), ov = $('#ov'), octx2 = ov.getContext('2d'), view = $('#view'), stage = $('#stage');
function applyRes() {
  out.width = P.w; out.height = P.h; fit();
}
function fit() {
  const r = stage.getBoundingClientRect(), pad = 10, k = Math.min((r.width - pad * 2) / P.w, (r.height - pad * 2) / P.h);
  const w = Math.max(40, Math.floor(P.w * k)), hh = Math.max(40, Math.floor(P.h * k));
  view.style.width = w + 'px'; view.style.height = hh + 'px';
  const d = Math.min(window.devicePixelRatio || 1, 2); ov.width = Math.round(w * d); ov.height = Math.round(hh * d); ovDirty = true;
}
new ResizeObserver(fit).observe(stage);
let ovDirty = true;

// ───────────────────────── fontes: criação e desenho ─────────────────────────
const modelItem = () => scene().items.some(i => i.type === 'model' && i.vis);
function mk(type, extra) { return { id: uid(), type, name: ({ model: 'Modelo VTuber', camera: 'Câmera', screen: 'Tela', image: 'Imagem', text: 'Texto', color: 'Cor' })[type], x: P.w / 2, y: P.h / 2, w: 200, h: 200, rot: 0, op: 1, vis: true, lock: false, flip: false, ...extra }; }
function addItem(it) { scene().items.push(it); selId = it.id; syncSources(); save(); ovDirty = true; renderTab(); return it; }
function fitInto(it, nw, nh, frac = 0.6) { const k = Math.min(P.w * frac / nw, P.h * frac / nh); it.w = nw * k; it.h = nh * k; }

function addModelItem() {
  if (!model.ready) return toast('Abra um modelo na aba “Modelo” primeiro.', 3000);
  const it = mk('model'); it.w = P.h * 0.9 * model.aspect; it.h = P.h * 0.9; it.x = P.w * 0.72; addItem(it);
}
async function addCameraItem() {
  try { await camMgr.use('add'); const it = mk('camera', { mirror: true }); fitInto(it, camVideo.videoWidth || 640, camVideo.videoHeight || 480, 0.45); camMgr.release('add'); addItem(it); }
  catch (e) { camMgr.release('add'); toast(explainCameraError(e), 6000); }
}
async function addScreenItem() {
  if (!navigator.mediaDevices?.getDisplayMedia) return toast('Captura de tela não é suportada neste aparelho/WebView. No Chrome do PC ela funciona.', 6000);
  try {
    const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
    const v = document.createElement('video'); v.muted = true; v.playsInline = true; v.srcObject = stream; await v.play();
    const it = mk('screen'); fitInto(it, v.videoWidth || 1280, v.videoHeight || 720, 0.9); screens.set(it.id, { stream, video: v });
    if (stream.getAudioTracks().length) { mixer.add('screen-' + it.id, 'Áudio da tela', new MediaStream(stream.getAudioTracks()), 'tela'); }
    stream.getVideoTracks()[0].onended = () => { it.vis = false; screens.delete(it.id); mixer.remove('screen-' + it.id); renderTab(); };
    addItem(it);
  } catch (e) { if (e?.name !== 'NotAllowedError') toast('Não consegui capturar a tela: ' + (e.message || e), 5000); }
}
async function addImageItem(file) {
  try {
    const asset = uid(); await idb.put(asset, file); const im = await loadImgBlob(file); imgs.set(asset, im);
    const it = mk('image', { asset, name: file.name.slice(0, 24) }); fitInto(it, im.naturalWidth, im.naturalHeight, 0.7); addItem(it);
  } catch (e) { toast(e.message || String(e), 4000); }
}
function addTextItem() { const it = mk('text', { text: 'Meu texto', fs: 72, font: 'system-ui, sans-serif', color: '#ffffff', stroke: '#000000', sw: 6, bg: '', align: 'center', bold: true }); textFit(it); addItem(it); }
function addColorItem() { const it = mk('color', { color: '#00b140' }); it.w = P.w; it.h = P.h; addItem(it); sendBack(it); }

const lines = it => String(it.text || ' ').split('\n');
function textFont(it) { return `${it.bold ? '700 ' : ''}${it.fs}px ${it.font || 'system-ui'}`; }
function textFit(it) {
  octx.save(); octx.font = textFont(it); const pad = it.fs * 0.25;
  it.w = Math.max(...lines(it).map(l => octx.measureText(l).width)) + pad * 2; it.h = lines(it).length * it.fs * 1.2 + pad * 2; octx.restore();
}
function scaleItem(it, k, b = { w: it.w, h: it.h, fs: it.fs }) {
  if (it.type === 'text') { it.fs = clamp(b.fs * k, 8, 600); textFit(it); } else { it.w = clamp(b.w * k, 8, P.w * 4); it.h = clamp(b.h * k, 8, P.h * 4); }
}

function drawItem(it, now) {
  const g = octx; g.save(); g.translate(it.x, it.y); g.rotate(it.rot * Math.PI / 180); g.globalAlpha = it.op;
  const hw = it.w / 2, hh = it.h / 2;
  try {
    if (it.type === 'color') { g.fillStyle = it.color; g.fillRect(-hw, -hh, it.w, it.h); }
    else if (it.type === 'model') { if (model.ready) { if (it.flip) g.scale(-1, 1); g.drawImage(model.draw(it.w, it.h), -hw, -hh, it.w, it.h); } }
    else if (it.type === 'image') { const im = imgs.get(it.asset); if (im) { if (it.flip) g.scale(-1, 1); g.drawImage(im, -hw, -hh, it.w, it.h); } }
    else if (it.type === 'camera') { if (camVideo.readyState >= 2) { if (it.mirror !== it.flip) g.scale(-1, 1); coverDraw(g, camVideo, camVideo.videoWidth, camVideo.videoHeight, it); } }
    else if (it.type === 'screen') { const s = screens.get(it.id); if (s && s.video.readyState >= 2) { if (it.flip) g.scale(-1, 1); coverDraw(g, s.video, s.video.videoWidth, s.video.videoHeight, it); } }
    else if (it.type === 'text') {
      if (it.bg) { g.fillStyle = it.bg; g.fillRect(-hw, -hh, it.w, it.h); }
      g.font = textFont(it); g.textBaseline = 'middle'; g.lineJoin = 'round';
      g.textAlign = it.align || 'center'; const ls = lines(it), lh = it.fs * 1.2, pad = it.fs * 0.25, tx = it.align === 'left' ? -hw + pad : it.align === 'right' ? hw - pad : 0;
      ls.forEach((l, i) => {
        const y = -hh + pad + lh * (i + 0.5);
        if (it.sw > 0) { g.lineWidth = it.sw; g.strokeStyle = it.stroke; g.strokeText(l, tx, y); }
        g.fillStyle = it.color; g.fillText(l, tx, y);
      });
    }
  } catch (e) { /* fonte indisponível neste quadro */ }
  g.restore();
}
/** drawImage “cover”: preenche o retângulo da fonte cortando o excesso. */
function coverDraw(g, src, sw, sh, it) {
  if (!sw || !sh) return; const k = Math.max(it.w / sw, it.h / sh), cw = it.w / k, ch = it.h / k;
  g.drawImage(src, (sw - cw) / 2, (sh - ch) / 2, cw, ch, -it.w / 2, -it.h / 2, it.w, it.h);
}

// ───────────────────────── câmera/tela sob demanda ─────────────────────────
let syncBusy = false;
async function syncSources() {
  if (syncBusy) return; syncBusy = true;
  try {
    const need = new Set(scene().items.filter(i => i.type === 'camera' && i.vis).map(i => 'item:' + i.id)); if (tracker.running) need.add('track');
    for (const k of [...camMgr.users]) if (k !== 'add' && !need.has(k)) camMgr.release(k);
    for (const k of need) if (!camMgr.users.has(k)) { try { await camMgr.use(k); } catch (e) { toast(explainCameraError(e), 6000); } }
  } finally { syncBusy = false; }
}

// ───────────────────────── laço principal ─────────────────────────
let lastT = 0, lastHud = 0, fpsE = 30, lastMeter = 0;
function frame(now) {
  requestAnimationFrame(frame);
  if (now - lastT < 1000 / P.fps - 2) return;
  const rawDt = (now - lastT) / 1000, dt = Math.min(0.05, rawDt); lastT = now;
  if (rawDt > 0) fpsE += (Math.min(120, 1 / rawDt) - fpsE) * 0.1;
  const sc = scene();
  if (model.ready && sc.items.some(i => i.type === 'model' && i.vis)) model.step(now, dt, tracker);
  octx.setTransform(1, 0, 0, 1, 0, 0); octx.globalAlpha = 1; octx.fillStyle = P.bg; octx.fillRect(0, 0, out.width, out.height);
  for (const it of sc.items) if (it.vis) drawItem(it, now);
  if (streamer.on) streamer.frame(out, now);
  if (ovDirty || dragging) drawOverlay();
  if (now - lastHud > 500) { lastHud = now; updateHud(); }
  if (now - lastMeter > 90) { lastMeter = now; meters(); }
}
function updateHud() {
  const parts = [];
  if (recorder.active) parts.push(h('span', { class: 'rec' }, '● REC ' + fmtT(recorder.seconds)));
  if (streamer.on) parts.push(h('span', { class: 'live' }, `AO VIVO ${fmtT(streamer.seconds)} · ${streamer.stats.kbps.toFixed(0)} kbps${streamer.stats.dropped ? ' · perdeu ' + streamer.stats.dropped : ''}`));
  parts.push(h('span', {}, `${fpsE.toFixed(0)} fps · ${tracker.running ? (tracker.active ? 'rastreando' : 'sem rosto') : 'sem rastreio'}`));
  $('#hud').replaceChildren(...parts);
  if (streamer.stats.err && streamer.on) { toast('Transmissão: ' + streamer.stats.err, 6000); streamer.stats.err = ''; }
  $('#btnRec').classList.toggle('on', recorder.active); $('#btnRec').textContent = recorder.active ? '■ Parar' : '⏺ Gravar';
  $('#btnLive').classList.toggle('on', streamer.on); $('#btnLive').textContent = streamer.on ? '■ Encerrar' : '📡 Ao vivo';
  $('#btnTrack').classList.toggle('on', tracker.running); $('#btnTrack').textContent = tracker.running ? '■ Rastreando' : '● Rastrear';
}
const fmtT = s => { s = Math.floor(s); return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`; };
function meters() {
  if (state.tab !== 'audio') return;
  document.querySelectorAll('[data-vu]').forEach(el => { const id = el.dataset.vu; el.firstChild.style.width = Math.round(mixer.level(id === 'master' ? null : id) * 100) + '%'; });
}

// ───────────────────────── seleção e edição direta no palco ─────────────────────────
const toLocal = (it, p) => { const a = -it.rot * Math.PI / 180, dx = p.x - it.x, dy = p.y - it.y; return { x: dx * Math.cos(a) - dy * Math.sin(a), y: dx * Math.sin(a) + dy * Math.cos(a) }; };
const hit = (it, p) => { const l = toLocal(it, p); return Math.abs(l.x) <= it.w / 2 && Math.abs(l.y) <= it.h / 2; };
const u = () => P.w / (parseFloat(view.style.width) || P.w);                     // pixels de saída por pixel de tela
const corner = (it, sx, sy) => { const a = it.rot * Math.PI / 180, lx = sx * it.w / 2, ly = sy * it.h / 2; return { x: it.x + lx * Math.cos(a) - ly * Math.sin(a), y: it.y + lx * Math.sin(a) + ly * Math.cos(a) }; };
function rotPos(it) { const a = it.rot * Math.PI / 180, d = it.h / 2 + 34 * u(); return { x: it.x + Math.sin(a) * d, y: it.y - Math.cos(a) * d }; }
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const outPt = e => { const r = out.getBoundingClientRect(); return { x: (e.clientX - r.left) * P.w / r.width, y: (e.clientY - r.top) * P.h / r.height }; };

function drawOverlay() {
  ovDirty = false; const g = octx2, k = ov.width / P.w; g.setTransform(1, 0, 0, 1, 0, 0); g.clearRect(0, 0, ov.width, ov.height);
  const it = sel(); if (!it) return;
  g.setTransform(k, 0, 0, k, 0, 0); const lw = 2 * u(), r = 8 * u();
  g.strokeStyle = '#4de2c5'; g.lineWidth = lw; g.beginPath();
  const c = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([x, y]) => corner(it, x, y)); c.forEach((p, i) => i ? g.lineTo(p.x, p.y) : g.moveTo(p.x, p.y)); g.closePath(); g.stroke();
  g.fillStyle = '#4de2c5'; for (const p of c) { g.beginPath(); g.arc(p.x, p.y, r, 0, 7); g.fill(); }
  const top = corner(it, 0, -1), rp = rotPos(it); g.beginPath(); g.moveTo(top.x, top.y); g.lineTo(rp.x, rp.y); g.stroke();
  g.fillStyle = '#ff5d8f'; g.beginPath(); g.arc(rp.x, rp.y, r, 0, 7); g.fill();
}
const pts = new Map(); let drag = null, dragging = false;
out.addEventListener('pointerdown', e => {
  out.setPointerCapture(e.pointerId); pts.set(e.pointerId, outPt(e)); const p = outPt(e); let it = sel();
  if (pts.size === 2 && it && !it.lock) { const [a, b] = [...pts.values()]; drag = { mode: 'pinch', d0: dist(a, b), a0: Math.atan2(b.y - a.y, b.x - a.x), rot0: it.rot, b: { w: it.w, h: it.h, fs: it.fs } }; return; }
  if (it && !it.lock) {
    const u2 = u();
    if (dist(p, rotPos(it)) < 22 * u2) { drag = { mode: 'rot', a0: Math.atan2(p.y - it.y, p.x - it.x), rot0: it.rot }; dragging = true; return; }
    for (const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) if (dist(p, corner(it, sx, sy)) < 22 * u2) { drag = { mode: 'scale', d0: Math.max(dist(p, it), 1), b: { w: it.w, h: it.h, fs: it.fs } }; dragging = true; return; }
  }
  const top = [...scene().items].reverse().find(i => i.vis && !i.lock && hit(i, p));
  if (top) { selId = top.id; drag = { mode: 'move', ox: top.x - p.x, oy: top.y - p.y }; dragging = true; ovDirty = true; renderTab(); } else { selId = null; ovDirty = true; renderTab(); }
});
out.addEventListener('pointermove', e => {
  if (!pts.has(e.pointerId)) return; pts.set(e.pointerId, outPt(e)); const it = sel(); if (!drag || !it) return; const p = outPt(e);
  if (drag.mode === 'move') {
    let x = p.x + drag.ox, y = p.y + drag.oy; const sn = 10 * u();
    if (Math.abs(x - P.w / 2) < sn) x = P.w / 2; if (Math.abs(y - P.h / 2) < sn) y = P.h / 2; it.x = x; it.y = y;
  } else if (drag.mode === 'scale') scaleItem(it, dist(p, it) / drag.d0, drag.b);
  else if (drag.mode === 'rot') { it.rot = drag.rot0 + (Math.atan2(p.y - it.y, p.x - it.x) - drag.a0) * 180 / Math.PI; if (e.shiftKey) it.rot = Math.round(it.rot / 15) * 15; }
  else if (drag.mode === 'pinch' && pts.size === 2) { const [a, b] = [...pts.values()]; scaleItem(it, dist(a, b) / drag.d0, drag.b); it.rot = drag.rot0 + (Math.atan2(b.y - a.y, b.x - a.x) - drag.a0) * 180 / Math.PI; }
  ovDirty = true;
});
const up = e => { pts.delete(e.pointerId); if (!pts.size) { const had = dragging; drag = null; dragging = false; if (had) { save(); renderTab(); } } else if (drag?.mode === 'pinch') drag = null; };
out.addEventListener('pointerup', up); out.addEventListener('pointercancel', up);

// ───────────────────────── operações nas fontes ─────────────────────────
function removeItem(it) {
  const s = scene(); s.items = s.items.filter(i => i !== it); if (selId === it.id) selId = null;
  const sc = screens.get(it.id); if (sc) { sc.stream.getTracks().forEach(t => t.stop()); screens.delete(it.id); mixer.remove('screen-' + it.id); }
  syncSources(); save(); ovDirty = true; renderTab();
}
function dupItem(it) { const c = { ...it, id: uid(), name: it.name + ' cópia', x: it.x + 30, y: it.y + 30 }; if (it.type === 'screen') return toast('A captura de tela não pode ser duplicada.', 2500); scene().items.push(c); selId = c.id; syncSources(); save(); ovDirty = true; renderTab(); }
function move(it, d) { const a = scene().items, i = a.indexOf(it), j = clamp(i + d, 0, a.length - 1); a.splice(i, 1); a.splice(j, 0, it); save(); renderTab(); }
const sendBack = it => move(it, -999);

// ───────────────────────── abas ─────────────────────────
const tabs = { items: tabItems, scenes: tabScenes, model: tabModel, audio: tabAudio, live: tabLive, set: tabSet };
function renderTab() {
  document.querySelectorAll('#tabs button').forEach(b => b.classList.toggle('on', b.dataset.tab === state.tab));
  const body = $('#tabbody'), top = body.scrollTop; body.replaceChildren(...tabs[state.tab]()); body.scrollTop = top;
  const s = $('#sceneSel'); s.replaceChildren(...P.scenes.map(x => h('option', { value: x.id, selected: x.id === P.cur }, x.name)));
}
$('#tabs').addEventListener('click', e => { const b = e.target.closest('button[data-tab]'); if (b) { state.tab = b.dataset.tab; renderTab(); } });
$('#sceneSel').onchange = e => { P.cur = e.target.value; selId = null; syncSources(); save(); ovDirty = true; renderTab(); };

const ICON = { model: '🧑‍🎤', camera: '📷', screen: '🖥', image: '🖼', text: 'T', color: '▮' };
function tabItems() {
  const sc = scene(), it = sel();
  const list = h('div', { class: 'list' }, [...sc.items].reverse().map(i => h('div', { class: 'it' + (i.id === selId ? ' sel' : '') + (i.vis ? '' : ' off') },
    h('button', { title: 'Mostrar/ocultar', onclick: () => { i.vis = !i.vis; syncSources(); save(); renderTab(); } }, i.vis ? '👁' : '🚫'),
    h('button', { title: 'Travar', onclick: () => { i.lock = !i.lock; save(); renderTab(); } }, i.lock ? '🔒' : '🔓'),
    h('button', { class: 'nm', onclick: () => { selId = i.id; ovDirty = true; renderTab(); } }, `${ICON[i.type]} ${i.name}`))));
  const out = [h('h3', {}, 'Fontes da cena “' + sc.name + '”'), sc.items.length ? list : h('p', { class: 'hint' }, 'Cena vazia. Adicione uma fonte abaixo.'),
    h('h3', {}, 'Adicionar'),
    h('div', { class: 'btns' },
      h('button', { onclick: addModelItem }, '🧑‍🎤 Modelo VTuber'), h('button', { onclick: addCameraItem }, '📷 Câmera'), h('button', { onclick: addScreenItem }, '🖥 Tela'),
      h('button', { onclick: () => $('#fileImg').click() }, '🖼 Imagem'), h('button', { onclick: addTextItem }, 'T Texto'), h('button', { onclick: addColorItem }, '▮ Cor / fundo'))];
  if (it) out.push(...inspector(it));
  else out.push(h('p', { class: 'hint' }, 'Toque num item no palco para mover (arrastar), redimensionar (cantos ou pinça) e girar (bolinha rosa).'));
  return out;
}
function inspector(it) {
  const upd = () => { ovDirty = true; save(); };
  const r = [h('h3', {}, 'Item: ' + it.name),
    h('div', { class: 'row two' }, h('label', {}, 'Nome'), h('input', { type: 'text', value: it.name, onchange: e => { it.name = e.target.value || it.name; save(); renderTab(); } })),
    slider('Posição X', 0, P.w, 1, it.x, v => { it.x = v; upd(); }, { fmt: v => v.toFixed(0) }),
    slider('Posição Y', 0, P.h, 1, it.y, v => { it.y = v; upd(); }, { fmt: v => v.toFixed(0) }),
    slider('Largura', 20, P.w * 2, 1, it.w, v => { scaleItem(it, v / it.w); upd(); }, { fmt: v => v.toFixed(0) }),
    slider('Rotação', -180, 180, 1, it.rot, v => { it.rot = v; upd(); }, { fmt: v => v.toFixed(0) + '°' }),
    slider('Opacidade', 0, 1, 0.01, it.op, v => { it.op = v; upd(); }, { fmt: v => Math.round(v * 100) + '%' })];
  if (it.type === 'text') r.push(
    h('div', { class: 'row two' }, h('label', {}, 'Texto'), h('textarea', { value: it.text, oninput: e => { it.text = e.target.value; textFit(it); upd(); } })),
    h('div', { class: 'row two' }, h('label', {}, 'Cor'), h('input', { type: 'color', value: it.color, oninput: e => { it.color = e.target.value; save(); } })),
    h('div', { class: 'row two' }, h('label', {}, 'Contorno'), h('input', { type: 'color', value: it.stroke, oninput: e => { it.stroke = e.target.value; save(); } })),
    slider('Espessura', 0, 24, 1, it.sw, v => { it.sw = v; save(); }, { fmt: v => v.toFixed(0) }),
    h('div', { class: 'row two' }, h('label', {}, 'Alinhar'), select([['left', 'Esquerda'], ['center', 'Centro'], ['right', 'Direita']], it.align, v => { it.align = v; save(); })),
    check('Negrito', it.bold, v => { it.bold = v; textFit(it); upd(); }),
    check('Caixa de fundo', !!it.bg, v => { it.bg = v ? '#000000aa' : ''; save(); }));
  if (it.type === 'color') r.push(h('div', { class: 'row two' }, h('label', {}, 'Cor'), h('input', { type: 'color', value: it.color, oninput: e => { it.color = e.target.value; save(); } })),
    h('p', { class: 'hint' }, 'Dica: use verde (#00b140) como fundo de chroma key e coloque este item abaixo do modelo.'));
  if (it.type === 'camera') r.push(check('Espelhar', it.mirror, v => { it.mirror = v; save(); }));
  if (it.type !== 'color') r.push(check('Inverter (esquerda/direita)', it.flip, v => { it.flip = v; save(); }));
  r.push(h('div', { class: 'btns' }, h('button', { onclick: () => move(it, 1) }, '⬆ Para frente'), h('button', { onclick: () => move(it, -1) }, '⬇ Para trás'),
    h('button', { onclick: () => { it.x = P.w / 2; it.y = P.h / 2; upd(); renderTab(); } }, 'Centralizar'), h('button', { onclick: () => dupItem(it) }, 'Duplicar'), h('button', { class: 'danger', onclick: () => removeItem(it) }, 'Remover')));
  return r;
}
$('#fileImg').onchange = e => { const f = e.target.files[0]; e.target.value = ''; if (f) addImageItem(f); };

function tabScenes() {
  return [h('h3', {}, 'Cenas'),
    h('div', { class: 'list' }, P.scenes.map(s => h('div', { class: 'it' + (s.id === P.cur ? ' sel' : ''), style: 'grid-template-columns:1fr' }, h('button', { class: 'nm', onclick: () => { P.cur = s.id; selId = null; syncSources(); save(); ovDirty = true; renderTab(); } }, `${s.name} · ${s.items.length} fontes`)))),
    h('div', { class: 'btns' },
      h('button', { class: 'primary', onclick: () => { const s = newScene('Cena ' + (P.scenes.length + 1)); P.scenes.push(s); P.cur = s.id; selId = null; save(); ovDirty = true; renderTab(); } }, '+ Nova cena'),
      h('button', { onclick: () => { const s = scene(), c = { ...s, id: uid(), name: s.name + ' cópia', items: s.items.filter(i => i.type !== 'screen').map(i => ({ ...i, id: uid() })) }; P.scenes.push(c); P.cur = c.id; selId = null; syncSources(); save(); ovDirty = true; renderTab(); } }, 'Duplicar'),
      h('button', { onclick: () => { const n = prompt('Nome da cena', scene().name); if (n) { scene().name = n; save(); renderTab(); } } }, 'Renomear'),
      h('button', { class: 'danger', onclick: () => { if (P.scenes.length < 2) return toast('Precisa existir ao menos uma cena.', 2500); if (!confirm('Apagar a cena “' + scene().name + '”?')) return; scene().items.slice().forEach(i => { const sc = screens.get(i.id); if (sc) { sc.stream.getTracks().forEach(t => t.stop()); screens.delete(i.id); } }); P.scenes = P.scenes.filter(s => s.id !== P.cur); P.cur = P.scenes[0].id; selId = null; syncSources(); save(); ovDirty = true; renderTab(); } }, 'Apagar')),
    h('p', { class: 'hint' }, 'Troque de cena no seletor do topo, inclusive durante a transmissão (corte instantâneo).')];
}

// ── modelo e rastreio ──
async function useModel(id, quiet) {
  try {
    const j = await bridge.get(id); if (!j) return false;
    await model.load(j, id); P.modelId = id; fixModelItems(); save(); ovDirty = true; if (!quiet) toast(`Modelo “${model.name}” carregado.`, 2500); renderTab(); return true;
  } catch (e) { toast('Não consegui abrir o modelo: ' + (e.message || e), 5000); return false; }
}
function fixModelItems() { for (const s of P.scenes) for (const i of s.items) if (i.type === 'model') { const k = i.h; i.w = k * model.aspect; } }
async function openModelFile(f) {
  try { const j = parseModelFile(await f.text()), id = await bridge.send(j); await useModel(id); await refreshLib(); } catch (e) { toast(e.message || String(e), 5000); }
}
$('#fileModel').onchange = e => { const f = e.target.files[0]; e.target.value = ''; if (f) openModelFile(f); };
async function refreshLib() { try { state.lib = await bridge.list(); } catch { state.lib = []; } if (state.tab === 'model') renderTab(); }
bridge.onModel(async id => { await refreshLib(); if (id === P.modelId || !model.ready) useModel(id, true); toast('Modelo atualizado, vindo do Rigger.', 2500); });

async function toggleTracking() {
  if (tracker.running) { tracker.stop(); camMgr.release('track'); syncSources(); renderTab(); return; }
  try { toast('Ligando a câmera…', 1500); await camMgr.use('track'); await tracker.start(camMgr.stream); toast('Rastreando. Olhe para a tela e toque em “Calibrar neutro”.', 3500); }
  catch (e) { camMgr.release('track'); toast(explainCameraError(e), 7000); }
  renderTab();
}
$('#btnTrack').onclick = toggleTracking;

function tabModel() {
  const cur = h('div', { class: 'it', style: 'grid-template-columns:1fr' }, h('span', { class: 'nm' }, model.ready ? `${model.name} · ${model.rig.layers.length} camadas · ${model.mode === 'gpu' ? 'GPU' : 'CPU'}` : 'Nenhum modelo'));
  const out = [h('h3', {}, 'Modelo ativo'), cur,
    h('div', { class: 'btns' }, h('button', { class: 'primary', onclick: () => $('#fileModel').click() }, '📂 Abrir arquivo .vrig'),
      h('button', { onclick: async () => { await model.loadDemo(); P.modelId = 'demo'; fixModelItems(); save(); ovDirty = true; renderTab(); } }, 'Modelo de demonstração')),
    h('h3', {}, 'Biblioteca (modelos enviados pelo Rigger ou abertos aqui)'),
    state.lib.length ? h('div', { class: 'list' }, state.lib.map(m => h('div', { class: 'it' + (m.id === P.modelId ? ' sel' : ''), style: 'grid-template-columns:1fr 40px' },
      h('button', { class: 'nm', onclick: () => useModel(m.id) }, `${m.name} · ${m.layers} camadas`), h('button', { title: 'Remover da biblioteca', onclick: async () => { await bridge.remove(m.id); refreshLib(); } }, '🗑')))) : h('p', { class: 'hint' }, 'Vazia. Abra um arquivo .vrig exportado do Rigger.'),
    h('h3', {}, 'Rastreio facial'),
    h('div', { class: 'btns' }, h('button', { onclick: toggleTracking }, tracker.running ? '■ Parar rastreio' : '● Iniciar rastreio'),
      h('button', { disabled: !tracker.running, onclick: () => { toast('Olhe para a tela, relaxe o rosto… calibrando em 2 s', 2000); setTimeout(() => { tracker.calibrate(); toast('Neutro calibrado ✔', 2000); }, 2000); } }, 'Calibrar neutro')),
    h('p', { class: 'hint' }, 'Status: ' + state.status),
    check('Espelhar movimento', TS.mirror, v => { TS.mirror = v; save(); }),
    slider('Suavização', 0, 0.95, 0.01, TS.smooth, v => { TS.smooth = v; save(); }),
    slider('Giro da cabeça', 0.3, 2, 0.01, TS.headGain, v => { TS.headGain = v; save(); }),
    slider('Olhos', 0.3, 2, 0.01, TS.eyeGain, v => { TS.eyeGain = v; save(); }),
    slider('Boca', 0.3, 2, 0.01, TS.mouthGain, v => { TS.mouthGain = v; save(); }),
    check('Piscar automático sem rastreio', model.s.blink, v => { model.s.blink = v; }),
    check('Respiração', model.s.breath, v => { model.s.breath = v; })];
  if (model.ready && model.rig.expressions.length) out.push(h('h3', {}, 'Expressões'), h('div', { class: 'btns' }, model.rig.expressions.map(e => h('button', { class: model.rig.exprW[e.id]?.target ? 'on' : '', onclick: () => { model.rig.toggleExpression(e.id); renderTab(); } }, e.name))));
  if (model.ready && model.rig.animations.length) out.push(h('h3', {}, 'Animações'), h('div', { class: 'btns' }, model.rig.animations.map(a => h('button', { class: model.anim?.an === a ? 'on' : '', onclick: () => { if (model.anim?.an === a) model.stopAnim(); else model.playAnim(a); renderTab(); } }, a.name))));
  return out;
}

// ── áudio ──
async function addMic() {
  try { await nativePerms(['RECORD_AUDIO']); mixer.ensure(); await mixer.addMic(TS.micId || ''); renderTab(); }
  catch (e) { toast(e?.name === 'NotAllowedError' ? 'Permissão do microfone negada.' : 'Microfone: ' + (e.message || e), 5000); }
}
function tabAudio() {
  const strip = (id, name, vol, muted, onVol, onMute, onDel) => h('div', { class: 'mix' }, h('div', { class: 'nm' }, h('b', {}, name), onDel ? h('button', { class: 'danger', style: 'min-height:24px;padding:0 8px', onclick: onDel }, 'remover') : null),
    h('input', { type: 'range', min: 0, max: 2, step: 0.01, value: vol, oninput: e => onVol(+e.target.value) }), h('button', { onclick: ev => { onMute(); renderTab(); } }, muted ? '🔇' : '🔊'),
    h('div', { class: 'vu', 'data-vu': id }, h('i')));
  const list = [...mixer.srcs.values()].map(s => strip(s.id, `${s.kind === 'mic' ? '🎤' : '🖥'} ${s.name}`, s.vol, s.muted, v => mixer.setVol(s.id, v), () => mixer.setMute(s.id, !s.muted), () => { mixer.remove(s.id); renderTab(); }));
  return [h('h3', {}, 'Mixer'), ...list, !list.length ? h('p', { class: 'hint' }, 'Nenhuma fonte de áudio. Adicione o microfone (a captura de tela traz o áudio dela sozinha).') : null,
    h('div', { class: 'btns' }, h('button', { class: 'primary', onclick: addMic }, '🎤 Adicionar microfone')),
    h('h3', {}, 'Saída (mestre)'), strip('master', 'Mestre', mixer.masterGain, mixer.muted, v => mixer.setMaster(v), () => mixer.setMaster(mixer.masterGain, !mixer.muted)),
    h('p', { class: 'hint' }, 'O mestre vai para a gravação e para a transmissão. Fones de ouvido evitam eco se o microfone captar o alto-falante.')];
}

// ── transmissão e gravação ──
async function toggleRec() {
  if (recorder.active) { await recorder.stop(); toast('Gravação salva.', 3000); return renderTab(); }
  try { mixer.ensure(); recorder.start(out, P.fps, mixer.stream, 'live'); toast('Gravando…', 1500); } catch (e) { toast(e.message || String(e), 5000); }
  renderTab();
}
$('#btnRec').onclick = toggleRec;
let wake = null;
async function toggleLive() {
  if (streamer.on) { await streamer.stop(); try { wake?.release(); } catch { /* ok */ } wake = null; toast('Transmissão encerrada.', 3000); return renderTab(); }
  if (!RtmpStreamer.supported) { state.tab = 'live'; renderTab(); return toast(RtmpStreamer.reason, 7000); }
  if (!P.url || !streamKey) { state.tab = 'live'; renderTab(); return toast('Preencha o servidor e a chave da transmissão.', 4000); }
  try {
    mixer.ensure(); toast('Conectando…', 2000);
    await streamer.start({ url: P.url, key: streamKey, width: P.w, height: P.h, fps: P.fps, kbps: P.kbps });
    try { wake = await navigator.wakeLock?.request('screen'); } catch { /* ok */ }
    toast('Você está ao vivo! Mantenha o app aberto.', 4000);
  } catch (e) { toast('Não consegui transmitir: ' + (e.message || e), 8000); }
  renderTab();
}
$('#btnLive').onclick = toggleLive;
function tabLive() {
  const supported = RtmpStreamer.supported;
  return [h('h3', {}, 'Transmitir ao vivo (RTMP)'),
    !supported ? h('p', { class: 'hint warn' }, RtmpStreamer.reason) : null,
    h('div', { class: 'row two' }, h('label', {}, 'Plataforma'), select(PLATFORMS.map(p => [p[0], p[1]]), P.platform, v => { P.platform = v; const p = PLATFORMS.find(x => x[0] === v); if (p[2]) P.url = p[2]; save(); renderTab(); })),
    h('div', { class: 'row two' }, h('label', {}, 'Servidor'), h('input', { type: 'text', value: P.url, placeholder: 'rtmp://…', onchange: e => { P.url = e.target.value.trim(); P.platform = (PLATFORMS.find(p => p[2] === P.url) || ['custom'])[0]; save(); } })),
    h('div', { class: 'row two' }, h('label', {}, 'Chave'), h('input', { type: 'password', value: streamKey, placeholder: 'chave da transmissão', autocomplete: 'off', oninput: e => { streamKey = e.target.value.trim(); save(); } })),
    check('Lembrar a chave neste aparelho', P.rememberKey, v => { P.rememberKey = v; save(); }),
    slider('Bitrate (kbps)', 800, 8000, 100, P.kbps, v => { P.kbps = v; save(); }, { fmt: v => v.toFixed(0) }),
    h('p', { class: 'hint' }, `Saída: ${P.w}×${P.h} a ${P.fps} fps (mude em “Ajustes”). Twitch recomenda 2500–6000 kbps em 720p/1080p. Nunca mostre a chave na tela de uma live.`),
    h('div', { class: 'btns' }, h('button', { class: 'golive' + (streamer.on ? ' on' : ''), onclick: toggleLive }, streamer.on ? '■ Encerrar transmissão' : '📡 Iniciar transmissão')),
    h('h3', {}, 'Gravação'), h('div', { class: 'btns' }, h('button', { class: 'rec' + (recorder.active ? ' on' : ''), onclick: toggleRec }, recorder.active ? '■ Parar e salvar' : '⏺ Gravar vídeo')),
    h('p', { class: 'hint' }, 'A gravação salva um arquivo de vídeo (.webm) com a cena e o áudio do mixer.')];
}

// ── ajustes ──
function applyResKey(key) {
  const [nw, nh] = RES[key], kx = nw / P.w, ky = nh / P.h, k = Math.min(kx, ky);
  for (const s of P.scenes) for (const i of s.items) { i.x *= kx; i.y *= ky; if (i.type === 'text') { i.fs *= k; textFit(i); } else { i.w *= (i.type === 'color' ? kx : k); i.h *= (i.type === 'color' ? ky : k); } }
  P.w = nw; P.h = nh; applyRes(); save(); ovDirty = true;
}
function tabSet() {
  const key = Object.keys(RES).find(k => RES[k][0] === P.w && RES[k][1] === P.h) || '1280x720';
  return [h('h3', {}, 'Vídeo de saída'),
    h('div', { class: 'row two' }, h('label', {}, 'Resolução'), select([['854x480', '480p (854×480)'], ['1280x720', '720p (1280×720)'], ['1920x1080', '1080p (1920×1080)'], ['720x1280', 'Vertical 720×1280'], ['1080x1920', 'Vertical 1080×1920']], key, v => { if (streamer.on || recorder.active) return toast('Pare a gravação/transmissão antes.', 3000); applyResKey(v); P.kbps = RES[v][0] * RES[v][1] > 1280 * 720 ? 4500 : RES[v][0] * RES[v][1] < 1280 * 720 ? 1200 : 2800; renderTab(); })),
    h('div', { class: 'row two' }, h('label', {}, 'Quadros/s'), select([[24, '24'], [30, '30'], [60, '60 (pesado)']], P.fps, v => { P.fps = +v; save(); })),
    h('div', { class: 'row two' }, h('label', {}, 'Fundo'), h('input', { type: 'color', value: P.bg, oninput: e => { P.bg = e.target.value; save(); } })),
    h('h3', {}, 'Câmera'),
    h('div', { class: 'row two' }, h('label', {}, 'Qualidade'), select([[360, '360p (leve)'], [480, '480p'], [720, '720p'], [1080, '1080p']], TS.camRes, v => { TS.camRes = +v; save(); toast('Vale na próxima vez que a câmera for ligada.', 2500); })),
    h('p', { class: 'hint' }, 'Câmera e rastreio usam a mesma câmera (aberta uma vez só). Resolução maior melhora a fonte “Câmera”, mas pesa no rastreio.'),
    h('h3', {}, 'Projeto'),
    h('div', { class: 'btns' }, h('button', { class: 'danger', onclick: () => { if (confirm('Apagar todas as cenas e ajustes deste aparelho?')) { try { localStorage.removeItem(LS); } catch { /* ok */ } location.reload(); } } }, 'Apagar projeto'))];
}

// ───────────────────────── início ─────────────────────────
window.__live = { P, TS, model, mixer, tracker, recorder, streamer, out, scene, addItem, mk, addModelItem, addTextItem, addColorItem, addCameraItem, useModel, state, camMgr, get selId() { return selId; }, set selId(v) { selId = v; ovDirty = true; }, outPt, rotPos };
(async function init() {
  applyRes(); renderTab(); requestAnimationFrame(frame);
  refreshLib().catch(() => {});
  await restoreImages();
  let ok = false;
  try { if (P.modelId && P.modelId !== 'demo') ok = await useModel(P.modelId, true); } catch { /* ok */ }
  if (!ok) { await model.loadDemo(); P.modelId = 'demo'; }
  if (!scene().items.length) { addColorItem(); const it = mk('model'); it.w = P.h * 0.9 * model.aspect; it.h = P.h * 0.9; scene().items.push(it); scene().items[0].color = '#00b140'; selId = null; }
  fixModelItems(); renderTab(); ovDirty = true; syncSources();
  if (!window.cordova && 'serviceWorker' in navigator) { /* sem service worker: o app muda com frequência */ }
})();
