package com.meuapp.live;

import android.media.MediaCodec;
import android.media.MediaCodecInfo;
import android.media.MediaFormat;
import java.nio.ByteBuffer;
import java.util.Arrays;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import org.apache.cordova.CallbackContext;
import org.apache.cordova.CordovaArgs;
import org.apache.cordova.CordovaPlugin;
import org.apache.cordova.PluginResult;
import org.json.JSONObject;

/**
 * Ponte JS → RTMP. O vídeo chega já em H.264 (WebCodecs, formato Annex B); o áudio chega como PCM e é codificado em AAC aqui (MediaCodec).
 * Tudo roda em threads próprias (uma para vídeo, uma para áudio) com fila limitada: se a rede engasgar, descartamos quadros P em vez de travar o app.
 */
public class LivePlugin extends CordovaPlugin {
    private RtmpPublisher pub;
    private final AtomicInteger dropped = new AtomicInteger();
    private volatile boolean needKey = true;
    private byte[] curSps, curPps;
    private boolean cfgSent = false;

    private ThreadPoolExecutor vexec, aexec;
    private MediaCodec aenc;
    private int sampleRate = 48000, channels = 2;
    private boolean aacCfgSent = false;
    private long audioPtsUs = -1;

    private static ThreadPoolExecutor single(String name, int cap) {
        ThreadPoolExecutor e = new ThreadPoolExecutor(1, 1, 0, TimeUnit.SECONDS, new ArrayBlockingQueue<>(cap), r -> { Thread t = new Thread(r, name); t.setDaemon(true); return t; });
        e.setRejectedExecutionHandler((r, ex) -> { });
        return e;
    }

    @Override
    public boolean execute(String action, CordovaArgs a, CallbackContext cb) throws org.json.JSONException {
        switch (action) {
            case "open": open(a, cb); return true;
            case "video": video(a.getArrayBuffer(0), a.getInt(1), a.getBoolean(2)); return true;
            case "audio": audio(a.getArrayBuffer(0), a.getInt(1)); return true;
            case "status": {
                JSONObject o = new JSONObject();
                o.put("open", pub != null && pub.isOpen()); o.put("bytesSent", pub == null ? 0 : pub.bytesSent);
                o.put("dropped", dropped.get()); o.put("error", pub == null ? "" : String.valueOf(pub.getError() == null ? "" : pub.getError()));
                cb.sendPluginResult(new PluginResult(PluginResult.Status.OK, o)); return true;
            }
            case "close": close(); cb.success(); return true;
        }
        return false;
    }

    private void open(CordovaArgs a, CallbackContext cb) throws org.json.JSONException {
        final String url = a.getString(0), key = a.getString(1);
        final int w = a.getInt(2), h = a.getInt(3), fps = a.getInt(4), kbps = a.getInt(5);
        sampleRate = a.getInt(6); channels = a.getInt(7);
        close();
        cordova.getThreadPool().execute(() -> {
            try {
                RtmpPublisher p = new RtmpPublisher(url, key);
                p.setMetadata(w, h, fps, kbps, sampleRate, channels);
                p.connect();
                startAudioEncoder();
                synchronized (this) {
                    pub = p; cfgSent = false; aacCfgSent = false; needKey = true; curSps = curPps = null; audioPtsUs = -1; dropped.set(0);
                    vexec = single("live-video", 90); aexec = single("live-audio", 200);
                }
                cb.success();
            } catch (Throwable t) { close(); cb.error(String.valueOf(t.getMessage() == null ? t.toString() : t.getMessage())); }
        });
    }

    private void startAudioEncoder() throws java.io.IOException {
        MediaFormat f = MediaFormat.createAudioFormat(MediaFormat.MIMETYPE_AUDIO_AAC, sampleRate, channels);
        f.setInteger(MediaFormat.KEY_AAC_PROFILE, MediaCodecInfo.CodecProfileLevel.AACObjectLC);
        f.setInteger(MediaFormat.KEY_BIT_RATE, 128_000);
        f.setInteger(MediaFormat.KEY_MAX_INPUT_SIZE, 16384);
        aenc = MediaCodec.createEncoderByType(MediaFormat.MIMETYPE_AUDIO_AAC);
        aenc.configure(f, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE);
        aenc.start();
    }

