package com.meuapp.live;

import java.io.*;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.security.SecureRandom;
import java.util.*;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import javax.net.ssl.SSLSocket;
import javax.net.ssl.SSLSocketFactory;

/**
 * Cliente RTMP/RTMPS (somente publicação) em Java puro — sem dependências do Android, testável no PC.
 * Fluxo: handshake → connect → releaseStream/FCPublish → createStream → publish → (metadados, config AVC/AAC, quadros).
 * Vídeo: H.264 em AVCC (NALs com prefixo de tamanho). Áudio: AAC cru (sem ADTS).
 */
public class RtmpPublisher {
    private static final Pattern URL = Pattern.compile("^(rtmps?)://([^/:]+)(?::(\\d+))?/(.+)$", Pattern.CASE_INSENSITIVE);

    private final boolean tls;
    private final String host, app, stream, tcUrl;
    private final int port;
    private Socket sock;
    private DataInputStream in;
    private OutputStream out;
    private final Object wlock = new Object();
    private int outChunk = 128, inChunk = 128, streamId = 0;
    private long bytesIn = 0, lastAck = 0, ackWindow = 2_500_000L;
    private volatile boolean open = false;
    private volatile String error = null;
    public volatile long bytesSent = 0;
    private final Map<Integer, CS> cs = new HashMap<>();
    private final Map<String, Object> meta = new LinkedHashMap<>();

    /** @param url  rtmp[s]://host[:porta]/app   (ou já com a chave no fim, se key for vazio)  @param key chave da transmissão */
    public RtmpPublisher(String url, String key) {
        Matcher m = URL.matcher(url.trim());
        if (!m.matches()) throw new IllegalArgumentException("URL RTMP inválida: " + url);
        tls = m.group(1).equalsIgnoreCase("rtmps");
        host = m.group(2);
        port = m.group(3) != null ? Integer.parseInt(m.group(3)) : (tls ? 443 : 1935);
        String path = m.group(4);
        while (path.endsWith("/")) path = path.substring(0, path.length() - 1);
        if (key == null || key.trim().isEmpty()) {
            int i = path.lastIndexOf('/');
            if (i < 0) throw new IllegalArgumentException("Falta a chave da transmissão.");
            app = path.substring(0, i); stream = path.substring(i + 1);
        } else { app = path; stream = key.trim(); }
        tcUrl = m.group(1).toLowerCase() + "://" + host + (m.group(3) != null ? ":" + port : "") + "/" + app;
    }

    public void setMetadata(int width, int height, int fps, int videoKbps, int sampleRate, int channels) {
        meta.put("duration", 0.0); meta.put("width", (double) width); meta.put("height", (double) height);
        meta.put("videodatarate", (double) videoKbps); meta.put("framerate", (double) fps); meta.put("videocodecid", 7.0);
        meta.put("audiodatarate", 128.0); meta.put("audiosamplerate", (double) sampleRate); meta.put("audiosamplesize", 16.0);
        meta.put("stereo", channels > 1); meta.put("audiocodecid", 10.0); meta.put("encoder", "VtuberLive");
    }

    public boolean isOpen() { return open; }
    public String getError() { return error; }

    // ───────────────────────── conexão ─────────────────────────
    public void connect() throws IOException {
        Socket s = new Socket();
        s.connect(new InetSocketAddress(host, port), 10_000);
        s.setTcpNoDelay(true); s.setSoTimeout(15_000);
        if (tls) {
            SSLSocket ss = (SSLSocket) ((SSLSocketFactory) SSLSocketFactory.getDefault()).createSocket(s, host, port, true);
            ss.startHandshake(); s = ss;
        }
        sock = s;
        in = new DataInputStream(new BufferedInputStream(s.getInputStream(), 16384));
        out = new BufferedOutputStream(s.getOutputStream(), 16384);
        try {
            handshake();
            writeMsg(2, 1, 0, 0, be32(4096)); outChunk = 4096;                       // Set Chunk Size

            Map<String, Object> o = new LinkedHashMap<>();
            o.put("app", app); o.put("type", "nonprivate"); o.put("flashVer", "FMLE/3.0 (compatible; VtuberLive)");
            o.put("tcUrl", tcUrl); o.put("fpad", false); o.put("capabilities", 15.0); o.put("audioCodecs", 3191.0);
            o.put("videoCodecs", 252.0); o.put("videoFunction", 1.0); o.put("objectEncoding", 0.0);
            command(3, 0, "connect", 1, o);
            awaitResult(1);

            writeMsg(2, 5, 0, 0, be32(2_500_000));                                   // Window Ack Size
            command(3, 0, "releaseStream", 2, null, stream);
            command(3, 0, "FCPublish", 3, null, stream);
            command(3, 0, "createStream", 4, (Object) null);
            List<Object> r = awaitResult(4);
            streamId = r.size() > 3 && r.get(3) instanceof Double ? ((Double) r.get(3)).intValue() : 1;

            command(4, streamId, "publish", 5, null, stream, "live");
            String code = awaitStatus();
            if (!code.startsWith("NetStream.Publish.Start")) throw new IOException("Servidor recusou a transmissão: " + code);

            ByteArrayOutputStream md = new ByteArrayOutputStream();
            amfStr(md, "@setDataFrame"); amfStr(md, "onMetaData"); amfEcma(md, meta);
            writeMsg(4, 18, streamId, 0, md.toByteArray());
            s.setSoTimeout(0); open = true;
            Thread t = new Thread(this::drain, "rtmp-drain"); t.setDaemon(true); t.start();
        } catch (IOException | RuntimeException e) { close(); throw e; }
    }

