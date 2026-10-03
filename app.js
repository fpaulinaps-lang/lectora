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
  ['COMO UN AUDIOLIBRO',
   'LectorLibre lee con una voz de narrador, sin internet y sin límites.',
   'Hace pausas entre las frases, los párrafos y los capítulos, como un audiolibro.',
   'Y sigue leyendo aunque bloquees el teléfono o abras otra aplicación.',
   'En el botón Voz puedes elegir otra voz, usar las del teléfono o la tuya, y cambiar la velocidad.'],
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
// Una página de PDF en frases, con párrafos: una línea que termina en punto y es claramente más corta que
// las demás cierra el párrafo (así la voz hace la pausa de párrafo, como en un audiolibro).
// sigue = la página anterior terminó a mitad de un párrafo.
const FIN_PARRAFO = /[.!?…:»"”)]$/;
function frasesPagina(lines, sigue){
  const largos = lines.map(l => l.length).sort((a, b) => a - b), ancho = largos[Math.floor(largos.length * 0.75)] || 0;
  const bloques = []; let cur = [];
  lines.forEach((l, k) => {
    if(isHeading(l)){ if(cur.length) bloques.push(cur); bloques.push([l]); cur = []; return; }
    cur.push(l);
    if(FIN_PARRAFO.test(l) && l.length < ancho * 0.8 && k < lines.length - 1){ bloques.push(cur); cur = []; }
  });
  if(cur.length) bloques.push(cur);
  const out = [];
  bloques.forEach((b, k) => {
    if(b.length === 1 && isHeading(b[0])){ out.push({t: b[0], h: true}); return; }
    splitSentences(joinLines(b)).forEach((t, j) => out.push(j === 0 && (k > 0 || !sigue) ? {t, np: true} : t));
  });
  return out;
}
const paginasPdf = raw => { const ls = stripRepeats(raw); return ls.map((l, i) => frasesPagina(l, i > 0 && !!ls[i - 1].length && !FIN_PARRAFO.test(ls[i - 1][ls[i - 1].length - 1]))); };

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
// voz del teléfono, voz natural (Piper) o «Mi voz» (telefono | natural | mivoz)
let modo = store.get('modo', 'natural');
if(!store.get('natural1')){ store.set('natural1', true); if(modo === 'telefono'){ modo = 'natural'; store.set('modo', modo); } }
const isAudioDoc = () => doc && doc.kind === 'audio';
// Voces naturales (Piper): se bajan de Hugging Face la primera vez que se usan.
const PIPER = 'https://huggingface.co/rhasspy/piper-voices/resolve/main/';
const VOCES_NA = {
  es: [{id: 'es_MX-claude-high', ruta: 'es/es_MX/claude/high', nombre: 'Claude · México', mb: 63},
       {id: 'es_AR-daniela-high', ruta: 'es/es_AR/daniela/high', nombre: 'Daniela · Argentina', mb: 114},
       {id: 'es_MX-ald-medium', ruta: 'es/es_MX/ald/medium', nombre: 'Ald · México', mb: 63},
       {id: 'es_ES-sharvard-medium', ruta: 'es/es_ES/sharvard/medium', nombre: 'Sharvard · España', mb: 77}],
  en: [{id: 'en_US-lessac-medium', ruta: 'en/en_US/lessac/medium', nombre: 'Lessac · EE. UU.', mb: 63},
       {id: 'en_US-amy-medium', ruta: 'en/en_US/amy/medium', nombre: 'Amy · EE. UU.', mb: 63}],
};
const vozNA = l => { const v = VOCES_NA[l === 'en' ? 'en' : 'es']; return v.find(x => x.id === store.get('na:' + (l === 'en' ? 'en' : 'es'))) || v[0]; };

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
    const dur = it.sample ? duracionDe(SAMPLE) : duracionLib(it);
    m.textContent = (it.sample ? 'Ejemplo · 3 páginas' : `${it.pages} ${it.pages===1?'página':'páginas'}`)
      + (dur != null ? ` · ${fmtTime(dur)} de lectura` : '')
      + (it.sample ? '' : (pct ? ` · ${pct}% leído` : ' · sin empezar') + (it.opened ? ` · ${fmtFecha(it.opened)}` : ''));
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
  completarDuraciones();
}
async function removeBook(key){
  if(doc && doc.key === key){ stop(); doc = null; }
  setLib(lib().filter(x=>x.key!==key));
  store.del('pos:'+key); store.del('time:'+key);
  await Promise.all([tx('docs','readwrite', s=>s.delete(key)), kv.del('audio', key), kv.del('portadas', key), kv.delPrefix('pistas', key + '|')]);
  const u = urlsPortada.get(key); if(u) URL.revokeObjectURL(u); urlsPortada.delete(key);
}
// Duración de la lectura en voz alta a velocidad normal (1×). Medido con la voz Paulina de Apple:
// 13,2 letras por segundo contando las pausas. Para los audios del Mac se usa la duración real.
const LETRAS_POR_SEG = 13.2;
function letrasDe(d){
  let n = 0;
  for(const pg of d.pages) for(const x of pg) n += (typeof x === 'string' ? x : x.t).length + 1;
  return n;
}
const duracionDe = d => d.kind === 'audio' && d.duration ? d.duration : letrasDe(d) / LETRAS_POR_SEG;
const duracionLib = it => it.audio && it.dur != null ? it.dur : it.letras != null ? it.letras / LETRAS_POR_SEG : null;
// Los libros agregados antes no tenían la duración guardada: se calcula una vez, al mostrar la biblioteca.
let calculandoDuraciones = false;
async function completarDuraciones(){
  if(calculandoDuraciones) return;
  const faltan = lib().filter(it => it.letras == null && !(it.audio && it.dur != null));
  if(!faltan.length) return;
  calculandoDuraciones = true;
  try{
    for(const it of faltan){ const d = await dbGet(it.key); if(d) libUpdate(it.key, d.kind === 'audio' ? {dur: Math.round(duracionDe(d))} : {letras: letrasDe(d)}); }
  }finally{ calculandoDuraciones = false; }
  if(!$('#libView').hidden) renderLibrary();
}
/* ---------- Dónde empieza el texto de verdad ---------- */
// Al abrir un libro por primera vez se saltan la portada, los créditos (ISBN, derechos), la dedicatoria y el
// índice: la lectura parte donde empieza el texto. Siempre se puede volver a la página 1.
const RX_INDICE = /^(índice|indice|índice general|contenido|contenidos|sumario|tabla de contenidos?|contents|table of contents)\b/i;
const RX_LEGAL = /\bISBN\b|dep[oó]sito legal|derechos reservados|all rights reserved|copyright|©|impreso en |printed in |queda (rigurosamente )?prohibida|first published|primera edici[oó]n/i;
const RX_PREVIO = /^(praise for|acclaim for|advance praise|what (others|people|readers|reviewers)\b.{0,40}\bsay|(other )?books by|also by|by the same author|otros libros|otras obras|del mismo autor|de la misma autora|elogios|lo que (se ha dicho|dicen)|dedicatoria|dedication|agradecimientos|acknowledge?ments)\b/i;
// títulos con que empieza el texto de verdad
const RX_CUERPO = /^(introducci[oó]n|presentaci[oó]n|pr[oó]logo|prefacio|nota (del|de la) aut|cap[ií]tulo|primera parte|parte primera|libro primero|introduction|preface|prologue|foreword|chapter|part (one|1|i)\b)/i;
const textosDe = sents => sents.map(x => typeof x === 'string' ? x : x.t);
const paginaPrevia = sents => esPrevio(textosDe(sents));
// Señales seguras: índice (con título o con líneas de puntos) y créditos (ISBN, derechos).
function esIndiceOCreditos(textos){
  const todo = textos.join(' '), letras = todo.replace(/[^\p{L}]/gu, '').length;
  if(textos.slice(0, 3).some(t => RX_INDICE.test(t.trim()))) return true;
  if((todo.match(/(\.\s?){4,}|…{2,}/g) || []).length >= 3) return true;
  return RX_LEGAL.test(todo) && letras < 2500;
}
function esPrevio(textos){
  const todo = textos.join(' ');
  const letras = todo.replace(/[^\p{L}]/gu, '').length;
  if(letras < 400) return true;                                        // portada, dedicatoria, casi en blanco
  if(esIndiceOCreditos(textos)) return true;
  if(textos.slice(0, 3).some(t => RX_PREVIO.test(t.trim()))) return true;
  const palabras = todo.split(/\s+/).length, numeros = (todo.match(/(^|\s)\d{1,4}(?=\s|$)/g) || []).length;
  return numeros >= 8 && numeros / palabras > 0.1;                     // índice sin título ni puntos
}
function inicioReal(d){
  if(d.kind === 'audio' || d.sample || !d.pages || d.pages.length < 3) return 0;
  if(d.inicioPag != null) return d.inicioPag;
  const lim = Math.min(40, Math.max(3, Math.ceil(d.pages.length * 0.2)));
  // todo lo que está antes del último índice o página de créditos también es parte del comienzo
  // (por ejemplo, la biografía del autor de la solapa); después se siguen saltando las páginas «previas»
  let p = 0;
  for(let q = 0; q < lim; q++) if(esIndiceOCreditos(textosDe(d.pages[q]))) p = q + 1;
  // …salvo que antes del índice ya empiece el texto (una introducción antes del índice)
  for(let q = 0; q < p; q++){
    const t = textosDe(d.pages[q]);
    if(!esPrevio(t) && t.slice(0, 2).some(x => RX_CUERPO.test(x.trim()))){ p = q; break; }
  }
  while(p < lim && paginaPrevia(d.pages[p])) p++;
  return p < lim ? p : 0;          // si todo el comienzo parece «previo», mejor no saltar nada
}

