// bridge.js — ponte entre o app de rigging e o Studio (rastreamento facial).
// Os dois apps rodam na mesma origem (pastas /pwa e /studio do mesmo site), então compartilham o IndexedDB e o BroadcastChannel:
//   • bridge.send(modelo) grava o modelo na biblioteca compartilhada e avisa o Studio (atualização ao vivo);
//   • exportModelFile(modelo) baixa um arquivo .vrig para abrir no Studio (ou em outro aparelho).
const DB = 'vrig-bridge', STORE = 'models';
let dbp = null;
const open = () => dbp || (dbp = new Promise((res, rej) => {
  const r = indexedDB.open(DB, 1);
  r.onupgradeneeded = () => r.result.createObjectStore(STORE, { keyPath: 'id' });
  r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
}));
const tx = async (mode, fn) => { const db = await open(); return new Promise((res, rej) => { const t = db.transaction(STORE, mode), q = fn(t.objectStore(STORE)); t.oncomplete = () => res(q?.result); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error); }); };
const slug = s => 'm_' + String(s || 'modelo').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\W+/g, '_').toLowerCase().slice(0, 40);

export const FILE_EXT = '.vrig';
const ch = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('vrig-bridge') : null;

export const bridge = {
  /** Grava o modelo na biblioteca (mesmo nome = substitui) e avisa os Studios abertos. Retorna o id. */
  async send(model, id) {
    const json = JSON.stringify({ ...model, format: 'vtuber-rigger' });
    id = id || slug(model.name);
    await tx('readwrite', s => s.put({ id, name: model.name || 'Modelo', ts: Date.now(), bytes: json.length, layers: model.layers?.length || 0, json }));
    ch?.postMessage({ type: 'model', id });
    return id;
  },
  async get(id) { const r = await tx('readonly', s => s.get(id)); return r ? JSON.parse(r.json) : null; },
  async list() {
    const all = await tx('readonly', s => s.getAll());
    return (all || []).map(({ id, name, ts, bytes, layers }) => ({ id, name, ts, bytes, layers })).sort((a, b) => b.ts - a.ts);
  },
  async remove(id) { await tx('readwrite', s => s.delete(id)); },
  /** cb(id) é chamado quando o rigger envia um modelo. */
  onModel(cb) { if (ch) ch.addEventListener('message', e => { if (e.data?.type === 'model') cb(e.data.id); }); },
};

/** Salva/compartilha um arquivo. No navegador: download normal. No app Cordova (o WebView ignora downloads):
 *  grava no cache com cordova-plugin-file e abre a folha de compartilhar (cordova-plugin-x-socialsharing) para salvar em Arquivos/Drive/WhatsApp. */
export function saveBlob(blob, filename) {
  const C = window.cordova, share = window.plugins?.socialsharing;
  if (C && window.resolveLocalFileSystemURL && C.file && share) {
    return new Promise((res, rej) => window.resolveLocalFileSystemURL(C.file.cacheDirectory, dir =>
      dir.getFile(filename, { create: true }, fe => fe.createWriter(w => {
        w.onwriteend = () => share.shareWithOptions({ files: [fe.nativeURL], subject: filename }, () => res(true), () => res(false));
        w.onerror = rej; w.write(blob);
      }, rej), rej), rej));
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = filename;
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  return Promise.resolve(true);
}

export function exportModelFile(model, name) {
  const blob = new Blob([JSON.stringify({ ...model, format: 'vtuber-rigger' })], { type: 'application/json' });
  return saveBlob(blob, (name || model.name || 'modelo').replace(/[^\w-]+/g, '_') + FILE_EXT);
}

/** Valida o texto de um arquivo de modelo (.vrig / .vrig.json / .json). Retorna o objeto ou lança erro em português. */
export function parseModelFile(text) {
  let j; try { j = JSON.parse(text); } catch { throw new Error('Arquivo inválido: não é um modelo .vrig.'); }
  if (!j || j.format !== 'vtuber-rigger' || !Array.isArray(j.layers)) throw new Error('Este arquivo não é um modelo do Rigger VTuber.');
  return j;
}
