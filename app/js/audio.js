// audio.js — mixer de áudio (microfone, áudio da tela) com ganho, mudo, medidor e saída para gravação / transmissão.
const WORKLET = `
class PcmTap extends AudioWorkletProcessor {
  constructor() { super(); this.n = 0; this.buf = new Int16Array(1024 * 2); }
  process(inputs) {
    const i = inputs[0]; if (!i || !i.length) return true;
    const L = i[0], R = i[1] || i[0];
    for (let k = 0; k < L.length; k++) {
      const l = Math.max(-1, Math.min(1, L[k])), r = Math.max(-1, Math.min(1, R[k]));
      this.buf[this.n * 2] = l < 0 ? l * 32768 : l * 32767; this.buf[this.n * 2 + 1] = r < 0 ? r * 32768 : r * 32767;
      if (++this.n === 1024) { const out = this.buf.buffer.slice(0); this.port.postMessage(out, [out]); this.n = 0; }
    }
    return true;
  }
}
registerProcessor('pcm-tap', PcmTap);`;

export class Mixer {
  constructor() { this.ctx = null; this.srcs = new Map(); this.masterGain = 1; this.muted = false; this.tap = null; }

  /** Precisa de um toque do usuário (política de áudio do navegador). */
  ensure() {
    if (this.ctx) { if (this.ctx.state === 'suspended') this.ctx.resume(); return this.ctx; }
    const ctx = this.ctx = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'interactive' });
    this.master = ctx.createGain(); this.master.channelCount = 2; this.master.channelCountMode = 'explicit';
    this.dest = ctx.createMediaStreamDestination();
    this.analyser = ctx.createAnalyser(); this.analyser.fftSize = 512;
    this.master.connect(this.dest); this.master.connect(this.analyser);
    return ctx;
  }
  get sampleRate() { return this.ctx?.sampleRate || 48000; }
  get stream() { this.ensure(); return this.dest.stream; }

  /** @param kind 'mic' | 'tela' */
  add(id, name, mediaStream, kind) {
    const ctx = this.ensure();
    if (this.srcs.has(id)) this.remove(id);
    const node = ctx.createMediaStreamSource(mediaStream), gain = ctx.createGain(), an = ctx.createAnalyser();
    an.fftSize = 512; node.connect(gain); gain.connect(an); gain.connect(this.master);
    this.srcs.set(id, { id, name, kind, mediaStream, node, gain, an, vol: 1, muted: false });
    return this.srcs.get(id);
  }
  async addMic(deviceId) {
    const ms = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: deviceId ? { exact: deviceId } : undefined, echoCancellation: false, noiseSuppression: true, autoGainControl: false }, video: false });
    return this.add('mic-' + Date.now().toString(36), ms.getAudioTracks()[0]?.label || 'Microfone', ms, 'mic');
  }
  remove(id) {
    const s = this.srcs.get(id); if (!s) return;
    try { s.node.disconnect(); s.gain.disconnect(); } catch { /* ok */ }
    if (s.kind === 'mic') s.mediaStream.getTracks().forEach(t => t.stop());
    this.srcs.delete(id);
  }
  setVol(id, v) { const s = this.srcs.get(id); if (!s) return; s.vol = v; s.gain.gain.value = s.muted ? 0 : v; }
  setMute(id, m) { const s = this.srcs.get(id); if (!s) return; s.muted = m; s.gain.gain.value = m ? 0 : s.vol; }
  setMaster(v, muted = this.muted) { this.masterGain = v; this.muted = muted; if (this.master) this.master.gain.value = muted ? 0 : v; }

  /** Nível 0–1 (RMS) de uma fonte (ou do mestre, id = null). */
  level(id) {
    const an = id ? this.srcs.get(id)?.an : this.analyser; if (!an) return 0;
    const b = this._b || (this._b = new Float32Array(512)); an.getFloatTimeDomainData(b);
    let s = 0; for (let i = 0; i < b.length; i++) s += b[i] * b[i];
    return Math.min(1, Math.sqrt(s / b.length) * 2.2);
  }

  /** Entrega PCM 16-bit estéreo intercalado (blocos de 1024 quadros) para a transmissão: cb(ArrayBuffer). */
  async startPcm(cb) {
    const ctx = this.ensure();
    if (!ctx.audioWorklet) throw new Error('Este WebView não tem AudioWorklet (áudio da transmissão).');
    if (!this._wl) { this._wl = URL.createObjectURL(new Blob([WORKLET], { type: 'text/javascript' })); await ctx.audioWorklet.addModule(this._wl); }
    this.tap = new AudioWorkletNode(ctx, 'pcm-tap', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2] });
    this.tap.port.onmessage = e => cb(e.data);
    this.silent = ctx.createGain(); this.silent.gain.value = 0;
    this.master.connect(this.tap); this.tap.connect(this.silent); this.silent.connect(ctx.destination);   // precisa estar ligado ao destino para rodar
  }
  stopPcm() {
    try { this.master.disconnect(this.tap); this.tap?.disconnect(); this.silent?.disconnect(); } catch { /* ok */ }
    if (this.tap) this.tap.port.onmessage = null;
    this.tap = null;
  }
}