function addToLibrary(d){
  const l = lib().filter(x=>x.key!==d.key);
  l.push({key:d.key, name:d.name, pages:d.pages.length, page:1, pct:0, audio:d.kind==='audio', epub:d.kind==='epub', ocr:!!d.ocr, voice:d.voice, added:Date.now(), ...(d.kind === 'audio' ? {dur: Math.round(duracionDe(d))} : {letras: letrasDe(d)})});
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
  let pos = store.get('pos:'+key, null), salto = 0;
  if(pos == null){
    salto = inicioReal(d);
    pos = 0; for(let p = 0; p < salto; p++) pos += d.pages[p].length;
  }
  setDoc(d, pos);
  libUpdate(key, {opened: Date.now()});
  showReader(); window.scrollTo({top:0});
  if(salto) showStatus(`Empieza en la página ${salto + 1}, donde comienza el texto: se saltaron la portada, los créditos y el índice. Para leerlos, ve a la página 1.`);
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
  MV.pref = null; olvidarBloques(); pararNA(true);
  if(MV.prep){ MV.prep = false; MV.prepTok++; store.del('prepActiva'); }
  $('#blackBtn').hidden = isAudioDoc() || modo !== 'telefono';
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
  // en segundo plano o con la pantalla negra no se redibuja (gasta batería y nadie lo ve)
  if(!force && (document.visibilityState !== 'visible' || !$('#blackout').hidden)) return;
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
    left = chars/(LETRAS_POR_SEG*rate);
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
    setTimeout(()=>{ try{ audioCtx && audioCtx.suspend(); }catch(e){} }, 1500);   // encendido gasta batería
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

// Se leen varias frases seguidas en un solo enunciado (hasta ~400 letras, mismo idioma y mismo párrafo):
// así la voz no se detiene ni reinicia la entonación en cada punto. Entre párrafos y alrededor de los
// títulos se hace una pausa más larga, como en un audiolibro. La frase marcada avanza con los eventos de palabra.
function tramo(desde){
  const l = flat[desde].l, v = voiceBy[l] || voiceBy.es;
  const enNube = v && v.localService === false;                // voces en la nube: una frase por vez (se cortan)
  const fin = [desde];
  let letras = flat[desde].t.length;
  for(let j = desde + 1; j < flat.length && !enNube; j++){
    const f = flat[j];
    if(f.l !== l || f.h || f.np || isHeading(f.t) || isHeading(flat[j - 1].t) || letras + f.t.length > 400 || j - desde >= 8) break;
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
    if(ult >= flat.length - 1){ finished(); return; }
    idx = ult + 1;
    // la voz ya deja un silencio corto al terminar: se agrega solo lo que falta para la pausa de audiolibro
    const ms = pausaTras(ult) * 1000 / rate - 180;
    if(ms < 40) speak(true);
    else { lastStart = Date.now() + ms; setTimeout(()=>{ if(my === token && playing) speak(true); }, ms); }
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
// Solo corre mientras se escucha con la voz del teléfono (un temporizador siempre activo gasta batería).
let vigilancia = null;
function vigilar(on){
  if(on && !vigilancia) vigilancia = setInterval(revisarVoz, 1000);
  if(!on && vigilancia){ clearInterval(vigilancia); vigilancia = null; }
}
function revisarVoz(){
  if(!playing || isAudioDoc() || !synth || usaAudio()){ vigilar(false); return; }
  if(synth.paused){ try{ synth.resume(); }catch(e){} }
  if(synth.speaking || synth.pending){ stalledSince = 0; return; }
  if(Date.now() - lastStart < 4000) return;
  if(!stalledSince){ stalledSince = Date.now(); return; }
  if(Date.now() - stalledSince > 5000 && document.visibilityState === 'visible'){
    stalledSince = 0;
    try{ synth.cancel(); }catch(e){}
    setTimeout(()=>{ if(playing) speak(); }, 50);
  }
}

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


/* ================= Mi voz (preparada de antemano) ================= */
// El teléfono genera la voz natural (Kokoro) y le pone tu timbre (OpenVoice) frase por frase, de antemano,
// y guarda cada frase. Al escuchar se arma una página entera como un solo audio: suena de corrido y con la
// pantalla bloqueada. (Generar en vivo no alcanza en iPhone sin tarjeta gráfica: por eso se prepara antes.)
const esMiVoz = () => modo === 'mivoz' && doc && !isAudioDoc();
const SRV = 24000;
const MV = {M: null, configurado: false, tgt: null, base: null, enDisco: new Set(), pref: null, prep: false, prepTok: 0,
            pag: null, url: null, sig: null, listo: null, relevoT: null, guardado: 0, turno: 0};   // pag/url/sig/turno: el audio que suena (también la voz natural)

// Frases guardadas en 12 bits (1,5 bytes por muestra, ~130 MB por hora de lectura).
function empacar(a){
  const n = a.length, o = new Uint8Array(Math.ceil(n / 2) * 3);
  let pico = 0; for(let i = 0; i < n; i++){ const v = Math.abs(a[i]); if(v > pico) pico = v; }
  const g = pico > 0.98 ? 0.98 / pico : 1;
  const q = i => i < n ? (Math.max(-2048, Math.min(2047, Math.round(a[i] * g * 2047))) + 2048) : 2048;
  for(let i = 0, k = 0; i < n; i += 2, k += 3){
    const x = q(i), y = q(i + 1);
    o[k] = x & 255; o[k + 1] = (x >> 8) | ((y & 15) << 4); o[k + 2] = y >> 4;
  }
  return {f: 'p12', n, d: o};
}
function desempacar(v){
  if(!v || !v.d) return null;
  const {n, d} = v, a = new Float32Array(n);
  for(let i = 0, k = 0; i < n; i += 2, k += 3){
    a[i] = ((d[k] | ((d[k + 1] & 15) << 8)) - 2048) / 2047;
    if(i + 1 < n) a[i + 1] = (((d[k + 1] >> 4) | (d[k + 2] << 4)) - 2048) / 2047;
  }
  return a;
}
function wav16(a, sr = SRV){
  const b = new ArrayBuffer(44 + a.length * 2), v = new DataView(b);
  const w = (o, t) => { for(let i = 0; i < t.length; i++) v.setUint8(o + i, t.charCodeAt(i)); };
  w(0, 'RIFF'); v.setUint32(4, 36 + a.length * 2, true); w(8, 'WAVEfmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true);
  v.setUint16(22, 1, true); v.setUint32(24, sr, true); v.setUint32(28, sr * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  w(36, 'data'); v.setUint32(40, a.length * 2, true);
  for(let i = 0; i < a.length; i++){ const x = Math.max(-1, Math.min(1, a[i])); v.setInt16(44 + i * 2, x < 0 ? x * 32768 : x * 32767, true); }
  return new Blob([b], {type: 'audio/wav'});
}
// Pausa después de cada frase, como en un audiolibro: corta entre frases, más larga entre párrafos, y un
// silencio claro antes y después de cada título o capítulo.
function pausaTras(i){
  const s = flat[i], sig = flat[i + 1];
  if(!s || !sig) return 0.4;
  const titulo = x => x.h || isHeading(x.t);
  if(titulo(s)) return 1.0;
  if(titulo(sig)) return 1.3;
  const fin = s.t.trim().replace(/["'»”’)\]]+$/, '').slice(-1), cierra = /[.!?…]/.test(fin);
  if(sig.np) return cierra ? 0.85 : 0.6;                      // párrafo nuevo
  if(sig.p !== s.p && cierra) return 0.6;                     // página nueva (sin marcas de párrafo)
  if(cierra) return /[?!]/.test(fin) ? 0.5 : 0.45;
  if(/[:;]/.test(fin)) return 0.32;
  return 0.18;                                                // frase larga partida: como una coma
}

function firmaMV(){ const b = store.get('vozBase'); return 'mv' + store.get('vozHash', '') + '-' + (b ? b.es.id + '.' + b.en.id : ''); }
const claveMV = i => `${doc.key}|${firmaMV()}|${i}`;
async function discoMV(){
  const pref = `${doc.key}|${firmaMV()}|`;
  if(MV.pref === pref) return;
  MV.pref = pref; MV.enDisco = new Set();
  const ks = await kv.keys('pistas', pref) || [];
  if(MV.pref === pref) ks.forEach(k => MV.enDisco.add(+k.slice(pref.length)));
}
const frasesDePagina = p => { const a = pageStarts[p], b = p + 1 < pageStarts.length ? pageStarts[p + 1] : flat.length; return Array.from({length: b - a}, (_, k) => a + k); };
const paginaLista = p => { const f = frasesDePagina(p); return f.length > 0 && f.every(i => MV.enDisco.has(i)); };

// Carga el motor (la primera vez descarga unos 180 MB) y elige la voz natural más parecida a la tuya.
async function motorMV(avance = ()=>{}){
  if(!MV.M) MV.M = await import('./voz/motor.js');
  if(!MV.configurado){
    MV.configurado = true;
    let gpu = false;   // «lectora:sinGPU» simula un iPhone sin tarjeta gráfica para probar
    try{ gpu = !store.get('sinGPU', false) && !!(navigator.gpu && await navigator.gpu.requestAdapter()); }catch(e){}
    MV.M.configurar({gpu});
  }
  await MV.M.prepararVoz(avance);
  await MV.M.prepararConversor(avance);
  await elegirBase();
}
async function elegirBase(){
  const h = store.get('vozSE'); if(!h) throw new Error('Primero graba tu voz.');
  MV.tgt = Float32Array.from(h);
  const g = store.get('vozBase');
  if(g && g.hash === store.get('vozHash')){
    MV.base = {es: {id: g.es.id, se: Float32Array.from(g.es.se)}, en: {id: g.en.id, se: Float32Array.from(g.en.se)}};
    return;
  }
  // huellas de las voces naturales calculadas de antemano: elegir es solo comparar números
  const huellas = await (await fetch('voz/huellas-base.json')).json();
  const cands = {es: ['ef_dora', 'em_alex'], en: ['af_heart', 'af_bella', 'am_michael', 'am_fenrir']};
  const base = {};
  for(const lang of ['es', 'en']){
    let mejor = null;
    for(const id of cands[lang]){
      const se = Float32Array.from(huellas[id]), sim = MV.M.parecido(se, MV.tgt);
      if(!mejor || sim > mejor.sim) mejor = {id, se, sim};
    }
    base[lang] = mejor;
  }
  MV.base = base;
  store.set('vozBase', {hash: store.get('vozHash'), es: {id: base.es.id, se: Array.from(base.es.se)}, en: {id: base.en.id, se: Array.from(base.en.se)}});
  MV.pref = null;
}
function avanceMV(msg, n, t){
  $('#mvDescarga').textContent = t > 1000 ? `${msg}: ${Math.round(n / 1e6)} de ${Math.round(t / 1e6)} MB (solo la primera vez; usa Wi-Fi).` : msg + '…';
}

/* ---------- Preparar el libro ---------- */
// Sin tarjeta gráfica, cuántos procesos convienen depende del teléfono: más núcleos ayudan, pero cada
// proceso carga sus modelos (~200 MB) y con poca memoria todo se vuelve más lento (o el iPhone cierra la app).
// Por eso se prueba: parte con [voz natural, timbre] = [1,1], mide, prueba [2,1] y [2,2], y se queda con
// la más rápida. El resultado se recuerda en este teléfono («mvProcesos»).
const PRUEBAS = [[1, 1], [2, 1], [2, 2]];
const LETRAS_POR_PRUEBA = 1500;          // ~1,5 minutos de lectura por prueba
async function prepararMV(){
  if(MV.prep){ MV.prep = false; MV.prepTok++; store.del('prepActiva'); if(!playing) holdScreen(false); actualizarMV(); return; }
  if(!store.get('vozSE')){ $('#mvEstado').textContent = 'Primero graba tu voz.'; return; }
  const tok = ++MV.prepTok, d = doc;
  MV.prep = true; holdScreen(true); actualizarMV();
  if(document.visibilityState === 'visible') store.set('prepActiva', {key: d.key});
  try{
    await motorMV(avanceMV);
    const conGPU = MV.M.usaGPU();
    const elegido = store.get('mvProcesos', null);
    let plan = conGPU || elegido ? null : PRUEBAS.slice(), resultados = [];
    let actual = conGPU ? [1, 1] : (elegido || PRUEBAS[0]);
    let cap = await MV.M.ajustar(...actual);
    $('#mvDescarga').textContent = '';
    await discoMV();
    // desde donde vas hasta el final, y después lo de antes
    const orden = [];
    for(let i = idx; i < flat.length; i++) if(!MV.enDisco.has(i)) orden.push(i);
    for(let i = 0; i < idx; i++) if(!MV.enDisco.has(i)) orden.push(i);
    const t0 = performance.now(); let letras = 0, fallo = null;
    const letrasTotal = orden.reduce((x, i) => x + flat[i].t.length, 0);
    let fase = {t: null, letras: 0};          // medición de la prueba en curso (desde la primera frase lista)
    const enVuelo = new Set();
    for(const i of orden){
      if(tok !== MV.prepTok || doc !== d || fallo) break;
      // fin de una prueba: medir, y pasar a la siguiente configuración o quedarse con la mejor
      if(plan && fase.t && fase.letras >= LETRAS_POR_PRUEBA){
        await Promise.all(enVuelo);
        resultados.push({conf: actual, rapidez: fase.letras / (performance.now() - fase.t)});
        const k = resultados.length;
        const mejor = resultados.reduce((a, b) => b.rapidez > a.rapidez ? b : a);
        const sigue = k < PRUEBAS.length && resultados[k - 1] === mejor;   // si la última no mejoró, no vale la pena seguir
        actual = sigue ? PRUEBAS[k] : mejor.conf;
        if(!sigue){ plan = null; store.set('mvProcesos', actual); }
        $('#mvDescarga').textContent = sigue ? 'Probando más procesos a la vez para ir más rápido…' : '';
        cap = await MV.M.ajustar(...actual);
        $('#mvDescarga').textContent = '';
        fase = {t: null, letras: 0};
      }
      const job = (async ()=>{
        const s = flat[i], b = MV.base[s.l] || MV.base.es;
        const crudo = MV.M.recortar(await MV.M.hablar(s.t, s.l, b.id, 1));
        if(tok !== MV.prepTok || doc !== d) return;
        const a = await MV.M.convertir(crudo, b.se, MV.tgt);
        if(tok !== MV.prepTok || doc !== d) return;
        await kv.put('pistas', claveMV(i), empacar(a));
        MV.enDisco.add(i); letras += s.t.length;
        if(fase.t == null) fase.t = performance.now(); else fase.letras += s.t.length;
        MV.falta = letras ? (performance.now() - t0) / 1000 / letras * (letrasTotal - letras) : null;
        actualizarMV();
      })().catch(e => { fallo = e; });
      enVuelo.add(job); job.finally(() => enVuelo.delete(job));
      if(enVuelo.size >= cap.voz + cap.timbre) await Promise.race(enVuelo);
    }
    await Promise.all(enVuelo);
    // si el libro se terminó en medio de las pruebas, se recuerda la mejor medida hasta ahora
    if(plan && fase.t && fase.letras > 0) resultados.push({conf: actual, rapidez: fase.letras / (performance.now() - fase.t)});
    if(plan && resultados.length > 1) store.set('mvProcesos', resultados.reduce((a, b) => b.rapidez > a.rapidez ? b : a).conf);
    if(fallo) throw fallo;
  }catch(e){ $('#mvEstado').textContent = e.message || String(e); }
  finally{
    if(tok === MV.prepTok){ MV.prep = false; MV.falta = null; store.del('prepActiva'); }
    if(!playing) holdScreen(false);
    actualizarMV();
  }
}
// Si la app se cierra mientras prepara (el iPhone la cierra si usa mucha memoria), la marca queda puesta.
// Mientras la app está en segundo plano no se marca: ahí el iPhone la puede cerrar sin que sea un problema.
document.addEventListener('visibilitychange', () => {
  if(!MV.prep || !doc) return;
  if(document.visibilityState === 'visible') store.set('prepActiva', {key: doc.key}); else store.del('prepActiva');
});
async function retomarPreparacion(){
  const m = store.get('prepActiva');
  if(!m) return;
  store.del('prepActiva');
  if(!doc || doc.key !== m.key || !store.get('vozSE')) return;
  store.set('mvProcesos', [1, 1]);
  if(modo !== 'mivoz') setModo('mivoz');
  showStatus('LectorLibre se cerró mientras preparaba tu voz (seguramente por falta de memoria). Sigo preparando, con menos procesos a la vez.');
  prepararMV();
}

function actualizarMV(){
  const tiene = !!store.get('vozSE');
  $('#recEmpty').hidden = tiene; $('#recDone').hidden = !tiene;
  $('#recBtn').textContent = tiene ? '● Grabar de nuevo' : '● Grabar mi voz';
  $('#recPlay').hidden = !tiene; $('#mvTest').hidden = !tiene;
  $('#mvPrepBox').hidden = !tiene || !doc || isAudioDoc();
  if(!doc || isAudioDoc() || !tiene) return;
  const conTexto = doc.pages.map((_, p) => p).filter(p => frasesDePagina(p).length);
  const listas = conTexto.filter(paginaLista).length;
  $('#mvBar').style.width = Math.round(listas / Math.max(1, conTexto.length) * 100) + '%';
  let t = `${listas} de ${conTexto.length} páginas listas con tu voz.`;
  if(MV.prep) t += MV.falta != null ? ` Preparando… faltan ~${fmtTime(MV.falta)}. Deja LectorLibre abierta y el teléfono cargando.` : ' Preparando…';
  else if(listas < conTexto.length) t += ' Toca «Preparar con mi voz» para seguir.';
  $('#mvEstado').textContent = t;
  $('#mvPrep').textContent = MV.prep ? 'Detener' : (listas ? 'Seguir preparando' : 'Preparar con mi voz');
  $('#mvPrep').hidden = !MV.prep && listas === conTexto.length;
}
$('#mvPrep').onclick = prepararMV;

/* ================= Voz natural (Piper), generada mientras escuchas ================= */
// Voces libres de Piper (licencia MIT, https://github.com/rhasspy/piper): suenan como un narrador, se generan
// en el teléfono sin internet (después de bajarlas una vez) y van más rápido que la lectura, así que no hace
// falta preparar nada. Se escuchan como un audio normal: siguen en otras apps y con el teléfono bloqueado.
const esNatural = () => modo === 'natural' && doc && !isAudioDoc();
const usaAudio = () => esMiVoz() || esNatural();
// Lo generado se guarda en el teléfono (no en la memoria) y, mientras escuchas, se adelanta hasta 45 minutos.
// Así, si el iPhone frena el trabajo con la pantalla bloqueada o en otra app, queda reserva de sobra, y al
// pausar y retomar todo está listo. Lo ya escuchado se borra; solo se guarda lo que viene (unos 2 MB por minuto).
const ADELANTE_SEG = 45 * 60;
// En el computador, dos procesos generan a la vez (casi el doble de rápido). En el teléfono, uno solo:
// cada proceso necesita cientos de MB y el iPhone cierra la página si se pasa («Ocurrió un problema»).
const ES_TELEFONO = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const NA = {ws: [], max: ES_TELEFONO ? 1 : 2, n: 0, pend: new Map(), cargadas: new Map(), bajadas: new Map(), sr: 22050,
            tok: 0, pos: -1, corre: false, dormidos: [], esperas: new Map(), hechas: new Map(), enCurso: new Map(), pref: null};

function procesoNA(k){
  if(NA.ws[k]) return NA.ws[k];
  const w = NA.ws[k] = new Worker('voz/piper-worker.js', {type: 'module'});
  w.onmessage = e => {
    const {id, ok, r, error} = e.data; const p = NA.pend.get(id); if(!p) return;
    NA.pend.delete(id); ok ? p.res(r) : p.rej(new Error(error));
  };
  w.onerror = e => {
    for(const [id, p] of [...NA.pend]) if(p.k === k){ NA.pend.delete(id); p.rej(new Error(e.message || 'La voz natural falló.')); }
    NA.ws[k] = null;
    for(const c of [...NA.cargadas.keys()]) if(c.startsWith(k + '|')) NA.cargadas.delete(c);
  };
  return w;
}
// Cierra los procesos de voz: libera toda su memoria (al cambiar de voz o dejar de usar la natural).
function cerrarNA(){
  pararNA(true);
  for(const w of NA.ws) if(w) w.terminate();
  NA.ws = []; NA.cargadas.clear();
  for(const p of NA.pend.values()) p.rej(new Error('detenido'));
  NA.pend.clear();
}
const llamarNA = (fn, args, transferir = [], k = 0) => new Promise((res, rej) => {
  const id = ++NA.n; NA.pend.set(id, {res, rej, k}); procesoNA(k).postMessage({id, fn, args}, transferir);
});
// Baja el archivo una sola vez y lo deja guardado en el teléfono (sin internet después).
async function bajarNA(url, avance){
  const c = await caches.open('lectora-voces');
  if(!(await c.match(url))){
    if(!NA.bajadas.has(url)) NA.bajadas.set(url, (async ()=>{
      const r = await fetch(url);
      if(!r.ok) throw new Error('No pude bajar la voz natural. Revisa la conexión (la primera vez necesita internet).');
      const total = +r.headers.get('content-length') || 0; let n = 0;
      const contar = new TransformStream({transform(trozo, ctl){ n += trozo.length; avance(n, total); ctl.enqueue(trozo); }});
      await c.put(url, new Response(r.body.pipeThrough(contar), {headers: {'Content-Type': 'application/octet-stream'}}));
    })().finally(() => NA.bajadas.delete(url)));
    await NA.bajadas.get(url);
  }
  return (await c.match(url)).arrayBuffer();
}
function cargarVozNA(l, k = 0){
  const v = vozNA(l), clave = k + '|' + v.id;
  if(!NA.cargadas.has(clave)) NA.cargadas.set(clave, (async ()=>{
    const avance = (n, t) => showStatus(`Bajando la voz ${v.nombre}: ${Math.round(n / 1e6)} de ${Math.round((t || v.mb * 1e6) / 1e6)} MB (solo la primera vez; usa Wi-Fi).`, null, t ? n / t : null);
    const [modelo, config] = await Promise.all([bajarNA(PIPER + v.ruta + '/' + v.id + '.onnx', avance), bajarNA(PIPER + v.ruta + '/' + v.id + '.onnx.json', ()=>{})]);
    NA.sr = await llamarNA('cargar', [v.id, modelo, config], [modelo, config], k);
    if(!$('#statusProg').hidden) hideStatus();
  })().catch(e => { NA.cargadas.delete(clave); throw e; }));
  return NA.cargadas.get(clave);
}
// Lo que se le pasa a la voz: los títulos en MAYÚSCULAS se escriben normal (si no, deletrea siglas)
// y terminan en punto, para que la entonación baje como al anunciar un capítulo.
function textoNA(s){
  let t = s.t.trim();
  if(t === t.toUpperCase() && /[A-ZÁÉÍÓÚÑ]{3}/.test(t)) t = t.toLowerCase().replace(/(^|[.!?¿¡:]\s*)(\p{L})/gu, (m, a, b) => a + b.toUpperCase());
  if((s.h || isHeading(s.t)) && !/[.!?…:;]$/.test(t)) t += '.';
  return t;
}
// Piper deja silencio al principio y al final de cada frase: se quita, y las pausas las pone pausaTras.
function recortarNA(a){
  const u = 0.008; let i = 0, j = a.length - 1;
  while(i < j && Math.abs(a[i]) < u) i++;
  while(j > i && Math.abs(a[j]) < u) j--;
  const m = Math.round(NA.sr * 0.03);
  return a.subarray(Math.max(0, i - m), Math.min(a.length, j + m));
}
// Una frase larga (o que sigue en la página siguiente) quedó partida en trozos: se genera entera, para que
// la entonación sea la de una sola frase, hasta ~280 letras (más largo, la voz necesita demasiada memoria
// y el iPhone cierra la página). Devuelve el último trozo.
const FIN_FRASE = /[.!?…:;]["'»”’)\]]*$/;
function finUnidad(i){
  let j = i, letras = flat[i].t.length;
  while(j + 1 < flat.length){
    const a = flat[j], b = flat[j + 1];
    if(FIN_FRASE.test(a.t.trim()) || b.np || b.h || a.h || isHeading(b.t) || isHeading(a.t) || b.l !== a.l || letras + b.t.length > 280) break;
    j++; letras += b.t.length + 1;
  }
  return j;
}

/* ---------- Lo generado, guardado en el teléfono ---------- */
// clave: na|libro|voces|frase|hasta|muestras (así se sabe qué hay sin leer el audio)
const firmaNA = () => `na|${doc.key}|${vozNA('es').id}+${vozNA('en').id}|`;
async function discoNA(){
  const pref = firmaNA();
  if(NA.pref === pref) return;
  NA.pref = pref; NA.hechas = new Map();
  const ks = await kv.keys('pistas', pref) || [];
  if(NA.pref !== pref) return;
  for(const k of ks){
    const [i, hasta, n] = k.slice(pref.length).split('|').map(Number);
    if(!NA.hechas.has(i)) NA.hechas.set(i, {hasta, n, k});
  }
  // lo de otros libros u otras voces ya no se usa: se borra
  const otros = new Set();
  for(const k of await kv.keys('pistas', 'na|') || []) if(!k.startsWith(pref)) otros.add(k.split('|').slice(0, 3).join('|') + '|');
  for(const p of otros) kv.delPrefix('pistas', p).catch(()=>{});
}
const adelanteSeg = () => { let n = 0; for(const [i, h] of NA.hechas) if(i >= idx) n += h.n; return n / NA.sr; };
function despertarNA(){ const d = NA.dormidos; NA.dormidos = []; d.forEach(r => r()); }
function mostrarAdelanto(){
  const el = $('#naAdelanto');
  if(!el || $('#scrim').hidden || modo !== 'natural' || !doc || isAudioDoc() || NA.pref !== firmaNA()) return;
  const s = adelanteSeg();
  el.textContent = s > 30 ? `Listo por adelantado en este libro: ~${fmtTime(s / rate)}.` : '';
}

async function generarNA(desde){
  const tok = ++NA.tok; NA.pos = desde; NA.corre = true;
  despertarNA();
  for(const [k, w] of [...NA.esperas]) if(k < desde || k > desde + 4){ NA.esperas.delete(k); w.rej(new Error('detenido')); }
  const pref = firmaNA();
  let soltar; const primera = new Promise(r => soltar = r);
  const trabajar = async k => {
    // el segundo proceso parte cuando ya suena la primera frase (cargar los dos a la vez demora el comienzo)
    if(k > 0) await Promise.race([primera, new Promise(r => setTimeout(r, 15000))]);
    while(tok === NA.tok && k < NA.max){
      while(adelanteSeg() > ADELANTE_SEG && !NA.esperas.size){
        await new Promise(r => NA.dormidos.push(r));
        if(tok !== NA.tok) return;
      }
      // la próxima frase que nadie tiene ni está haciendo
      let i = NA.pos;
      while(i < flat.length && (NA.hechas.has(i) || NA.enCurso.has(i))) i = (NA.hechas.has(i) ? NA.hechas.get(i).hasta : NA.enCurso.get(i)) + 1;
      if(i >= flat.length) return;
      const s = flat[i], hasta = finUnidad(i);
      NA.pos = hasta + 1; NA.enCurso.set(i, hasta);
      try{
        let texto = textoNA(s); for(let j = i + 1; j <= hasta; j++) texto += ' ' + textoNA(flat[j]);
        await cargarVozNA(s.l, k);
        const a = await llamarNA('hablar', [vozNA(s.l).id, texto], [], k);
        if(!doc || firmaNA() !== pref) return;               // cambiaste de libro o de voz
        const v = empacar(recortarNA(a)), clave = pref + String(i).padStart(7, '0') + '|' + hasta + '|' + v.n;
        await kv.put('pistas', clave, v);
        NA.hechas.set(i, {hasta, n: v.n, k: clave}); soltar();
        const w = NA.esperas.get(i); if(w){ NA.esperas.delete(i); w.res(); }
        mostrarAdelanto();
      }catch(e){
        if(k === 0) throw e;
        NA.max = 1;                                           // el segundo proceso no pudo: sigue uno solo
        if(i < NA.pos) NA.pos = i;
        return;
      }finally{ NA.enCurso.delete(i); }
    }
  };
  try{ await Promise.all(Array.from({length: NA.max}, (_, k) => trabajar(k))); }
  catch(e){ for(const w of NA.esperas.values()) w.rej(e); NA.esperas.clear(); }
  finally{ if(tok === NA.tok) NA.corre = false; }
}
function pararNA(limpiar){
  NA.tok++; NA.corre = false;
  despertarNA();
  for(const w of NA.esperas.values()) w.rej(new Error('detenido'));
  NA.esperas.clear();
  if(limpiar){ NA.pref = null; NA.hechas = new Map(); }
}
// Espera a que la frase i esté generada (si el generador va a otra parte, lo lleva ahí).
function esperarNA(i){
  if(NA.hechas.has(i)) return Promise.resolve();
  const p = new Promise((res, rej) => NA.esperas.set(i, {res, rej}));
  // ¿ya se está haciendo, o el generador llegará pronto a i como comienzo de frase?
  let enCamino = NA.corre && NA.enCurso.has(i);
  for(let h = NA.pos, n = 0; NA.corre && !enCamino && n < 5 && h <= i; n++){
    if(h === i) enCamino = true;
    h = (NA.hechas.has(h) ? NA.hechas.get(h).hasta : NA.enCurso.has(h) ? NA.enCurso.get(h) : finUnidad(h)) + 1;
  }
  if(!enCamino) generarNA(i); else despertarNA();
  return p;
}
const fuenteNA = {
  get sr(){ return NA.sr; }, max: 150,
  lista: i => NA.hechas.has(i),
  async primera(i){ await discoNA(); await esperarNA(i); },
  async audio(i){
    const h = NA.hechas.get(i); if(!h) return null;
    const a = desempacar(await kv.get('pistas', h.k));
    return a && {a: aEntero(a), hasta: h.hasta};
  },
  usada(i){
    const h = NA.hechas.get(i);
    if(h){ NA.hechas.delete(i); kv.del('pistas', h.k).catch(()=>{}); }
    despertarNA();
  },
};

/* ================= Escuchar como audio: «Mi voz» preparada y la voz natural ================= */
// Varias frases seguidas forman un solo audio (un «bloque»), con las pausas de lectura y el tiempo de cada
// frase. Mientras más largo el bloque, menos veces tiene que despertarse la app con el teléfono bloqueado o
// en otra app (gasta menos batería y hay menos riesgo de corte al cambiar de audio). Con la voz natural el
// primer bloque es corto (empieza a sonar enseguida) y los siguientes crecen a medida que el generador se adelanta.
const fuenteMV = {
  sr: SRV, max: 300,
  lista: i => MV.enDisco.has(i),
  async primera(i){ if(!MV.enDisco.has(i)) throw new Error('sin preparar'); },
  audio: async i => { const a = desempacar(await kv.get('pistas', claveMV(i))); return a && {a: aEntero(a), hasta: i}; },
  usada(){},
};
const fuenteAU = () => esMiVoz() ? fuenteMV : fuenteNA;
// Audio en 16 bits: la mitad de memoria que en decimales (iPhone cierra las páginas que usan mucha).
function aEntero(f){
  const o = new Int16Array(f.length);
  for(let i = 0; i < f.length; i++){ const x = Math.max(-1, Math.min(1, f[i])); o[i] = x < 0 ? x * 32768 : x * 32767; }
  return o;
}
function wavDePartes(partes, sr){
  const n = partes.reduce((x, a) => x + a.length, 0), b = new ArrayBuffer(44 + n * 2), v = new DataView(b);
  const w = (o, t) => { for(let i = 0; i < t.length; i++) v.setUint8(o + i, t.charCodeAt(i)); };
  w(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); w(8, 'WAVEfmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true);
  v.setUint16(22, 1, true); v.setUint32(24, sr, true); v.setUint32(28, sr * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  w(36, 'data'); v.setUint32(40, n * 2, true);
  const d = new Int16Array(b, 44, n); let k = 0;
  for(const a of partes){ d.set(a, k); k += a.length; }
  return new Blob([b], {type: 'audio/wav'});
}
// Cada bloque termina con un silencio extra (COLA): el bloque siguiente empieza en el otro reproductor
// mientras este todavía suena, así el iPhone nunca ve que el audio «terminó» (si lo ve, con la pantalla
// bloqueada o en otra app no deja seguir, y la app se duerme).
const COLA = 2;
async function armarBloque(desde){
  const F = fuenteAU(), sr = F.sr, partes = [], tiempos = [];
  await F.primera(desde);
  let t = 0, ult = desde;
  for(let i = desde; i < flat.length; i++){
    if(i > desde && (t >= F.max || !F.lista(i))) break;
    const r = await F.audio(i);
    if(!r) break;
    // una frase generada entera puede cubrir varios trozos: el tiempo de cada uno, según sus letras
    const {a, hasta} = r, dur = a.length / sr;
    let letras = 0, acc = 0; for(let k = i; k <= hasta; k++) letras += flat[k].t.length;
    for(let k = i; k <= hasta; k++){ tiempos.push({i: k, s: t + dur * acc / letras}); acc += flat[k].t.length; }
    F.usada(i); partes.push(a); t += dur;
    const pz = new Int16Array(Math.round(pausaTras(hasta) * sr)); partes.push(pz); t += pz.length / sr;
    ult = i = hasta;
  }
  if(!tiempos.length) return null;
  partes.push(new Int16Array(Math.round(COLA * sr)));
  return {desde, ult, tiempos, fin: t, url: URL.createObjectURL(wavDePartes(partes, sr))};
}

/* ---------- Dos reproductores que se pasan la posta ---------- */
const reproductores = [new Audio(), new Audio()];
reproductores.forEach(el => { el.preload = 'auto'; el.preservesPitch = true; });
let audioVoz = reproductores[0];
const otroReproductor = () => reproductores[0] === audioVoz ? reproductores[1] : reproductores[0];
const SILENCIO = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YQAAAAA=';
// Al tocar «Leer»: el iPhone solo deja sonar después a los reproductores que sonaron con un toque,
// y la sesión de audio «playback» es la que sigue con la pantalla bloqueada y en otras apps.
function desbloquearAudio(){
  try{ if(navigator.audioSession) navigator.audioSession.type = 'playback'; }catch(e){}
  if(MV.desbloqueado) return;
  MV.desbloqueado = true;
  for(const el of reproductores){
    if(!el.paused) continue;
    el.src = SILENCIO;
    el.play().then(() => { if(el.src === SILENCIO) el.pause(); }).catch(() => {});
  }
}
function soltarBloque(b, el){
  if(el && el.src === b.url){ el.removeAttribute('src'); try{ el.load(); }catch(e){} }
  setTimeout(() => URL.revokeObjectURL(b.url), 3000);
}
function ponerBloque(b){
  clearTimeout(MV.relevoT); MV.relevoT = null;
  MV.pag = b; MV.url = b.url; MV.sig = null;
  if(MV.listo){ soltarBloque(MV.listo.b, MV.listo.el); MV.listo = null; }
}
async function sonarBloque(b, desde){
  const viejo = MV.pag;
  ponerBloque(b);
  if(viejo && viejo !== b) soltarBloque(viejo, null);
  audioVoz.src = b.url; audioVoz.playbackRate = rate;
  const t = (b.tiempos.find(x => x.i === desde) || b.tiempos[0]).s;
  const empezar = () => { try{ audioVoz.currentTime = t; }catch(e){} };
  if(t > 0){ if(audioVoz.readyState >= 1) empezar(); else audioVoz.addEventListener('loadedmetadata', empezar, {once: true}); }
  await audioVoz.play();
  seguirGenerando();
}
function seguirGenerando(){
  if(!esNatural() || NA.corre || !MV.pag) return;
  const q = (MV.listo ? MV.listo.b.ult : MV.pag.ult) + 1;
  if(q < flat.length) generarNA(q);
}
// El bloque siguiente se arma ~25 s antes de que termine este, y queda cargado en el otro reproductor.
function prepararSiguiente(){
  const b = MV.pag;
  if(!b || MV.sig || MV.listo || !playing) return;
  const q = b.ult + 1;
  if(q >= flat.length) return;
  const p = MV.sig = (async ()=>{
    if(esMiVoz()){ await discoMV(); if(!fuenteMV.lista(q)) return null; }
    const nb = await armarBloque(q);
    if(!nb) return null;
    if(MV.pag !== b){ soltarBloque(nb, null); return null; }
    const el = otroReproductor();
    el.src = nb.url; el.playbackRate = rate; el.load();
    MV.listo = {b: nb, el};
    programarRelevo();
    return MV.listo;
  })().catch(() => null).then(r => { if(!r && MV.sig === p) MV.sig = null; return r; });
}
function programarRelevo(){
  clearTimeout(MV.relevoT); MV.relevoT = null;
  if(!MV.listo || !MV.pag || !playing) return;
  const ms = (MV.pag.fin - audioVoz.currentTime) / (audioVoz.playbackRate || 1) * 1000;
  MV.relevoT = setTimeout(() => { MV.relevoT = null; revisarRelevo(); }, Math.max(0, ms - 100));
}
function revisarRelevo(){
  const b = MV.pag;
  if(!b || !playing || !usaAudio()) return;
  const quedan = b.fin - audioVoz.currentTime;
  if(quedan < 25) prepararSiguiente();
  if(MV.listo && quedan <= 0.15) relevar();
}
// El otro reproductor empieza mientras este suena su silencio final; recién después se detiene este.
async function relevar(){
  const L = MV.listo;
  if(!L) return;
  MV.listo = null;
  const viejo = audioVoz, bViejo = MV.pag;
  audioVoz = L.el;
  ponerBloque(L.b);
  idx = L.b.desde;
  audioVoz.playbackRate = rate;
  try{ await audioVoz.play(); }
  catch(e){
    if(audioVoz !== L.el) return;
    stop(); showStatus('El teléfono detuvo la lectura. Toca reproducir para seguir.'); return;
  }
  viejo.pause(); soltarBloque(bViejo, viejo);
  seguirGenerando();
  save(true);
  if(document.visibilityState === 'visible') showSentence(true);
}
// Al cambiar de libro, de voz o de tipo de voz, lo ya armado no sirve.
function olvidarBloques(){
  clearTimeout(MV.relevoT); MV.relevoT = null;
  if(MV.listo){ soltarBloque(MV.listo.b, MV.listo.el); MV.listo = null; }
  if(MV.pag){ soltarBloque(MV.pag, audioVoz); MV.pag = null; }
  MV.url = null; MV.sig = null;
}
function avisoSinPreparar(){
  showStatus('Esta parte todavía no está preparada con tu voz. Abre «Voz» y toca «Preparar con mi voz», o elige otra voz.');
}
async function playAU(){
  desbloquearAudio();
  const i = idx;
  // seguir donde quedó la pausa, sin rearmar nada
  if(MV.pag && audioVoz.src === MV.pag.url && audioVoz.readyState >= 1){
    const x = MV.pag.tiempos.find(y => y.i === i);
    if(x){
      sincronizarAU();
      if(idx !== i){ idx = i; try{ audioVoz.currentTime = x.s; }catch(e){} }
      playing = true; setPlayIcon();
      try{ await audioVoz.play(); seguirGenerando(); programarRelevo(); return; }
      catch(e){ playing = false; setPlayIcon(); }
    }
  }
  if(esMiVoz()){
    await discoMV();
    if(!fuenteMV.lista(i)){ avisoSinPreparar(); openSheet(); return; }
  }
  playing = true; setPlayIcon();
  const yo = ++MV.turno;
  try{
    if(esNatural()){ await discoNA(); if(!NA.hechas.has(i)) showStatus('Preparando la voz…'); }
    const b = await armarBloque(i);
    if(yo !== MV.turno || !playing){ if(b) soltarBloque(b, null); return; }
    hideStatus();
    if(!b){ stop(); return; }
    await sonarBloque(b, i);
  }catch(e){
    if(yo !== MV.turno) return;
    playing = false; setPlayIcon();
    if(e && e.message === 'detenido') return;
    if(e && e.message === 'sin preparar'){ avisoSinPreparar(); return; }
    showStatus(e && e.name === 'NotAllowedError' ? 'El teléfono no dejó reproducir. Toca el botón otra vez.' : (e && e.message) || 'No se pudo reproducir.', e && e.name === 'NotAllowedError' ? null : 'err');
  }
}
// Frase que está sonando, según el tiempo del audio.
function sincronizarAU(){
  if(!usaAudio() || !MV.pag) return false;
  const t = audioVoz.currentTime; let cur = MV.pag.tiempos[0];
  for(const x of MV.pag.tiempos){ if(x.s <= t + 0.05) cur = x; else break; }
  if(cur && cur.i !== idx){ idx = cur.i; return true; }
  return false;
}
// Solo cuenta lo que hace el reproductor que está sonando (el otro espera su turno).
const actual = (fn) => e => { if(e.target === audioVoz && usaAudio()) fn(e); };
for(const el of reproductores){
  // Con la app fuera de pantalla solo se revisa el relevo; la posición se calcula al volver o al pausar.
  el.addEventListener('timeupdate', actual(()=>{
    revisarRelevo();
    if(document.visibilityState !== 'visible' || !$('#blackout').hidden) return;
    if(sincronizarAU()){
      showSentence(true);
      if(Date.now() - MV.guardado > 3000){ MV.guardado = Date.now(); save(); }
    }
  }));
  // Si el relevo no alcanzó (el teléfono se demoró), se hace al terminar.
  el.addEventListener('ended', actual(async ()=>{
    if(!playing || !MV.pag) return;
    const b = MV.pag;
    if(b.ult + 1 >= flat.length){ finished(); return; }
    if(MV.listo){ relevar(); return; }
    prepararSiguiente();
    if(esNatural()) showStatus('Generando la voz… (sigue sola en cuanto esté lista)');
    const L = MV.sig ? await MV.sig : null;
    if(MV.pag !== b || !playing) return;
    if(L && MV.listo){ hideStatus(); relevar(); return; }
    idx = b.ult + 1;
    stop(); showSentence(true, true); save(true);
    if(esMiVoz()) showStatus('Hasta aquí llega lo preparado con tu voz. Abre «Voz» y toca «Seguir preparando».');
    else showStatus('La voz se detuvo. Toca reproducir para seguir.');
  }));
  // (al saltar a otra parte, la pausa la hace la app: no es que hayas pausado)
  el.addEventListener('pause', actual(()=>{
    if(MV.callar){ MV.callar = false; return; }
    if(el.src === SILENCIO) return;
    sincronizarAU();
    if(playing && !el.ended && el.currentTime > 0.2){ playing = false; setPlayIcon(); save(true); pararNA(false); clearTimeout(MV.relevoT); }
  }));
  el.addEventListener('play', actual(()=>{ if(!playing && el.src !== SILENCIO){ playing = true; setPlayIcon(); } }));
}
document.addEventListener('visibilitychange', ()=>{
  if(!usaAudio() || !MV.pag) return;
  sincronizarAU();
  if(document.visibilityState === 'visible') showSentence(true); else save(true);
});
async function saltarAU(i){
  if(!playing){ showSentence(true, true); save(); return; }
  const x = MV.pag && MV.pag.tiempos.find(y => y.i === i);
  if(x && !audioVoz.paused){ audioVoz.currentTime = x.s; showSentence(true, true); programarRelevo(); return; }
  MV.turno++;
  if(!audioVoz.paused){ MV.callar = true; audioVoz.pause(); }
  showSentence(true, true);
  await playAU();
}

/* ---------- Grabar tu voz ---------- */
let grabando = null;
$('#recBtn').onclick = async ()=>{
  if(grabando){ grabando.terminar(); return; }
  let stream;
  try{ stream = await navigator.mediaDevices.getUserMedia({audio: {echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1}}); }
  catch(e){ showStatus('No pude usar el micrófono. Revisa el permiso en Ajustes › Safari › Micrófono (o en los permisos del navegador).', 'err'); return; }
  $('#recLive').hidden = false; $('#recEmpty').hidden = false; $('#recDone').hidden = true;
  const partes = [], rec = new MediaRecorder(stream);
  rec.ondataavailable = e => { if(e.data.size) partes.push(e.data); };
  const ctx = new (window.AudioContext || window.webkitAudioContext)(); ctx.resume().catch(()=>{});
  const an = ctx.createAnalyser(); an.fftSize = 512; ctx.createMediaStreamSource(stream).connect(an);
  const buf = new Uint8Array(an.fftSize), DUR = 25, t0 = Date.now(); let raf;
  const tic = ()=>{
    an.getByteTimeDomainData(buf); let pk = 0; for(const v of buf) pk = Math.max(pk, Math.abs(v - 128));
    $('#recLevel').style.width = Math.min(100, pk / 128 * 140) + '%';
    const q = Math.max(0, DUR - Math.floor((Date.now() - t0) / 1000));
    $('#recTime').textContent = `Grabando… ${q} s (toca «Terminar» si ya leíste todo)`;
    if(q <= 0) terminar(); else raf = requestAnimationFrame(tic);
  };
  const terminar = ()=>{ if(rec.state !== 'inactive') rec.stop(); cancelAnimationFrame(raf); };
  grabando = {terminar};
  $('#recBtn').textContent = '■ Terminar';
  rec.onstop = async ()=>{
    stream.getTracks().forEach(t => t.stop()); grabando = null;
    $('#recLive').hidden = true; $('#recBtn').textContent = 'Procesando…'; $('#recBtn').disabled = true;
    try{
      const blob = new Blob(partes, {type: rec.mimeType || 'audio/mp4'});
      const pcm = await ctx.decodeAudioData(await blob.arrayBuffer());
      if(pcm.duration < 8) throw new Error('La grabación quedó muy corta. Lee el texto completo (unos 20 segundos).');
      showStatus('Analizando tu voz…');
      if(!MV.M) MV.M = await import('./voz/motor.js');
      let a = MV.M.recortar(pcm.getChannelData(0));
      let pico = 0; for(const v of a) pico = Math.max(pico, Math.abs(v));
      if(pico > 0) a = a.map(v => v * 0.95 / pico);             // nivel parejo, sin importar la distancia al micrófono
      const se = await MV.M.huellaDe(a, pcm.sampleRate);
      await kv.put('voz', 'grabacion', blob);
      store.set('vozSE', Array.from(se)); store.set('vozHash', Date.now().toString(36)); store.del('vozBase');
      await elegirBase();
      MV.pref = null; if(doc) await discoMV();
      hideStatus();
    }catch(e){ showStatus(e.message || 'No pude procesar la grabación. Intenta otra vez.', 'err'); }
    finally{ ctx.close(); $('#recBtn').disabled = false; actualizarMV(); }
  };
  rec.start(); tic();
};
$('#recPlay').onclick = async ()=>{
  const b = await kv.get('voz', 'grabacion'); if(!b) return;
  new Audio(URL.createObjectURL(b)).play().catch(()=>{});
};
$('#mvTest').onclick = async ()=>{
  const btn = $('#mvTest'); btn.disabled = true;
  const prueba = new Audio(); prueba.src = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YQAAAAA='; prueba.play().catch(()=>{});
  try{
    $('#mvTestNote').textContent = 'Preparando la prueba (la primera vez descarga la voz)…';
    await motorMV(avanceMV); $('#mvDescarga').textContent = '';
    const b = MV.base.es;
    const a = await MV.M.convertir(MV.M.recortar(await MV.M.hablar('Hola. Así suena mi voz leyendo mis libros, con calma y sin apuro.', 'es', b.id, 1)), b.se, MV.tgt);
    prueba.src = URL.createObjectURL(wav16(a)); prueba.playbackRate = rate; await prueba.play();
    $('#mvTestNote').textContent = '';
  }catch(e){ $('#mvTestNote').textContent = e.message || String(e); }
  finally{ btn.disabled = false; }
};

/* ---------- Elegir entre la voz del teléfono y la tuya ---------- */
function setModo(m){
  if(m !== modo && playing) stop();
  if(m !== modo) olvidarBloques();
  if(m !== 'natural') cerrarNA();
  modo = m; store.set('modo', m);
  document.querySelectorAll('.seg button').forEach(b => b.setAttribute('aria-pressed', b.dataset.modo === m ? 'true' : 'false'));
  document.querySelectorAll('[data-panel]').forEach(p => p.hidden = p.dataset.panel !== m);
  $('#blackBtn').hidden = !doc || isAudioDoc() || m !== 'telefono';
  updateVoiceBtn();
  if(m === 'mivoz' && doc && !isAudioDoc()) discoMV().then(actualizarMV); else actualizarMV();
}
document.querySelectorAll('.seg button').forEach(b => b.onclick = () => setModo(b.dataset.modo));

/* ---------- Elegir la voz natural ---------- */
function llenarNA(){
  for(const l of ['es', 'en']){
    const sel = $(l === 'es' ? '#naEs' : '#naEn'), elegida = vozNA(l).id; sel.innerHTML = '';
    for(const v of VOCES_NA[l]){
      const o = document.createElement('option'); o.value = v.id; o.textContent = `${v.nombre} (${v.mb} MB)`;
      o.selected = v.id === elegida; sel.appendChild(o);
    }
    sel.onchange = ()=>{ if(playing) stop(); store.set('na:' + l, sel.value); olvidarBloques(); cerrarNA(); updateVoiceBtn(); };
  }
}
$('#naTest').onclick = async ()=>{
  const btn = $('#naTest'); btn.disabled = true;
  const prueba = new Audio(); prueba.src = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YQAAAAA='; prueba.play().catch(()=>{});
  try{
    $('#naNote').textContent = 'Preparando (la primera vez baja la voz)…';
    await cargarVozNA('es');
    const a = recortarNA(await llamarNA('hablar', [vozNA('es').id, 'Capítulo uno. Era una tarde tranquila, y el pueblo entero parecía dormir. Nadie imaginaba lo que estaba por pasar.']));
    prueba.src = URL.createObjectURL(wav16(a, NA.sr)); prueba.playbackRate = rate; prueba.preservesPitch = true; await prueba.play();
    $('#naNote').textContent = '';
  }catch(e){ $('#naNote').textContent = e.message || String(e); }
  finally{ btn.disabled = false; }
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
  if(usaAudio()){ primeAudio(); await playAU(); return; }
  if(!synth){ showStatus('Este navegador no puede leer en voz alta. Abre la app en Safari (iPhone) o Chrome (Android).', 'err'); return; }
  primeAudio();
  if(!voices.length || !voiceBy.es){
    voices = synth.getVoices();
    voiceBy.es = pickVoice('es'); voiceBy.en = pickVoice('en');
  }
  if(synth.paused){ try{ synth.resume(); }catch(e){} }
  playing = true; setPlayIcon(); holdScreen(true); vigilar(true); programarNegro();
  speak();
}
function stop(){
  const was = playing;
  playing = false; token++; vigilar(false); clearTimeout(negroTimer);
  if(synth) synth.cancel();
  if(!audioZip.paused) audioZip.pause();
  if(!audioVoz.paused) audioVoz.pause();
  MV.turno++; pararNA(false); clearTimeout(MV.relevoT);
  if(!MV.prep) holdScreen(false);
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
  if(usaAudio()){ saltarAU(idx); return; }
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
  h('previoustrack', ()=>{ sincronizarAU(); jump(idx-1); }); h('nexttrack', ()=>{ sincronizarAU(); jump(idx+1); });
  h('seekbackward', ()=>{ if(isAudioDoc() && zipUrl) audioZip.currentTime = Math.max(0, audioZip.currentTime-15); else jump(idx-2); });
  h('seekforward', ()=>{ if(isAudioDoc() && zipUrl) audioZip.currentTime = Math.min(audioZip.duration||1e9, audioZip.currentTime+15); else jump(idx+2); });
}
// iPhone detiene la voz del teléfono cuando se sale de la app: al volver, la vigilancia la retoma.
// La primera vez se explica que para escuchar en otras apps hay que usar «Mi voz» preparada.
document.addEventListener('visibilitychange', ()=>{
  if(!playing || !doc || isAudioDoc() || usaAudio()) return;
  if(document.visibilityState === 'hidden') MV.fondoTel = true;
  else if(MV.fondoTel){
    MV.fondoTel = false;
    if(!store.get('avisoFondo')){
      store.set('avisoFondo', true);
      showStatus('Con la voz del teléfono, iPhone pausa la lectura cuando sales de LectorLibre (sigue sola al volver). Para escuchar mientras usas otras apps o con el teléfono bloqueado, usa «Mi voz» ya preparada.');
    }
  }
});
document.addEventListener('visibilitychange',()=>{
  if(document.visibilityState==='visible'){ if(playing && !isAudioDoc() && !usaAudio()) holdScreen(true); if(doc && !$('#readView').hidden) showSentence(true); }
});

/* ---------- Pantalla negra ---------- */
let lastTap = 0;
$('#blackBtn').onclick = ()=>{ $('#blackout').hidden = false; updateMeta(); };
// Con la voz del teléfono la pantalla tiene que quedar encendida: si no la tocas por un rato, se pone negra
// sola (en pantallas OLED el negro apaga los píxeles). Se desactiva en Voz › «Apagar la pantalla sola».
const NEGRO_SEG = 20;
let negroTimer = null;
function programarNegro(){
  clearTimeout(negroTimer);
  if(!store.get('autoNegro', true)) return;
  negroTimer = setTimeout(()=>{
    if(playing && doc && !isAudioDoc() && !usaAudio() && document.visibilityState === 'visible' && $('#scrim').hidden){
      $('#blackout').hidden = false; updateMeta();
    }
  }, NEGRO_SEG * 1000);
}
['touchstart', 'mousedown', 'keydown', 'scroll'].forEach(ev => document.addEventListener(ev, ()=>{ if(playing) programarNegro(); }, {passive: true}));
$('#blackout').addEventListener('click', ()=>{
  const now = Date.now();
  if(now - lastTap < 400){ $('#blackout').hidden = true; showSentence(true); }
  lastTap = now;
});

/* ================= Hoja de voz ================= */
function updateVoiceBtn(){
  let t = 'Voz';
  if(doc && isAudioDoc()) t = doc.voice || 'Audio';
  else if(modo === 'mivoz') t = 'Mi voz';
  else if(modo === 'natural') t = vozNA('es').nombre.split(' · ')[0];
  else if(voiceBy.es) t = voiceBy.es.name.replace(/\s*\(.*\)\s*/,'');
  $('#voiceBtn').textContent = t;
}
function openSheet(){
  const a = isAudioDoc();
  $('#engineBox').hidden = a; $('#audioNote').hidden = !a;
  setModo(modo); llenarNA();
  if(modo === 'natural' && doc && !isAudioDoc()) discoNA().then(mostrarAdelanto);
  $('#scrim').hidden = false; fillVoices();
}
function closeSheet(){ $('#scrim').hidden = true; }
$('#voiceBtn').onclick = openSheet;
$('#rateBtn').onclick = openSheet;
$('#closeSheet').onclick = closeSheet;
$('#scrim').addEventListener('click', e=>{ if(e.target.id==='scrim') closeSheet(); });
$('#allLangs').onchange = fillVoices;
$('#autoNegro').checked = store.get('autoNegro', true);
$('#autoNegro').onchange = e => { store.set('autoNegro', e.target.checked); if(playing) programarNegro(); };

function setRate(r){
  rate = Math.round(r*100)/100; store.set('rate', rate);
  const txt = rate.toFixed(rate*10%1 ? 2 : 1).replace('.',',') + '×';
  $('#rateBtn').textContent = txt; $('#rateVal').textContent = txt; $('#rate').value = rate;
  audioZip.playbackRate = rate; reproductores.forEach(el => el.playbackRate = rate); programarRelevo();
  updateMeta();
}
$('#rate').oninput = e=> setRate(+e.target.value);
$('#rate').onchange = ()=>{ if(playing && !isAudioDoc() && !usaAudio()) speak(); };

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
  const pages = paginasPdf(raw);
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
  const pages = paginasPdf(raw);
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
  // Project Gutenberg agrega su licencia al principio y al final: no es parte del libro
  for(const e of [...body.querySelectorAll('script,style,nav,#pg-header,#pg-footer,.pg-boilerplate,section.pg-boilerplate')]) e.remove();
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
  const pagDe = new Map(), caps = [];  // capítulo -> página donde empieza; texto de cada capítulo
  for(const [n, it] of orden.entries()){
    showStatus(`${file.name}: leyendo el capítulo ${n + 1} de ${orden.length}`, null, (n + 1) / orden.length);
    const html = await texto(rutaEpub(base, it.href));
    if(!html) continue;
    cerrar(); pagDe.set(it.href.split('#')[0], pages.length);
    const cap = {p: pages.length, textos: []}; caps.push(cap);
    // un capítulo del comienzo que es casi todo enlaces es un índice (aunque no tenga números ni título)
    if(n < 40){
      const dom = new DOMParser().parseFromString(html, 'text/html'), total = limpio(dom.body ? dom.body.textContent : '').length;
      const enlaces = [...dom.querySelectorAll('a[href]')].reduce((x, a) => x + limpio(a.textContent).length, 0);
      cap.indice = total > 0 && enlaces / total > 0.5;
    }
    for(const b of bloquesDe(html)){
      cap.textos.push(b.t);
      if(b.h){ if(letras > 600) cerrar(); pag.push({t:b.t, h:true}); letras += b.t.length; continue; }
      splitSentences(b.t).forEach((t, k) => { pag.push(k === 0 ? {t, np:true} : t); letras += t.length; });
      if(letras >= 2500) cerrar();
    }
  }
  cerrar();
  if(!pages.length) throw new Error(`«${file.name}» no tiene texto que leer.`);
  const key = file.name + '|' + file.size;
  const d = {key, kind:'epub', name: titulo || file.name.replace(/\.epub$/i,''), pages};
  // Dónde empieza el texto según el propio libro (EPUB 3: «bodymatter» en el índice; EPUB 2: <guide> «text»)
  try{
    let href = [...opf.getElementsByTagName('reference')].find(r => /^(text|start|bodymatter)$/i.test(r.getAttribute('type') || ''))?.getAttribute('href');
    const nav = Object.values(man).find(x => /\bnav\b/.test(x.props));
    let dirNav = '';
    if(!href && nav){
      const h = await texto(rutaEpub(base, nav.href));
      const m = h && h.match(/<a[^>]*epub:type="[^"]*bodymatter[^"]*"[^>]*href="([^"]+)"|<a[^>]*href="([^"]+)"[^>]*epub:type="[^"]*bodymatter/i);
      if(m){ href = m[1] || m[2]; dirNav = nav.href.includes('/') ? nav.href.slice(0, nav.href.lastIndexOf('/') + 1) : ''; }
    }
    let desde = 0;
    if(href){
      const destino = rutaEpub(base, dirNav + href.split('#')[0]);
      const it = orden.find(x => rutaEpub(base, x.href.split('#')[0]) === destino);
      const p = it && pagDe.get(it.href.split('#')[0]);
      if(p != null) desde = Math.max(0, caps.findIndex(c => c.p === p));
    }
    // la marca a veces apunta a la portada o a la página del título: desde ahí se saltan los capítulos
    // que parecen portada, créditos, elogios, dedicatoria o índice
    const lim = Math.min(40, Math.max(3, Math.ceil(caps.length * 0.3)));
    let k = desde;
    while(k < lim && k < caps.length - 1 && (caps[k].indice || esPrevio(caps[k].textos))) k++;
    if(k < lim && caps[k].p < pages.length) d.inicioPag = caps[k].p;
  }catch(e){ /* sin marcas: se adivina al abrir */ }
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
setRate(rate);
(async ()=>{
  const last = store.get('last', null);
  if(store.get('view') === 'read' && last){
    const d = last === SAMPLE.key ? SAMPLE : await dbGet(last);
    if(d){ setDoc(d, store.get('pos:'+d.key, 0)); showReader(); return; }
  }
  showLibrary();
})().then(()=> retomarPreparacion());
window.lectora = {estado: () => ({idx, playing})};