    public void close() {
        open = false;
        try { if (sock != null) sock.close(); } catch (IOException ignored) { }
    }

    private void handshake() throws IOException {
        byte[] c1 = new byte[1536];
        new SecureRandom().nextBytes(c1);
        Arrays.fill(c1, 4, 8, (byte) 0);
        synchronized (wlock) { out.write(3); out.write(c1); out.flush(); }
        int s0 = in.read(); if (s0 != 3) throw new IOException("Handshake RTMP inválido (S0=" + s0 + ")");
        byte[] s1 = new byte[1536]; in.readFully(s1);
        byte[] s2 = new byte[1536]; in.readFully(s2);
        synchronized (wlock) { out.write(s1); out.flush(); }                         // C2 = eco de S1
    }

    /** Lê (e descarta) o que o servidor manda, para o buffer não encher; responde ping e confirmações. */
    private void drain() {
        try { while (open) readMessage(); }
        catch (IOException e) { if (open) error = e.getMessage() == null ? e.toString() : e.getMessage(); }
        finally { open = false; }
    }

    // ───────────────────────── envio de mídia ─────────────────────────
    /** AVCDecoderConfigurationRecord (veja H264Util.avcConfig). Reenvie se o SPS/PPS mudar. */
    public void sendVideoConfig(byte[] avcc) throws IOException {
        byte[] p = new byte[5 + avcc.length];
        p[0] = 0x17; p[1] = 0; System.arraycopy(avcc, 0, p, 5, avcc.length);
        send(6, 9, 0, p);
    }
    /** @param nalus NAL units com prefixo de 4 bytes de tamanho (AVCC) */
    public void sendVideo(byte[] nalus, int ts, boolean key) throws IOException {
        byte[] p = new byte[5 + nalus.length];
        p[0] = (byte) (key ? 0x17 : 0x27); p[1] = 1; System.arraycopy(nalus, 0, p, 5, nalus.length);
        send(6, 9, ts, p);
    }
    public void sendAudioConfig(byte[] asc) throws IOException {
        byte[] p = new byte[2 + asc.length]; p[0] = (byte) 0xAF; p[1] = 0; System.arraycopy(asc, 0, p, 2, asc.length);
        send(7, 8, 0, p);
    }
    public void sendAudio(byte[] aac, int ts) throws IOException {
        byte[] p = new byte[2 + aac.length]; p[0] = (byte) 0xAF; p[1] = 1; System.arraycopy(aac, 0, p, 2, aac.length);
        send(7, 8, ts, p);
    }
    private void send(int csid, int type, int ts, byte[] payload) throws IOException {
        if (!open) throw new IOException(error != null ? error : "Conexão fechada");
        writeMsg(csid, type, streamId, ts, payload);
    }

    // ───────────────────────── chunks ─────────────────────────
    private void command(int csid, int sid, String name, double txn, Object... args) throws IOException {
        ByteArrayOutputStream b = new ByteArrayOutputStream();
        amfStr(b, name); amfNum(b, txn);
        for (Object a : args) amf(b, a);
        writeMsg(csid, 20, sid, 0, b.toByteArray());
    }

