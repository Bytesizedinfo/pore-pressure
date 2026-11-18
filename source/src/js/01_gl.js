'use strict';
/* WebGL2 helpers: programs with uniform caching, textures, render targets, fullscreen + instanced geometry. */
PP.GL = function (canvas) {
  const gl = canvas.getContext('webgl2', {
    antialias: false, alpha: false, depth: true, stencil: false, premultipliedAlpha: false,
    preserveDrawingBuffer: !!PP.TEST, powerPreference: 'high-performance',
  });
  if (!gl) throw new Error('WebGL2 is not available in this browser.');
  const extCBF = gl.getExtension('EXT_color_buffer_float');
  gl.getExtension('EXT_color_buffer_half_float');
  gl.getExtension('OES_texture_float_linear');
  if (!extCBF) PP.diag.error('EXT_color_buffer_float missing: float render targets unavailable');
  this.gl = gl;

  const HDR = '#version 300 es\nprecision highp float;\nprecision highp int;\nprecision highp sampler2D;\n';
  this.progs = [];
  this.parallel = gl.getExtension('KHR_parallel_shader_compile');
  // compile + link without querying status, so the driver can work while assets download
  this.program = function (name, vs, fs) {
    const mk = (type, src) => { const sh = gl.createShader(type); gl.shaderSource(sh, HDR + src); gl.compileShader(sh); return sh; };
    const vsS = mk(gl.VERTEX_SHADER, vs), fsS = mk(gl.FRAGMENT_SHADER, fs);
    const p = gl.createProgram();
    gl.attachShader(p, vsS); gl.attachShader(p, fsS);
    gl.linkProgram(p);
    const prog = { p, u: {}, name, done: false };
    prog.finish = () => {
      if (prog.done) return; prog.done = true;
      if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
        for (const [sh, kind, src] of [[vsS, ' VS', vs], [fsS, ' FS', fs]]) {
          if (gl.getShaderParameter(sh, gl.COMPILE_STATUS)) continue;
          const log = gl.getShaderInfoLog(sh) || '';
          const lines = (HDR + src).split('\n');
          const m = /ERROR: \d+:(\d+)/.exec(log);
          PP.diag.error(name + kind + ': ' + log + (m ? '\n  > ' + (lines[+m[1] - 1] || '') : ''));
        }
        PP.diag.error(name + ' link: ' + gl.getProgramInfoLog(p));
      }
      const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS) || 0;
      for (let i = 0; i < n; i++) {
        const info = gl.getActiveUniform(p, i);
        prog.u[info.name.replace(/\[0\]$/, '')] = gl.getUniformLocation(p, info.name);
      }
    };
    this.progs.push(prog);
    return prog;
  };
  this.finishAll = async function () {
    const ext = this.parallel;
    if (ext) {
      const t0 = performance.now();
      while (performance.now() - t0 < 90000 && !this.progs.every((pr) => gl.getProgramParameter(pr.p, ext.COMPLETION_STATUS_KHR))) {
        await new Promise((r) => setTimeout(r, 20));
      }
    }
    this.progs.forEach((pr) => pr.finish());
  };

  this.tex = function (w, h, opt = {}) {
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    const ifmt = opt.ifmt || gl.RGBA8, fmt = opt.fmt || gl.RGBA, type = opt.type || gl.UNSIGNED_BYTE;
    gl.texImage2D(gl.TEXTURE_2D, 0, ifmt, w, h, 0, fmt, type, opt.data || null);
    const filt = opt.filter || gl.LINEAR;
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, opt.mip ? gl.LINEAR_MIPMAP_LINEAR : filt);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filt);
    const wrap = opt.wrap || gl.CLAMP_TO_EDGE;
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrap);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wrap);
    if (opt.mip) gl.generateMipmap(gl.TEXTURE_2D);
    return { t, w, h, ifmt, fmt, type };
  };

  this.texFromImage = function (img, opt = {}) {
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, img);
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
    const af = gl.getExtension('EXT_texture_filter_anisotropic');
    if (af) gl.texParameterf(gl.TEXTURE_2D, af.TEXTURE_MAX_ANISOTROPY_EXT, 8);
    return { t, w: img.width, h: img.height };
  };

  // render target with N color attachments (+ optional depth)
  this.target = function (w, h, specs, depth) {
    const fb = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    const texs = specs.map((s, i) => {
      const tx = this.tex(w, h, s);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0 + i, gl.TEXTURE_2D, tx.t, 0);
      return tx;
    });
    let db = null;
    if (depth) {
      db = gl.createRenderbuffer();
      gl.bindRenderbuffer(gl.RENDERBUFFER, db);
      gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT24, w, h);
      gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, db);
    }
    gl.drawBuffers(specs.map((_, i) => gl.COLOR_ATTACHMENT0 + i));
    const st = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    if (st !== gl.FRAMEBUFFER_COMPLETE) PP.diag.error('Framebuffer incomplete 0x' + st.toString(16));
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return { fb, texs, w, h, db };
  };
  this.freeTarget = function (rt) {
    if (!rt) return;
    rt.texs.forEach((t) => gl.deleteTexture(t.t));
    if (rt.db) gl.deleteRenderbuffer(rt.db);
    gl.deleteFramebuffer(rt.fb);
  };

  // fullscreen triangle
  this.fsVao = gl.createVertexArray();
  gl.bindVertexArray(this.fsVao);
  const fsb = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, fsb);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

  // instanced quad: per-instance 4 x vec4 attributes (locations 1..4)
  this.instVao = gl.createVertexArray();
  gl.bindVertexArray(this.instVao);
  const qb = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, qb);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  this.instBuf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, this.instBuf);
  this.INST_FLOATS = 16;
  for (let i = 0; i < 4; i++) {
    gl.enableVertexAttribArray(1 + i);
    gl.vertexAttribPointer(1 + i, 4, gl.FLOAT, false, 64, i * 16);
    gl.vertexAttribDivisor(1 + i, 1);
  }
  gl.bindVertexArray(null);

  this.drawFS = function () { gl.bindVertexArray(this.fsVao); gl.drawArrays(gl.TRIANGLES, 0, 3); };
  this.drawInstances = function (data, count) {
    if (!count) return;
    gl.bindVertexArray(this.instVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instBuf);
    gl.bufferData(gl.ARRAY_BUFFER, data.subarray(0, count * 16), gl.DYNAMIC_DRAW);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, count);
  };
  this.bindTex = function (unit, tex, loc) {
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, tex.t || tex);
    if (loc != null) gl.uniform1i(loc, unit);
  };
};
