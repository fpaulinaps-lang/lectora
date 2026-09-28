// Lectora: biblioteca de PDFs que se leen en voz alta con la voz del teléfono, una voz natural o la tuya.
const $ = s => document.querySelector(s);
const synth = window.speechSynthesis;
const pdfjs = window.pdfjsLib || window['pdfjs-dist/build/pdf'];
if(pdfjs) pdfjs.GlobalWorkerOptions.workerSrc = 'vendor/pdf.worker.min.js';

/* ---------- Service worker: sin internet y con varios núcleos para la voz ---------- */
if('serviceWorker' in navigator){
  navigator.serviceWorker.register('sw.js').catch(()=>{});
  // Cuando una versión nueva del service worker toma el control, recargar una vez: así la página
  // queda aislada (COOP/COEP) y la voz puede usar varios núcleos.
  navigator.serviceWorker.addEventListener('controllerchange', ()=>{
    const n = +(sessionStorage.getItem('lectora-recargas') || 0);
    if(!self.crossOriginIsolated && n < 2){ sessionStorage.setItem('lectora-recargas', n + 1); location.reload(); }
  });
}
try{ navigator.storage && navigator.storage.persist && navigator.storage.persist(); }catch(e){}

const SAMPLE = {key:'ejemplo', name:'Cómo usar LectorLibre', sample:true, pages:[
  ['CÓMO USAR LA LECTORA',
   'Esta es una página de ejemplo para que escuches cómo funciona.',
   'Toca Agregar, elige uno o varios PDF o EPUB de tu teléfono y quedarán guardados en tu biblioteca.',
   'También puedes agregar fotos de páginas, o sacarlas con la cámara: LectorLibre reconoce el texto.',
   'Luego toca el botón grande de reproducir.',
   'La frase que se está leyendo queda marcada, y las páginas avanzan solas.',
   'Si quieres saltar a otra parte, toca cualquier frase y la lectura seguirá desde ahí.'],
  ['UNA VOZ MÁS NATURAL',
   'LectorLibre usa las voces que trae tu teléfono, sin internet y sin límites.',
   'Para que suene más natural, descarga una voz mejorada o premium en los ajustes del teléfono.',
   'En iPhone está en Ajustes, Accesibilidad, Contenido leído, Voces.',
   'Después, en el botón Voz, puedes probarla y cambiar la velocidad.'],
  ['ENGLISH TOO',
   'LectorLibre also reads English, and it picks the right voice for every sentence.',
   'Un documento que mezcla los dos idiomas se lee sin que tengas que cambiar nada.']
]};

const store = {
  get(k,d){ try{ const v = localStorage.getItem('lectora:'+k); return v==null ? d : JSON.parse(v); }catch(e){ return d; } },
  set(k,v){ try{ localStorage.setItem('lectora:'+k, JSON.stringify(v)); }catch(e){} },
  del(k){ try{ localStorage.removeItem('lectora:'+k); }catch(e){} }
};

/* ---------- IndexedDB: libros, audios del Mac, voz ya generada y tu grabación ---------- */
let dbp = null;
function idb(){
  if(!dbp) dbp = new Promise((res,rej)=>{
    try{
      const r = indexedDB.open('lectora',4);
      r.onupgradeneeded = ()=>{
        const db = r.result;
        for(const [n, o] of [['docs',{keyPath:'key'}],['audio',undefined],['pistas',undefined],['voz',undefined],['portadas',undefined]])
          if(!db.objectStoreNames.contains(n)) db.createObjectStore(n, o);
      };
      r.onsuccess = ()=> res(r.result); r.onerror = ()=> rej(r.error);
    }catch(e){ rej(e); }
  });
  return dbp;
}
async function tx(storeName, mode, fn){
  try{
    const db = await idb();
    return await new Promise((res,rej)=>{
      const t = db.transaction(storeName,mode); const r = fn(t.objectStore(storeName));
      t.oncomplete = ()=> res(r && r.result); t.onerror = ()=> rej(t.error); t.onabort = ()=> rej(t.error);
    });
  }catch(e){ return null; }
}
const dbPut = d => tx('docs','readwrite', s=>s.put(d));
const dbGet = k => tx('docs','readonly', s=>s.get(k));
const kv = {
  get: (st, k) => tx(st,'readonly', s=>s.get(k)),
  put: (st, k, v) => tx(st,'readwrite', s=>s.put(v,k)),
  del: (st, k) => tx(st,'readwrite', s=>s.delete(k)),
  keys: (st, prefix) => tx(st,'readonly', s=>s.getAllKeys(IDBKeyRange.bound(prefix, prefix + '￿'))),
  delPrefix: (st, prefix) => tx(st,'readwrite', s=>s.delete(IDBKeyRange.bound(prefix, prefix + '￿'))),
};

/* ---------- Portadas ---------- */
// Se guardan chicas (unos 150×200 px en JPEG): se ven como miniatura al lado del título.
async function miniatura(fuente){
  const alto = 200, ancho = Math.round(alto * fuente.width / fuente.height);
  const c = document.createElement('canvas'); c.width = Math.max(1, ancho); c.height = alto;
  c.getContext('2d').drawImage(fuente, 0, 0, c.width, c.height);
  return await new Promise(res => c.toBlob(res, 'image/jpeg', 0.82));
}
async function portadaPdf(pdf){
  try{
    const pg = await pdf.getPage(1);
    const v0 = pg.getViewport({scale: 1}), vp = pg.getViewport({scale: 300 / v0.height});
    const c = document.createElement('canvas'); c.width = Math.ceil(vp.width); c.height = Math.ceil(vp.height);
    const ctx = c.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
    // intent 'print': dibuja de una vez, sin esperar a que la pantalla se redibuje; y nunca más de 5 s
    const tarea = pg.render({canvasContext: ctx, viewport: vp, intent: 'print'});
    const listo = await Promise.race([tarea.promise.then(() => true), new Promise(r => setTimeout(() => r(false), 5000))]);
    if(!listo){ try{ tarea.cancel(); }catch(e){} return null; }
    pg.cleanup();
    return await miniatura(c);
  }catch(e){ return null; }
}
async function portadaImagen(bytes, tipo){
  try{
    const bmp = await createImageBitmap(new Blob([bytes], {type: tipo || 'image/jpeg'}));
    const b = await miniatura(bmp); bmp.close && bmp.close();
    return b;
  }catch(e){ return null; }
}
const urlsPortada = new Map();
async function urlPortada(key){
  if(urlsPortada.has(key)) return urlsPortada.get(key);
  const b = await kv.get('portadas', key);
  const u = b ? URL.createObjectURL(b) : null;
  urlsPortada.set(key, u);
  return u;
}