    // ───── vídeo ─────
    private void video(final byte[] annexb, final int ts, final boolean key) {
        final ThreadPoolExecutor ex = vexec; final RtmpPublisher p = pub;
        if (ex == null || p == null) return;
        if (needKey && !key) { dropped.incrementAndGet(); return; }
        if (ex.getQueue().remainingCapacity() < 10 && !key) { needKey = true; dropped.incrementAndGet(); return; }   // rede lenta: pula até o próximo quadro-chave
        if (key) needKey = false;
        ex.execute(() -> {
            try {
                H264Util.Frame f = H264Util.convert(annexb, 0, annexb.length);
                if (f.sps != null && f.pps != null && (!cfgSent || !Arrays.equals(f.sps, curSps) || !Arrays.equals(f.pps, curPps))) {
                    curSps = f.sps; curPps = f.pps; p.sendVideoConfig(H264Util.avcConfig(f.sps, f.pps)); cfgSent = true;
                }
                if (!cfgSent || f.avcc.length == 0) return;                      // ainda sem SPS/PPS
                p.sendVideo(f.avcc, ts, f.key);
            } catch (Exception e) { /* o status() mostra o erro */ }
        });
    }

    // ───── áudio ─────
    private void audio(final byte[] pcm, final int ts) {
        final ThreadPoolExecutor ex = aexec; final MediaCodec enc = aenc; final RtmpPublisher p = pub;
        if (ex == null || enc == null || p == null) return;
        ex.execute(() -> {
            try {
                if (audioPtsUs < 0) audioPtsUs = ts * 1000L;
                int off = 0;
                while (off < pcm.length) {
                    int i = enc.dequeueInputBuffer(20_000);
                    if (i < 0) { drain(enc, p); continue; }
                    ByteBuffer b = enc.getInputBuffer(i); b.clear();
                    int n = Math.min(b.remaining(), pcm.length - off);
                    b.put(pcm, off, n);
                    enc.queueInputBuffer(i, 0, n, audioPtsUs, 0);
                    audioPtsUs += (long) n * 1_000_000L / (2L * channels * sampleRate);
                    off += n;
                    drain(enc, p);
                }
            } catch (Exception e) { /* idem */ }
        });
    }

    private void drain(MediaCodec enc, RtmpPublisher p) throws java.io.IOException {
        MediaCodec.BufferInfo info = new MediaCodec.BufferInfo();
        while (true) {
            int o = enc.dequeueOutputBuffer(info, 0);
            if (o < 0) return;                                                     // sem saída / formato mudou
            ByteBuffer b = enc.getOutputBuffer(o);
            byte[] d = new byte[info.size]; b.position(info.offset); b.get(d, 0, info.size);
            enc.releaseOutputBuffer(o, false);
            if ((info.flags & MediaCodec.BUFFER_FLAG_CODEC_CONFIG) != 0) { p.sendAudioConfig(d); aacCfgSent = true; }
            else if (info.size > 0) {
                if (!aacCfgSent) { p.sendAudioConfig(H264Util.aacConfig(sampleRate, channels)); aacCfgSent = true; }
                p.sendAudio(d, (int) (info.presentationTimeUs / 1000));
            }
        }
    }

    private synchronized void close() {
        if (vexec != null) vexec.shutdownNow(); if (aexec != null) aexec.shutdownNow();
        vexec = aexec = null;
        if (aenc != null) { try { aenc.stop(); } catch (Exception ignored) { } try { aenc.release(); } catch (Exception ignored) { } aenc = null; }
        if (pub != null) { pub.close(); pub = null; }
    }

    @Override public void onDestroy() { close(); }
}
