package com.meuapp.live;

import java.io.ByteArrayOutputStream;
import java.util.ArrayList;
import java.util.List;

/** Converte H.264 “Annex B” (códigos de início 00 00 01) — saída do WebCodecs/MediaCodec — para o formato do RTMP/FLV (AVCC). */
public final class H264Util {
    private H264Util() { }

    public static class Frame {
        public byte[] sps, pps;       // preenchidos quando o quadro traz SPS/PPS
        public byte[] avcc;           // NAL units com prefixo de 4 bytes (sem SPS/PPS/AUD)
        public boolean key;
    }

    /** @return pares {início, fim} de cada NAL (sem o código de início). */
    public static List<int[]> split(byte[] d, int off, int len) {
        List<int[]> r = new ArrayList<>();
        int end = off + len, i = off, start = -1;
        while (i + 2 < end) {
            if (d[i] == 0 && d[i + 1] == 0 && d[i + 2] == 1) {
                if (start >= 0) { int e = i; while (e > start && d[e - 1] == 0) e--; r.add(new int[] { start, e }); }
                start = i + 3; i += 3;
            } else i++;
        }
        if (start >= 0 && start < end) r.add(new int[] { start, end });
        return r;
    }

    public static Frame convert(byte[] d, int off, int len) {
        Frame f = new Frame();
        ByteArrayOutputStream o = new ByteArrayOutputStream(len + 16);
        for (int[] n : split(d, off, len)) {
            int t = d[n[0]] & 0x1F, size = n[1] - n[0];
            if (size <= 0) continue;
            if (t == 7) { f.sps = java.util.Arrays.copyOfRange(d, n[0], n[1]); continue; }
            if (t == 8) { f.pps = java.util.Arrays.copyOfRange(d, n[0], n[1]); continue; }
            if (t == 9) continue;                                   // delimitador de unidade de acesso
            if (t == 5) f.key = true;
            o.write(size >> 24); o.write(size >> 16); o.write(size >> 8); o.write(size);
            o.write(d, n[0], size);
        }
        f.avcc = o.toByteArray();
        return f;
    }

    /** AVCDecoderConfigurationRecord a partir de SPS e PPS. */
    public static byte[] avcConfig(byte[] sps, byte[] pps) {
        ByteArrayOutputStream o = new ByteArrayOutputStream();
        o.write(1); o.write(sps[1]); o.write(sps[2]); o.write(sps[3]); o.write(0xFF); o.write(0xE1);
        o.write(sps.length >> 8); o.write(sps.length); o.write(sps, 0, sps.length);
        o.write(1); o.write(pps.length >> 8); o.write(pps.length); o.write(pps, 0, pps.length);
        return o.toByteArray();
    }

    /** AudioSpecificConfig (AAC-LC) de 2 bytes. */
    public static byte[] aacConfig(int sampleRate, int channels) {
        int[] rates = { 96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350 };
        int idx = 4; for (int i = 0; i < rates.length; i++) if (rates[i] == sampleRate) idx = i;
        int v = (2 << 11) | (idx << 7) | (channels << 3);
        return new byte[] { (byte) (v >> 8), (byte) v };
    }
}
