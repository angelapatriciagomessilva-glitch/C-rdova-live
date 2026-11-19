// gl.js — renderizador WebGL2 das camadas (GPU). Substitui o desenho por triângulos do Canvas2D,
// que era o principal causador de aquecimento e travadas em celulares.
//
// Todas as camadas viram malhas texturizadas; a deformação (warp/malha) continua sendo calculada em JS
// (poucos vértices) e a rasterização, a mistura de cores e a minificação (mipmaps) ficam na GPU.
// O resultado é desenhado num canvas fora da tela e copiado para o canvas principal.

const VS = `#version 300 es
in vec2 a_pos; in vec2 a_uv;
uniform vec3 u_r0; uniform vec3 u_r1;
out vec2 v_uv;
void main() { vec3 p = vec3(a_pos, 1.0); gl_Position = vec4(dot(u_r0, p), dot(u_r1, p), 0.0, 1.0); v_uv = a_uv; }`;
const FS = `#version 300 es
precision mediump float;
uniform sampler2D u_tex; uniform sampler2D u_mask; uniform float u_alpha; uniform float u_hasMask; uniform vec2 u_res;
in vec2 v_uv; out vec4 o;
void main() {
  float m = u_hasMask > 0.5 ? texture(u_mask, gl_FragCoord.xy / u_res).a : 1.0;   // corte: só aparece onde a máscara tem forma
  o = texture(u_tex, v_uv) * (u_alpha * m);
}`;

/** Modos de mistura que o renderizador GPU só aproxima (viram "normal"). */
export const GL_APPROX_BLENDS = new Set(['overlay', 'soft-light']);

export class GLRenderer {
  constructor(canvas, { maxTexture = 2048 } = {}) {
    const gl = canvas.getContext('webgl2', { alpha: true, premultipliedAlpha: true, antialias: false, depth: false, stencil: false, desynchronized: false });
    if (!gl) throw new Error('WebGL2 indisponível');
    this.canvas = canvas; this.gl = gl; this.lost = false;
    this.maxTexture = Math.min(maxTexture, gl.getParameter(gl.MAX_TEXTURE_SIZE));
    canvas.addEventListener('webglcontextlost', e => { e.preventDefault(); this.lost = true; });
    canvas.addEventListener('webglcontextrestored', () => { this._init(); this.lost = false; });
    this._init();
  }

