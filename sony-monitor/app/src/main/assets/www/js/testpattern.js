/* نمط اختبار اصطناعي — ليس بثًا من الكاميرا.
 * غرضه الوحيد: تجربة LUT وأدوات المراقبة وسلاسة العرض على الهاتف قبل توفّر الكاميرا.
 * تظهر شارة تحذير دائمة في الواجهة عند تفعيله.
 */
const TestPattern = (() => {
  const W = 960, H = 540;
  const cv = document.createElement('canvas'); cv.width=W; cv.height=H;
  const ctx = cv.getContext('2d');
  let t0 = performance.now();

  function draw(){
    const t = (performance.now() - t0)/1000;
    // أشرطة ألوان علوية
    const bars = ['#c0c0c0','#c0c000','#00c0c0','#00c000','#c000c0','#c00000','#0000c0','#000000'];
    const bw = W/bars.length;
    for(let i=0;i<bars.length;i++){ ctx.fillStyle=bars[i]; ctx.fillRect(i*bw,0,bw,H*0.55); }
    // تدرّج سطوع سفلي (لاختبار Histogram/Waveform/False Color)
    const grad = ctx.createLinearGradient(0,0,W,0);
    grad.addColorStop(0,'#000'); grad.addColorStop(1,'#fff');
    ctx.fillStyle=grad; ctx.fillRect(0,H*0.55,W,H*0.25);
    // مربّع أبيض متحرّك (لاختبار Focus Peaking و Zebra والحركة)
    const x = (Math.sin(t*0.8)*0.5+0.5)*(W-140);
    ctx.fillStyle='#fff'; ctx.fillRect(x, H*0.8, 120, 90);
    ctx.strokeStyle='#000'; ctx.lineWidth=6; ctx.strokeRect(x, H*0.8, 120, 90);
    // نص واضح
    ctx.fillStyle='rgba(242,183,5,0.95)'; ctx.font='bold 26px sans-serif'; ctx.textAlign='center';
    ctx.fillText('نمط اختبار — ليس بثًا من الكاميرا', W/2, H*0.9);
    return cv;
  }

  return { draw, get width(){return W;}, get height(){return H;}, canvas: cv };
})();
