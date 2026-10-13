// Step-2 prototype (test only, not app code): the detector's warp into the calibration view and its
// per-pixel three-frame test on the GPU (WebGL2), to measure the time and compare the moving-pixel map
// with BallDetector.detect. In the browser: new GLDetect(det.cfg, frameW, frameH); per frame push(frame, H)
// with the stabiliser's homography, then diff(thr, slack) -> the moving-pixel map (needs 3 frames).
// Measured 2026-10-13 (IMG_6813, i9-9880H, Chromium): CPU warp + read + test + blobs 18.5 ms; GPU upload +
// warp + test + read-back 12.5 ms (read-back 9 ms), blobs and colours still to add; map overlap 84%.
export class GLDetect {
  // cfg: BallDetector.cfg (pw, ph, bx0, by0, scale, roi); srcW/srcH: frame size
  constructor(cfg, srcW, srcH) {
    this.cfg = cfg; this.srcW = srcW; this.srcH = srcH;
    const { pw, ph } = cfg;
    this.canvas = new OffscreenCanvas(pw, ph);
    const gl = this.gl = this.canvas.getContext('webgl2', { antialias: false, depth: false, preserveDrawingBuffer: false });
    if (!gl) throw new Error('no webgl2');
    const vs = `#version 300 es
      in vec2 p; void main() { gl_Position = vec4(p, 0.0, 1.0); }`;
    // 1. warp: processing pixel -> calibration-view pixel -> frame pixel (homography), bilinear from a
    //    mipmapped copy of the frame (the frame is ~2x the processing size); alpha 0 outside the frame
    const fsWarp = `#version 300 es
      precision highp float;
      uniform sampler2D src; uniform mat3 H; uniform vec2 srcSize; uniform vec3 view; // bx0, by0, scale
      uniform float lod;
      out vec4 o;
      void main() {
        vec2 q = gl_FragCoord.xy; // y up: row 0 of the read-back is the bottom; flipped in the read
        vec2 c = vec2(view.x + q.x / view.z, view.y + (float(${ph}) - q.y) / view.z);
        vec3 s = H * vec3(c, 1.0);
        vec2 f = s.xy / s.z;
        if (f.x < 0.0 || f.y < 0.0 || f.x > srcSize.x || f.y > srcSize.y) { o = vec4(0.0); return; }
        o = vec4(textureLod(src, f / srcSize, lod).rgb, 1.0);
      }`;
    // 2. the three-frame test of BallDetector.detect, per pixel; m packed in R (low byte) and G (high)
    const fsDiff = `#version 300 es
      precision highp float;
      uniform sampler2D A; uniform sampler2D B; uniform sampler2D D; uniform sampler2D roi;
      uniform float thr; uniform float slack;
      out vec4 o;
      vec3 px(sampler2D t, ivec2 p) { return texelFetch(t, p, 0).rgb * 255.0; }
      float al(sampler2D t, ivec2 p) { return texelFetch(t, p, 0).a; }
      void main() {
        ivec2 p = ivec2(gl_FragCoord.xy);
        o = vec4(0.0, 0.0, 0.0, 1.0);
        if (texelFetch(roi, p, 0).r < 0.5) return;
        vec3 a = px(A, p), b = px(B, p), d = px(D, p);
        float d2 = dot(abs(b - d), vec3(1.0)), d1 = dot(abs(b - a), vec3(1.0));
        if (d2 < thr || d1 < thr) return;
        if (slack > 0.0) {
          if (al(A, p) < 0.98 || al(B, p) < 0.98 || al(D, p) < 0.98) return;
          ivec2 sz = textureSize(B, 0);
          if (p.x < 1 || p.y < 1 || p.x >= sz.x - 1 || p.y >= sz.y - 1) return;
          ivec2 ex = ivec2(1, 0), ey = ivec2(0, 1);
          vec3 ga = abs(px(A, p + ex) - px(A, p - ex)) + abs(px(A, p + ey) - px(A, p - ey));
          vec3 gd = abs(px(D, p + ex) - px(D, p - ex)) + abs(px(D, p + ey) - px(D, p - ey));
          float g = 0.5 * dot(max(ga, gd), vec3(1.0));
          float need = thr + slack * g;
          if (d1 < need || d2 < need) return;
        }
        float m = floor(min(d1, d2) + 0.5);
        o = vec4(mod(m, 256.0) / 255.0, floor(m / 256.0) / 255.0, 0.0, 1.0);
      }`;
    const prog = fs => {
      const mk = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s)); return s; };
      const pr = gl.createProgram(); gl.attachShader(pr, mk(gl.VERTEX_SHADER, vs)); gl.attachShader(pr, mk(gl.FRAGMENT_SHADER, fs));
      gl.bindAttribLocation(pr, 0, 'p'); gl.linkProgram(pr);
      if (!gl.getProgramParameter(pr, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(pr));
      return pr;
    };
    this.pWarp = prog(fsWarp); this.pDiff = prog(fsDiff);
    const buf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    const tex = (w, h, filter, data = null, fmt = gl.RGBA8, f2 = gl.RGBA) => {
      const t = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      if (w) gl.texImage2D(gl.TEXTURE_2D, 0, fmt, w, h, 0, f2, gl.UNSIGNED_BYTE, data);
      return t;
    };
    this.src = tex(0, 0, gl.LINEAR_MIPMAP_LINEAR);
    // roi as R8, rows flipped to GL's bottom-up order
    const roi = new Uint8Array(pw * ph);
    for (let y = 0; y < ph; y++) for (let x = 0; x < pw; x++) roi[(ph - 1 - y) * pw + x] = cfg.roi[y * pw + x] ? 255 : 0;
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    this.roi = tex(pw, ph, gl.NEAREST, roi, gl.R8, gl.RED);
    this.ring = [0, 1, 2].map(() => { const t = tex(pw, ph, gl.NEAREST); const fb = gl.createFramebuffer(); gl.bindFramebuffer(gl.FRAMEBUFFER, fb); gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0); return { t, fb }; });
    this.outT = tex(pw, ph, gl.NEAREST); this.outFb = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.outFb); gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.outT, 0);
    this.k = 0; this.out = new Uint8Array(pw * ph * 4);
  }

  // A frame (ImageBitmap / video / canvas) warped into the ring with H (calibration view -> frame)
  push(frame, H) {
    const gl = this.gl, c = this.cfg;
    gl.bindTexture(gl.TEXTURE_2D, this.src);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, frame);
    gl.generateMipmap(gl.TEXTURE_2D);
    const slot = this.ring[this.k % 3]; this.k++;
    gl.bindFramebuffer(gl.FRAMEBUFFER, slot.fb); gl.viewport(0, 0, c.pw, c.ph);
    gl.useProgram(this.pWarp);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.src);
    gl.uniform1i(gl.getUniformLocation(this.pWarp, 'src'), 0);
    // mat3 is column-major: H rows -> columns
    const h = H || [1, 0, 0, 0, 1, 0, 0, 0, 1];
    gl.uniformMatrix3fv(gl.getUniformLocation(this.pWarp, 'H'), false, [h[0], h[3], h[6], h[1], h[4], h[7], h[2], h[5], h[8]]);
    gl.uniform2f(gl.getUniformLocation(this.pWarp, 'srcSize'), this.srcW, this.srcH);
    gl.uniform3f(gl.getUniformLocation(this.pWarp, 'view'), c.bx0, c.by0, c.scale);
    gl.uniform1f(gl.getUniformLocation(this.pWarp, 'lod'), Math.max(0, Math.log2(1 / c.scale)));
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  // The per-pixel test on the last three frames; returns m (Uint16Array, top-down rows like the CPU)
  diff(thr, slack, read = true) {
    const gl = this.gl, c = this.cfg, n = this.k;
    const A = this.ring[(n - 3) % 3].t, B = this.ring[(n - 2) % 3].t, D = this.ring[(n - 1) % 3].t;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.outFb); gl.viewport(0, 0, c.pw, c.ph);
    gl.useProgram(this.pDiff);
    [A, B, D, this.roi].forEach((t, i) => { gl.activeTexture(gl.TEXTURE0 + i); gl.bindTexture(gl.TEXTURE_2D, t); });
    ['A', 'B', 'D', 'roi'].forEach((nm, i) => gl.uniform1i(gl.getUniformLocation(this.pDiff, nm), i));
    gl.uniform1f(gl.getUniformLocation(this.pDiff, 'thr'), thr); gl.uniform1f(gl.getUniformLocation(this.pDiff, 'slack'), slack);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    if (!read) return null;
    gl.readPixels(0, 0, c.pw, c.ph, gl.RGBA, gl.UNSIGNED_BYTE, this.out);
    const m = new Uint16Array(c.pw * c.ph), o = this.out;
    for (let y = 0; y < c.ph; y++) { const r = (c.ph - 1 - y) * c.pw * 4, w = y * c.pw; for (let x = 0; x < c.pw; x++) { const j = r + x * 4; m[w + x] = o[j] + 256 * o[j + 1]; } }
    return m;
  }
}
