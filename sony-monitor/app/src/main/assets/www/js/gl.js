/* محرّك WebGL2 لمعالجة صورة المونيتور على وحدة معالجة الرسوميات (GPU):
 *  - رفع إطار البث كنسيج
 *  - تطبيق LUT ثلاثي الأبعاد بشدّة قابلة للضبط
 *  - Zebra / False Color / Focus Peaking / تحذير احتراق الإضاءات / تحذير الظلال
 *  - تكبير رقمي للمعاينة (لا يضيف تفاصيل)
 *  - تمريرة منفصلة (بلا تكبير/مؤثرات) لقراءة بكسلات مصغّرة تُحسب منها أدوات المراقبة
 *
 * صدق تقني: كل هذه المؤثرات تُحسب من إطار المعاينة المضغوط، وليست من RAW/Log.
 */
const GL = (() => {
  let gl, canvas;
  let prog, quadVao;
  let frameTex, lutTex;
  let frameW = 0, frameH = 0, lutSize = 2;
  let scopeFbo, scopeTex, scopeW = 240, scopeH = 160;
  const u = {};
  let params = {
    lutOn: false, lutIntensity: 1.0,
    zebra: false, zebraTh: 0.95,
    falseColor: false,
    peaking: false, peakColor: [1,0,0], peakStr: 0.3,
    clipWarn: true, crushWarn: false, crushTh: 0.04,
    zoom: 1.0, panX: 0.5, panY: 0.5,
    scopeAfterLut: false
  };

  const VERT = `#version 300 es
  in vec2 aPos;
  out vec2 vUv;
  uniform vec4 uZoom; // xy = center, z = scale, w unused
  uniform int uScopePass;
  void main(){
    vec2 uv = aPos * 0.5 + 0.5;
    uv.y = 1.0 - uv.y;
    if(uScopePass==0){
      vec2 c = uZoom.xy; float s = uZoom.z;
      uv = c + (uv - 0.5) / s;
    }
    vUv = uv;
    gl_Position = vec4(aPos, 0.0, 1.0);
  }`;

  const FRAG = `#version 300 es
  precision highp float;
  precision highp sampler3D;
  in vec2 vUv;
  out vec4 outColor;
  uniform sampler2D uFrame;
  uniform sampler3D uLut;
  uniform vec2 uTexel;      // 1/width, 1/height
  uniform int uScopePass;   // 1 = تمريرة الأدوات (بلا مؤثرات/تكبير)
  uniform int uLutOn;
  uniform float uLutIntensity;
  uniform int uZebra; uniform float uZebraTh;
  uniform int uFalse;
  uniform int uPeak; uniform vec3 uPeakColor; uniform float uPeakStr;
  uniform int uClip; uniform int uCrush; uniform float uCrushTh;

  float luma(vec3 c){ return dot(c, vec3(0.2126, 0.7152, 0.0722)); }

  vec3 applyLut(vec3 c){
    vec3 lc = texture(uLut, clamp(c, 0.0, 1.0)).rgb;
    return mix(c, lc, uLutIntensity);
  }

  vec3 falseColor(float y){
    // خريطة ألوان تقريبية حسب مستوى السطوع (0..1) — دليلها في الواجهة
    if(y < 0.020) return vec3(0.5,0.0,0.5);   // بنفسجي: أسود مقصوص
    if(y < 0.100) return vec3(0.0,0.0,0.8);   // أزرق
    if(y < 0.200) return vec3(0.0,0.6,0.8);   // سماوي
    if(y < 0.380) return vec3(0.0,0.6,0.2);   // أخضر داكن
    if(y < 0.440) return vec3(0.4,0.9,0.3);   // أخضر (رمادي 18%)
    if(y < 0.520) return vec3(0.6,0.6,0.6);   // رمادي
    if(y < 0.560) return vec3(0.95,0.5,0.6);  // وردي (بشرة)
    if(y < 0.700) return vec3(0.8,0.8,0.8);   // رمادي فاتح
    if(y < 0.900) return vec3(0.95,0.85,0.2); // أصفر
    if(y < 0.970) return vec3(0.95,0.55,0.1); // برتقالي
    return vec3(0.95,0.1,0.1);                // أحمر: أبيض مقصوص
  }

  float edgeLuma(vec2 uv){
    float l  = luma(texture(uFrame, uv).rgb);
    float lx = luma(texture(uFrame, uv + vec2(uTexel.x,0.0)).rgb);
    float ly = luma(texture(uFrame, uv + vec2(0.0,uTexel.y)).rgb);
    return abs(l-lx) + abs(l-ly);
  }

  void main(){
    vec2 uv = vUv;
    if(uv.x<0.0||uv.x>1.0||uv.y<0.0||uv.y>1.0){ outColor=vec4(0.0,0.0,0.0,1.0); return; }
    vec3 c = texture(uFrame, uv).rgb;

    if(uScopePass==1){
      if(uLutOn==1) c = applyLut(c);
      outColor = vec4(c,1.0); return;
    }

    if(uLutOn==1) c = applyLut(c);
    float y = luma(c);

    if(uFalse==1){ outColor = vec4(falseColor(y),1.0); return; }

    vec3 outc = c;

    // تحذير احتراق الإضاءات (قنوات قريبة من 1.0)
    if(uClip==1 && max(max(c.r,c.g),c.b) >= 0.99){ outc = vec3(1.0,0.0,0.0); }
    // تحذير الظلال شديدة الظلمة
    if(uCrush==1 && y <= uCrushTh){ outc = vec3(0.0,0.2,1.0); }

    // Zebra على المناطق فوق الحدّ
    if(uZebra==1 && y >= uZebraTh){
      float stripe = mod(gl_FragCoord.x + gl_FragCoord.y, 12.0);
      if(stripe < 6.0) outc = mix(outc, vec3(1.0), 0.7);
    }

    // Focus Peaking
    if(uPeak==1){
      float e = edgeLuma(uv);
      if(e > (0.6 - uPeakStr*0.6)) outc = uPeakColor;
    }

    outColor = vec4(outc, 1.0);
  }`;

  function compile(type, src){
    const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
    if(!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error('Shader: '+gl.getShaderInfoLog(s));
    return s;
  }

  function init(cv){
    canvas = cv;
    gl = canvas.getContext('webgl2', { antialias:false, premultipliedAlpha:false, preserveDrawingBuffer:true });
    if(!gl) throw new Error('WebGL2 غير مدعوم على هذا الجهاز.');

    prog = gl.createProgram();
    gl.attachShader(prog, compile(gl.VERTEX_SHADER, VERT));
    gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, FRAG));
    gl.linkProgram(prog);
    if(!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error('Link: '+gl.getProgramInfoLog(prog));
    gl.useProgram(prog);

    // مربّع ملء الشاشة
    quadVao = gl.createVertexArray();
    gl.bindVertexArray(quadVao);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1, 1,-1, -1,1, 1,1]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, 'aPos');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);

    // مواقع الـ uniforms
    ['uFrame','uLut','uTexel','uScopePass','uLutOn','uLutIntensity','uZebra','uZebraTh',
     'uFalse','uPeak','uPeakColor','uPeakStr','uClip','uCrush','uCrushTh','uZoom'].forEach(n=>{
      u[n] = gl.getUniformLocation(prog, n);
    });

    frameTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, frameTex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    setLut(LutParser.identity(2));
    initScopeFbo();
  }

  function initScopeFbo(){
    scopeTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, scopeTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, scopeW, scopeH, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    scopeFbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, scopeFbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, scopeTex, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  function setLut(lut){
    lutSize = lut.size;
    if(!lutTex) lutTex = gl.createTexture();
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_3D, lutTex);
    // نحوّل RGB float إلى RGBA8
    const n = lutSize*lutSize*lutSize;
    const data = new Uint8Array(n*4);
    for(let i=0;i<n;i++){
      data[i*4+0] = Math.round(Math.min(1,Math.max(0,lut.rgb[i*3+0]))*255);
      data[i*4+1] = Math.round(Math.min(1,Math.max(0,lut.rgb[i*3+1]))*255);
      data[i*4+2] = Math.round(Math.min(1,Math.max(0,lut.rgb[i*3+2]))*255);
      data[i*4+3] = 255;
    }
    gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGBA8, lutSize, lutSize, lutSize, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE);
  }

  function uploadFrame(src, w, h){
    frameW = w; frameH = h;
    if(canvas.width !== w || canvas.height !== h){
      const maxW = 1280;
      let rw = w, rh = h;
      if(w > maxW){ rw = maxW; rh = Math.round(h * maxW / w); }
      canvas.width = rw; canvas.height = rh;
      // ضبط حجم الأدوات بحسب النسبة
      scopeW = 256; scopeH = Math.max(64, Math.round(256 * h / w));
      initScopeFbo();
    }
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, frameTex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src);
  }

  function setParams(p){ Object.assign(params, p); }

  function bindCommonUniforms(scopePass){
    gl.useProgram(prog);
    gl.bindVertexArray(quadVao);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, frameTex); gl.uniform1i(u.uFrame, 0);
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_3D, lutTex); gl.uniform1i(u.uLut, 1);
    gl.uniform2f(u.uTexel, 1/Math.max(1,frameW), 1/Math.max(1,frameH));
    gl.uniform1i(u.uScopePass, scopePass);
    gl.uniform1i(u.uLutOn, params.lutOn?1:0);
    gl.uniform1f(u.uLutIntensity, params.lutIntensity);
    gl.uniform1i(u.uZebra, params.zebra?1:0);
    gl.uniform1f(u.uZebraTh, params.zebraTh);
    gl.uniform1i(u.uFalse, params.falseColor?1:0);
    gl.uniform1i(u.uPeak, params.peaking?1:0);
    gl.uniform3fv(u.uPeakColor, params.peakColor);
    gl.uniform1f(u.uPeakStr, params.peakStr);
    gl.uniform1i(u.uClip, params.clipWarn?1:0);
    gl.uniform1i(u.uCrush, params.crushWarn?1:0);
    gl.uniform1f(u.uCrushTh, params.crushTh);
    gl.uniform4f(u.uZoom, params.panX, params.panY, params.zoom, 0);
  }

  function render(){
    if(!frameW) return;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0,0,canvas.width, canvas.height);
    bindCommonUniforms(0);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  // يرسم مصدر الأدوات إلى FBO مصغّر ويعيد بكسلات RGBA.
  // afterLut=true ⇒ يُطبّق LUT (فقط إن كان مفعّلًا) لحساب الأدوات بعد LUT؛
  // afterLut=false ⇒ إشارة الكاميرا الخام قبل LUT (الافتراضي).
  function readScopePixels(afterLut){
    if(!frameW) return null;
    gl.bindFramebuffer(gl.FRAMEBUFFER, scopeFbo);
    gl.viewport(0,0,scopeW, scopeH);
    gl.useProgram(prog);
    gl.bindVertexArray(quadVao);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, frameTex); gl.uniform1i(u.uFrame,0);
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_3D, lutTex); gl.uniform1i(u.uLut,1);
    gl.uniform1i(u.uScopePass, 1);
    gl.uniform1i(u.uLutOn, (afterLut && params.lutOn)?1:0);
    gl.uniform1f(u.uLutIntensity, params.lutIntensity);
    gl.uniform4f(u.uZoom, 0.5,0.5,1.0,0);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    const px = new Uint8Array(scopeW*scopeH*4);
    gl.readPixels(0,0,scopeW,scopeH, gl.RGBA, gl.UNSIGNED_BYTE, px);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return { width: scopeW, height: scopeH, pixels: px };
  }

  function captureDataURL(){
    // يلتقط ما هو معروض حاليًا (مع LUT) كصورة معاينة
    try { return canvas.toDataURL('image/jpeg', 0.92); } catch(e){ return null; }
  }

  return { init, setLut, uploadFrame, setParams, render, readScopePixels, captureDataURL,
           get size(){ return {w:frameW,h:frameH}; } };
})();
