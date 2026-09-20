/* منطق التطبيق: ربط الجسر + WebGL + الأدوات + اللوحات + الحالة.
 * ينظّم وضعي العمل (مونيتور/تحكم) عبر لوحات جانبية، ويحسب FPS وزمن المعالجة فعليًا،
 * ولا يعرض أي وظيفة/قيمة إلا بناءً على أحداث حقيقية من الكاميرا.
 */
(() => {
  const $ = s => document.querySelector(s);
  const el = {
    stage: $('#stage'), glcanvas: $('#glcanvas'), flipWrap: $('#flipWrap'),
    guides: $('#guides'), refOverlay: $('#refOverlay'), sourceBadge: $('#sourceBadge'),
    connDot: $('#connDot'), connText: $('#connText'),
    recDot: $('#recDot'), recTime: $('#recTime'),
    fps: $('#fps'), latency: $('#latency'),
    camBatt: $('#camBatt'), phoneBatt: $('#phoneBatt'), camCard: $('#camCard'),
    hideUiBtn: $('#hideUiBtn'), toolrail: $('#toolrail'),
    panelHost: $('#panelHost'), panelTitle: $('#panelTitle'), panelBody: $('#panelBody'), panelClose: $('#panelClose'),
    toast: $('#toast')
  };

  // الحالة
  const defaults = {
    lutOn:false, lutIntensity:100, activeLutId:null,
    zebra:false, zebraTh:95, falseColor:false, clipWarn:true, crushWarn:false, crushTh:4,
    hist:true, histRGB:false, wave:false, parade:false, scopeSource:'pre', scopeRate:3,
    zoom:100, peaking:false, peakColor:'r', peakStr:30,
    gThirds:false, gCenter:false, gAspect:'', gSafe:false, gOpacity:60,
    flipH:false, refOn:false, refOpacity:50,
    keepOn:true, lvSize:'L'
  };
  let S = Object.assign({}, defaults, Store.getSettings());
  let caps = null;               // قدرات الكاميرا المكتشَفة
  let connected = false, testMode = false;
  let refImageURL = null;
  let recStartMs = 0, recTimer = null;
  let currentModel = 'default';

  // FPS
  let frameCount = 0, fpsWindow = [], lastProcMs = 0;

  // ============ التهيئة ============
  function boot(){
    try { GL.init(el.glcanvas); }
    catch(e){ toast('خطأ WebGL: '+e.message); }
    applyParamsToGL();
    loadActiveLut();
    Bridge.setFrameHandler(onNativeFrame);
    wireBridgeEvents();
    wireChrome();
    // إبقاء الشاشة مضاءة حسب الإعداد
    Bridge.cmd.keepScreenOn(S.keepOn);
    pollPhoneStatus();
    drawGuides();
    openPanel('connect');
    requestAnimationFrame(loop);
  }

  // ============ حلقة العرض (نمط الاختبار فقط يحتاج rAF مستمر) ============
  function loop(){
    if(testMode){
      const cv = TestPattern.draw();
      GL.uploadFrame(cv, TestPattern.width, TestPattern.height);
      GL.render();
      tickFps(performance.now());
      maybeScopes();
    }
    requestAnimationFrame(loop);
  }

  // ============ إطار حقيقي من الكاميرا ============
  function onNativeFrame(f){
    if(testMode) return; // نمط الاختبار له الأولوية عند تفعيله
    const t = performance.now();
    GL.uploadFrame(f.bitmap, f.bitmap.width, f.bitmap.height);
    GL.render();
    lastProcMs = (performance.now()-t) + (f.decodeMs||0);
    tickFps(t);
    maybeScopes();
    if(f.bitmap.close) f.bitmap.close();
  }

  let scopeFrameCtr = 0;
  function maybeScopes(){
    if(!(S.hist||S.histRGB||S.wave||S.parade)) return;
    if((++scopeFrameCtr % Math.max(1,S.scopeRate)) !== 0) return;
    const data = GL.readScopePixels(S.scopeSource === 'post');
    if(data) Scopes.update(data);
  }

  function tickFps(t){
    fpsWindow.push(t);
    while(fpsWindow.length>2 && t - fpsWindow[0] > 1000) fpsWindow.shift();
    const span = t - fpsWindow[0];
    const fps = span>0 ? ((fpsWindow.length-1)*1000/span) : 0;
    el.fps.textContent = (fps?fps.toFixed(0):'—') + ' fps';
    el.latency.textContent = (lastProcMs?lastProcMs.toFixed(0):'—') + ' ms';
  }

  // ============ أحداث الأصل ============
  function wireBridgeEvents(){
    Bridge.on('status', d=>{
      if(d.phase==='binding') setConn('warn','جارٍ الربط بالشبكة…');
      if(d.phase==='discovering') setConn('warn','جارٍ البحث عن الكاميرا…');
    });
    Bridge.on('connected', d=>{
      caps = d; connected = true; currentModel = d.model || 'default';
      setConn('on', 'متصل: ' + (d.model||'كاميرا'));
      renderCaps(d);
      applyCapsToControls(d);
      // ابدأ البث تلقائيًا إن كان مدعومًا
      if(d.hasLiveview){ Bridge.cmd.startLiveview(); }
      else toast('هذه الكاميرا لا تُتيح البث الحي عبر هذا الاتصال.');
      loadFavLutForContext();
    });
    Bridge.on('disconnected', ()=>{ connected=false; caps=null; setConn('off','غير متصل'); disableControls(); });
    Bridge.on('error', d=>{ setConn('off', d.message||'خطأ'); toast(d.message||'خطأ'); });
    Bridge.on('stream', d=>{
      if(d.state==='connected') setConn('on', 'البث حي');
      else if(d.state==='reconnecting') setConn('warn', `انقطع البث — إعادة محاولة (${d.attempt})…`);
      else if(d.state==='lost') setConn('warn', 'انقطع البث: '+(d.reason||''));
      else if(d.state==='starting') setConn('warn','بدء البث…');
    });
    Bridge.on('camera-status', updateCameraStatus);
    Bridge.on('action', d=>{
      logAction(d);
      if(d.action==='startMovieRec' && d.ok) setRecording(true);
      if(d.action==='stopMovieRec' && d.ok) setRecording(false);
      if(d.action==='takePicture' && d.ok) toast('تم الالتقاط ✓');
    });
  }

  function setConn(kind, text){
    el.connDot.className = 'dot ' + (kind==='on'?'dot-on':kind==='warn'?'dot-warn':'dot-off');
    el.connText.textContent = text;
  }

  function updateCameraStatus(st){
    // بطارية/بطاقة الكاميرا
    if(st.cameraBatteryLevel!=null && st.cameraBatteryDenom){
      el.camBatt.textContent = '📷 ' + Math.round(st.cameraBatteryLevel/st.cameraBatteryDenom*100) + '%';
    } else if(st.cameraBatteryStatus){ el.camBatt.textContent = '📷 ' + st.cameraBatteryStatus; }
    if(st.recordableImages!=null) el.camCard.textContent = '🗂 ' + st.recordableImages + ' صورة';
    else if(st.recordableTimeMin!=null) el.camCard.textContent = '🗂 ' + st.recordableTimeMin + ' د';

    if(st.isRecordingMovie===true) setRecording(true);
    if(st.isRecordingMovie===false) setRecording(false);

    // تحديث القيم الظاهرة في لوحة التحكم (القيمة الحالية فقط — تأكيد من الكاميرا)
    fillSelectCurrent('setIso', st.iso, st.isoCandidates);
    fillSelectCurrent('setShutter', st.shutter, st.shutterCandidates);
    fillSelectCurrent('setF', st.fnumber, st.fnumberCandidates);
  }

  function setRecording(on){
    el.recDot.classList.toggle('hidden', !on);
    el.recTime.classList.toggle('hidden', !on);
    const recBtn = $('#btnRec');
    if(recBtn){ recBtn.classList.toggle('recording', on); recBtn.textContent = on?'إيقاف التسجيل':'بدء تسجيل'; }
    if(on && !recTimer){
      recStartMs = Date.now();
      recTimer = setInterval(()=>{
        const s = Math.floor((Date.now()-recStartMs)/1000);
        el.recTime.textContent = String(Math.floor(s/60)).padStart(2,'0')+':'+String(s%60).padStart(2,'0');
      }, 500);
    } else if(!on && recTimer){ clearInterval(recTimer); recTimer=null; }
  }

  // ============ WebGL params ============
  function applyParamsToGL(){
    GL.setParams({
      lutOn: S.lutOn, lutIntensity: S.lutIntensity/100,
      zebra: S.zebra, zebraTh: S.zebraTh/100,
      falseColor: S.falseColor,
      peaking: S.peaking, peakColor: peakColorVec(S.peakColor), peakStr: S.peakStr/100,
      clipWarn: S.clipWarn, crushWarn: S.crushWarn, crushTh: S.crushTh/100,
      zoom: S.zoom/100
    });
    el.flipWrap.classList.toggle('flip', S.flipH);
    el.refOverlay.style.opacity = S.refOpacity/100;
    el.refOverlay.classList.toggle('show', S.refOn && !!refImageURL);
  }
  function peakColorVec(c){ return c==='g'?[0,1,0]:c==='b'?[0,0.4,1]:c==='y'?[1,0.9,0]:[1,0,0]; }

  function persist(){ Store.saveSettings(S); }

  // ============ LUT ============
  function loadActiveLut(){
    const luts = Store.getLuts();
    const active = luts.find(l=>l.id===S.activeLutId);
    if(active){ try { GL.setLut(LutParser.fromStorable(active.lut)); } catch(e){} }
    else { GL.setLut(LutParser.identity(2)); }
  }
  function loadFavLutForContext(){
    const favId = Store.getFavLut(currentModel);
    if(favId){ S.activeLutId = favId; loadActiveLut(); persist(); }
  }

  // ============ لوحات ============
  function openPanel(name){
    const tpl = document.getElementById('tpl-'+name);
    if(!tpl) return;
    el.panelBody.innerHTML = '';
    el.panelBody.appendChild(tpl.content.cloneNode(true));
    el.panelHost.classList.remove('hidden');
    [...el.toolrail.children].forEach(b=>b.classList.toggle('active', b.dataset.panel===name));
    el.panelTitle.textContent = ({connect:'الاتصال',scopes:'أدوات المراقبة',lut:'LUT للمعاينة',focus:'التركيز والتأطير',control:'التحكم بالكاميرا',files:'الملفات والمشاريع',settings:'الإعدادات'})[name]||'لوحة';
    ({connect:wireConnect,scopes:wireScopes,lut:wireLut,focus:wireFocus,control:wireControl,files:wireFiles,settings:wireSettings})[name]();
  }

  function wireChrome(){
    [...el.toolrail.children].forEach(b=> b.onclick = ()=> openPanel(b.dataset.panel));
    el.panelClose.onclick = ()=> el.panelHost.classList.add('hidden');
    el.hideUiBtn.onclick = ()=> document.body.classList.toggle('hiddenUi');
    window.addEventListener('resize', drawGuides);
    // نقرة على المسرح تُظهر/تخفي الواجهة أيضًا
    el.stage.addEventListener('click', ()=>{ if(document.body.classList.contains('hiddenUi')) document.body.classList.remove('hiddenUi'); });
  }

  // زر الرجوع من الأصل: يغلق اللوحة/يُظهر الواجهة قبل الخروج
  window.__onBackPressed = function(){
    if(document.body.classList.contains('hiddenUi')){ document.body.classList.remove('hiddenUi'); return true; }
    if(!el.panelHost.classList.contains('hidden')){ el.panelHost.classList.add('hidden'); return true; }
    return false;
  };

  // -------- لوحة الاتصال --------
  function wireConnect(){
    const bC = $('#btnConnect'), bD = $('#btnDisconnect'), chk = $('#chkTest');
    bC.onclick = ()=>{ if(!Bridge.hasNative){ toast('الطبقة الأصلية غير متاحة (تشغيل على المتصفح؟)'); } setConn('warn','جارٍ الاتصال…'); Bridge.cmd.connect(); };
    bD.onclick = ()=>{ Bridge.cmd.disconnect(); };
    chk.checked = testMode;
    chk.onchange = ()=>{ setTestMode(chk.checked); };
    if(caps) renderCaps(caps);
  }
  function setTestMode(on){
    testMode = on;
    el.stage.classList.toggle('testmode', on);
    if(on){ toast('تم تفعيل نمط الاختبار — ليس بثًا من الكاميرا'); }
  }
  function renderCaps(d){
    const box = $('#capBox'), list = $('#capList');
    if(!box) return;
    box.classList.remove('hidden'); list.innerHTML='';
    const rows = [
      ['البث الحي', d.hasLiveview],['التقاط صور', d.hasTakePicture],['تسجيل فيديو', d.hasMovieRec],
      ['ضبط ISO', d.canSetIso],['ضبط الغالق', d.canSetShutter],['ضبط الفتحة', d.canSetFNumber],
      ['تعويض التعريض', d.canSetExposureComp],['توازن الأبيض', d.canSetWhiteBalance],['استعراض الملفات', d.hasAvContent]
    ];
    rows.forEach(([n,ok])=>{ const li=document.createElement('li'); li.className=ok?'yes':'no'; li.textContent=n+': '+(ok?'مدعوم':'غير متاح عبر هذا الاتصال'); list.appendChild(li); });
  }

  // -------- لوحة الأدوات --------
  function wireScopes(){
    const host = $('#scopeCanvases');
    Scopes.init(host);
    Scopes.setEnabled({hist:S.hist,histRGB:S.histRGB,wave:S.wave,parade:S.parade});
    bindChk('#scHist','hist', v=>Scopes.setEnabled({hist:v}));
    bindChk('#scHistRGB','histRGB', v=>Scopes.setEnabled({histRGB:v}));
    bindChk('#scWave','wave', v=>Scopes.setEnabled({wave:v}));
    bindChk('#scParade','parade', v=>Scopes.setEnabled({parade:v}));
    bindChk('#scZebra','zebra', ()=>applyParamsToGL());
    bindChk('#scFalse','falseColor', ()=>applyParamsToGL());
    bindChk('#scClip','clipWarn', ()=>applyParamsToGL());
    bindRange('#zebraTh','#zebraThV','zebraTh', v=>v, ()=>applyParamsToGL());
    bindRange('#crushTh','#crushThV','crushTh', v=>v, ()=>applyParamsToGL());
    const src=$('#scopeSource'); src.value=S.scopeSource; src.onchange=()=>{ S.scopeSource=src.value; persist(); };
    // دليل False Color
    const legend = document.createElement('div'); legend.className='note small';
    legend.innerHTML = '<b>دليل False Color:</b><br>' + Scopes.falseColorLegend.map(([c,t])=>`<span style="display:inline-block;width:10px;height:10px;background:${c};margin-inline-end:4px;border-radius:2px"></span>${t}`).join('<br>');
    $('#scopeCanvases').before(legend);
  }

  // -------- لوحة LUT --------
  function wireLut(){
    $('#lutOn').checked = S.lutOn;
    $('#lutOn').onchange = e=>{ S.lutOn=e.target.checked; persist(); applyParamsToGL(); };
    bindRange('#lutIntensity','#lutIntensityV','lutIntensity', v=>v+'%', ()=>applyParamsToGL());
    const cmp=$('#btnLutCompare');
    const down=()=>{ GL.setParams({lutOn:false}); }; const up=()=>{ GL.setParams({lutOn:S.lutOn}); };
    cmp.addEventListener('touchstart',e=>{e.preventDefault();down();}); cmp.addEventListener('touchend',up);
    cmp.addEventListener('mousedown',down); cmp.addEventListener('mouseup',up); cmp.addEventListener('mouseleave',up);
    $('#btnLutImport').onclick = ()=> $('#lutFile').click();
    $('#lutFile').onchange = onLutFile;
    renderLutList();
  }
  function onLutFile(e){
    const file = e.target.files[0]; if(!file) return;
    const reader = new FileReader();
    reader.onload = ()=>{
      try {
        const lut = LutParser.parseCube(reader.result);
        const luts = Store.getLuts();
        const id = 'lut_'+Date.now();
        luts.push({ id, name: file.name.replace(/\.cube$/i,''), size: lut.size, order: luts.length, lut: LutParser.toStorable(lut) });
        if(!Store.saveLuts(luts)){ toast('تعذّر الحفظ — قد تكون مساحة التخزين ممتلئة'); return; }
        S.activeLutId = id; S.lutOn = true; persist();
        loadActiveLut(); applyParamsToGL(); renderLutList();
        toast('تم استيراد LUT: '+file.name);
      } catch(err){ toast('خطأ في الملف: '+err.message); }
    };
    reader.readAsText(file);
  }
  function renderLutList(){
    const host = $('#lutList'); if(!host) return; host.innerHTML='';
    const luts = Store.getLuts().sort((a,b)=>a.order-b.order);
    if(!luts.length){ host.innerHTML='<p class="note small">لا توجد LUTs محفوظة بعد.</p>'; return; }
    luts.forEach((l,idx)=>{
      const item=document.createElement('div'); item.className='lutItem'+(l.id===S.activeLutId?' active':'');
      const name=document.createElement('span'); name.className='name'; name.textContent=l.name+' ('+l.size+'³)';
      name.onclick=()=>{ S.activeLutId=l.id; S.lutOn=true; persist(); loadActiveLut(); applyParamsToGL(); renderLutList(); $('#lutOn').checked=true; };
      const fav=btn('★','حفظ كمفضّل لهذه الكاميرا',()=>{ Store.setFavLut(currentModel, l.id); toast('تم تعيين LUT مفضّل لـ '+currentModel); });
      const ren=btn('✎','إعادة تسمية',()=>{ const n=prompt('اسم جديد', l.name); if(n){ l.name=n; Store.saveLuts(luts); renderLutList(); } });
      const up=btn('▲','',()=>reorder(luts,idx,-1)); const dn=btn('▼','',()=>reorder(luts,idx,1));
      const del=btn('🗑','حذف',()=>{ if(confirm('حذف '+l.name+'؟')){ const rest=luts.filter(x=>x.id!==l.id); Store.saveLuts(rest); if(S.activeLutId===l.id){S.activeLutId=null;S.lutOn=false;persist();loadActiveLut();applyParamsToGL();} renderLutList(); } });
      item.append(name,fav,ren,up,dn,del); host.appendChild(item);
    });
  }
  function reorder(luts,idx,dir){ const j=idx+dir; if(j<0||j>=luts.length) return; const a=luts[idx],b=luts[j]; const o=a.order;a.order=b.order;b.order=o; Store.saveLuts(luts); renderLutList(); }

  // -------- لوحة التركيز والتأطير --------
  function wireFocus(){
    bindRange('#zoom','#zoomV','zoom', v=>(v/100).toFixed(1)+'x', ()=>applyParamsToGL());
    bindChk('#peakOn','peaking', ()=>applyParamsToGL());
    const pc=$('#peakColor'); pc.value=S.peakColor; pc.onchange=()=>{ S.peakColor=pc.value; persist(); applyParamsToGL(); };
    bindRange('#peakStr','#peakStrV','peakStr', v=>v, ()=>applyParamsToGL());
    bindChk('#gThirds','gThirds', drawGuides);
    bindChk('#gCenter','gCenter', drawGuides);
    const ga=$('#gAspect'); ga.value=S.gAspect; ga.onchange=()=>{ S.gAspect=ga.value; persist(); drawGuides(); };
    bindChk('#gSafe','gSafe', drawGuides);
    bindRange('#gOpacity','#gOpacityV','gOpacity', v=>v+'%', drawGuides);
    bindChk('#flipH','flipH', ()=>applyParamsToGL());
    $('#btnSetRef').onclick = ()=>{ const url=GL.captureDataURL(); if(url){ refImageURL=url; el.refOverlay.src=url; S.refOn=true; persist(); applyParamsToGL(); $('#refOn').checked=true; toast('حُفظت صورة معاينة مرجعية (ليست ملف الكاميرا)'); } };
    bindChk('#refOn','refOn', ()=>applyParamsToGL());
    bindRange('#refOpacity','#refOpacityV','refOpacity', v=>v+'%', ()=>applyParamsToGL());
  }

  // -------- لوحة التحكم --------
  function wireControl(){
    $('#btnShot').onclick = ()=> Bridge.cmd.takePicture();
    $('#btnRec').onclick = ()=>{ const rec=$('#btnRec').classList.contains('recording'); if(rec) Bridge.cmd.stopMovieRec(); else Bridge.cmd.startMovieRec(); };
    ['setIso','setShutter','setF','setWB'].forEach(id=>{ const s=$('#'+id); if(s) s.onchange=()=>onSettingChange(id, s.value); });
    if(caps) applyCapsToControls(caps);
    Bridge.cmd.refreshStatus();
  }
  function onSettingChange(id, val){
    const map={setIso:'iso',setShutter:'shutter',setF:'fnumber',setWB:'whitebalance'};
    Bridge.cmd.setSetting(map[id], val);
    toast('أُرسل الأمر — بانتظار تأكيد الكاميرا…');
  }
  function applyCapsToControls(d){
    const shot=$('#btnShot'), rec=$('#btnRec');
    if(shot) shot.disabled = !d.hasTakePicture;
    if(rec) rec.disabled = !d.hasMovieRec;
    setSel('setIso', d.canSetIso); setSel('setShutter', d.canSetShutter); setSel('setF', d.canSetFNumber); setSel('setWB', d.canSetWhiteBalance);
    const cc=$('#controlCaps'); if(cc) cc.textContent = 'مفعّل حسب قدرات '+(d.model||'الكاميرا')+': التقاط='+yn(d.hasTakePicture)+'، فيديو='+yn(d.hasMovieRec)+'، ISO='+yn(d.canSetIso)+'، غالق='+yn(d.canSetShutter)+'، فتحة='+yn(d.canSetFNumber)+'.';
  }
  function setSel(id, on){ const s=$('#'+id); if(s) s.disabled=!on; }
  function yn(b){ return b?'نعم':'لا'; }
  function disableControls(){ ['btnShot','btnRec','setIso','setShutter','setF','setWB'].forEach(id=>{ const e=document.getElementById(id); if(e) e.disabled=true; }); }
  function fillSelectCurrent(id, current, candidates){
    const s=document.getElementById(id); if(!s||current==null) return;
    // اعمر القائمة من الخيارات المتاحة القادمة من الكاميرا (إن وُجدت)
    if(Array.isArray(candidates) && candidates.length){
      const cur = s.value;
      s.innerHTML='';
      candidates.forEach(v=>{ const o=document.createElement('option'); o.value=String(v); o.textContent=String(v); s.appendChild(o); });
      if([...s.options].some(o=>o.value===cur)) s.value=cur;
    }
    // اضمن وجود القيمة الحالية المؤكَّدة من الكاميرا
    let opt=[...s.options].find(o=>o.value===String(current));
    if(!opt){ opt=document.createElement('option'); opt.value=String(current); opt.textContent=String(current); s.appendChild(opt); }
    s.value=String(current);
  }
  function logAction(d){
    const host=$('#actionLog'); if(!host) return;
    const line=document.createElement('div');
    line.className = d.ok?'ok':'err';
    const label = d.label || d.action || 'أمر';
    line.textContent = (d.ok?'✓ ':'✗ ') + label + (d.value?(' → '+d.value):'') + (d.message?(' — '+d.message):'');
    host.prepend(line);
  }

  // -------- لوحة الملفات والمشاريع --------
  function wireFiles(){
    document.querySelectorAll('#panelBody .tab').forEach(t=> t.onclick=()=>{
      document.querySelectorAll('#panelBody .tab').forEach(x=>x.classList.remove('active'));
      t.classList.add('active');
      $('#filesBrowse').classList.toggle('hidden', t.dataset.tab!=='browse');
      $('#filesProjects').classList.toggle('hidden', t.dataset.tab!=='projects');
    });
    const bb=$('#btnBrowse');
    if(bb){ bb.disabled = !(caps && caps.hasAvContent); bb.onclick=()=> toast('استعراض الملفات يحتاج تبديل الكاميرا لوضع نقل المحتوى — قيد الاختبار على a7 III.'); }
    $('#btnAddProj').onclick = ()=>{ const n=$('#projName').value.trim(); if(!n) return; const ps=Store.getProjects(); ps.push({id:'p_'+Date.now(), name:n, shots:[]}); Store.saveProjects(ps); $('#projName').value=''; renderProjects(); };
    renderProjects();
  }
  function renderProjects(){
    const host=$('#projList'); if(!host) return; host.innerHTML='';
    const ps=Store.getProjects();
    if(!ps.length){ host.innerHTML='<p class="note small">لا مشاريع بعد. أنشئ مشروعًا لتنظيم اللقطات والملاحظات (يُحفظ داخل التطبيق فقط).</p>'; return; }
    ps.forEach(p=>{
      const it=document.createElement('div'); it.className='projItem';
      const nm=document.createElement('span'); nm.className='name'; nm.style.flex='1'; nm.textContent=p.name+' ('+p.shots.length+' لقطة)';
      const add=btn('+لقطة','', ()=>{ const scene=prompt('اسم المشهد:'); if(scene===null) return; const shot=prompt('رقم اللقطة:')||''; const note=prompt('ملاحظات:')||''; p.shots.push({scene,shot,note,fav:false,ts:Date.now()}); Store.saveProjects(ps); renderProjects(); });
      const fav=btn('★','مفضّلة', ()=>{ p.fav=!p.fav; Store.saveProjects(ps); });
      const del=btn('🗑','حذف', ()=>{ if(confirm('حذف المشروع؟')){ Store.saveProjects(ps.filter(x=>x.id!==p.id)); renderProjects(); } });
      it.append(nm,add,fav,del); host.appendChild(it);
    });
  }

  // -------- لوحة الإعدادات --------
  function wireSettings(){
    $('#keepOn').checked=S.keepOn; $('#keepOn').onchange=e=>{ S.keepOn=e.target.checked; persist(); Bridge.cmd.keepScreenOn(S.keepOn); };
    const lv=$('#lvSize'); lv.value=S.lvSize; lv.onchange=()=>{ S.lvSize=lv.value; persist(); };
    const sr=$('#scopeRate'); sr.value=String(S.scopeRate); sr.onchange=()=>{ S.scopeRate=+sr.value; persist(); };
    $('#btnSaveLayout').onclick=()=>{ persist(); toast('حُفظ توزيع الأدوات'); };
    $('#btnResetLayout').onclick=()=>{ S=Object.assign({}, defaults); persist(); applyParamsToGL(); drawGuides(); toast('استُرجعت الإعدادات الافتراضية'); openPanel('settings'); };
    $('#about').innerHTML = 'مونيتور Sony — نسخة أساس 0.1. الاتصال عبر Sony ScalarWebAPI (Camera Remote API). البث الحي والتقاط الصور مؤكدان بالبروتوكول ويحتاجان تأكيدًا على a7 III؛ وظائف أخرى مصنّفة في COMPATIBILITY.md.';
  }

  // ============ أدلة التأطير (SVG) ============
  function drawGuides(){
    const svg=el.guides;
    // اضبط SVG فوق مستطيل عرض الكانفس
    const cr=el.glcanvas.getBoundingClientRect(), sr=el.stage.getBoundingClientRect();
    svg.style.left=(cr.left-sr.left)+'px'; svg.style.top=(cr.top-sr.top)+'px';
    svg.style.width=cr.width+'px'; svg.style.height=cr.height+'px';
    svg.setAttribute('viewBox','0 0 1000 1000'); svg.setAttribute('preserveAspectRatio','none');
    const op=S.gOpacity/100;
    let g='';
    const line=(x1,y1,x2,y2)=>`<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="white" stroke-width="1.5" opacity="${op}"/>`;
    if(S.gThirds){ g+=line(333,0,333,1000)+line(667,0,667,1000)+line(0,333,1000,333)+line(0,667,1000,667); }
    if(S.gCenter){ g+=line(500,0,500,1000)+line(0,500,1000,500); }
    if(S.gSafe){ g+=`<rect x="100" y="100" width="800" height="800" fill="none" stroke="#f2b705" stroke-width="1.5" opacity="${op}"/>`; }
    if(S.gAspect){ g+=aspectFrame(S.gAspect, op); }
    svg.innerHTML=g;
  }
  function aspectFrame(aspect, op){
    const cw=el.glcanvas.width, ch=el.glcanvas.height; if(!cw||!ch) return '';
    const canvasAR=cw/ch;
    const [a,b]=aspect.split(':').map(Number); const targetAR=a/b;
    let x=0,y=0,w=1000,h=1000;
    if(targetAR>canvasAR){ h=1000*(canvasAR/targetAR); y=(1000-h)/2; }
    else { w=1000*(targetAR/canvasAR); x=(1000-w)/2; }
    return `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="none" stroke="#2b7fff" stroke-width="2" opacity="${op}"/>`
      + `<rect x="0" y="0" width="1000" height="${y}" fill="black" opacity="${op*0.5}"/>`
      + `<rect x="0" y="${y+h}" width="1000" height="${y}" fill="black" opacity="${op*0.5}"/>`
      + `<rect x="0" y="${y}" width="${x}" height="${h}" fill="black" opacity="${op*0.5}"/>`
      + `<rect x="${x+w}" y="${y}" width="${x}" height="${h}" fill="black" opacity="${op*0.5}"/>`;
  }

  // ============ حالة الهاتف ============
  function pollPhoneStatus(){
    const st=Bridge.cmd.phoneStatus();
    if(st && st.batteryPct!=null) el.phoneBatt.textContent = '📱 '+st.batteryPct+'%'+(st.charging?'⚡':'');
    setTimeout(pollPhoneStatus, 15000);
  }

  // ============ مساعدات ربط ============
  function bindChk(sel, key, after){ const e=$(sel); if(!e) return; e.checked=S[key]; e.onchange=()=>{ S[key]=e.checked; persist(); after&&after(e.checked); }; }
  function bindRange(sel, valSel, key, fmt, after){ const e=$(sel), v=$(valSel); if(!e) return; e.value=S[key]; if(v) v.textContent=fmt(S[key]); e.oninput=()=>{ S[key]=+e.value; if(v) v.textContent=fmt(+e.value); after&&after(+e.value); }; e.onchange=persist; }
  function btn(txt,title,fn){ const b=document.createElement('button'); b.textContent=txt; if(title)b.title=title; b.onclick=fn; return b; }
  let toastTimer=null;
  function toast(msg){ el.toast.textContent=msg; el.toast.classList.remove('hidden'); clearTimeout(toastTimer); toastTimer=setTimeout(()=>el.toast.classList.add('hidden'), 3200); }

  document.addEventListener('DOMContentLoaded', boot);
})();
