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

const SAMPLE = {key:'ejemplo', name:'Cómo usar la Lectora', sample:true, pages:[
  ['CÓMO USAR LA LECTORA',
   'Esta es una página de ejemplo para que escuches cómo funciona.',
   'Toca Agregar, elige uno o varios PDF o EPUB de tu teléfono y quedarán guardados en tu biblioteca.',
   'Luego toca el botón grande de reproducir.',
   'La frase que se está leyendo queda marcada, y las páginas avanzan solas.',
   'Si quieres saltar a otra parte, toca cualquier frase y la lectura seguirá desde ahí.'],
  ['TRES TIPOS DE VOZ',
   'En el botón Voz eliges cómo suena la lectura.',
   'La voz del teléfono gasta poco, pero suena más robótica.',
   'La voz natural la genera el propio teléfono, sin internet ni límites.',
   'Y en Mi voz grabas veinticinco segundos leyendo un texto, y la Lectora le pone tu timbre a la voz natural.'],
  ['ENGLISH TOO',
   'The Lectora also reads English, and it picks the right voice for every sentence.',
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
      const r = indexedDB.open('lectora',3);
      r.onupgradeneeded = ()=>{
        const db = r.result;
        for(const [n, o] of [['docs',{keyPath:'key'}],['audio',undefined],['pistas',undefined],['voz',undefined]])
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
let engine = store.get('engine', 'sistema');           // sistema | natural | mivoz
const isAudioDoc = () => doc && doc.kind === 'audio';
const neural = () => !isAudioDoc() && (engine === 'natural' || engine === 'mivoz');

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
    const b = document.createElement('button'); b.className = 'book-open';
    const t = document.createElement('span'); t.className = 'book-title'; t.textContent = it.name;
    const m = document.createElement('span'); m.className = 'book-meta';
    const pct = it.pct || 0;
    m.textContent = it.sample ? 'Ejemplo · 3 páginas'
      : `${it.pages} ${it.pages===1?'página':'páginas'}` + (pct ? ` · ${pct}% leído` : ' · sin empezar') + (it.opened ? ` · ${fmtFecha(it.opened)}` : '');
    if(it.audio || it.epub){ const g = document.createElement('span'); g.className = 'tag'; g.textContent = it.epub ? 'EPUB' : (it.voice || 'audio'); m.appendChild(g); }
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
  await Promise.all([tx('docs','readwrite', s=>s.delete(key)), kv.del('audio', key), kv.delPrefix('pistas', key + '|')]);
}
function addToLibrary(d){
  const l = lib().filter(x=>x.key!==d.key);
  l.push({key:d.key, name:d.name, pages:d.pages.length, page:1, pct:0, audio:d.kind==='audio', epub:d.kind==='epub', voice:d.voice, added:Date.now()});
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
  N.reset();
  $('#blackBtn').hidden = isAudioDoc();
  updateVoiceBtn();
  renderPage(flat.length ? flat[idx].p : 0);
  updateMeta(); mediaMeta();
  if(neural()) precalentarInmediato(); else precalentar();
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
function setWaiting(on){ $('#play').classList.toggle('wait', !!on); }
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

function speak(continuando = false){
  const my = ++token;
  const s = flat[idx];
  if(!s){ stop(); return; }
  showSentence(true); save();
  const u = new SpeechSynthesisUtterance(s.t);
  const v = voiceBy[s.l] || voiceBy.es;
  if(v){ u.voice = v; u.lang = v.lang; } else u.lang = s.l === 'en' ? 'en-US' : 'es-ES';
  u.rate = rate;
  u.onstart = ()=>{
    if(my === token){
      lastStart = Date.now();
      stalledSince = 0;
    }
  };
  u.onend = ()=>{
    if(my !== token || !playing) return;
    if(idx < flat.length - 1){ idx++; speak(true); } else finished();
  };
  u.onerror = e=>{
    if(my !== token || !playing) return;
    if(e.error === 'interrupted' || e.error === 'canceled') return;
    if(e.error === 'not-allowed'){ stop(); showStatus('El teléfono bloqueó el audio. Toca el botón de reproducir otra vez.'); return; }
    if(idx < flat.length - 1){ idx++; speak(true); } else stop();
  };
  window._u = u;
  lastStart = Date.now();
  stalledSince = 0;
  if(synth.paused){ try{ synth.resume(); }catch(e){} }
  synth.speak(u);
}

// Watchdog no intrusivo: solo rescata la reproducción si se congela de verdad por varios segundos
setInterval(()=>{
  if(!playing || isAudioDoc() || neural() || !synth) return;
  if(synth.paused){ try{ synth.resume(); }catch(e){} }
  if(synth.speaking || synth.pending){ stalledSince = 0; return; }
  if(Date.now() - lastStart < 4000) return;
  if(!stalledSince){ stalledSince = Date.now(); return; }
  if(Date.now() - stalledSince > 5000 && document.visibilityState === 'visible'){
    stalledSince = 0;
    try{ synth.cancel(); }catch(e){}
    setTimeout(()=>{ if(playing && !neural()) speak(); }, 50);
  }
}, 1000);

// Voces del sistema: fuera las voces "de broma" de Apple (cantan o suenan a efectos) y las Eloquence, muy robóticas.
const NOVEDAD = /^(Albert|Bad News|Bahh|Bells|Boing|Bubbles|Cellos|Deranged|Good News|Hysterical|Jester|Organ|Pipe Organ|Superstar|Trinoids|Whisper|Wobble|Zarvox|Fred|Junior|Kathy|Ralph|Eddy|Flo|Grandma|Grandpa|Reed|Rocko|Sandy|Shelley)\b/i;
const esNovedad = v => NOVEDAD.test(v.name) || /speech\.synthesis\.voice\.|eloquence/i.test(v.voiceURI || '');
const isGood = v => /premium|enhanced|mejorad|natural|neural|wavenet|studio/i.test(v.name + ' ' + v.voiceURI);
const PREFERIDAS = /^(Mónica|Monica|Paulina|Marisol|Jorge|Juan|Diego|Francisca|Samantha|Ava|Zoe|Evan|Allison|Susan|Nathan|Google)/i;
function score(v, lang){
  let s = 0;
  if(v.lang.toLowerCase().startsWith(lang)) s += 100;
  if(v.default) s += 60;                                       // La voz activa del sistema en iOS/Android arranca sin demora
  if(/compact/i.test(v.voiceURI)) s += 45;                     // Voces compactas locales: inicio instantáneo (0 ms)
  if(v.localService) s += 40;                                  // Local en el dispositivo
  if(PREFERIDAS.test(v.name)) s += 25;
  if(lang==='es'){ if(/es[-_]CL/i.test(v.lang)) s += 6; else if(/es[-_](MX|US|419)/i.test(v.lang)) s += 4; }
  if(lang==='en' && /en[-_]US/i.test(v.lang)) s += 4;
  if(/enhanced|mejorad/i.test(v.name + ' ' + v.voiceURI)) s += 5; // Mejoradas disponibles, pero no prioritarias sobre la instantánea
  if(/network|online|cloud|siri/i.test(v.name + ' ' + v.voiceURI)) s -= 50; // Evita voces en la nube que demoran varios segundos
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
    if(playing && engine==='sistema') speak();
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

/* ================= Motor 3: voz natural y tu voz, generadas en el teléfono ================= */
const audioClip = new Audio(); audioClip.preload = 'auto';
const PAUSA = 0.28, PAUSA_PAG = 0.7, ADELANTE = 6;
const NAT = {es: store.get('nat:es', 'ef_dora'), en: store.get('nat:en', 'af_heart')};
const N = {
  M: null, listos: new Map(), enDisco: new Set(), enCurso: new Set(), esperas: new Map(),
  genTok: 0, playTok: 0, prep: false, precalentando: false, base: null, tgt: null, clipUrl: null, velocidadReal: null,
  reset(){ this.genTok++; this.playTok++; this.listos.clear(); this.enDisco.clear(); this.enCurso.clear(); this.prep = false; this.precalentando = false; this.primera = null; this.rapido = false; this.esperas.forEach(ws=>ws.forEach(w=>w(null))); this.esperas.clear(); this.discoCargado = null; this.discoP = null; },
};
function firma(){
  return engine === 'mivoz' ? 'mv' + (store.get('vozHash','') || '') : 'nat-' + NAT.es + '-' + NAT.en;
}
const clave = i => `${doc.key}|${firma()}|${i}`;

// µ-law: guarda la voz generada en 1 byte por muestra (unos 86 MB por hora)
const MU = 255;
function aMu(a){ const o = new Uint8Array(a.length); for(let i=0;i<a.length;i++){ const x = Math.max(-1, Math.min(1, a[i])); const y = Math.sign(x) * Math.log1p(MU*Math.abs(x)) / Math.log1p(MU); o[i] = Math.round((y + 1) * 127.5); } return o; }
const DE_MU = (()=>{ const t = new Float32Array(256); for(let i=0;i<256;i++){ const y = i/127.5 - 1; t[i] = Math.sign(y) * (Math.pow(1+MU, Math.abs(y)) - 1) / MU; } return t; })();
function deMu(u){ const o = new Float32Array(u.length); for(let i=0;i<u.length;i++) o[i] = DE_MU[u[i]]; return o; }

function progreso(msg, n, t){
  if(t > 1000) showStatus(`${msg}: ${Math.round(n/1e6)} de ${Math.round(t/1e6)} MB. Solo pasa la primera vez; usa Wi-Fi.`, null, n/t);
  else if(playing || N.prep) showStatus(msg + '…', null, null);
}
// ¿Hay tarjeta gráfica para la web? (iOS 18 y anteriores: no). «lectora:sinGPU» la desactiva para probar.
async function hayGPU(){
  if(store.get('sinGPU', false)) return false;
  try{ return !!(navigator.gpu && await navigator.gpu.requestAdapter()); }catch(e){ return false; }
}
let neuralP = null, neuralEngine = null;
function cargarNeural(){
  if(neuralP && neuralEngine === engine) return neuralP;
  neuralEngine = engine;
  neuralP = (async ()=>{
    if(!N.M) N.M = await import('./voz/motor.js');
    if(!N.configurado){
      N.configurado = true;
      let gpu = false;
      gpu = await hayGPU();
      N.M.configurar({gpu});
    }
    await N.M.prepararVoz(progreso);
    if(engine === 'natural') await N.M.vozEnParalelo();
    if(engine === 'mivoz' && store.get('vozSE')){
      N.M.vozEnParalelo(true).catch(()=>{});   // sin GPU: otro proceso más para la voz natural, sin esperarlo
      await N.M.prepararConversor(progreso);
      await prepararMiVoz();
    }
    hideStatus();
  })();
  neuralP.catch(()=>{ neuralP = null; });
  return neuralP;
}
async function prepararMiVoz(){
  const h = store.get('vozSE', null);
  if(!h) throw new Error('Primero graba tu voz en el botón Voz › Mi voz.');
  N.tgt = Float32Array.from(h);
  const guardada = store.get('vozBase', null);
  if(guardada && guardada.hash === store.get('vozHash')){
    N.base = {es:{id:guardada.es.id, se:Float32Array.from(guardada.es.se)}, en:{id:guardada.en.id, se:Float32Array.from(guardada.en.se)}};
    return;
  }
  // Elige la voz natural cuyo timbre se parece más al tuyo: la conversión queda más limpia.
  // Las huellas de las voces naturales vienen calculadas de antemano (voz/huellas-base.json), así que esto
  // es solo comparar números: antes generaba frases de prueba con cada voz y tardaba medio minuto sin GPU.
  const huellas = await huellasBase();
  const base = {};
  for(const lang of ['es','en']){
    let mejor = null;
    for(const v of VOCES_BASE[lang]){
      const se = Float32Array.from(huellas[v]);
      const sim = N.M.parecido(se, N.tgt);
      if(!mejor || sim > mejor.sim) mejor = {id:v, se, sim};
    }
    base[lang] = mejor;
  }
  N.base = base;
  store.set('vozBase', {hash:store.get('vozHash'), es:{id:base.es.id, se:Array.from(base.es.se)}, en:{id:base.en.id, se:Array.from(base.en.se)}});
}
const VOCES_BASE = {es: ['ef_dora', 'em_alex'], en: ['af_heart', 'af_bella', 'am_michael', 'am_fenrir']};
let huellasP = null;
function huellasBase(){
  if(!huellasP) huellasP = fetch('voz/huellas-base.json').then(r => { if(!r.ok) throw new Error('No pude cargar las voces base.'); return r.json(); });
  huellasP.catch(()=>{ huellasP = null; });
  return huellasP;
}

// Qué frases de este libro (con esta voz) ya están generadas y guardadas.
function cargarDisco(){
  const pref = `${doc.key}|${firma()}|`;
  if(N.discoCargado === pref && N.discoP) return N.discoP;
  N.discoCargado = pref;
  N.discoP = (async ()=>{
    const ks = await kv.keys('pistas', pref) || [];
    if(N.discoCargado === pref) ks.forEach(k => N.enDisco.add(+k.slice(pref.length)));
  })();
  return N.discoP;
}
function siguienteFaltante(){
  const falta = j => !N.listos.has(j) && !N.enDisco.has(j) && !N.enCurso.has(j);
  // primero lo que viene justo después de la frase actual
  const precal = !playing && !N.prep && N.precalentando;
  const fin = Math.min(flat.length, idx + (precal ? 2 : ADELANTE + 1));
  for(let j = idx; j < fin; j++) if(falta(j)) return j;
  if(N.prep){   // preparando: el resto del libro, y luego lo que quedó antes de la frase actual
    for(let j = fin; j < flat.length; j++) if(falta(j)) return j;
    for(let j = 0; j < idx; j++) if(falta(j)) return j;
  }
  return -1;
}
function entregar(i, a){
  N.listos.set(i, a);
  for(const k of N.listos.keys()) if(k < idx - 2 || k > idx + ADELANTE + 4) N.listos.delete(k);   // poca memoria
  const ws = N.esperas.get(i); if(ws){ N.esperas.delete(i); ws.forEach(w=>w(a)); }
}
async function generador(){
  const my = ++N.genTok;
  let convCola = Promise.resolve(), pendientes = 0;
  const trabajos = new Set();
  try{
    await cargarNeural();
    await cargarDisco();
    const paralelo = await N.M.paralelo();
    while(my === N.genTok && ((playing && neural()) || N.prep || N.precalentando)){
      // mientras arranca la primera frase, no competir con ella por el procesador
      if(N.rapido){ await new Promise(r=>setTimeout(r, 100)); continue; }
      const i = siguienteFaltante();
      if(i < 0){
        if(N.prep && !flat.some((_, j) => !N.enDisco.has(j))){ terminarPrep(); break; }
        if(!playing && !N.prep){
          N.precalentando = false;
          break;
        }
        await new Promise(r=>setTimeout(r, 400)); continue;
      }
      N.enCurso.add(i);
      const s = flat[i];
      const t0 = performance.now();
      const vozId = engine === 'mivoz' ? N.base[s.l].id : NAT[s.l];
      const terminar = async (a)=>{
        // ritmo real: tiempo desde que terminó la frase anterior (las etapas trabajan en paralelo)
        const ahora = performance.now(), el = (ahora - Math.max(t0, N.ultimoFin || 0)) / 1000; N.ultimoFin = ahora;
        N.medidas = (N.medidas || []).concat((a.length / N.M.SR) / Math.max(0.05, el)).slice(-6);
        // la primera frase incluye preparar el motor: se juzga la velocidad desde la tercera
        if(N.medidas.length >= 4) N.velocidadReal = N.medidas.slice(-4).reduce((x, y) => x + y) / 4;
        const u8 = aMu(a);
        await kv.put('pistas', clave(i), u8);
        N.enDisco.add(i); N.enCurso.delete(i);
        entregar(i, a);
        if(N.prep) actualizarPrep();
      };
      if(paralelo > 1){
        // sin tarjeta gráfica: cada proceso genera una frase distinta al mismo tiempo
        const job = (async ()=>{
          let a = N.M.recortar(await N.M.hablar(s.t, s.l, vozId, 1));
          if(my !== N.genTok){ N.enCurso.delete(i); return; }
          if(engine === 'mivoz') a = await N.M.convertir(a, N.base[s.l].se, N.tgt);
          if(my !== N.genTok){ N.enCurso.delete(i); return; }
          await terminar(a);
        })().catch(e => { N.enCurso.delete(i); throw e; });
        trabajos.add(job); job.finally(()=>trabajos.delete(job)).catch(()=>{});
        if(trabajos.size >= paralelo) await Promise.race(trabajos);
        continue;
      }
      const crudo = N.M.recortar(await N.M.hablar(s.t, s.l, vozId, 1));
      if(my !== N.genTok){ N.enCurso.delete(i); break; }
      if(engine === 'mivoz'){
        // La voz natural (tarjeta gráfica) sigue con la frase siguiente mientras el procesador pone tu timbre.
        pendientes++;
        convCola = convCola.then(async ()=>{
          if(my !== N.genTok){ N.enCurso.delete(i); return; }
          const a = await N.M.convertir(crudo, N.base[s.l].se, N.tgt);
          await terminar(a);
        }).finally(()=>{ pendientes--; });
        if(pendientes >= 2) await convCola;
      } else await terminar(crudo);
    }
    await convCola;
    await Promise.all(trabajos);
  }catch(e){
    N.enCurso.clear();
    if(my === N.genTok){ stop(); showStatus(e.message || String(e), 'err'); }
  }
}
// Arranca la generación si no hay otra andando (una sola a la vez).
function asegurarGenerador(){
  if(N.vivo) return;
  N.vivo = true;
  generador().finally(()=>{ N.vivo = false; if((playing && neural()) || N.prep || N.precalentando) setTimeout(asegurarGenerador, 50); });
}
async function clipDe(i){
  if(N.listos.has(i)) return N.listos.get(i);
  await cargarDisco();
  const u8 = N.enDisco.has(i) ? await kv.get('pistas', clave(i)) : null;
  if(u8){ const a = deMu(u8); N.listos.set(i, a); return a; }
  asegurarGenerador();
  return await new Promise(res=>{ if(!N.esperas.has(i)) N.esperas.set(i, []); N.esperas.get(i).push(res); });
}
// Parte una frase en un primer trozo corto (hasta la primera coma o unas 4-6 palabras) y el resto,
// para empezar a sonar casi de inmediato (en menos de medio segundo).
function partirFrase(t){
  if(t.length < 28) return null;
  let corte = -1;
  const re = /[,;:—–]\s/g; let m;
  while((m = re.exec(t))){
    if(m.index >= 8 && m.index <= 38){ corte = m.index + 1; break; }
    if(m.index > 38) break;
  }
  if(corte < 0){
    corte = t.lastIndexOf(' ', 30);
    if(corte < 10){
      const sp = t.indexOf(' ', 10);
      if(sp > 0 && sp <= 38) corte = sp;
    }
  }
  if(corte < 6) return null;
  const a = t.slice(0, corte).trim(), b = t.slice(corte).trim();
  return (a.length >= 6 && b.length >= 6) ? [a, b] : null;
}
// La primera frase (la que va a sonar al tocar reproducir) se genera de forma prioritaria e instantánea:
// si es larga, se parte en un primer trozo ultrarrápido y se pipelinea en paralelo (voz natural + timbre).
// Si es corta, se sintetiza y convierte directamente en una sola llamada sin demoras.
function prepararPrimera(i){
  if(N.primera && N.primera.i === i && N.primera.firma === firma()) return N.primera;
  const s = flat[i];
  if(!s || N.enCurso.has(i) || N.enDisco.has(i) || N.listos.has(i)) return null;
  if(engine === 'mivoz' && !store.get('vozSE')) return null;
  N.enCurso.add(i); N.rapido = true;
  const pr = {i, firma: firma()};

  const aTimbre = async x => {
    x = N.M.recortar(x);
    if(engine !== 'mivoz') return x;
    const baseObj = (N.base && (N.base[s.l] || N.base.es)) || null;
    const baseSe = baseObj ? baseObj.se : null;
    return (baseSe && N.tgt) ? await N.M.convertir(x, baseSe, N.tgt) : x;
  };

  const getVozId = () => {
    if(engine === 'mivoz'){
      const baseObj = (N.base && (N.base[s.l] || N.base.es)) || null;
      return baseObj ? baseObj.id : (NAT[s.l] || 'ef_dora');
    }
    return NAT[s.l] || NAT.es || 'ef_dora';
  };

  const partes = partirFrase(s.t);

  if(!partes){
    // Frase corta: generar y convertir directo en una sola etapa de alta prioridad
    pr.a = cargarNeural().then(async ()=>{
      const crudo = await N.M.hablar(s.t, s.l, getVozId(), 1);
      return await aTimbre(crudo);
    });
    pr.resto = null;
    pr.a.then(a => {
      if(N.primera !== pr) return;
      kv.put('pistas', clave(i), aMu(a)).then(()=>{ N.enDisco.add(i); });
      N.enCurso.delete(i); entregar(i, a);
    }).catch(()=>{ N.enCurso.delete(i); if(N.primera === pr) N.primera = null; })
      .finally(()=>{ if(N.primera === pr) N.rapido = false; });
    pr.a.catch(()=>{});
    N.primera = pr;
    return pr;
  }

  // Pipelining paralelo óptimo:
  // 1. Worker 1 sintetiza partes[0] (ultracorto, listo en ~250ms).
  // 2. Apenas k1 termina: Worker 2 convierte el timbre de k1 mientras Worker 1 sintetiza partes[1] en paralelo.
  const k1Promise = cargarNeural().then(()=> N.M.hablar(partes[0], s.l, getVozId(), 1));
  pr.a = k1Promise.then(aTimbre);
  pr.resto = k1Promise.then(()=> N.M.hablar(partes[1], s.l, getVozId(), 1)).then(aTimbre);

  Promise.all([pr.a, pr.resto]).then(([a, b]) => {
    if(N.primera !== pr) return;
    const gap = Math.round(0.12 * N.M.SR), full = new Float32Array(a.length + gap + b.length);
    full.set(a); full.set(b, a.length + gap);
    kv.put('pistas', clave(i), aMu(full)).then(()=>{ N.enDisco.add(i); });
    N.enCurso.delete(i); entregar(i, full);
  }).catch(()=>{ N.enCurso.delete(i); if(N.primera === pr) N.primera = null; })
    .finally(()=>{ if(N.primera === pr) N.rapido = false; });
  pr.a.catch(()=>{}); pr.resto.catch(()=>{});
  N.primera = pr;
  return pr;
}
async function sonar(a, pausa, my){
  const conPausa = new Float32Array(a.length + Math.round(pausa * N.M.SR)); conPausa.set(a);
  if(N.clipUrl) URL.revokeObjectURL(N.clipUrl);
  N.clipUrl = URL.createObjectURL(N.M.wav(conPausa));
  N.cambiando = true;
  N.priming = false;
  N.ultimoCambioSrc = Date.now();
  audioClip.src = N.clipUrl; audioClip.playbackRate = rate; audioClip.preservesPitch = true;
  try{ await audioClip.play(); return true; }
  catch(e){ if(my === N.playTok && e.name !== 'AbortError'){ stop(); showStatus('El teléfono no dejó reproducir. Toca el botón otra vez.'); } return false; }
  finally{ setTimeout(()=>{ N.cambiando = false; }, 120); }
}
async function reproducirClip(i){
  const my = ++N.playTok;
  idx = i; showSentence(true); save();
  if(!N.M) N.M = await import('./voz/motor.js');
  N.resto = null;
  let a = N.listos.get(i), primerTrozo = false;
  if(N.primera && N.primera.i !== i) N.primera = null;
  if(!a){
    setWaiting(true);
    showStatus('Iniciando lectura…');
    try{
      await cargarDisco();
      a = N.listos.get(i);
      if(!a && !N.enDisco.has(i)){
        const pr = prepararPrimera(i);
        if(pr){
          a = await pr.a;
          primerTrozo = !!pr.resto;
          N.resto = pr.resto ? {i, my, promesa: pr.resto} : null;
        }
      }
    }catch(e){ a = null; }
    if(!a) a = await clipDe(i);
    hideStatus();
    setWaiting(false);
  }
  if(my !== N.playTok || !playing || !a) return;
  const pausa = primerTrozo ? 0.12 : (flat[i+1] && flat[i+1].p !== flat[i].p) ? PAUSA_PAG : PAUSA;
  if(!(await sonar(a, pausa, my))) return;
  if(N.velocidadReal && N.velocidadReal < 1.05 && !store.get('avisoLento')){
    store.set('avisoLento', true);
    showStatus('Tu teléfono genera esta voz un poco más lento de lo que la lee, así que a ratos va a pausar. Para evitarlo, usa «Preparar libro» en el botón Voz.');
  }
}
let precalTimer = null;
async function precalentarInmediato(){
  clearTimeout(precalTimer);
  if(!doc || !flat.length || playing || N.prep || !neural() || isAudioDoc()) return;
  if(engine === 'mivoz' && !store.get('vozSE')) return;
  try{
    if(!N.M) N.M = await import('./voz/motor.js');
    cargarNeural().catch(()=>{});
    await cargarDisco();
    if(playing || N.prep || !neural() || isAudioDoc()) return;
    const falta = j => !N.listos.has(j) && !N.enDisco.has(j);
    const fin = Math.min(flat.length, idx + 2);
    let hayFalta = false;
    for(let j = idx; j < fin; j++){ if(falta(j)){ hayFalta = true; break; } }
    if(!hayFalta) return;
    prepararPrimera(idx);
    N.precalentando = true;
    asegurarGenerador();
  }catch(e){}
}
function precalentar(){
  clearTimeout(precalTimer);
  if(!doc || !flat.length || playing || N.prep || !neural() || isAudioDoc()) return;
  if(engine === 'mivoz' && !store.get('vozSE')) return;
  precalTimer = setTimeout(precalentarInmediato, 350);
}
audioClip.addEventListener('ended', async ()=>{
  if(N.priming) return;
  if(!playing || !neural()) return;
  const r = N.resto;
  if(r && r.i === idx && r.my === N.playTok){
    N.resto = null;
    setWaiting(true);
    let b = null; try{ b = await r.promesa; }catch(e){}
    setWaiting(false);
    if(r.my !== N.playTok || !playing) return;
    if(b){ const pausa = (flat[idx+1] && flat[idx+1].p !== flat[idx].p) ? PAUSA_PAG : PAUSA; await sonar(b, pausa, r.my); return; }
  }
  if(idx < flat.length-1) reproducirClip(idx+1); else finished();
});
audioClip.addEventListener('pause', ()=>{
  if(neural() && playing && !N.cambiando && !N.priming && (Date.now() - (N.ultimoCambioSrc || 0) > 300) && !audioClip.ended && audioClip.currentTime < audioClip.duration - 0.05){
    /* pausa desde la pantalla bloqueada */
    playing = false; N.playTok++; setPlayIcon(); save(true);
  }
});

/* ---------- Preparar el libro entero ---------- */
function actualizarPrep(){
  const hechos = N.enDisco.size, total = flat.length;
  $('#prepNote').textContent = `${hechos} de ${total} frases listas (${Math.round(hechos/Math.max(1,total)*100)}%)`;
}
function terminarPrep(){ N.prep = false; $('#prepBtn').textContent = 'Preparar libro'; $('#prepNote').textContent = 'Libro listo: puedes escucharlo sin generar nada.'; if(!playing) holdScreen(false); }
$('#prepBtn').onclick = async ()=>{
  if(N.prep){ N.prep = false; $('#prepBtn').textContent = 'Preparar libro'; if(!playing) holdScreen(false); actualizarPrep(); return; }
  if(engine === 'mivoz' && !store.get('vozSE')){ $('#prepNote').textContent = 'Primero graba tu voz.'; return; }
  N.prep = true; $('#prepBtn').textContent = 'Detener'; holdScreen(true);
  await cargarDisco(); actualizarPrep();
  asegurarGenerador();
};

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
  if(neural()){
    if(engine === 'mivoz' && !store.get('vozSE')){ openSheet(); showStatus('Primero graba tu voz: toca «● Grabar mi voz».'); return; }
    // Desbloquea el audio con este toque (iOS exige un gesto para el primer sonido).
    N.priming = true;
    N.cambiando = true;
    audioClip.src = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YQAAAAA='; audioClip.play().catch(()=>{});
    playing = true; setPlayIcon(); holdScreen(true);
    asegurarGenerador();
    reproducirClip(idx);
    return;
  }
  if(!synth){ showStatus('Este navegador no puede usar las voces del teléfono. Elige la voz Natural.', 'err'); return; }
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
  playing = false; token++; N.playTok++; N.priming = false;
  N.precalentando = false;
  clearTimeout(precalTimer);
  if(!N.prep) N.genTok++;
  setWaiting(false);
  if(synth) synth.cancel();
  if(!audioZip.paused) audioZip.pause();
  if(!audioClip.paused) audioClip.pause();
  if(!N.prep) holdScreen(false);
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
  if(neural()){
    if(playing){
      N.genTok++;
      asegurarGenerador();
      reproducirClip(idx);
    } else {
      showSentence(true, true); save();
      precalentarInmediato();
    }
    return;
  }
  if(playing){
    if(synth){
      try{ synth.cancel(); }catch(e){}
      setTimeout(()=>{ if(playing && !neural()) speak(); }, 30);
    } else speak();
  } else { showSentence(true, true); save(); }
}

/* ---------- Controles de la pantalla bloqueada ---------- */
function mediaMeta(){
  if(!('mediaSession' in navigator) || !doc) return;
  try{
    navigator.mediaSession.metadata = new MediaMetadata({title: doc.name, artist: 'Lectora', artwork:[{src:'icons/icon-512.png', sizes:'512x512', type:'image/png'}]});
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
  if(document.visibilityState==='visible'){ if(playing && engine==='sistema' && !isAudioDoc()) holdScreen(true); if(doc && !$('#readView').hidden) showSentence(true); }
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
  else if(engine === 'mivoz') t = 'Mi voz';
  else if(engine === 'natural') t = 'Natural';
  else if(voiceBy.es) t = voiceBy.es.name.replace(/\s*\(.*\)\s*/,'');
  $('#voiceBtn').textContent = t;
}
function fillNatural(){
  const M = {es:[['ef_dora','Dora (mujer)'],['em_alex','Álex (hombre)']], en:[['af_heart','Heart (mujer)'],['af_bella','Bella (mujer)'],['am_michael','Michael (hombre)'],['am_fenrir','Fenrir (hombre)']]};
  for(const lang of ['es','en']){
    const sel = $(lang==='es' ? '#natEs' : '#natEn'); sel.innerHTML = '';
    M[lang].forEach(([id, n])=>{ const o = document.createElement('option'); o.value = id; o.textContent = n; if(NAT[lang]===id) o.selected = true; sel.appendChild(o); });
    sel.onchange = ()=>{ NAT[lang] = sel.value; store.set('nat:'+lang, sel.value); if(neural()) reiniciarNeural(); };
  }
}
function reiniciarNeural(){
  const era = playing; stop(); N.reset();
  if(era) play(); else precalentar();
}
// Con qué calcula la voz este teléfono (solo se sabe una vez cargado el motor).
function notaMotor(){
  if(!N.M || !N.configurado) return '';
  if(N.M.usaGPU()) return ' Tu teléfono genera la voz con la tarjeta gráfica (modo rápido).';
  const ios = /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  return ' Tu teléfono genera la voz con el procesador' + (self.crossOriginIsolated ? '' : ' (un solo núcleo)') + ', que es más lento' +
    (ios ? ': con iOS 26 o más nuevo usaría la tarjeta gráfica y sería unas 4 veces más rápido.' : '.') +
    ' Para no esperar, usa «Preparar libro».';
}
function setEngine(e){
  const antes = engine;
  engine = e; store.set('engine', e);
  document.querySelectorAll('.seg button').forEach(b=>b.setAttribute('aria-pressed', b.dataset.engine === e ? 'true' : 'false'));
  document.querySelectorAll('[data-panel]').forEach(p=>p.hidden = p.dataset.panel !== e);
  $('#prepBox').hidden = !(e === 'natural' || e === 'mivoz');
  $('#blackBtn').hidden = !doc || isAudioDoc();
  const tam = N.M ? N.M.tamanoVoz() : (navigator.gpu ? 326 : 92);
  $('#dlNote').textContent = e === 'sistema' ? '' :
    `La primera vez descarga la voz (unos ${tam + (e==='mivoz' ? 70 : 0)} MB; conviene Wi-Fi). Después funciona sin internet.` + notaMotor();
  updateVoiceBtn(); refreshRec();
  if(antes !== e && doc){
    const era = playing;
    stop();
    N.reset();
    if(era) play();
    else if(neural()) precalentarInmediato();
    else precalentar();
  } else if((e === 'mivoz' || e === 'natural') && doc && !playing){
    precalentarInmediato();
  }
  if(e === 'mivoz' && store.get('vozSE')){
    cargarNeural().catch(()=>{});
  } else if(e === 'natural'){
    cargarNeural().catch(()=>{});
  }
}
document.querySelectorAll('.seg button').forEach(b=>b.onclick = ()=>setEngine(b.dataset.engine));

function openSheet(){
  const a = isAudioDoc();
  $('#engineBox').hidden = a; $('#audioNote').hidden = !a;
  if(a) $('#audioNote').textContent = `Este libro es un audio hecho en el Mac con ${doc.voice ? doc.voice.toLowerCase() : 'otra voz'}. Aquí solo cambias la velocidad.`;
  if(a) $('#prepBox').hidden = true; else setEngine(engine);
  if(!a && doc && neural()) cargarDisco().then(()=>{ if(!N.prep) $('#prepNote').textContent = N.enDisco.size ? `${N.enDisco.size} de ${flat.length} frases listas` : ''; });
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
  audioZip.playbackRate = rate; audioClip.playbackRate = rate;
  updateMeta();
}
$('#rate').oninput = e=> setRate(+e.target.value);
$('#rate').onchange = ()=>{ if(playing && engine==='sistema' && !isAudioDoc()) speak(); };

// Probar la voz elegida
$('#test').onclick = async ()=>{
  const btn = $('#test'); btn.disabled = true; $('#testNote').textContent = '';
  try{
    if(engine === 'sistema'){
      if(!synth) return;
      synth.cancel();
      [['es','Hola. Así suena la voz en español.'],['en','And this is the English voice.']].forEach(([l,t])=>{
        const u = new SpeechSynthesisUtterance(t); const v = voiceBy[l];
        if(v){ u.voice = v; u.lang = v.lang; } else u.lang = l==='en' ? 'en-US' : 'es-ES';
        u.rate = rate; synth.speak(u);
      });
      return;
    }
    if(engine === 'mivoz' && !store.get('vozSE')){ $('#testNote').textContent = 'Primero graba tu voz.'; return; }
    const prueba = new Audio(); prueba.src = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YQAAAAA='; prueba.play().catch(()=>{});
    $('#testNote').textContent = 'Preparando…';
    await cargarNeural();
    const frase = 'Hola. Así suena esta voz leyendo tus libros, con calma y sin apuro.';
    let a = await N.M.hablar(frase, 'es', engine === 'mivoz' ? N.base.es.id : NAT.es);
    if(engine === 'mivoz') a = await N.M.convertir(a, N.base.es.se, N.tgt);
    prueba.src = URL.createObjectURL(N.M.wav(a)); prueba.playbackRate = rate; await prueba.play();
    $('#testNote').textContent = '';
  }catch(e){ $('#testNote').textContent = e.message || String(e); hideStatus(); }
  finally{ btn.disabled = false; }
};

/* ---------- Grabar tu voz ---------- */
function refreshRec(){
  const tiene = !!store.get('vozSE');
  $('#recEmpty').hidden = tiene; $('#recDone').hidden = !tiene;
  $('#recBtn').textContent = tiene ? '● Grabar de nuevo' : '● Grabar mi voz';
  $('#recPlay').hidden = !tiene;
}
let grabando = null;
$('#recBtn').onclick = async ()=>{
  if(grabando){ grabando.terminar(); return; }
  let stream;
  try{ stream = await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:false, noiseSuppression:true, autoGainControl:true}}); }
  catch(e){ $('#recTime').textContent = ''; showStatus('No pude usar el micrófono. Revisa que la Lectora tenga permiso en Ajustes › Safari › Micrófono (o en los permisos del navegador).', 'err'); return; }
  $('#recLive').hidden = false; $('#recEmpty').hidden = false; $('#recDone').hidden = true;
  const partes = []; const rec = new MediaRecorder(stream);
  rec.ondataavailable = e=>{ if(e.data.size) partes.push(e.data); };
  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  ctx.resume().catch(()=>{});
  const an = ctx.createAnalyser(); an.fftSize = 512; ctx.createMediaStreamSource(stream).connect(an);
  const buf = new Uint8Array(an.fftSize);
  const DUR = 25; const t0 = Date.now();
  let raf;
  const tic = ()=>{
    an.getByteTimeDomainData(buf); let pk = 0; for(const v of buf) pk = Math.max(pk, Math.abs(v-128));
    $('#recLevel').style.width = Math.min(100, pk/128*140) + '%';
    const q = Math.max(0, DUR - Math.floor((Date.now()-t0)/1000));
    $('#recTime').textContent = `Grabando… ${q} s (toca «Terminar» si ya leíste todo)`;
    if(q <= 0) terminar(); else raf = requestAnimationFrame(tic);
  };
  const terminar = ()=>{ if(rec.state !== 'inactive') rec.stop(); cancelAnimationFrame(raf); };
  grabando = {terminar};
  $('#recBtn').textContent = '■ Terminar';
  rec.onstop = async ()=>{
    stream.getTracks().forEach(t=>t.stop()); grabando = null;
    $('#recLive').hidden = true; $('#recBtn').textContent = 'Procesando…'; $('#recBtn').disabled = true;
    try{
      const blob = new Blob(partes, {type: rec.mimeType || 'audio/mp4'});
      const pcm = await ctx.decodeAudioData(await blob.arrayBuffer());
      const a = pcm.getChannelData(0);
      if(pcm.duration < 8) throw new Error('La grabación quedó muy corta. Lee el texto completo (unos 20 segundos).');
      showStatus('Analizando tu voz…');
      if(!N.M) N.M = await import('./voz/motor.js');
      if(!N.configurado){ N.configurado = true; N.M.configurar({gpu: await hayGPU()}); }
      const se = await N.M.huellaDe(N.M.recortar(a), pcm.sampleRate);
      await kv.put('voz', 'grabacion', blob);
      store.set('vozSE', Array.from(se));
      store.set('vozHash', Date.now().toString(36));
      store.del('vozBase');
      neuralP = null;
      await prepararMiVoz();          // instantáneo: compara tu huella con las de las voces naturales
      hideStatus();
      precalentarMotor();             // el motor se carga en segundo plano, sin hacerte esperar
      if(engine === 'mivoz' && doc){ const era = playing; stop(); N.reset(); if(era) play(); else precalentarInmediato(); }
    }catch(e){ showStatus(e.message || 'No pude procesar la grabación. Intenta otra vez.', 'err'); }
    finally{ ctx.close(); $('#recBtn').disabled = false; refreshRec(); }
  };
  rec.start(); tic();
};
$('#recPlay').onclick = async ()=>{
  const b = await kv.get('voz', 'grabacion'); if(!b) return;
  const a = new Audio(URL.createObjectURL(b)); a.play().catch(()=>{});
};

/* ================= Agregar libros ================= */
function showStatus(msg, kind, frac){
  $('#statusText').textContent = msg; $('#status').className = 'status' + (kind ? ' '+kind : ''); $('#status').hidden = false;
  const pr = $('#statusProg'); pr.hidden = frac == null; if(frac != null) pr.firstChild.style.width = Math.round(frac*100) + '%';
}
function hideStatus(){ $('#status').hidden = true; }

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
  const pages = stripRepeats(raw).map(ls=>splitSentences(joinLines(ls)));
  if(!pages.some(p=>p.length)) throw new Error(`«${file.name}» no tiene texto, solo imágenes de las páginas (es un escaneo). Pásalo antes por un programa de OCR.`);
  const key = file.name + '|' + file.size;
  const d = {key, name:file.name.replace(/\.pdf$/i,''), pages};
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
  throw new Error('El archivo usa una compresión que la Lectora no conoce.');
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
  for(const f of files){
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
  $('#installText').textContent = installEvt ? 'Instala la Lectora para abrirla desde la pantalla de inicio, como cualquier app.'
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
setRate(rate); fillNatural(); setEngine(engine); refreshRec();
(async ()=>{
  const last = store.get('last', null);
  if(store.get('view') === 'read' && last){
    const d = last === SAMPLE.key ? SAMPLE : await dbGet(last);
    if(d){ setDoc(d, store.get('pos:'+d.key, 0)); showReader(); return; }
  }
  showLibrary();
})().then(()=> setTimeout(precalentarMotor, 800));

// Al abrir la app con la voz natural o la tuya, el motor se carga de inmediato en segundo plano (tarda varios
// segundos), así al elegir un libro y tocar reproducir ya está listo. Solo si ya se descargó: no gasta datos.
async function precalentarMotor(){
  try{
    if(playing || !(engine === 'natural' || engine === 'mivoz')) return;
    if(engine === 'mivoz' && !store.get('vozSE')) return;
    if(!N.M) N.M = await import('./voz/motor.js');
    if(!(await N.M.modelosGuardados(engine === 'mivoz'))) return;
    await cargarNeural();
    if(doc && !playing) precalentarInmediato();
  }catch(e){ /* si falla, se reintenta al tocar reproducir */ }
}
// Para revisar problemas desde la consola del navegador.
window.lectora = {N, audioClip, estado: () => ({idx, playing, engine, firma: doc && firma()})};
