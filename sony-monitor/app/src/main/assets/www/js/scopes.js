/* حساب ورسم أدوات المراقبة من بكسلات إطار المعاينة المصغّر (readback من GPU).
 * كل القيم من بث المعاينة المضغوط: تقريبية (0–100% من قيمة البكسل) وليست قياسًا مُعايَرًا.
 */
const Scopes = (() => {
  let host;
  let enabled = { hist:true, histRGB:false, wave:false, parade:false };
  const cards = {};

  function makeCard(key, title, w, h){
    const card = document.createElement('div');
    card.className = 'scopeCard';
    const cap = document.createElement('div'); cap.className='cap'; cap.textContent = title;
    const cv = document.createElement('canvas'); cv.width=w; cv.height=h;
    card.appendChild(cap); card.appendChild(cv);
    cards[key] = { card, cv, ctx: cv.getContext('2d') };
    return card;
  }

  function init(container){
    host = container;
    rebuild();
  }

  function setEnabled(e){ Object.assign(enabled, e); rebuild(); }

  function rebuild(){
    if(!host) return;
    host.innerHTML = '';
    Object.keys(cards).forEach(k=>delete cards[k]);
    if(enabled.hist)   host.appendChild(makeCard('hist','Histogram — السطوع (تقريبي)', 256, 120));
    if(enabled.histRGB)host.appendChild(makeCard('histRGB','RGB Histogram (تقريبي)', 256, 120));
    if(enabled.wave)   host.appendChild(makeCard('wave','Waveform — السطوع (تقريبي)', 256, 140));
    if(enabled.parade) host.appendChild(makeCard('parade','RGB Parade (تقريبي)', 256, 140));
  }

  function update(data){
    if(!data) return;
    const { width, height, pixels } = data;
    if(enabled.hist || enabled.histRGB) drawHistogram(width, height, pixels);
    if(enabled.wave) drawWaveform(width, height, pixels);
    if(enabled.parade) drawParade(width, height, pixels);
  }

  function drawHistogram(w,h,px){
    const binsL = new Float32Array(256), binsR=new Float32Array(256), binsG=new Float32Array(256), binsB=new Float32Array(256);
    for(let i=0;i<px.length;i+=4){
      const r=px[i], g=px[i+1], b=px[i+2];
      const y = (0.2126*r + 0.7152*g + 0.0722*b)|0;
      binsL[y]++; binsR[r]++; binsG[g]++; binsB[b]++;
    }
    if(enabled.hist) plotHist(cards.hist, [ {d:binsL, c:'#e7e9ee'} ]);
    if(enabled.histRGB) plotHist(cards.histRGB, [ {d:binsR,c:'rgba(255,80,80,0.9)'},{d:binsG,c:'rgba(80,255,120,0.9)'},{d:binsB,c:'rgba(90,140,255,0.9)'} ]);
  }

  function plotHist(card, series){
    if(!card) return;
    const {cv, ctx} = card; const W=cv.width, H=cv.height;
    ctx.clearRect(0,0,W,H); ctx.fillStyle='#000'; ctx.fillRect(0,0,W,H);
    // خطوط مرجعية 0/50/100%
    ctx.strokeStyle='rgba(255,255,255,0.12)'; ctx.lineWidth=1;
    [0.25,0.5,0.75].forEach(f=>{ ctx.beginPath(); ctx.moveTo(f*W,0); ctx.lineTo(f*W,H); ctx.stroke(); });
    let max=1; series.forEach(s=>{ for(let i=0;i<256;i++) if(s.d[i]>max) max=s.d[i]; });
    series.forEach(s=>{
      ctx.strokeStyle=s.c; ctx.beginPath();
      for(let i=0;i<256;i++){
        const x = i/255*W; const y = H - (s.d[i]/max)*H;
        if(i===0) ctx.moveTo(x,y); else ctx.lineTo(x,y);
      }
      ctx.stroke();
    });
  }

  function drawWaveform(w,h,px){
    const card = cards.wave; if(!card) return;
    const {cv, ctx} = card; const W=cv.width, H=cv.height;
    const acc = new Float32Array(W*H);
    for(let y=0;y<h;y++){
      for(let x=0;x<w;x++){
        const i=(y*w+x)*4;
        const lum = (0.2126*px[i]+0.7152*px[i+1]+0.0722*px[i+2])/255;
        const cx = (x/(w-1)*(W-1))|0;
        const cy = (H-1) - (lum*(H-1))|0;
        acc[cy*W+cx] += 1;
      }
    }
    renderAcc(ctx, W, H, acc, [180,255,180]);
    gridLines(ctx,W,H);
  }

  function drawParade(w,h,px){
    const card = cards.parade; if(!card) return;
    const {cv, ctx} = card; const W=cv.width, H=cv.height;
    const third = Math.floor(W/3);
    ctx.clearRect(0,0,W,H); ctx.fillStyle='#000'; ctx.fillRect(0,0,W,H);
    const chans = [ {o:0,col:[255,90,90]}, {o:1,col:[90,255,120]}, {o:2,col:[110,150,255]} ];
    chans.forEach((ch,idx)=>{
      const acc = new Float32Array(third*H);
      for(let y=0;y<h;y++){
        for(let x=0;x<w;x++){
          const i=(y*w+x)*4;
          const v = px[i+ch.o]/255;
          const cx = (x/(w-1)*(third-1))|0;
          const cy = (H-1) - (v*(H-1))|0;
          acc[cy*third+cx] += 1;
        }
      }
      renderAccOffset(ctx, third, H, acc, ch.col, idx*third);
    });
    gridLines(ctx,W,H);
  }

  function renderAcc(ctx,W,H,acc,col){
    const img = ctx.createImageData(W,H);
    let max=1; for(let i=0;i<acc.length;i++) if(acc[i]>max) max=acc[i];
    for(let i=0;i<acc.length;i++){
      const a = Math.min(1, acc[i]/max*3);
      img.data[i*4]=col[0]; img.data[i*4+1]=col[1]; img.data[i*4+2]=col[2]; img.data[i*4+3]=a*255;
    }
    ctx.fillStyle='#000'; ctx.fillRect(0,0,W,H);
    ctx.putImageData(img,0,0);
  }

  function renderAccOffset(ctx,W,H,acc,col,offx){
    const img = ctx.createImageData(W,H);
    let max=1; for(let i=0;i<acc.length;i++) if(acc[i]>max) max=acc[i];
    for(let i=0;i<acc.length;i++){
      const a = Math.min(1, acc[i]/max*3);
      img.data[i*4]=col[0]; img.data[i*4+1]=col[1]; img.data[i*4+2]=col[2]; img.data[i*4+3]=a*255;
    }
    ctx.putImageData(img, offx, 0);
  }

  function gridLines(ctx,W,H){
    ctx.strokeStyle='rgba(255,255,255,0.12)'; ctx.lineWidth=1;
    [0.25,0.5,0.75].forEach(f=>{ ctx.beginPath(); ctx.moveTo(0,f*H); ctx.lineTo(W,f*H); ctx.stroke(); });
  }

  // دليل ألوان False Color
  const falseColorLegend = [
    ['#800080','أسود مقصوص (<2%)'],
    ['#0000cc','ظلال (2–10%)'],
    ['#0099cc','ظلال متوسطة'],
    ['#009933','منتصف منخفض'],
    ['#66e64d','رمادي 18% (~40%)'],
    ['#999999','منتصف'],
    ['#f28099','بشرة (~52–56%)'],
    ['#cccccc','منتصف فاتح'],
    ['#f2d933','إضاءات (~90%)'],
    ['#f28c1a','إضاءات عالية'],
    ['#f21a1a','أبيض مقصوص (>97%)']
  ];

  return { init, setEnabled, update, falseColorLegend };
})();