    private void writeMsg(int csid, int type, int sid, int ts, byte[] pl) throws IOException {
        synchronized (wlock) {
            boolean ext = ts < 0 || ts >= 0xFFFFFF;
            int t24 = ext ? 0xFFFFFF : ts;
            out.write(csid & 63);                                                    // fmt 0
            out.write(t24 >> 16); out.write(t24 >> 8); out.write(t24);
            out.write(pl.length >> 16); out.write(pl.length >> 8); out.write(pl.length);
            out.write(type);
            out.write(sid); out.write(sid >> 8); out.write(sid >> 16); out.write(sid >> 24);   // little-endian
            if (ext) out.write(be32(ts));
            int off = 0;
            while (off < pl.length) {
                int n = Math.min(outChunk, pl.length - off);
                out.write(pl, off, n); off += n;
                if (off < pl.length) { out.write(0xC0 | (csid & 63)); if (ext) out.write(be32(ts)); }   // fmt 3
            }
            out.flush();
            bytesSent += 12 + pl.length;
        }
    }

    private static class CS { int ts, tsDelta, len, type, sid; boolean ext; ByteArrayOutputStream buf; }
    private static class Msg { int type, sid, ts; byte[] data; }

    private Msg readMessage() throws IOException {
        while (true) {
            int b = in.readUnsignedByte(); bytesIn++;
            int fmt = b >> 6, csid = b & 63;
            if (csid == 0) { csid = in.readUnsignedByte() + 64; bytesIn++; }
            else if (csid == 1) { int lo = in.readUnsignedByte(), hi = in.readUnsignedByte(); csid = lo + (hi << 8) + 64; bytesIn += 2; }
            CS c = cs.get(csid); if (c == null) { c = new CS(); cs.put(csid, c); }
            if (fmt == 0) {
                int ts = u24(); c.len = u24(); c.type = in.readUnsignedByte(); c.sid = Integer.reverseBytes(in.readInt()); bytesIn += 11;
                c.ext = ts == 0xFFFFFF; if (c.ext) { ts = in.readInt(); bytesIn += 4; }
                c.ts = ts; c.tsDelta = 0; c.buf = new ByteArrayOutputStream(Math.max(16, c.len));
            } else if (fmt == 1 || fmt == 2) {
                int d = u24(); bytesIn += 3;
                if (fmt == 1) { c.len = u24(); c.type = in.readUnsignedByte(); bytesIn += 4; }
                c.ext = d == 0xFFFFFF; if (c.ext) { d = in.readInt(); bytesIn += 4; }
                c.tsDelta = d; c.ts += d; c.buf = new ByteArrayOutputStream(Math.max(16, c.len));
            } else {
                if (c.ext) { in.readInt(); bytesIn += 4; }
                if (c.buf == null) { c.ts += c.tsDelta; c.buf = new ByteArrayOutputStream(Math.max(16, c.len)); }
            }
            int n = Math.min(inChunk, c.len - c.buf.size());
            byte[] tmp = new byte[n]; in.readFully(tmp); bytesIn += n; c.buf.write(tmp);
            if (c.buf.size() >= c.len) {
                Msg m = new Msg(); m.type = c.type; m.sid = c.sid; m.ts = c.ts; m.data = c.buf.toByteArray(); c.buf = null;
                control(m);
                return m;
            }
        }
    }
    private int u24() throws IOException { return (in.readUnsignedByte() << 16) | (in.readUnsignedByte() << 8) | in.readUnsignedByte(); }

    private void control(Msg m) throws IOException {
        if (m.type == 1 && m.data.length >= 4) inChunk = Math.max(1, ((m.data[0] & 0x7F) << 24) | ((m.data[1] & 0xFF) << 16) | ((m.data[2] & 0xFF) << 8) | (m.data[3] & 0xFF));
        else if (m.type == 5 && m.data.length >= 4) ackWindow = (((long) (m.data[0] & 0xFF)) << 24) | ((m.data[1] & 0xFF) << 16) | ((m.data[2] & 0xFF) << 8) | (m.data[3] & 0xFF);
        else if (m.type == 4 && m.data.length >= 6 && m.data[0] == 0 && m.data[1] == 6) {           // ping → pong
            byte[] r = new byte[6]; r[1] = 7; System.arraycopy(m.data, 2, r, 2, 4); writeMsg(2, 4, 0, 0, r);
        }
        if (bytesIn - lastAck >= ackWindow) { lastAck = bytesIn; writeMsg(2, 3, 0, 0, be32((int) (bytesIn & 0x7FFFFFFF))); }
    }

    private List<Object> parse(Msg m) throws IOException {
        DataInputStream d = new DataInputStream(new ByteArrayInputStream(m.data));
        List<Object> l = new ArrayList<>();
        try { while (d.available() > 0) l.add(readAmf(d)); } catch (IOException ignored) { }
        return l;
    }