  _init() {
    const gl = this.gl;
    const sh = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error('shader: ' + gl.getShaderInfoLog(s)); return s; };
    const pr = this.prog = gl.createProgram();
    gl.attachShader(pr, sh(gl.VERTEX_SHADER, VS)); gl.attachShader(pr, sh(gl.FRAGMENT_SHADER, FS));
    gl.bindAttribLocation(pr, 0, 'a_pos'); gl.bindAttribLocation(pr, 1, 'a_uv');
    gl.linkProgram(pr);
    if (!gl.getProgramParameter(pr, gl.LINK_STATUS)) throw new Error('programa GL: ' + gl.getProgramInfoLog(pr));
    this.u = { r0: gl.getUniformLocation(pr, 'u_r0'), r1: gl.getUniformLocation(pr, 'u_r1'), a: gl.getUniformLocation(pr, 'u_alpha'), t: gl.getUniformLocation(pr, 'u_tex'), m: gl.getUniformLocation(pr, 'u_mask'), hm: gl.getUniformLocation(pr, 'u_hasMask'), res: gl.getUniformLocation(pr, 'u_res') };
    this.vao = gl.createVertexArray(); gl.bindVertexArray(this.vao);
    this.vbo = gl.createBuffer(); this.ibo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo); gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.ibo);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 16, 0);
    gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 16, 8);
    gl.useProgram(pr); gl.uniform1i(this.u.t, 0); gl.uniform1i(this.u.m, 1); gl.uniform1f(this.u.hm, 0);
    this.fbo = null; this.maskTex = null; this.maskKey = null; this._maskW = 0; this._maskH = 0;
    gl.disable(gl.DEPTH_TEST); gl.disable(gl.CULL_FACE); gl.enable(gl.BLEND);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    this.texs = new Map(); this._blend = null; this._lastIdx = null; this._vcap = 0; this._icap = 0; this._tex = null; this._scratch = new Float32Array(4096);
    this.quadIdx = new Uint32Array([0, 1, 2, 1, 3, 2]);
  }

  resize(w, h) { if (this.canvas.width !== w || this.canvas.height !== h) { this.canvas.width = w; this.canvas.height = h; } }

  begin() {
    const gl = this.gl;
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(this.prog); gl.bindVertexArray(this.vao); gl.activeTexture(gl.TEXTURE0);
    this._blend = null; this._tex = null; this.maskKey = null;
    gl.uniform2f(this.u.res, this.canvas.width, this.canvas.height); gl.uniform1f(this.u.hm, 0);
  }

  _ensureMask() {
    const gl = this.gl, W = this.canvas.width, H = this.canvas.height;
    if (this.fbo && this._maskW === W && this._maskH === H) return;
    if (!this.fbo) { this.fbo = gl.createFramebuffer(); this.maskTex = gl.createTexture(); }
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, this.maskTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, W, H, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo); gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.maskTex, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.activeTexture(gl.TEXTURE0);
    this._maskW = W; this._maskH = H;
  }
  /** Começa a desenhar a forma da máscara num buffer fora da tela. */
  beginMask() {
    const gl = this.gl; this._ensureMask();
    gl.uniform1f(this.u.hm, 0);
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, null); gl.activeTexture(gl.TEXTURE0);   // evita “feedback loop” (textura ligada e usada como destino)
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo); gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
  }
  endMask() {
    const gl = this.gl; gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, this.maskTex); gl.activeTexture(gl.TEXTURE0);
  }
  useMask(on) { this.gl.uniform1f(this.u.hm, on ? 1 : 0); }

  /** Textura da imagem (recortada ao conteúdo visível + 1 px transparente de borda). null = imagem vazia. */
  getTex(img) {
    let t = this.texs.get(img);
    if (t !== undefined) return t;
    const gl = this.gl, W = img.naturalWidth || img.width, H = img.naturalHeight || img.height;
    t = null;
    if (W > 0 && H > 0) {
      const c = document.createElement('canvas'); c.width = W; c.height = H;
      const g = c.getContext('2d', { willReadFrequently: true }); g.drawImage(img, 0, 0);
      const d = g.getImageData(0, 0, W, H).data;
      let x0 = W, y0 = H, x1 = -1, y1 = -1;
      for (let y = 0; y < H; y++) {
        const row = y * W * 4 + 3;
        for (let x = 0; x < W; x++) if (d[row + x * 4] > 0) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
      }
      if (x1 >= 0) {
        const cw = x1 - x0 + 1, ch = y1 - y0 + 1, k = Math.min(1, this.maxTexture / (Math.max(cw, ch) + 2));
        const tw = Math.max(2, Math.round((cw + 2) * k)), th = Math.max(2, Math.round((ch + 2) * k));
        const tc = document.createElement('canvas'); tc.width = tw; tc.height = th;
        const tg = tc.getContext('2d'); tg.imageSmoothingQuality = 'high';
        tg.drawImage(img, x0, y0, cw, ch, k, k, cw * k, ch * k);
        const tex = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, tc);
        gl.generateMipmap(gl.TEXTURE_2D);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        t = { tex, cx: x0, cy: y0, cw, ch, bytes: tw * th * 4 * 1.33 };
        tc.width = tc.height = 0;
      }
      c.width = c.height = 0;
    }
    this.texs.set(img, t);
    return t;
  }

  /** Libera texturas de imagens que não estão mais no projeto. */
  sweep(live) {
    const gl = this.gl;
    for (const [img, t] of this.texs) if (!live.has(img)) { if (t) gl.deleteTexture(t.tex); this.texs.delete(img); }
  }
  get memoryMB() { let n = 0; for (const t of this.texs.values()) if (t) n += t.bytes; return n / 1048576; }

  _setBlend(mode) {
    if (mode === this._blend) return;
    const gl = this.gl; this._blend = mode;
    gl.blendEquationSeparate(mode === 'darken' ? gl.MIN : mode === 'lighten' ? gl.MAX : gl.FUNC_ADD, gl.FUNC_ADD);
    switch (mode) {
      case 'multiply': gl.blendFuncSeparate(gl.DST_COLOR, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA); break;
      case 'screen': gl.blendFuncSeparate(gl.ONE, gl.ONE_MINUS_SRC_COLOR, gl.ONE, gl.ONE_MINUS_SRC_ALPHA); break;
      case 'lighter': gl.blendFuncSeparate(gl.ONE, gl.ONE, gl.ONE, gl.ONE_MINUS_SRC_ALPHA); break;
      default: gl.blendFuncSeparate(gl.ONE, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    }
  }

  _matrix(M) {
    const gl = this.gl, W = this.canvas.width, H = this.canvas.height;
    gl.uniform3f(this.u.r0, (2 * M.a) / W, (2 * M.c) / W, (2 * M.e) / W - 1);
    gl.uniform3f(this.u.r1, (-2 * M.b) / H, (-2 * M.d) / H, 1 - (2 * M.f) / H);
  }

  _draw(tex, n, idx, M, alpha, blend) {
    const gl = this.gl;
    this._matrix(M); gl.uniform1f(this.u.a, alpha); this._setBlend(blend);
    if (this._tex !== tex.tex) { gl.bindTexture(gl.TEXTURE_2D, tex.tex); this._tex = tex.tex; }
    // buffers pré-alocados + bufferSubData (sem realocar a cada camada); índices só são reenviados quando mudam
    const need = n * 16;
    if (need > this._vcap) { this._vcap = Math.max(need, this._vcap * 2, 8192); gl.bufferData(gl.ARRAY_BUFFER, this._vcap, gl.DYNAMIC_DRAW); }
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, this._scratch, 0, n * 4);
    if (idx !== this._lastIdx) {
      if (idx.byteLength > this._icap) { this._icap = Math.max(idx.byteLength, this._icap * 2, 4096); gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, this._icap, gl.DYNAMIC_DRAW); }
      gl.bufferSubData(gl.ELEMENT_ARRAY_BUFFER, 0, idx); this._lastIdx = idx;
    }
    gl.drawElements(gl.TRIANGLES, idx.length, gl.UNSIGNED_INT, 0);
  }

  /** Imagem sem deformação: um quadrilátero. (x,y) = posição da camada no rig. */
  drawQuad(tex, x, y, M, alpha, blend) {
    const s = this._scratch, x0 = x + tex.cx - 1, y0 = y + tex.cy - 1, x1 = x + tex.cx + tex.cw + 1, y1 = y + tex.cy + tex.ch + 1;
    s.set([x0, y0, 0, 0, x1, y0, 1, 0, x0, y1, 0, 1, x1, y1, 1, 1], 0);
    this._draw(tex, 4, this.quadIdx, M, alpha, blend);
  }

  /** pos = [x,y,...] no espaço da camada; src = [sx,sy,...] em pixels da imagem; idx = triângulos. */
  drawTris(tex, pos, src, idx, M, alpha, blend) {
    const n = pos.length / 2;
    if (this._scratch.length < n * 4) this._scratch = new Float32Array(Math.ceil(n * 4 * 1.5));
    const s = this._scratch, iw = 1 / (tex.cw + 2), ih = 1 / (tex.ch + 2), ox = 1 - tex.cx, oy = 1 - tex.cy;
    for (let i = 0; i < n; i++) {
      s[i * 4] = pos[i * 2]; s[i * 4 + 1] = pos[i * 2 + 1];
      s[i * 4 + 2] = (src[i * 2] + ox) * iw; s[i * 4 + 3] = (src[i * 2 + 1] + oy) * ih;
    }
    this._draw(tex, n, idx, M, alpha, blend);
  }
}
