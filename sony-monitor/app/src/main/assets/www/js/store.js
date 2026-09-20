/* تخزين محلي بسيط داخل التطبيق (لا يعدّل ملفات الكاميرا الأصلية إطلاقًا).
 * يحفظ: قائمة LUTs، الإعدادات، المشاريع والملاحظات، LUT المفضّل لكل كاميرا/مشروع.
 * كل عمليات القراءة/الكتابة محاطة بحماية لأن التخزين قد يفشل في بعض الحالات.
 */
const Store = (() => {
  const K = {
    luts: 'sm_luts',
    settings: 'sm_settings',
    projects: 'sm_projects',
    favLut: 'sm_fav_lut'   // خريطة: cameraModel/projectId -> lutId
  };

  function read(key, fallback) {
    try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; }
    catch (e) { return fallback; }
  }
  function write(key, val) {
    try { localStorage.setItem(key, JSON.stringify(val)); return true; }
    catch (e) { return false; }
  }

  return {
    // LUTs: [{id, name, size, data(base64 of Float32? we store as array), order}]
    getLuts() { return read(K.luts, []); },
    saveLuts(list) { return write(K.luts, list); },

    getSettings() { return read(K.settings, {}); },
    saveSettings(s) { return write(K.settings, s); },
    patchSettings(patch) { const s = this.getSettings(); Object.assign(s, patch); this.saveSettings(s); return s; },

    getProjects() { return read(K.projects, []); },
    saveProjects(p) { return write(K.projects, p); },

    getFavLuts() { return read(K.favLut, {}); },
    setFavLut(key, lutId) { const m = this.getFavLuts(); m[key] = lutId; write(K.favLut, m); },
    getFavLut(key) { return this.getFavLuts()[key] || null; }
  };
})();