    private List<Object> awaitResult(int txn) throws IOException {
        while (true) {
            Msg m = readMessage();
            if (m.type != 20) continue;
            List<Object> l = parse(m);
            if (l.size() < 2 || !(l.get(0) instanceof String)) continue;
            String name = (String) l.get(0);
            double t = l.get(1) instanceof Double ? (Double) l.get(1) : -1;
            if ("_error".equals(name) && t == txn) throw new IOException("Servidor respondeu erro (" + describe(l) + ")");
            if ("_result".equals(name) && t == txn) return l;
            if ("onStatus".equals(name) && statusCode(l).contains("Failed")) throw new IOException("Falha: " + statusCode(l));
        }
    }
    private String awaitStatus() throws IOException {
        while (true) {
            Msg m = readMessage();
            if (m.type != 20) continue;
            List<Object> l = parse(m);
            if (!l.isEmpty() && "onStatus".equals(l.get(0))) { String c = statusCode(l); if (!c.isEmpty()) return c; }
            if (!l.isEmpty() && "_error".equals(l.get(0))) throw new IOException("Servidor respondeu erro (" + describe(l) + ")");
        }
    }
    @SuppressWarnings("unchecked")
    private static String statusCode(List<Object> l) {
        for (Object o : l) if (o instanceof Map) { Object c = ((Map<String, Object>) o).get("code"); if (c != null) return c.toString(); }
        return "";
    }
    private static String describe(List<Object> l) { String c = statusCode(l); return c.isEmpty() ? l.toString() : c; }

    // ───────────────────────── AMF0 ─────────────────────────
    private static byte[] be32(int v) { return new byte[] { (byte) (v >> 24), (byte) (v >> 16), (byte) (v >> 8), (byte) v }; }
    private static void key(ByteArrayOutputStream o, String s) { byte[] b = s.getBytes(StandardCharsets.UTF_8); o.write(b.length >> 8); o.write(b.length); o.write(b, 0, b.length); }
    private static void amfStr(ByteArrayOutputStream o, String s) { o.write(2); key(o, s); }
    private static void amfNum(ByteArrayOutputStream o, double v) { o.write(0); long b = Double.doubleToLongBits(v); for (int i = 56; i >= 0; i -= 8) o.write((int) (b >> i)); }
    @SuppressWarnings("unchecked")
    private static void amf(ByteArrayOutputStream o, Object v) {
        if (v == null) o.write(5);
        else if (v instanceof String) amfStr(o, (String) v);
        else if (v instanceof Number) amfNum(o, ((Number) v).doubleValue());
        else if (v instanceof Boolean) { o.write(1); o.write((Boolean) v ? 1 : 0); }
        else if (v instanceof Map) { o.write(3); props(o, (Map<String, Object>) v); }
    }
    private static void props(ByteArrayOutputStream o, Map<String, Object> m) { for (Map.Entry<String, Object> e : m.entrySet()) { key(o, e.getKey()); amf(o, e.getValue()); } o.write(0); o.write(0); o.write(9); }
    private static void amfEcma(ByteArrayOutputStream o, Map<String, Object> m) { o.write(8); byte[] n = be32(m.size()); o.write(n, 0, 4); props(o, m); }

    private static Object readAmf(DataInputStream d) throws IOException {
        int t = d.readUnsignedByte();
        switch (t) {
            case 0: return d.readDouble();
            case 1: return d.readUnsignedByte() != 0;
            case 2: return utf(d);
            case 3: return readProps(d);
            case 5: case 6: return null;
            case 8: d.readInt(); return readProps(d);
            case 10: { int n = d.readInt(); List<Object> l = new ArrayList<>(); for (int i = 0; i < n; i++) l.add(readAmf(d)); return l; }
            case 12: { byte[] b = new byte[d.readInt()]; d.readFully(b); return new String(b, StandardCharsets.UTF_8); }
            default: throw new IOException("AMF0 não suportado: " + t);
        }
    }
    private static String utf(DataInputStream d) throws IOException { byte[] b = new byte[d.readUnsignedShort()]; d.readFully(b); return new String(b, StandardCharsets.UTF_8); }
    private static Map<String, Object> readProps(DataInputStream d) throws IOException {
        Map<String, Object> m = new LinkedHashMap<>();
        while (true) {
            String k = utf(d);
            if (k.isEmpty()) { d.readUnsignedByte(); return m; }          // marcador de fim (9)
            m.put(k, readAmf(d));
        }
    }
}
