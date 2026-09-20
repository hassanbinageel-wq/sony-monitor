/* الجسر بين طبقة الويب والطبقة الأصلية.
 *  - يستقبل الأحداث window.__sonyEvent والإطارات window.__sonyFrame من Kotlin.
 *  - يوفّر واجهة أوامر Bridge.cmd.* تستدعي window.SonyBridge (مع بديل آمن للتطوير في المتصفح).
 */
const Bridge = (() => {
  const listeners = {};
  let frameHandler = null;
  const hasNative = typeof window.SonyBridge !== 'undefined';

  function on(type, cb){ (listeners[type] = listeners[type] || []).push(cb); }
  function emit(type, data){ (listeners[type]||[]).forEach(cb=>{ try{cb(data);}catch(e){console.error(e);} }); }

  // أوامر إلى الأصل (تتحمّل غياب SonyBridge أثناء التطوير على المتصفح)
  const N = hasNative ? window.SonyBridge : null;
  const cmd = {
    connect(){ N && N.connect(); },
    disconnect(){ N && N.disconnect(); },
    startLiveview(){ N && N.startLiveview(); },
    stopLiveview(){ N && N.stopLiveview(); },
    takePicture(){ N && N.takePicture(); },
    startMovieRec(){ N && N.startMovieRec(); },
    stopMovieRec(){ N && N.stopMovieRec(); },
    setSetting(k,v){ N && N.setSetting(k, String(v)); },
    refreshStatus(){ N && N.refreshStatus(); },
    keepScreenOn(b){ N && N.keepScreenOn(!!b); },
    phoneStatus(){ try { return N ? JSON.parse(N.getPhoneStatus()) : {}; } catch(e){ return {}; } }
  };

  // استقبال الأحداث من الأصل
  window.__sonyEvent = function(type, jsonStr){
    let obj = {};
    try { obj = JSON.parse(jsonStr); } catch(e){}
    emit(type, obj);
    emit('*', { type, data: obj });
  };

  // استقبال إطار: base64 لصورة JPEG
  window.__sonyFrame = function(b64, seq, cameraTs, arrivalMs){
    if(!frameHandler) return;
    const t = performance.now();
    const blob = base64ToBlob(b64, 'image/jpeg');
    createImageBitmap(blob).then(bitmap=>{
      frameHandler({ bitmap, seq, cameraTs, arrivalMs, decodeMs: performance.now()-t });
    }).catch(()=>{});
  };

  function base64ToBlob(b64, mime){
    const bin = atob(b64);
    const len = bin.length;
    const bytes = new Uint8Array(len);
    for(let i=0;i<len;i++) bytes[i] = bin.charCodeAt(i);
    return new Blob([bytes], { type: mime });
  }

  return { on, emit, cmd, hasNative, setFrameHandler(fn){ frameHandler = fn; } };
})();
