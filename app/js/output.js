// output.js — gravação em arquivo (MediaRecorder) e transmissão RTMP (WebCodecs → plugin nativo).
import { saveBlob } from './bridge.js';

export class Recorder {
  constructor() { this.rec = null; this.t0 = 0; }
  get active() { return !!this.rec; }
  start(canvas, fps, audioStream, name = 'live') {
    if (!window.MediaRecorder) throw new Error('Este WebView não grava vídeo (MediaRecorder).');
    const vs = canvas.captureStream(fps);
    audioStream?.getAudioTracks().forEach(t => vs.addTrack(t));
    const mime = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm', 'video/mp4'].find(m => MediaRecorder.isTypeSupported(m)) || '';
    const parts = [], rec = new MediaRecorder(vs, mime ? { mimeType: mime, videoBitsPerSecond: Math.max(2e6, canvas.width * canvas.height * 4) } : {});
    rec.ondataavailable = e => e.data.size && parts.push(e.data);
    this.done = new Promise(res => {
      rec.onstop = async () => {
        vs.getVideoTracks().forEach(t => t.stop()); this.rec = null;
        const ext = (rec.mimeType || '').includes('mp4') ? 'mp4' : 'webm';
        const blob = new Blob(parts, { type: rec.mimeType || 'video/webm' });
        try { await saveBlob(blob, `${name}_${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.${ext}`); } catch (e) { console.error(e); }
        res(blob);
      };
    });
    rec.start(1000); this.rec = rec; this.t0 = performance.now();
  }
  stop() { return this.rec ? (this.rec.stop(), this.done) : Promise.resolve(null); }
  get seconds() { return this.rec ? (performance.now() - this.t0) / 1000 : 0; }
}

export const PLATFORMS = [
  ['twitch', 'Twitch', 'rtmp://live.twitch.tv/app'],
  ['youtube', 'YouTube', 'rtmp://a.rtmp.youtube.com/live2'],
  ['youtubes', 'YouTube (RTMPS)', 'rtmps://a.rtmps.youtube.com:443/live2'],
  ['facebook', 'Facebook Live', 'rtmps://live-api-s.facebook.com:443/rtmp/'],
  ['custom', 'Outro servidor RTMP…', ''],
];
export const QUALITY = {
  '480': { w: 854, h: 480, kbps: 1200 }, '720': { w: 1280, h: 720, kbps: 2800 }, '1080': { w: 1920, h: 1080, kbps: 5000 },
};

/** Transmissão: quadros do canvas → VideoEncoder (H.264, Annex B) → LiveRtmp.video; PCM do mixer → LiveRtmp.audio (AAC é feito no nativo). */
export class RtmpStreamer {
  constructor(mixer) { this.mixer = mixer; this.on = false; this.stats = { fps: 0, kbps: 0, dropped: 0, err: '' }; }
  static get supported() { return !!window.LiveRtmp && typeof VideoEncoder !== 'undefined'; }
  static get reason() {
    if (!window.LiveRtmp) return 'Transmitir ao vivo só funciona no app Android compilado com o plugin cordova-plugin-live-rtmp (veja o LEIA-ME). No navegador dá para gravar.';
    if (typeof VideoEncoder === 'undefined') return 'Este WebView não tem WebCodecs (VideoEncoder). Atualize o “Android System WebView” na Play Store.';
    return '';
  }

  async start({ url, key, width, height, fps, kbps }) {
    if (this.on) return;
    const sr = this.mixer.ensure().sampleRate;
    const level = width * height > 1280 * 720 ? '2a' : '1f';
    let cfg = null;
    for (const codec of ['avc1.4200' + level, 'avc1.4d00' + level, 'avc1.6400' + level]) {
      const c = { codec, width, height, bitrate: kbps * 1000, framerate: fps, avc: { format: 'annexb' }, latencyPreference: 'realtime', bitrateMode: 'constant' };
      try { if ((await VideoEncoder.isConfigSupported(c)).supported) { cfg = c; break; } } catch { /* tenta o próximo */ }
    }
    if (!cfg) throw new Error('Este aparelho não codifica H.264 pelo WebView (WebCodecs).');
    await new Promise((ok, err) => window.LiveRtmp.open({ url, key, width, height, fps, videoKbps: kbps, sampleRate: sr, channels: 2 }, ok, m => err(new Error(m))));
    this.cfg = cfg; this.fps = fps; this.t0 = performance.now(); this.n = 0; this.bytes = 0; this.aSamples = 0; this.aBase = null; this.stats = { fps: 0, kbps: 0, dropped: 0, err: '' }; this.lastStat = { t: this.t0, n: 0, b: 0 };
    this.enc = new VideoEncoder({
      output: chunk => {
        const b = new ArrayBuffer(chunk.byteLength); chunk.copyTo(b); this.bytes += b.byteLength;
        window.LiveRtmp.video(b, chunk.timestamp / 1000, chunk.type === 'key');
      },
      error: e => { this.stats.err = e.message || String(e); },
    });
    this.enc.configure(cfg);
    await this.mixer.startPcm(buf => {
      if (!this.on) return;
      if (this.aBase === null) this.aBase = performance.now() - this.t0;
      window.LiveRtmp.audio(buf, this.aBase + this.aSamples / sr * 1000); this.aSamples += buf.byteLength / 4;
    });
    this.on = true;
    this.poll = setInterval(() => window.LiveRtmp.status(s => { if (s) { this.stats.dropped = s.dropped; if (s.error) this.stats.err = s.error; if (!s.open && this.on) this.stats.err ||= 'Conexão encerrada'; } }), 2000);
  }

  /** Chamado a cada quadro composto. */
  frame(canvas, now) {
    if (!this.on || !this.enc || this.enc.state !== 'configured') return;
    if (this.enc.encodeQueueSize > 4) { this.stats.dropped++; return; }
    const ts = (now - this.t0) * 1000, f = new VideoFrame(canvas, { timestamp: ts });
    this.enc.encode(f, { keyFrame: this.n % (this.fps * 2) === 0 }); f.close(); this.n++;
    if (now - this.lastStat.t >= 1000) {
      const dt = (now - this.lastStat.t) / 1000;
      this.stats.fps = (this.n - this.lastStat.n) / dt; this.stats.kbps = (this.bytes - this.lastStat.b) * 8 / 1000 / dt;
      this.lastStat = { t: now, n: this.n, b: this.bytes };
    }
  }
  get seconds() { return this.on ? (performance.now() - this.t0) / 1000 : 0; }

  async stop() {
    if (!this.on) return;
    this.on = false; clearInterval(this.poll);
    this.mixer.stopPcm();
    try { await this.enc.flush(); } catch { /* ok */ }
    try { this.enc.close(); } catch { /* ok */ }
    this.enc = null; window.LiveRtmp.close();
  }
}