/* ---------- Texto del PDF ---------- */
function pageLines(content){
  const lines = []; let cur = ''; let lastY = null, lastX = null, lastW = null;
  for(const it of content.items){
    if(typeof it.str !== 'string') continue;
    const x = it.transform ? it.transform[4] : null;
    const y = it.transform ? Math.round(it.transform[5]) : null;
    if(lastY !== null && y !== null && Math.abs(y-lastY) > 2 && cur.trim()){
      lines.push(cur); cur=''; lastX = null; lastW = null;
    }
    if(cur && lastX !== null && x !== null && lastW !== null && (x - (lastX + lastW)) > 2 && !cur.endsWith(' ') && !it.str.startsWith(' ')){
      cur += ' ';
    }
    cur += it.str;
    if(it.hasEOL){ lines.push(cur); cur=''; lastX = null; lastW = null; }
    else { lastX = x; lastW = it.width || 0; }
    if(y !== null) lastY = y;
  }
  if(cur.trim()) lines.push(cur);
  return lines.map(l=>l.replace(/\s+/g,' ').trim()).filter(Boolean);
}
const isPageNum = l => /^[-–—\s]*(p[aá]g(ina)?\.?\s*|page\s*)?\d+(\s*(de|of|\/)\s*\d+)?[-–—\s]*$/i.test(l);
const norm = l => l.toLowerCase().replace(/\d+/g,'#').replace(/\s+/g,' ').trim();
function stripRepeats(pages){
  const count = new Map();
  pages.forEach(ls=>{ new Set([...ls.slice(0,2), ...ls.slice(-2)].map(norm)).forEach(k=>count.set(k,(count.get(k)||0)+1)); });
  const thr = Math.max(3, pages.length*0.3);
  return pages.map(ls=>ls.filter((l,i)=>{
    if(isPageNum(l)) return false;
    const edge = i<2 || i>=ls.length-2;
    return !(pages.length>=4 && edge && l.length<120 && count.get(norm(l))>=thr);
  }));
}
const isHeading = l => l.length<90 && !/[.,;:]$/.test(l) && l===l.toUpperCase() && /[A-ZÁÉÍÓÚÑ]{3}/.test(l);
function joinLines(lines){
  let out = '', prev = '';
  for(const l of lines){
    if(!out) out = l;
    else if(isHeading(prev) || isHeading(l)) out += '\n' + l;
    else if(/[A-Za-zÁÉÍÓÚáéíóúñÑ]-$/.test(out) && /^[a-záéíóúñü]/.test(l)) out = out.slice(0,-1) + l;
    else out += ' ' + l;
    prev = l;
  }
  return out;
}
const ABBR = /(?:\b(?:arts?|inc|núm|nº|n°|nro|sr|sra|srta|dr|dra|mr|mrs|ms|lic|etc|págs?|pp?|caps?|vol|ej|cfr|vid|op|cit|ss|sgtes?|ed|av|dto|dfl|ord|aprox|fig|tel|cía|ltda|vs|e\.g|i\.e|no|st|jr)|\b[A-Za-zÁÉÍÓÚÑ]|\d+)\.$/i;
function chop(t, max=220){
  const r = [];
  while(t.length > max){
    let cut = Math.max(t.lastIndexOf(', ',max), t.lastIndexOf('; ',max), t.lastIndexOf(': ',max));
    if(cut < max*0.4) cut = t.lastIndexOf(' ',max);
    if(cut <= 0) cut = max;
    r.push(t.slice(0,cut+1).trim()); t = t.slice(cut+1).trim();
  }
  if(t) r.push(t);
  return r;
}
function splitSentences(text){
  const out = [];
  for(const block of text.split(/\n+/)){
    const parts = block.match(/[^.!?…]+(?:[.!?…]+["'»”’)\]]*|$)/g) || [];
    let buf = '';
    for(const p of parts){
      buf += p;
      const t = buf.trim();
      if(t.length < 18 || ABBR.test(t)) continue;
      out.push(...chop(t)); buf = '';
    }
    if(buf.trim()) out.push(...chop(buf.trim()));
  }
  return out.filter(s=>/[\p{L}\p{N}]/u.test(s));
}

/* ---------- Idioma de cada frase ---------- */
const ES = new Set('de la que el en y los se del las un por con una su para es al lo como más pero sus le ya o este sí porque esta entre cuando muy sin sobre también me hasta hay donde quien desde todo nos durante todos uno les ni contra otros ese eso ante ellos e esto mí antes algunos qué unos yo otro otras otra él tanto esa estos mucho quienes nada muchos cual poco ella estar estas algunas algo nosotros artículo ley será podrá deberá'.split(' '));
const EN = new Set('the of and to in is that it for was on are as with his they at be this have from or one had by but not what all were we when your can said there use an each which she do how their if will up other about out many then them these so some her would make like him into time has look two more write go see number way could people my than first been call who its now find long down day did get come made may part shall any such too also'.split(' '));
function detect(s, fallback){
  if(/[ñ¿¡áéíóú]/i.test(s)) return 'es';
  const words = s.toLowerCase().match(/[a-záéíóúñü']+/g) || [];
  let es = 0, en = 0;
  for(const w of words){ if(ES.has(w)) es++; if(EN.has(w)) en++; }
  return es > en ? 'es' : en > es ? 'en' : fallback;
}

/* ---------- Estado ---------- */
let doc = null, flat = [], pageStarts = [], shownPage = 0;
let idx = 0, playing = false, rate = store.get('rate',1), wake = null;
const isAudioDoc = () => doc && doc.kind === 'audio';

/* ---------- Biblioteca ---------- */
const lib = () => store.get('lib', []);
const setLib = l => store.set('lib', l);
function libUpdate(key, patch){ const l = lib(); const it = l.find(x=>x.key===key); if(it){ Object.assign(it, patch); setLib(l); } }
function fmtFecha(t){
  if(!t) return '';
  const d = Math.floor((Date.now() - t) / 86400000);
  return d <= 0 ? 'hoy' : d === 1 ? 'ayer' : d < 7 ? `hace ${d} días` : new Date(t).toLocaleDateString('es-CL', {day:'numeric', month:'short'});
}
function renderLibrary(){
  const l = lib().slice().sort((a,b)=>(b.opened||b.added||0)-(a.opened||a.added||0));
  const shelf = $('#shelf'); shelf.innerHTML = '';
  $('#libCount').textContent = l.length ? `${l.length} ${l.length===1?'libro':'libros'}` : '';
  const items = [...l, {key:SAMPLE.key, name:SAMPLE.name, pages:SAMPLE.pages.length, sample:true}];
  items.forEach((it, n)=>{
    const li = document.createElement('li');
    li.className = 'book' + (n===0 && it.opened && !it.sample ? ' cont' : '');
    li.dataset.kind = it.sample ? 'ejemplo' : it.audio ? 'audio' : 'pdf';
    const spine = document.createElement('div'); spine.className = 'spine';
    spine.textContent = (it.name.match(/[A-Za-zÁÉÍÓÚÑáéíóúñ0-9]/) || ['·'])[0].toUpperCase();
    if(!it.sample) urlPortada(it.key).then(u => {
      if(!u) return;
      const im = document.createElement('img'); im.src = u; im.alt = ''; im.className = 'portada';
      spine.textContent = ''; spine.classList.add('con-portada'); spine.appendChild(im);
    });
    const b = document.createElement('button'); b.className = 'book-open';
    const t = document.createElement('span'); t.className = 'book-title'; t.textContent = it.name;
    const m = document.createElement('span'); m.className = 'book-meta';
    const pct = it.pct || 0;
    m.textContent = it.sample ? 'Ejemplo · 3 páginas'
      : `${it.pages} ${it.pages===1?'página':'páginas'}` + (pct ? ` · ${pct}% leído` : ' · sin empezar') + (it.opened ? ` · ${fmtFecha(it.opened)}` : '');
    if(it.audio || it.epub || it.ocr){ const g = document.createElement('span'); g.className = 'tag'; g.textContent = it.epub ? 'EPUB' : it.ocr ? 'OCR' : (it.voice || 'audio'); m.appendChild(g); }
    b.append(t, m);
    if(!it.sample){ const p = document.createElement('div'); p.className = 'prog'; p.innerHTML = '<i></i>'; p.firstChild.style.width = pct + '%'; b.appendChild(p); }
    b.onclick = ()=> openBook(it.key);
    li.append(spine, b);
    if(!it.sample){
      const x = document.createElement('button'); x.className = 'book-x'; x.textContent = '×'; x.setAttribute('aria-label', 'Quitar ' + it.name);
      x.onclick = async ()=>{
        if(!x.classList.contains('confirm')){ x.classList.add('confirm'); x.textContent = 'Quitar'; setTimeout(()=>{ x.classList.remove('confirm'); x.textContent = '×'; }, 3000); return; }
        await removeBook(it.key); renderLibrary();
      };
      li.appendChild(x);
    } else li.appendChild(document.createElement('span'));
    shelf.appendChild(li);
  });
}
async function removeBook(key){
  if(doc && doc.key === key){ stop(); doc = null; }
  setLib(lib().filter(x=>x.key!==key));
  store.del('pos:'+key); store.del('time:'+key);
  await Promise.all([tx('docs','readwrite', s=>s.delete(key)), kv.del('audio', key), kv.del('portadas', key), kv.delPrefix('pistas', key + '|')]);
  const u = urlsPortada.get(key); if(u) URL.revokeObjectURL(u); urlsPortada.delete(key);
}
function addToLibrary(d){
  const l = lib().filter(x=>x.key!==d.key);
  l.push({key:d.key, name:d.name, pages:d.pages.length, page:1, pct:0, audio:d.kind==='audio', epub:d.kind==='epub', ocr:!!d.ocr, voice:d.voice, added:Date.now()});
  setLib(l);
}

/* ---------- Vistas ---------- */
function showLibrary(){
  stop();
  $('#libView').hidden = false; $('#readView').hidden = true; $('#player').hidden = true;
  $('#backBtn').hidden = true; $('#docName').hidden = true; $('#brand').hidden = false; $('#addBtn').hidden = false;
  document.body.classList.remove('leyendo');
  store.set('view', 'lib');
  renderLibrary(); window.scrollTo({top:0});
}
function showReader(){
  $('#libView').hidden = true; $('#readView').hidden = false; $('#player').hidden = false;
  $('#backBtn').hidden = false; $('#docName').hidden = false; $('#brand').hidden = true; $('#addBtn').hidden = true;
  document.body.classList.add('leyendo');
  store.set('view', 'read');
}
async function openBook(key){
  hideStatus();
  let d = key === SAMPLE.key ? SAMPLE : await dbGet(key);
  if(!d){ showStatus('No encontré ese libro guardado en este teléfono. Vuelve a agregarlo con «+ Agregar».', 'err'); return; }
  setDoc(d, store.get('pos:'+key, 0));
  libUpdate(key, {opened: Date.now()});
  showReader(); window.scrollTo({top:0});
}

function setDoc(d, pos){
  stop();
  doc = d; flat = []; pageStarts = [];
  let lang = 'es';
  d.pages.forEach((sents,p)=>{
    pageStarts.push(flat.length);
    sents.forEach(x=>{
      if(typeof x === 'string'){ lang = detect(x, lang); flat.push({p, t:x, l:lang}); }
      else { if(!x.l) lang = detect(x.t, lang); flat.push({p, t:x.t, l:x.l || lang, s:x.s, e:x.e, h:x.h, np:x.np}); }
    });
  });
  idx = Math.min(Math.max(0, pos|0), Math.max(0, flat.length-1));
  $('#docName').textContent = d.name;
  $('#pageCount').textContent = d.pages.length;
  $('#pageInput').max = d.pages.length;
  store.set('last', d.key);
  if(zipUrl){ URL.revokeObjectURL(zipUrl); zipUrl = null; audioZip.removeAttribute('src'); audioZip.load(); }
  $('#blackBtn').hidden = isAudioDoc();
  updateVoiceBtn();
  renderPage(flat.length ? flat[idx].p : 0);
  updateMeta(); mediaMeta();
}

function renderPage(p){
  shownPage = p;
  const el = $('#page'); el.innerHTML = '';
  const folio = document.createElement('div'); folio.className = 'folio';
  folio.innerHTML = `<span>Página ${p+1}</span><span>${doc.sample ? 'Ejemplo' : isAudioDoc() ? 'Audio' : ''}</span>`;
  el.appendChild(folio);
  const text = document.createElement('div'); text.className = 'text';
  const n = (p+1 < pageStarts.length ? pageStarts[p+1] : flat.length) - pageStarts[p];
  if(!n){
    const e = document.createElement('p'); e.className = 'empty';
    e.textContent = 'Esta página no tiene texto que leer (puede ser una imagen o estar en blanco).';
    text.appendChild(e);
  }
  let para = document.createElement('p');
  for(let j=0;j<n;j++){
    const i = pageStarts[p]+j, t = flat[i].t;
    const titulo = isHeading(t) || flat[i].h;
    if((titulo || flat[i].np) && para.childNodes.length){ text.appendChild(para); para = document.createElement('p'); }
    const s = document.createElement('span'); s.className = 's'; s.dataset.i = i; s.textContent = t + ' ';
    if(flat[i].l === 'en') s.lang = 'en';
    para.appendChild(s);
    if(titulo){ para.style.fontWeight = '600'; text.appendChild(para); para = document.createElement('p'); }
  }
  if(para.childNodes.length) text.appendChild(para);
  el.appendChild(text);
  $('#pageInput').value = p+1;
  mark(false);
}
function mark(scroll){
  document.querySelectorAll('.s.on').forEach(e=>e.classList.remove('on'));
  const s = document.querySelector(`.s[data-i="${idx}"]`);
  if(s){
    s.classList.add('on');
    if(scroll && $('#blackout').hidden){
      const r = s.getBoundingClientRect();
      if(r.top < 70 || r.bottom > window.innerHeight - 190) s.scrollIntoView({block:'center', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth'});
    }
  }
}
function showSentence(scroll, force){
  if(!force && document.visibilityState !== 'visible') return;
  const s = flat[idx]; if(!s) return;
  if(s.p !== shownPage) renderPage(s.p);
  mark(scroll); updateMeta();
}
function fmtTime(sec){
  if(sec < 60) return 'menos de 1 min';
  const m = Math.round(sec/60);
  if(m < 60) return m + ' min';
  return Math.floor(m/60) + ' h ' + (m%60) + ' min';
}
function updateMeta(){
  if(!doc) return;
  const total = flat.length;
  const p = total ? flat[idx].p : 0;
  let pct, left;
  if(isAudioDoc() && doc.duration){
    const t = zipUrl ? audioZip.currentTime : (flat[idx] ? flat[idx].s : 0);
    pct = Math.round(t/doc.duration*100); left = (doc.duration - t)/rate;
  } else {
    pct = total ? Math.round(idx/Math.max(1,total-1)*100) : 0;
    let chars = 0; for(let i=idx;i<total;i++) chars += flat[i].t.length;
    left = chars/(15*rate);
  }
  $('#where').textContent = `Página ${p+1} de ${doc.pages.length} · ${pct}%`;
  $('#left').textContent = total ? 'quedan ~' + fmtTime(left) : '';
  $('#bar').style.width = pct + '%';
  $('#blackText').textContent = `${playing ? 'Leyendo' : 'En pausa'} · página ${p+1} de ${doc.pages.length}`;
}
let lastSave = 0;
function save(force){
  if(!doc) return;
  store.set('pos:'+doc.key, idx);
  if(isAudioDoc() && zipUrl) store.set('time:'+doc.key, audioZip.currentTime);
  if(force || Date.now() - lastSave > 3000){
    lastSave = Date.now();
    const pct = isAudioDoc() && doc.duration && zipUrl ? Math.round(audioZip.currentTime/doc.duration*100) : Math.round(idx/Math.max(1,flat.length-1)*100);
    libUpdate(doc.key, {page: flat.length ? flat[idx].p+1 : 1, pct});
  }
}

/* ---------- Estado del botón y pantalla ---------- */
function setPlayIcon(){
  $('#playIcon').innerHTML = playing ? '<path d="M6 4h4v16H6zM14 4h4v16h-4z"/>' : '<path d="M7 4v16l13-8z"/>';
  $('#play').setAttribute('aria-label', playing ? 'Pausar' : 'Leer');
  if('mediaSession' in navigator) navigator.mediaSession.playbackState = playing ? 'playing' : 'paused';
  updateMeta();
}
async function holdScreen(on){
  try{
    if(on && 'wakeLock' in navigator && !wake){ wake = await navigator.wakeLock.request('screen'); wake.addEventListener('release',()=>wake=null); }
    if(!on && wake){ await wake.release(); wake = null; }
  }catch(e){ wake = null; }
}

/* ================= Motor 1: voces del teléfono ================= */
let token = 0, lastStart = 0, stalledSince = 0, voices = [], voiceBy = {es:null, en:null};
let audioCtx = null, synthPrimed = false;

// Desbloquea y precalienta el subsistema de audio y síntesis de voz en iOS Safari al primer toque
function primeAudio(){
  try{
    if(!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if(audioCtx && audioCtx.state === 'suspended') audioCtx.resume().catch(()=>{});
  }catch(e){}
  if(!synthPrimed && synth){
    synthPrimed = true;
    try{
      const dummy = new SpeechSynthesisUtterance(' ');
      dummy.volume = 0.01;
      dummy.rate = 2;
      synth.speak(dummy);
    }catch(e){}
  }
}
['touchstart', 'mousedown', 'keydown'].forEach(evt => {
  document.addEventListener(evt, primeAudio, {once: true, passive: true});
});

// Se leen varias frases seguidas en un solo enunciado (hasta ~400 letras, mismo idioma): así la voz no
// se detiene ni reinicia la entonación en cada punto. La frase marcada avanza con los eventos de palabra.
function tramo(desde){
  const l = flat[desde].l, v = voiceBy[l] || voiceBy.es;
  const enNube = v && v.localService === false;                // voces en la nube: una frase por vez (se cortan)
  const fin = [desde];
  let letras = flat[desde].t.length;
  for(let j = desde + 1; j < flat.length && !enNube; j++){
    const f = flat[j];
    if(f.l !== l || f.h || isHeading(f.t) || letras + f.t.length > 400 || j - desde >= 8) break;
    fin.push(j); letras += f.t.length + 1;
  }
  return fin;
}
function speak(continuando = false){
  const my = ++token;
  const s = flat[idx];
  if(!s){ stop(); return; }
  showSentence(true); save();
  const indices = tramo(idx), inicios = [];
  let texto = '';
  for(const j of indices){ if(texto) texto += ' '; inicios.push(texto.length); texto += flat[j].t; }
  const u = new SpeechSynthesisUtterance(texto);
  const v = voiceBy[s.l] || voiceBy.es;
  if(v){ u.voice = v; u.lang = v.lang; } else u.lang = s.l === 'en' ? 'en-US' : 'es-ES';
  u.rate = rate;
  u.onstart = ()=>{ if(my === token){ lastStart = Date.now(); stalledSince = 0; } };
  u.onboundary = e=>{
    if(my !== token || !playing) return;
    lastStart = Date.now();
    let k = 0; while(k + 1 < inicios.length && inicios[k + 1] <= e.charIndex) k++;
    const i = indices[k];
    if(i !== idx){ idx = i; showSentence(true); save(); }
  };
  u.onend = ()=>{
    if(my !== token || !playing) return;
    const ult = indices[indices.length - 1];
    if(ult < flat.length - 1){ idx = ult + 1; speak(true); } else finished();
  };
  u.onerror = e=>{
    if(my !== token || !playing) return;
    if(e.error === 'interrupted' || e.error === 'canceled') return;
    if(e.error === 'not-allowed'){ stop(); showStatus('El teléfono bloqueó el audio. Toca el botón de reproducir otra vez.'); return; }
    const ult = indices[indices.length - 1];
    if(ult < flat.length - 1){ idx = ult + 1; speak(true); } else stop();
  };
  window._u = u;
  lastStart = Date.now();
  stalledSince = 0;
  if(synth.paused){ try{ synth.resume(); }catch(e){} }
  synth.speak(u);
}

// Watchdog no intrusivo: solo rescata la reproducción si se congela de verdad por varios segundos
setInterval(()=>{
  if(!playing || isAudioDoc() || !synth) return;
  if(synth.paused){ try{ synth.resume(); }catch(e){} }
  if(synth.speaking || synth.pending){ stalledSince = 0; return; }
  if(Date.now() - lastStart < 4000) return;
  if(!stalledSince){ stalledSince = Date.now(); return; }
  if(Date.now() - stalledSince > 5000 && document.visibilityState === 'visible'){
    stalledSince = 0;
    try{ synth.cancel(); }catch(e){}
    setTimeout(()=>{ if(playing) speak(); }, 50);
  }
}, 1000);

// Voces del sistema: fuera las voces "de broma" de Apple (cantan o suenan a efectos) y las Eloquence, muy robóticas.
const NOVEDAD = /^(Albert|Bad News|Bahh|Bells|Boing|Bubbles|Cellos|Deranged|Good News|Hysterical|Jester|Organ|Pipe Organ|Superstar|Trinoids|Whisper|Wobble|Zarvox|Fred|Junior|Kathy|Ralph|Eddy|Flo|Grandma|Grandpa|Reed|Rocko|Sandy|Shelley)\b/i;
const esNovedad = v => NOVEDAD.test(v.name) || /speech\.synthesis\.voice\.|eloquence/i.test(v.voiceURI || '');
const isGood = v => /premium|enhanced|mejorad|natural|neural|wavenet|studio/i.test(v.name + ' ' + v.voiceURI);
const PREFERIDAS = /^(Mónica|Monica|Paulina|Marisol|Jorge|Juan|Diego|Francisca|Samantha|Ava|Zoe|Evan|Allison|Susan|Nathan|Google)/i;
function score(v, lang){
  const nombre = v.name + ' ' + (v.voiceURI || '');
  let s = 0;
  if(v.lang.toLowerCase().startsWith(lang)) s += 100;
  // La calidad manda: las «Premium» y «Mejoradas» suenan naturales; las «compactas» son las robóticas.
  if(/premium/i.test(nombre)) s += 80;
  else if(/enhanced|mejorad|natural|neural|wavenet|studio/i.test(nombre)) s += 60;
  if(/compact/i.test(nombre)) s -= 30;
  if(PREFERIDAS.test(v.name)) s += 15;
  if(v.localService) s += 10;
  if(/network|online|cloud/i.test(nombre)) s -= 20;            // en la nube: tardan en partir y se cortan en frases largas
  if(v.default) s += 5;
  if(lang==='es'){ if(/es[-_]CL/i.test(v.lang)) s += 6; else if(/es[-_](MX|US|419)/i.test(v.lang)) s += 4; }
  if(lang==='en' && /en[-_]US/i.test(v.lang)) s += 4;
  return s;
}
function pickVoice(lang){
  const saved = store.get('voice:'+lang, null);
  const ok = voices.filter(v => !esNovedad(v));
  const hit = ok.find(v=>v.voiceURI===saved);
  if(hit) return hit;
  return ok.slice().sort((a,b)=>score(b,lang)-score(a,lang)).find(v=>v.lang.toLowerCase().startsWith(lang)) || null;
}
function loadVoices(){
  if(!synth) return;
  voices = synth.getVoices();
  voiceBy.es = pickVoice('es'); voiceBy.en = pickVoice('en');
  fillVoices(); updateVoiceBtn();
}
function fillVoices(){
  const all = $('#allLangs').checked;
  for(const lang of ['es','en']){
    const sel = $(lang==='es' ? '#voiceEs' : '#voiceEn'); sel.innerHTML = '';
    const list = voices.filter(v=> !esNovedad(v) && (all || v.lang.toLowerCase().startsWith(lang) || v===voiceBy[lang]))
      .sort((a,b)=>score(b,lang)-score(a,lang) || a.name.localeCompare(b.name));
    if(!list.length){ const o = document.createElement('option'); o.textContent = 'Voz del sistema'; sel.appendChild(o); }
    list.forEach(v=>{
      const o = document.createElement('option'); o.value = v.voiceURI;
      o.textContent = (isGood(v)?'★ ':'') + v.name + ' · ' + v.lang;
      if(v===voiceBy[lang]) o.selected = true;
      sel.appendChild(o);
    });
  }
  const missing = ['es','en'].filter(l=>!voices.some(v=>v.lang.toLowerCase().startsWith(l) && isGood(v)));
  $('#voiceNote').textContent = missing.length
    ? `Para que suenen mejor, descarga voces «Mejorada» o «Premium» en ${missing.map(l=>l==='es'?'español':'inglés').join(' y ')}: en iPhone, Ajustes › Accesibilidad › Contenido leído › Voces.` : '';
}
if(synth){ loadVoices(); synth.addEventListener ? synth.addEventListener('voiceschanged', loadVoices) : (synth.onvoiceschanged = loadVoices); }
for(const lang of ['es','en']){
  $(lang==='es' ? '#voiceEs' : '#voiceEn').onchange = e=>{
    const v = voices.find(v=>v.voiceURI===e.target.value);
    if(v){ voiceBy[lang] = v; store.set('voice:'+lang, v.voiceURI); }
    fillVoices(); updateVoiceBtn();
    if(playing && !isAudioDoc()) speak();
  };
}

/* ================= Motor 2: audios del Mac (.zip) ================= */
const audioZip = new Audio(); audioZip.preload = 'auto';
let zipUrl = null, lastTimeSave = 0;
async function ensureZipAudio(){
  if(!isAudioDoc() || zipUrl) return !!zipUrl;
  const blob = await kv.get('audio', doc.key);
  if(!blob){ showStatus('No encontré el audio de este libro en el teléfono. Vuelve a agregarlo.', 'err'); return false; }
  zipUrl = URL.createObjectURL(blob);
  audioZip.src = zipUrl; audioZip.playbackRate = rate;
  const saved = store.get('time:'+doc.key, null);
  const t0 = saved != null ? saved : (flat[idx] ? flat[idx].s : 0);
  const seek = ()=>{ try{ audioZip.currentTime = t0; }catch(e){} };
  if(audioZip.readyState >= 1) seek(); else audioZip.addEventListener('loadedmetadata', seek, {once:true});
  return true;
}
function sentenceAt(t){
  let lo = 0, hi = flat.length-1, ans = 0;
  while(lo <= hi){ const m = (lo+hi)>>1; if(flat[m].s <= t + 0.05){ ans = m; lo = m+1; } else hi = m-1; }
  return ans;
}
audioZip.addEventListener('timeupdate', ()=>{
  if(!isAudioDoc() || !flat.length) return;
  const i = sentenceAt(audioZip.currentTime);
  if(i !== idx){ idx = i; showSentence(true); }
  if(Date.now() - lastTimeSave > 4000){ lastTimeSave = Date.now(); save(); if(document.visibilityState==='visible') updateMeta(); }
});
audioZip.addEventListener('ended', ()=>{ playing = false; setPlayIcon(); store.set('time:'+doc.key, 0); finished(); });
audioZip.addEventListener('pause', ()=>{ if(isAudioDoc() && playing){ playing = false; setPlayIcon(); save(true); } });
audioZip.addEventListener('play', ()=>{ if(isAudioDoc() && !playing){ playing = true; setPlayIcon(); } });

/* ================= Reproducir / pausar ================= */
async function play(){
  if(!flat.length) return;
  hideStatus();
  if(isAudioDoc()){
    if(!(await ensureZipAudio())) return;
    playing = true; setPlayIcon();
    try{ await audioZip.play(); }catch(e){ playing = false; setPlayIcon(); showStatus('El teléfono no dejó reproducir. Toca el botón otra vez.'); }
    return;
  }
  if(!synth){ showStatus('Este navegador no puede leer en voz alta. Abre la app en Safari (iPhone) o Chrome (Android).', 'err'); return; }
  primeAudio();
  if(!voices.length || !voiceBy.es){
    voices = synth.getVoices();
    voiceBy.es = pickVoice('es'); voiceBy.en = pickVoice('en');
  }
  if(synth.paused){ try{ synth.resume(); }catch(e){} }
  playing = true; setPlayIcon(); holdScreen(true);
  speak();
}
function stop(){
  const was = playing;
  playing = false; token++;
  if(synth) synth.cancel();
  if(!audioZip.paused) audioZip.pause();
  holdScreen(false);
  if(was) save(true);
  if(doc) setPlayIcon();
}
function finished(){ stop(); showStatus('Terminaste de leer este libro.'); libUpdate(doc.key, {pct:100}); }
function jump(i){
  if(!flat.length) return;
  idx = Math.min(Math.max(0,i), flat.length-1);
  if(isAudioDoc()){
    if(zipUrl) audioZip.currentTime = flat[idx].s; else store.set('time:'+doc.key, flat[idx].s);
    showSentence(true, true); save(); return;
  }
  if(playing){
    if(synth){
      try{ synth.cancel(); }catch(e){}
      setTimeout(()=>{ if(playing) speak(); }, 30);
    } else speak();
  } else { showSentence(true, true); save(); }
}

/* ---------- Controles de la pantalla bloqueada ---------- */
function mediaMeta(){
  if(!('mediaSession' in navigator) || !doc) return;
  try{
    navigator.mediaSession.metadata = new MediaMetadata({title: doc.name, artist: 'LectorLibre', artwork:[{src:'icons/icon-512.png', sizes:'512x512', type:'image/png'}]});
  }catch(e){}
}
if('mediaSession' in navigator){
  const h = (a,f)=>{ try{ navigator.mediaSession.setActionHandler(a,f); }catch(e){} };
  h('play', ()=>play()); h('pause', ()=>stop());
  h('previoustrack', ()=>jump(idx-1)); h('nexttrack', ()=>jump(idx+1));
  h('seekbackward', ()=>{ if(isAudioDoc() && zipUrl) audioZip.currentTime = Math.max(0, audioZip.currentTime-15); else jump(idx-2); });
  h('seekforward', ()=>{ if(isAudioDoc() && zipUrl) audioZip.currentTime = Math.min(audioZip.duration||1e9, audioZip.currentTime+15); else jump(idx+2); });
}
document.addEventListener('visibilitychange',()=>{
  if(document.visibilityState==='visible'){ if(playing && !isAudioDoc()) holdScreen(true); if(doc && !$('#readView').hidden) showSentence(true); }
});

/* ---------- Pantalla negra ---------- */
let lastTap = 0;
$('#blackBtn').onclick = ()=>{ $('#blackout').hidden = false; updateMeta(); };
$('#blackout').addEventListener('click', ()=>{
  const now = Date.now();
  if(now - lastTap < 400){ $('#blackout').hidden = true; showSentence(true); }
  lastTap = now;
});

/* ================= Hoja de voz ================= */
function updateVoiceBtn(){
  let t = 'Voz';
  if(doc && isAudioDoc()) t = doc.voice || 'Audio';
  else if(voiceBy.es) t = voiceBy.es.name.replace(/\s*\(.*\)\s*/,'');
  $('#voiceBtn').textContent = t;
}
function openSheet(){
  const a = isAudioDoc();
  $('#engineBox').hidden = a; $('#audioNote').hidden = !a;
  $('#scrim').hidden = false; fillVoices();
}
function closeSheet(){ $('#scrim').hidden = true; }
$('#voiceBtn').onclick = openSheet;
$('#rateBtn').onclick = openSheet;
$('#closeSheet').onclick = closeSheet;
$('#scrim').addEventListener('click', e=>{ if(e.target.id==='scrim') closeSheet(); });
$('#allLangs').onchange = fillVoices;

function setRate(r){
  rate = Math.round(r*100)/100; store.set('rate', rate);
  const txt = rate.toFixed(rate*10%1 ? 2 : 1).replace('.',',') + '×';
  $('#rateBtn').textContent = txt; $('#rateVal').textContent = txt; $('#rate').value = rate;
  audioZip.playbackRate = rate;
  updateMeta();
}
$('#rate').oninput = e=> setRate(+e.target.value);
$('#rate').onchange = ()=>{ if(playing && !isAudioDoc()) speak(); };

// Probar la voz elegida
$('#test').onclick = ()=>{
  if(!synth) return;
  synth.cancel();
  [['es','Hola. Así suena la voz en español.'],['en','And this is the English voice.']].forEach(([l,t])=>{
    const u = new SpeechSynthesisUtterance(t); const v = voiceBy[l];
    if(v){ u.voice = v; u.lang = v.lang; } else u.lang = l==='en' ? 'en-US' : 'es-ES';
    u.rate = rate; synth.speak(u);
  });
};

/* ================= Agregar libros ================= */
function showStatus(msg, kind, frac){
  $('#statusText').textContent = msg; $('#status').className = 'status' + (kind ? ' '+kind : ''); $('#status').hidden = false;
  const pr = $('#statusProg'); pr.hidden = frac == null; if(frac != null) pr.firstChild.style.width = Math.round(frac*100) + '%';
}
function hideStatus(){ $('#status').hidden = true; }

/* ---------- OCR: reconocer el texto de páginas escaneadas y de fotos ---------- */
// Tesseract (vendor/tesseract) corre en el propio teléfono, sin internet. Español e inglés, modelos «fast».
let ocrP = null;
function motorOcr(){
  if(!ocrP) ocrP = (async ()=>{
    if(!window.Tesseract){
      await new Promise((res, rej)=>{ const sc = document.createElement('script'); sc.src = 'vendor/tesseract/tesseract.min.js'; sc.onload = res; sc.onerror = ()=>rej(new Error('No se pudo cargar el reconocedor de texto. Recarga la app.')); document.head.appendChild(sc); });
    }
    const base = new URL('vendor/tesseract/', location.href).href;
    return await Tesseract.createWorker(['spa', 'eng'], 1, {
      workerPath: base + 'worker.min.js', corePath: base, langPath: base + 'lang', gzip: true,
    });
  })();
  ocrP.catch(()=>{ ocrP = null; });
  return ocrP;
}
async function soltarOcr(){
  if(!ocrP) return;
  try{ (await ocrP).terminate(); }catch(e){}
  ocrP = null;
}
// Texto de una imagen (canvas o bitmap), en líneas.
async function ocrLineas(imagen){
  const w = await motorOcr();
  const {data} = await w.recognize(imagen);
  return (data.text || '').split('\n').map(l => l.replace(/\s+/g, ' ').trim()).filter(l => l && /[\p{L}\p{N}]{2}/u.test(l));
}
async function lienzoPagina(pdf, n, alto = 2200){
  const pg = await pdf.getPage(n);
  const v0 = pg.getViewport({scale: 1}), vp = pg.getViewport({scale: Math.min(4, alto / v0.height)});
  const c = document.createElement('canvas'); c.width = Math.ceil(vp.width); c.height = Math.ceil(vp.height);
  const ctx = c.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
  await pg.render({canvasContext: ctx, viewport: vp, intent: 'print'}).promise;
  pg.cleanup();
  return c;
}
function lienzoImagen(bmp, lado = 2400){
  const k = Math.min(1, lado / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas'); c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
  const ctx = c.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
  ctx.drawImage(bmp, 0, 0, c.width, c.height);
  return c;
}
// Aviso de avance con el tiempo que falta.
function avanceOcr(nombre, hechas, total, t0){
  const porPag = hechas ? (performance.now() - t0) / hechas / 1000 : 0;
  const falta = porPag ? Math.round(porPag * (total - hechas)) : 0;
  showStatus(`${nombre}: reconociendo el texto (OCR), página ${Math.min(hechas + 1, total)} de ${total}` +
    (falta > 20 ? ` · faltan ~${fmtTime(falta)}` : '') + '. Deja la app abierta.', null, hechas / total);
}

async function importPdf(file){
  if(!pdfjs) throw new Error('No se pudo cargar el lector de PDF. Recarga la página.');
  const data = new Uint8Array(await file.arrayBuffer());
  const pdf = await pdfjs.getDocument({data, isEvalSupported:false}).promise;
  const raw = [];
  for(let i=1;i<=pdf.numPages;i++){
    const pg = await pdf.getPage(i);
    raw.push(pageLines(await pg.getTextContent()));
    pg.cleanup();
    if(i%3===0 || i===pdf.numPages) showStatus(`${file.name}: sacando el texto, página ${i} de ${pdf.numPages}`, null, i/pdf.numPages);
  }
  // Páginas escaneadas (sin texto, o con apenas un número de página): se reconoce el texto con OCR.
  const escaneadas = raw.map((ls, i) => ls.join(' ').replace(/\s/g, '').length < 25 ? i : -1).filter(i => i >= 0);
  if(escaneadas.length){
    const t0 = performance.now();
    try{
      for(const [k, i] of escaneadas.entries()){
        avanceOcr(file.name, k, escaneadas.length, t0);
        raw[i] = await ocrLineas(await lienzoPagina(pdf, i + 1));
      }
    }finally{ await soltarOcr(); }
  }
  const pages = stripRepeats(raw).map(ls=>splitSentences(joinLines(ls)));
  if(!pages.some(p=>p.length)) throw new Error(`No encontré texto en «${file.name}», ni siquiera con OCR. Si es una foto, prueba con más luz y la hoja derecha.`);
  const key = file.name + '|' + file.size;
  const d = {key, name:file.name.replace(/\.pdf$/i,''), pages, ocr: escaneadas.length || undefined};
  const portada = await portadaPdf(pdf);
  if(portada){ await kv.put('portadas', key, portada); urlsPortada.delete(key); }
  await dbPut(d); addToLibrary(d);
  return d;
}
// Fotos de páginas (o sacadas con la cámara): todas las elegidas juntas forman un libro, una página por foto.
async function importFotos(fotos){
  const raw = [], t0 = performance.now();
  let portada = null;
  try{
    for(const [k, f] of fotos.entries()){
      avanceOcr(fotos.length === 1 ? f.name : 'Fotos', k, fotos.length, t0);
      let bmp;
      try{ bmp = await createImageBitmap(f); }
      catch(e){ throw new Error(`No pude abrir la foto «${f.name}».`); }
      if(!portada) portada = await miniatura(bmp);
      raw.push(await ocrLineas(lienzoImagen(bmp)));
      bmp.close && bmp.close();
    }
  }finally{ await soltarOcr(); }
  const pages = stripRepeats(raw).map(ls => splitSentences(joinLines(ls)));
  if(!pages.some(p => p.length)) throw new Error('No encontré texto en las fotos. Prueba con más luz, la hoja derecha y sin sombras.');
  const primera = fotos[0].name.replace(/\.[^.]+$/, '');
  const fecha = new Date().toLocaleDateString('es-CL', {day: 'numeric', month: 'long'});
  const nombre = fotos.length === 1 && !/^(IMG|image|foto|photo)[_ -]?\d*/i.test(primera) ? primera : `Fotos del ${fecha}`;
  const key = 'fotos|' + fotos.map(f => f.name + f.size).join(',').slice(0, 200) + '|' + Date.now();
  const d = {key, kind: 'fotos', name: nombre, pages, ocr: fotos.length};
  if(portada){ await kv.put('portadas', key, portada); urlsPortada.delete(key); }
  await dbPut(d); addToLibrary(d);
  return d;
}

async function readZipEntries(file){
  const tailLen = Math.min(file.size, 65557);
  const tail = new DataView(await file.slice(file.size - tailLen).arrayBuffer());
  let e = -1;
  for(let i = tailLen - 22; i >= 0; i--){ if(tail.getUint32(i,true) === 0x06054b50){ e = i; break; } }
  if(e < 0) throw new Error('no es un zip');
  const count = tail.getUint16(e+10,true), cdSize = tail.getUint32(e+12,true), cdOff = tail.getUint32(e+16,true);
  const cd = new DataView(await file.slice(cdOff, cdOff+cdSize).arrayBuffer());
  const out = {}; let o = 0;
  for(let k=0;k<count;k++){
    const method = cd.getUint16(o+10,true), size = cd.getUint32(o+20,true);
    const nl = cd.getUint16(o+28,true), xl = cd.getUint16(o+30,true), cl = cd.getUint16(o+32,true), lho = cd.getUint32(o+42,true);
    const name = new TextDecoder().decode(new Uint8Array(cd.buffer, o+46, nl));
    const ent = {method, size, lho, file, get blob(){ return datosZip(this); }};
    out[name] = ent;
    if(name.startsWith('/')) out[name.slice(1)] = ent;
    o += 46 + nl + xl + cl;
  }
  return out;
}
// Los datos de una entrada del zip (sin descomprimir). Se lee la cabecera local recién cuando se necesita.
function datosZip(ent){
  const lector = {
    async start(){
      const lh = new DataView(await ent.file.slice(ent.lho, ent.lho + 30).arrayBuffer());
      return ent.lho + 30 + lh.getUint16(26,true) + lh.getUint16(28,true);
    },
  };
  return {
    async arrayBuffer(){ const st = await lector.start(); return ent.file.slice(st, st + ent.size).arrayBuffer(); },
    async text(){ return new TextDecoder().decode(await this.arrayBuffer()); },
    async slice(){ const st = await lector.start(); return ent.file.slice(st, st + ent.size); },
  };
}
// Contenido de una entrada, descomprimiendo si hace falta.
async function leerZip(ent){
  const crudo = await ent.blob.slice();
  if(ent.method === 0) return crudo.arrayBuffer();
  if(ent.method === 8){
    if(typeof DecompressionStream === 'undefined') throw new Error('Este navegador no puede descomprimir el archivo. Actualiza el sistema del teléfono.');
    return new Response(crudo.stream().pipeThrough(new DecompressionStream('deflate-raw'))).arrayBuffer();
  }
  throw new Error('El archivo usa una compresión que LectorLibre no conoce.');
}

async function importZip(file){
  const z = await readZipEntries(file);
  const j = z['lectora.json'] || z['/lectora.json'], a = z['audio.m4a'] || z['/audio.m4a'];
  if(!j || !a) throw new Error(`«${file.name}» no viene del Estudio Lectora.`);
  const metaTxt = j.method === 0 ? await j.blob.text() : new TextDecoder().decode(await leerZip(j));
  const meta = JSON.parse(metaTxt);
  const key = 'audio|' + file.name + '|' + file.size;
  showStatus(`${file.name}: guardando el audio…`);
  const audioData = a.method === 0 ? await a.blob.slice() : await leerZip(a);
  const blob = new Blob([audioData], {type:'audio/mp4'});
  if(!(await kv.put('audio', key, blob) !== null)) throw new Error('No hay espacio para guardar el audio en el teléfono.');
  const d = {key, kind:'audio', name:meta.name, voice:meta.voice, duration:meta.duration, pages:meta.pages};
  await dbPut(d); addToLibrary(d);
  return d;
}
$('#file').addEventListener('change', async e=>{
  const files = [...e.target.files]; e.target.value = '';
  if(!files.length) return;
  const ok = [], malos = [];
  const esFoto = f => /^image\//.test(f.type) || /\.(jpe?g|png|heic|heif|webp|gif|bmp|tiff?)$/i.test(f.name);
  const fotos = files.filter(esFoto);
  if(fotos.length){
    try{ ok.push(await importFotos(fotos)); }catch(err){ malos.push(err.message || String(err)); }
  }
  for(const f of files.filter(f => !esFoto(f))){
    try{
      showStatus(`Agregando ${f.name}…`);
      ok.push(/\.epub$/i.test(f.name) || /epub/.test(f.type) ? await importEpub(f)
            : /\.zip$/i.test(f.name) || /zip/.test(f.type) ? await importZip(f) : await importPdf(f));
    }catch(err){ malos.push(err.message || String(err)); }
  }
  renderLibrary();
  if(malos.length) showStatus(malos.join(' '), 'err');
  else showStatus(ok.length === 1 ? `Agregado «${ok[0].name}».` : `Agregados ${ok.length} libros.`);
  setTimeout(()=>{ if(!malos.length) hideStatus(); }, 4000);
});

/* ---------- EPUB ---------- */
const BLOQUES = new Set('p h1 h2 h3 h4 h5 h6 li blockquote div section article aside dd dt pre td th figcaption caption header footer tr table ul ol dl figure hr main body'.split(' '));
const SEL_BLOQUES = [...BLOQUES].join(',');
const limpio = t => t.replace(/\s+/g, ' ').trim();
// textContent, pero un <br> cuenta como espacio (si no, «salto<br>de» se lee «saltode»)
function textoDe(n){
  if(n.nodeType === 3) return n.textContent;
  if(n.nodeType !== 1) return '';
  if((n.localName || '').toLowerCase() === 'br') return ' ';
  let t = ''; for(const c of n.childNodes) t += textoDe(c); return t;
}
// Texto de un capítulo en bloques: {t, h} (h = título).
function bloquesDe(html){
  let d = new DOMParser().parseFromString(html, 'application/xhtml+xml');
  if(d.getElementsByTagName('parsererror').length) d = new DOMParser().parseFromString(html, 'text/html');
  const body = d.body || d.getElementsByTagName('body')[0];
  if(!body) return [];
  for(const e of [...body.querySelectorAll('script,style,nav')]) e.remove();
  // llamadas a notas al pie (¹, [2], *): no se leen
  for(const e of [...body.querySelectorAll('sup')]) if(/^[\s\[\(]*[\divx*†‡]+[\]\)\s]*$/i.test(e.textContent)) e.remove();
  const out = [];
  (function recorrer(el){
    let suelto = '';
    const soltar = ()=>{ const t = limpio(suelto); if(t) out.push({t}); suelto = ''; };
    for(const n of el.childNodes){
      if(n.nodeType === 3){ suelto += n.textContent; continue; }
      if(n.nodeType !== 1) continue;
      const tag = (n.localName || '').toLowerCase();
      if(tag === 'br'){ suelto += ' '; continue; }
      if(!BLOQUES.has(tag)){ suelto += textoDe(n); continue; }
      soltar();
      if(/^h[1-6]$/.test(tag)){ const t = limpio(textoDe(n)); if(t) out.push({t, h:true}); }
      else if(n.querySelector(SEL_BLOQUES)) recorrer(n);
      else { const t = limpio(textoDe(n)); if(t) out.push({t}); }
    }
    soltar();
  })(body);
  return out;
}
function rutaEpub(base, href){
  const partes = (base + href.split('#')[0]).split('/'), out = [];
  for(const p of partes){ if(p === '..') out.pop(); else if(p && p !== '.') out.push(p); }
  return out.join('/');
}
async function importEpub(file){
  const z = await readZipEntries(file);
  const texto = async ruta => {
    const ent = z[ruta] || z[decodeURIComponent(ruta)];
    return ent ? new TextDecoder().decode(await leerZip(ent)) : null;
  };
  const xml = t => new DOMParser().parseFromString(t, 'application/xml');
  // Con DRM, los capítulos vienen cifrados (encryption.xml también se usa solo para tipografías: eso no importa).
  const cifrado = await texto('META-INF/encryption.xml');
  if(cifrado && /CipherReference[^>]*URI="[^"]+\.(x?html?|xml)"/i.test(cifrado))
    throw new Error(`«${file.name}» tiene protección anticopia (DRM) y no se puede leer fuera de la aplicación donde se compró.`);
  const cont = await texto('META-INF/container.xml');
  if(!cont) throw new Error(`«${file.name}» no parece un EPUB válido.`);
  const opfRuta = xml(cont).getElementsByTagName('rootfile')[0]?.getAttribute('full-path');
  const opfTxt = opfRuta && await texto(opfRuta);
  if(!opfTxt) throw new Error(`«${file.name}» no parece un EPUB válido.`);
  const opf = xml(opfTxt);
  const base = opfRuta.includes('/') ? opfRuta.slice(0, opfRuta.lastIndexOf('/') + 1) : '';
  const man = {};
  for(const it of opf.getElementsByTagName('item')) man[it.getAttribute('id')] = {href: it.getAttribute('href'), tipo: it.getAttribute('media-type') || '', props: it.getAttribute('properties') || ''};
  const orden = [...opf.getElementsByTagName('itemref')].filter(r => r.getAttribute('linear') !== 'no')
    .map(r => man[r.getAttribute('idref')]).filter(x => x && /html/.test(x.tipo) && !/\bnav\b/.test(x.props));
  const titulo = limpio(opf.getElementsByTagName('dc:title')[0]?.textContent || opf.getElementsByTagNameNS('*', 'title')[0]?.textContent || '');

  // Un EPUB no tiene páginas: se arma una "página" cada ~2.500 letras, y cada capítulo empieza en página nueva.
  const pages = []; let pag = [], letras = 0;
  const cerrar = ()=>{ if(pag.length) pages.push(pag); pag = []; letras = 0; };
  for(const [n, it] of orden.entries()){
    showStatus(`${file.name}: leyendo el capítulo ${n + 1} de ${orden.length}`, null, (n + 1) / orden.length);
    const html = await texto(rutaEpub(base, it.href));
    if(!html) continue;
    cerrar();
    for(const b of bloquesDe(html)){
      if(b.h){ if(letras > 600) cerrar(); pag.push({t:b.t, h:true}); letras += b.t.length; continue; }
      splitSentences(b.t).forEach((t, k) => { pag.push(k === 0 ? {t, np:true} : t); letras += t.length; });
      if(letras >= 2500) cerrar();
    }
  }
  cerrar();
  if(!pages.length) throw new Error(`«${file.name}» no tiene texto que leer.`);
  const key = file.name + '|' + file.size;
  const d = {key, kind:'epub', name: titulo || file.name.replace(/\.epub$/i,''), pages};
  try{
    const items = Object.values(man);
    const idMeta = [...opf.getElementsByTagName('meta')].find(m => m.getAttribute('name') === 'cover')?.getAttribute('content');
    let img = items.find(x => /cover-image/.test(x.props))
      || (idMeta && man[idMeta] && /^image\//.test(man[idMeta].tipo) ? man[idMeta] : null)
      || items.find(x => /^image\//.test(x.tipo) && /cover|portada/i.test(x.href));
    let ruta = img && rutaEpub(base, img.href), tipo = img && img.tipo;
    if(!img && orden[0]){
      // sin portada declarada: la primera imagen del primer capítulo
      const html = await texto(rutaEpub(base, orden[0].href)) || '';
      const src = (html.match(/<img[^>]+src="([^"]+)"/i) || html.match(/<image[^>]+href="([^"]+)"/i) || [])[1];
      const dir = rutaEpub(base, orden[0].href).replace(/[^/]*$/, '');
      if(src){ ruta = rutaEpub(dir, src); tipo = /\.png$/i.test(src) ? 'image/png' : 'image/jpeg'; }
    }
    const ent = ruta && (z[ruta] || z[decodeURIComponent(ruta)]);
    const portada = ent && await portadaImagen(await leerZip(ent), tipo);
    if(portada){ await kv.put('portadas', key, portada); urlsPortada.delete(key); }
  }catch(e){ /* sin portada: se muestra la inicial */ }
  await dbPut(d); addToLibrary(d);
  return d;
}

/* ---------- Controles del lector ---------- */
$('#backBtn').onclick = showLibrary;
$('#play').onclick = ()=> playing ? stop() : play();
$('#prev').onclick = ()=> jump(idx-1);
$('#next').onclick = ()=> jump(idx+1);
$('#page').addEventListener('click', e=>{ const s = e.target.closest('.s'); if(s) jump(+s.dataset.i); });
function goPage(p){
  if(!doc) return;
  p = Math.min(Math.max(0,p), doc.pages.length-1);
  const next = p+1 < pageStarts.length ? pageStarts[p+1] : flat.length;
  if(pageStarts[p] < next) jump(pageStarts[p]); else renderPage(p);
  window.scrollTo({top:0});
}
$('#prevPage').onclick = ()=> goPage(shownPage-1);
$('#nextPage').onclick = ()=> goPage(shownPage+1);
$('#pageInput').addEventListener('change', e=> goPage((+e.target.value||1)-1));

/* ---------- Instalar en la pantalla de inicio ---------- */
const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
let installEvt = null;
function showInstall(){
  if(standalone || store.get('installDone', false)) return;
  const ios = /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform==='MacIntel' && navigator.maxTouchPoints>1);
  $('#installText').textContent = installEvt ? 'Instala LectorLibre para abrirla desde la pantalla de inicio, como cualquier app.'
    : ios ? 'Para tenerla como app: toca Compartir (el cuadrado con la flecha) y luego «Agregar a inicio».'
          : 'Para tenerla como app: abre el menú ⋮ del navegador y toca «Instalar app» o «Agregar a pantalla principal».';
  $('#installBtn').hidden = !installEvt; $('#install').hidden = false;
}
window.addEventListener('beforeinstallprompt', e=>{ e.preventDefault(); installEvt = e; showInstall(); });
window.addEventListener('appinstalled', ()=>{ store.set('installDone', true); $('#install').hidden = true; });
$('#installBtn').onclick = async ()=>{ if(!installEvt) return; installEvt.prompt(); await installEvt.userChoice; installEvt = null; $('#install').hidden = true; };
$('#installClose').onclick = ()=>{ store.set('installDone', true); $('#install').hidden = true; };
showInstall();

/* ---------- Inicio ---------- */
// La biblioteca antigua (versiones anteriores) guardaba máximo 20 libros sin fecha: se conservan tal cual.
setRate(rate); limpiarVocesAntiguas();
(async ()=>{
  const last = store.get('last', null);
  if(store.get('view') === 'read' && last){
    const d = last === SAMPLE.key ? SAMPLE : await dbGet(last);
    if(d){ setDoc(d, store.get('pos:'+d.key, 0)); showReader(); return; }
  }
  showLibrary();
})();
window.lectora = {estado: () => ({idx, playing})};

// La voz natural y «Mi voz» se quitaron (2026-09-28): se libera lo que habían descargado y generado
// (unos 400 MB de modelos, las frases ya generadas y la grabación), una sola vez.
async function limpiarVocesAntiguas(){
  if(store.get('vocesLimpias', false)) return;
  try{ await caches.delete('lectora-modelos-v1'); }catch(e){}
  await Promise.all([tx('pistas','readwrite', s=>s.clear()), tx('voz','readwrite', s=>s.clear())]);
  for(const k of ['engine','vozSE','vozHash','vozBase','nat:es','nat:en','sinGPU','avisoLento','baseGender']) store.del(k);
  store.set('vocesLimpias', true);
}
