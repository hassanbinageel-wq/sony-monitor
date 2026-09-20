/* محلّل ملفات LUT بصيغة .cube (ثلاثية الأبعاد) لتحويلها إلى نسيج 3D في WebGL.
 * ترتيب بيانات .cube: القناة الحمراء تتغيّر أسرع، ثم الخضراء، ثم الزرقاء —
 * وهو نفس ترتيب texImage3D (العرض=R، الارتفاع=G، العمق=B).
 */
const LutParser = (() => {

  function parseCube(text) {
    const lines = text.split(/\r?\n/);
    let size = 0;
    let title = '';
    let domainMin = [0, 0, 0], domainMax = [1, 1, 1];
    const values = [];
    let is1D = false;

    for (let raw of lines) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const up = line.toUpperCase();
      if (up.startsWith('TITLE')) { const m = line.match(/"([^"]*)"/); if (m) title = m[1]; continue; }
      if (up.startsWith('LUT_3D_SIZE')) { size = parseInt(line.split(/\s+/)[1], 10); continue; }
      if (up.startsWith('LUT_1D_SIZE')) { size = parseInt(line.split(/\s+/)[1], 10); is1D = true; continue; }
      if (up.startsWith('DOMAIN_MIN')) { const p = line.split(/\s+/); domainMin = [+p[1], +p[2], +p[3]]; continue; }
      if (up.startsWith('DOMAIN_MAX')) { const p = line.split(/\s+/); domainMax = [+p[1], +p[2], +p[3]]; continue; }
      const parts = line.split(/\s+/).map(Number);
      if (parts.length >= 3 && parts.every(n => !isNaN(n))) {
        values.push(parts[0], parts[1], parts[2]);
      }
    }

    if (is1D) throw new Error('ملفات LUT أحادية (1D) غير مدعومة بعد — استخدم LUT ثلاثي الأبعاد (3D).');
    if (!size || size < 2) throw new Error('لم يُعثر على LUT_3D_SIZE صالح في الملف.');
    const expected = size * size * size * 3;
    if (values.length !== expected)
      throw new Error(`عدد القيم (${values.length/3}) لا يطابق الحجم المتوقّع (${size*size*size}).`);

    return { size, title, rgb: Float32Array.from(values), domainMin, domainMax };
  }

  // LUT محايد (identity) — يُستخدم حين لا يوجد LUT مفعّل
  function identity(size = 2) {
    const rgb = new Float32Array(size * size * size * 3);
    let i = 0;
    for (let b = 0; b < size; b++)
      for (let g = 0; g < size; g++)
        for (let r = 0; r < size; r++) {
          rgb[i++] = r / (size - 1);
          rgb[i++] = g / (size - 1);
          rgb[i++] = b / (size - 1);
        }
    return { size, title: 'identity', rgb, domainMin: [0,0,0], domainMax: [1,1,1] };
  }

  // للتخزين المحلي: نحوّل Float32Array إلى مصفوفة أرقام والعكس
  function toStorable(lut) {
    return { size: lut.size, title: lut.title, rgb: Array.from(lut.rgb), domainMin: lut.domainMin, domainMax: lut.domainMax };
  }
  function fromStorable(o) {
    return { size: o.size, title: o.title || '', rgb: Float32Array.from(o.rgb), domainMin: o.domainMin || [0,0,0], domainMax: o.domainMax || [1,1,1] };
  }

  return { parseCube, identity, toStorable, fromStorable };
})();
