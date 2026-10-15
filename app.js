// Lectora: biblioteca de PDFs que se leen en voz alta con la voz del teléfono, una voz natural o la tuya.
import { BovedaBiometrica } from './voz/seguridad-biometrica.js';
const $ = s => document.querySelector(s);
const synth = window.speechSynthesis;
const pdfjs = window.pdfjsLib || window['pdfjs-dist/build/pdf'];
if(pdfjs) pdfjs.GlobalWorkerOptions.workerSrc = 'vendor/pdf.worker.min.js';

/* ---------- Service worker: sin internet y con varios núcleos para la voz ---------- */
if('serviceWorker' in navigator){
  // updateViaCache 'none' + update(): sin esto el navegador puede quedarse hasta 10 minutos con la copia
  // vieja de sw.js en su memoria y el teléfono nunca se entera de que hay una versión nueva.
  navigator.serviceWorker.register('sw.js', {updateViaCache: 'none'})
    .then(r => { r.update().catch(()=>{}); })
    .catch(()=>{});
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

/* ---------- Plataforma (iPhone, Android, Windows…) ---------- */
// La app es para iPhone, Android y Windows: los pasos que se explican (permisos, voces, grabadora) cambian.
const PLAT = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1) ? 'ios'
  : /Android/i.test(navigator.userAgent) ? 'android' : /Windows/i.test(navigator.userAgent) ? 'windows' : /Mac/i.test(navigator.platform) ? 'mac' : 'otro';
const GRABADORA = {ios: 'Notas de Voz', android: 'la Grabadora del teléfono', windows: 'la Grabadora de sonido de Windows', mac: 'Notas de Voz'}[PLAT] || 'una app de grabación';
const SISTEMA = {ios: 'el iPhone', android: 'el teléfono', windows: 'Windows', mac: 'el Mac'}[PLAT] || 'el sistema';

/* ---------- Interruptor de seguridad ---------- */
// La «voz entrenada» (la bóveda biométrica) y el Entrenador del computador quedan DESACTIVADOS a
// propósito: el cifrado se podía revertir sin Face ID (la llave se derivaba del propio registro) y el
// entrenador quedaba expuesto en la red con un código de 6 dígitos sin límite de intentos.
// Con esto en false nada de eso se ejecuta ni sale a la red, y sus datos quedan en cuarentena (SEGURIDAD.md).
// Reactivar SOLO después de rediseñar la protección.
const VOZ_SENSIBLE_ACTIVA = false;

/* ---------- Diagnóstico ---------- */
// Lo que pasa mientras se escucha fuera de la app (no se puede ver de otra forma en el iPhone). Se muestra
// en «Voz» › Diagnóstico, para mandar una captura si algo falla. Solo queda en este teléfono.
function diag(msg){
  const l = store.get('diag', []);
  l.push(new Date().toTimeString().slice(0, 8) + ' ' + msg);
  while(l.length > 120) l.shift();
  store.set('diag', l);
}
// si al abrir la app seguía marcada «leyendo», el iPhone la cerró mientras sonaba
if(store.get('sonando')){ diag(`⚠ La app se cerró mientras leía (la cerró ${SISTEMA} por memoria o procesador, o la cerraste tú)`); store.set('sonando', false); }

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
  keys: (st, prefix) => tx(st,'readonly', s=> prefix ? s.getAllKeys(IDBKeyRange.bound(prefix, prefix + '￿')) : s.getAllKeys()),
  delPrefix: (st, prefix) => tx(st,'readwrite', s=>s.delete(IDBKeyRange.bound(prefix, prefix + '￿'))),
};

// BORRADO de los datos de la función desactivada (pedido del usuario: no dejarlos guardados).
// Se sobrescribe cada registro antes de borrarlo (mejor esfuerzo) y se limpian también los restos que
// hubieran quedado de la cuarentena anterior. Nada de esto se puede recuperar después.
async function borrarDatosDeVoz(){
  if(VOZ_SENSIBLE_ACTIVA) return 0;
  if(store.get('voz_datos_borrados_v1', false)) return 0;
  let n = 0;
  const borrar = async k => { try{
    if(await kv.get('voz', k) == null) return;
    try{ await kv.put('voz', k, new Uint8Array(8192)); }catch(e){}     // sobrescritura antes de borrar
    await kv.del('voz', k); n++;
  }catch(e){} };
  try{
    for(const pref of ['ent:', 'cuarentena:ent:']) for(const k of await kv.keys('voz', pref) || []) await borrar(k);
    for(const k of ['modelo_cifrado', 'boveda_meta', 'cuarentena:modelo_cifrado', 'cuarentena:boveda_meta',
                    'grabacion', 'comparar', 'huella', 'muestra']) await borrar(k);
  }catch(e){}
  for(const k of ['entrenador', 'cuarentena:entrenador', 'vozEntrenada', 'cuarentena:vozEntrenada',
                  'vozSE', 'vozHash', 'vozBase', 'entSeg', 'vozGuia', 'pcEpocas', 'voz_purga_segura_v1', 'voz_cuarentena_v1']){
    try{ if(store.get(k, null) !== null){ store.del(k); n++; } }catch(e){}
  }
  try{                                                                 // modelos sin cifrar en la caché
    const c = await caches.open('lectora-voces');
    for(const r of await c.keys()) if(/mi-voz|voz\.onnx|lectoravoz/i.test(r.url)){ await c.delete(r); n++; }
  }catch(e){}
  store.set('voz_datos_borrados_v1', Date.now());
  return n;
}
// La purga destructiva de la versión anterior queda ANULADA (borraba datos sin avisar ni preguntar).
async function ejecutarPurgaInicial(){
  const n = await borrarDatosDeVoz();
  if(n){
    diag('Datos de voz borrados por seguridad (' + n + ' registros). Función desactivada mientras se rediseña.');
    const av = $('#entAviso'); if(av){ av.hidden = false;
      av.textContent = '🔒 Se borraron los datos de la voz entrenada (' + n + ' registros) y la función quedó desactivada mientras se rediseña su seguridad.'; }
  }
}
ejecutarPurgaInicial().catch(()=>{});

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
       // Daniela es la única voz argentina de Piper y el modelo más pesado de todos: medido, tarda
       // ~1,45 veces lo que dura el audio (las demás voces van ~6 veces más rápido que la lectura),
       // así que en vivo hace una pausa en cada frase. Con «Preparar audio completo» funciona bien.
       {id: 'es_AR-daniela-high', ruta: 'es/es_AR/daniela/high', nombre: 'Daniela · Argentina', mb: 114, lenta: true},
       {id: 'es_ES-sharvard-medium', ruta: 'es/es_ES/sharvard/medium', nombre: 'Sharvard · España', mb: 77}],
  en: [{id: 'en_US-lessac-medium', ruta: 'en/en_US/lessac/medium', nombre: 'Lessac · EE. UU.', mb: 63},
       {id: 'en_US-amy-medium', ruta: 'en/en_US/amy/medium', nombre: 'Amy · EE. UU.', mb: 63}],
};
if(store.get('na:es') === 'es_MX-ald-medium'){ store.set('na:es', 'es_MX-claude-high'); }
// dónde está el modelo: las voces de Piper en Hugging Face; «Mi voz entrenada», guardada en el teléfono
const urlModeloNA = v => v.modelo || PIPER + v.ruta + '/' + v.id + '.onnx';
if(VOZ_SENSIBLE_ACTIVA){ const m = store.get('vozEntrenada', null); if(m) VOCES_NA.es.unshift({id: 'mi-voz-entrenada', nombre: 'Mi voz entrenada', mb: m.mb, modelo: new URL('mi-voz-entrenada/voz.onnx', location.href).href}); }
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
  await Promise.all([tx('docs','readwrite', s=>s.delete(key)), kv.del('audio', key), kv.del('portadas', key), kv.delPrefix('pistas', key + '|'), kv.delPrefix('pistas', 'na|' + key + '|')]);   // tu voz y la voz natural de ese libro
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
  precalentarNA();
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
  if(NA.prep){ NA.prep = false; NA.prepTok++; }
  $('#blackBtn').hidden = isAudioDoc() || modo !== 'telefono';
  updateVoiceBtn();
  actualizarNA();
  if(modo === 'mivoz' && store.get('vozSE')) setTimeout(() => precalentarMV(), 500);
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
    ? `Para que suenen mejor, instala voces de mejor calidad en ${missing.map(l=>l==='es'?'español':'inglés').join(' y ')}: ` + ({
        ios: 'en Ajustes › Accesibilidad › Contenido leído › Voces, elige una que diga «Mejorada» o «Premium».',
        android: 'en Ajustes › Sistema › Idiomas › Salida de texto a voz, elige Google e instala el idioma.',
        windows: 'en Configuración › Hora e idioma › Voz › Agregar voces (y usa Edge, que trae voces «Natural»).'}[PLAT] || 'en la configuración de voz del sistema.') : '';
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
            pag: null, url: null, sig: null, listo: null, relevoT: null, guardado: 0, turno: 0,
            enCurso: new Map(), mem: new Map(), cfg: null, tick: null, silencios: 0, silencioSeg: 0};
            // enCurso: frases generándose ahora (para no repetir trabajo); mem: audio listo sin pasar por el disco;
            // cfg: procesos del motor ya ajustados; tick: el adelanto mientras se escucha; silencios: esperas ya sufridas

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

function firmaMV(){ const b = store.get('vozBase'); return 'mvp' + store.get('vozHash', '') + '-' + (b ? b.es.clave + '.' + b.en.clave : ''); }
// Voces base de «Mi voz»: voces Piper que hablan español de verdad (las de Kokoro tenían acento inglés: el
// conversor cambia el timbre, pero el acento y la entonación son los de la voz base). Se usa la más parecida
// a tu huella; sus huellas se calcularon de antemano (voz/huellas-piper.json).
const BASES_MV = {
  es: [{id: 'es_MX-claude-high', ruta: 'es/es_MX/claude/high', sid: 0, nombre: 'Claude · México (mujer)', mb: 63, acento: 'latino'},
       {id: 'es_MX-ald-medium', ruta: 'es/es_MX/ald/medium', sid: 0, nombre: 'Ald · México (hombre)', mb: 63, acento: 'latino'},
       {id: 'es_ES-sharvard-medium', ruta: 'es/es_ES/sharvard/medium', sid: 1, nombre: 'Sharvard · España (mujer)', mb: 77, acento: 'espana'},
       {id: 'es_ES-sharvard-medium', ruta: 'es/es_ES/sharvard/medium', sid: 0, nombre: 'Sharvard · España (hombre)', mb: 77, acento: 'espana'}],
  en: [{id: 'en_US-amy-medium', ruta: 'en/en_US/amy/medium', sid: 0, nombre: 'Amy · EE. UU.', mb: 63},
       {id: 'en_US-lessac-medium', ruta: 'en/en_US/lessac/medium', sid: 0, nombre: 'Lessac · EE. UU.', mb: 63}],
};
BASES_MV.es.concat(BASES_MV.en).forEach(b => b.clave = b.id + (b.sid ? '#' + b.sid : ''));
let huellasPiper = null;
async function basesMasParecidas(tgt){
  if(!huellasPiper) huellasPiper = await (await fetch('voz/huellas-piper.json')).json();
  const base = {};
  for(const l of ['es', 'en']){
    let mejor = null;
    // el acento lo pone la voz base (el conversor solo cambia el timbre): por defecto, latinoamericano
    const acento = store.get('mvAcento', 'latino');
    for(const b of BASES_MV[l].filter(b => l === 'en' || b.acento === acento)){
      const se = Float32Array.from(huellasPiper[b.clave]), sim = MV.M.parecido(se, tgt);
      if(!mejor || sim > mejor.sim) mejor = {...b, se, sim};
    }
    base[l] = mejor;
  }
  return base;
}
// La voz base lee el texto (Piper, en el proceso de la voz natural) y queda a 24 kHz, lista para el conversor.
async function hablarBaseMV(texto, l, b, avance){
  const idioma = l === 'en' ? 'en' : 'es';
  await cargarModeloNA(b, idioma, 0, avance);
  const a = recortarNA(await llamarNA('hablar', [b.id, texto, 1, undefined, b.sid], [], 0));
  return MV.M.remuestrear(Float32Array.from(a), NA.sr, MV.M.SR);
}
const claveMV = i => `${doc.key}|${firmaMV()}|${i}`;
async function discoMV(){
  const pref = `${doc.key}|${firmaMV()}|`;
  if(MV.pref === pref) return;
  MV.pref = pref; MV.enDisco = new Set();
  MV.mem.clear();                       // lo que estaba listo era de otro libro u otra voz
  MV.enCurso.clear();
  const ks = await kv.keys('pistas', pref) || [];
  if(MV.pref === pref) ks.forEach(k => MV.enDisco.add(+k.slice(pref.length)));
}
const frasesDePagina = p => { const a = pageStarts[p], b = p + 1 < pageStarts.length ? pageStarts[p + 1] : flat.length; return Array.from({length: b - a}, (_, k) => a + k); };
const paginaLista = p => { const f = frasesDePagina(p); return f.length > 0 && f.every(i => listaMV(i)); };

// Carga el conversor de timbre (la primera vez ~66 MB, más la voz base de Piper) y elige la voz base más parecida a la tuya.
async function motorMV(avance = ()=>{}){
  await motorBaseMV(avance);
  await elegirBase();
}
// El motor de voz (voz natural + conversor de timbre) sin exigir una voz grabada: la grabación guiada lo usa
// para medir la similitud antes de que exista tu voz.
async function motorBaseMV(avance = ()=>{}){
  if(!MV.M) MV.M = await import('./voz/motor.js');
  if(!MV.configurado){
    MV.configurado = true;
    let gpu = false;   // «lectora:sinGPU» simula un iPhone sin tarjeta gráfica para probar
    try{ gpu = !store.get('sinGPU', false) && !!(navigator.gpu && await navigator.gpu.requestAdapter()); }catch(e){}
    MV.M.configurar({gpu});
  }
  await MV.M.prepararConversor(avance);              // la voz base es Piper: Kokoro ya no se baja ni se carga
}
async function elegirBase(){
  const h = store.get('vozSE'); if(!h) throw new Error('Primero graba tu voz.');
  MV.tgt = Float32Array.from(h);
  const g = store.get('vozBase');
  if(g && g.hash === store.get('vozHash') && g.es.clave && g.acento === store.get('mvAcento', 'latino')){
    const de = x => ({...BASES_MV[x.l].find(b => b.clave === x.clave), se: Float32Array.from(x.se)});
    MV.base = {es: de({...g.es, l: 'es'}), en: de({...g.en, l: 'en'})};
    if(MV.base.es.id && MV.base.en.id) return;
  }
  MV.base = await basesMasParecidas(MV.tgt);
  store.set('vozBase', {hash: store.get('vozHash'), acento: store.get('mvAcento', 'latino'), es: {clave: MV.base.es.clave, se: Array.from(MV.base.es.se)}, en: {clave: MV.base.en.clave, se: Array.from(MV.base.en.se)}});
  diag(`«Mi voz»: voz base ${MV.base.es.nombre} (parecido ${Math.round(MV.base.es.sim * 100)}%) y ${MV.base.en.nombre} en inglés`);
  MV.pref = null;
}
function avanceMV(msg, n, t){
  const txt = t > 1000 ? `${msg}: ${Math.round(n / 1e6)} de ${Math.round(t / 1e6)} MB (solo la primera vez; usa Wi-Fi).` : msg + '…';
  $('#mvDescarga').textContent = txt;
  if(playing || !$('#status').hidden) showStatus(txt, null, t ? n / t : null);
}
async function precalentarMV(){
  if(!store.get('vozSE')) return;
  try{
    if(!MV.M) MV.M = await import('./voz/motor.js');
    if(await MV.M.modelosGuardados(true, true)){
      await motorMV(()=>{});
      // sin Kokoro alcanza la memoria para dejar abiertos los 2 procesos de timbre y cargada la voz base:
      // así «Leer» no hace una pausa en la segunda frase mientras se abren
      await asegurarCfgMV();
      cargarModeloNA(MV.base.es, 'es', 0, ()=>{}).catch(()=>{});
    }
  }catch(e){}
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
    // Mientras se escucha no se prueban configuraciones: cambiar la cantidad de procesos a mitad de la
    // lectura la dejaría esperando. Se usa la que ya se midió (o la que está en uso).
    let plan = (conGPU || elegido || playing) ? null : PRUEBAS.slice(), resultados = [];
    let actual = conGPU ? [1, 1] : (elegido || (playing ? [1, 1] : PRUEBAS[0]));
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
      // La pre-generación usa la misma vía de generación que la lectura (asegurarFraseMV): así nunca
      // quedan frases saltadas (antes, si una estaba en curso, la pre-generación la daba por hecha y la
      // lectura se quedaba esperando justo esa) y si estás escuchando, las dos esperan el mismo trabajo.
      const s = flat[i];
      const job = (async ()=>{
        await asegurarFraseMV(i);
        if(tok !== MV.prepTok || doc !== d || !listaMV(i)) return;
        letras += s.t.length;
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
  // Con la función de voz entrenada desactivada, «Mi voz» es otra vez la grabación local del teléfono.
  const tiene = VOZ_SENSIBLE_ACTIVA ? !!store.get('vozEntrenada') : !!store.get('vozSE');
  if($('#recEmpty')) $('#recEmpty').hidden = tiene;
  if($('#recDone')) $('#recDone').hidden = !tiene;
  if($('#recBtn')){
    $('#recBtn').textContent = tiene ? '● Grabar de nuevo' : '● Grabar mi voz';
    $('#recBtn').disabled = false;
  }
  if(typeof actualizarBovedaUI === 'function') actualizarBovedaUI();
  if($('#recPlay')) $('#recPlay').hidden = !tiene;
  if($('#mvTest')) $('#mvTest').hidden = !tiene;
  if($('#mvComparar')) $('#mvComparar').hidden = !tiene;
  if($('#recSim')) $('#recSim').hidden = true;
  if($('#mvPrepBox')) $('#mvPrepBox').hidden = !tiene || !doc || isAudioDoc();
  if(!doc || isAudioDoc() || !tiene) return;
  const conTexto = doc.pages.map((_, p) => p).filter(p => frasesDePagina(p).length);
  const listas = conTexto.filter(paginaLista).length;
  if($('#mvBar')) $('#mvBar').style.width = Math.round(listas / Math.max(1, conTexto.length) * 100) + '%';
  let t = `${listas} de ${conTexto.length} páginas listas con tu voz.`;
  if(MV.prep) t += MV.falta != null ? ` Pre-generando… faltan ~${fmtTime(MV.falta)}. Puedes cancelar cuando quieras.` : ' Pre-generando…';
  else if(listas < conTexto.length) t += ' Toca «Leer» (▶) para escuchar al vuelo al instante, o pre-genera todo el libro.';
  else t += ' Audio completo listo: guardado en tu teléfono.';
  if($('#mvEstado')) $('#mvEstado').textContent = t;
  if($('#mvPrep')){
    $('#mvPrep').textContent = MV.prep ? 'Detener' : (listas ? (listas === conTexto.length ? 'Re-generar libro completo' : 'Seguir pre-generando') : 'Pre-generar con mi voz');
    $('#mvPrep').hidden = false;
  }
}
if($('#mvPrep')) $('#mvPrep').onclick = prepararMV;

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
// Un solo proceso genera la voz: cada uno necesita cientos de MB y el iPhone cierra la página si se pasa
// («Ocurrió un problema»). (La app es solo para celular.)
const NA = {ws: [], max: 1, limite: Infinity, n: 0, pend: new Map(), cargadas: new Map(), bajadas: new Map(), sr: 22050,
            tok: 0, pos: -1, corre: false, dormidos: [], esperas: new Map(), hechas: new Map(), cub: null, enCurso: new Map(), pref: null, prep: false, prepTok: 0, falta: null};

function procesoNA(k){
  if(NA.ws[k]) return NA.ws[k];
  const w = NA.ws[k] = new Worker('voz/piper-worker.js', {type: 'module'});
  w.onmessage = e => {
    const {id, ok, r, error} = e.data; const p = NA.pend.get(id); if(!p) return;
    NA.pend.delete(id); ok ? p.res(r) : p.rej(new Error(error));
  };
  w.onerror = e => { diag('el proceso de la voz falló: ' + (e.message || 'sin detalle')); reiniciarProceso(k, e.message || 'La voz natural falló.'); };
  return w;
}
// Cierra un proceso de voz y olvida lo que tenía: el siguiente pedido crea uno limpio. Cerrar el proceso
// es lo único que le devuelve su memoria al iPhone (soltar la voz adentro no la devuelve).
function reiniciarProceso(k, motivo){
  const w = NA.ws[k];
  NA.ws[k] = null;
  if(w) try{ w.terminate(); }catch(e){}
  for(const [id, p] of [...NA.pend]) if(p.k === k){ NA.pend.delete(id); clearTimeout(p.t); p.rej(new Error(motivo || 'detenido')); }
  for(const c of [...NA.cargadas.keys()]) if(c.startsWith(k + '|')) NA.cargadas.delete(c);
}
// Al cambiar de voz o dejar de usar la natural: todo de nuevo, sin la memoria de la voz anterior.
function soltarNA(){
  pararNA(true);
  NA.ws.forEach((w, k) => reiniciarProceso(k, 'detenido'));
  NA.cargadas.clear();
}
// Si el proceso no contesta (por ejemplo, el iPhone lo cerró por memoria sin avisar), se reinicia en vez de
// quedar esperando para siempre.
const ESPERA_NA = {cargar: 60000, hablar: 30000, soltar: 15000};
const llamarNA = (fn, args, transferir = [], k = 0) => new Promise((res, rej) => {
  const id = ++NA.n, p = {k, res: r => { clearTimeout(p.t); res(r); }, rej: e => { clearTimeout(p.t); rej(e); }};
  p.t = setTimeout(() => {
    if(!NA.pend.has(id)) return;
    diag(`la voz no respondió (${fn}): se reinicia`);
    reiniciarProceso(k, 'La voz no respondió. Toca reproducir para intentar de nuevo.');
  }, ESPERA_NA[fn] || 60000);
  NA.pend.set(id, p);
  procesoNA(k).postMessage({id, fn, args}, transferir);
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
  const idioma = l === 'en' ? 'en' : 'es';
  return cargarModeloNA(vozNA(idioma), idioma, k);
}
// Una voz de Piper por idioma en el proceso: cargar otra del mismo idioma suelta la anterior.
function cargarModeloNA(v, idioma, k = 0, avanceExtra){
  const clave = k + '|' + idioma;
  // otra voz del mismo idioma: el proceso suelta la anterior al cargar esta
  if(NA.cargadas.has(clave) && NA.cargadas.get(clave).id !== v.id) NA.cargadas.delete(clave);
  if(!NA.cargadas.has(clave)) NA.cargadas.set(clave, (async ()=>{
    let modelo, config;
    if(v.id === 'mi-voz-entrenada'){
      if(!VOZ_SENSIBLE_ACTIVA) throw new Error('La voz entrenada está desactivada por seguridad (en revisión). Nada de sus datos se lee ni sale de este teléfono.');
      const cifrado = await kv.get('voz', 'modelo_cifrado');
      const meta = await kv.get('voz', 'boveda_meta');
      if(!cifrado || !meta) throw new Error('No se encontró tu voz cifrada en la bóveda de este dispositivo.');
      showStatus('Verifica tu identidad con ' + BovedaBiometrica.nombreBiometria() + ' para activar tu voz…');
      let cryptoKey;
      try {
        cryptoKey = await BovedaBiometrica.desbloquear(meta);
      } catch(err) {
        hideStatus();
        throw err;
      }
      showStatus('Descifrando modelo en memoria segura RAM…');
      const paquete = await BovedaBiometrica.descifrar(cifrado, cryptoKey);
      const dec = BovedaBiometrica.desempaquetar(paquete);
      modelo = dec.onnx; config = dec.json;
    } else {
      const avance = avanceExtra || ((n, t) => showStatus(`Bajando la voz ${v.nombre}: ${Math.round(n / 1e6)} de ${Math.round((t || v.mb * 1e6) / 1e6)} MB (solo la primera vez; usa Wi-Fi).`, null, t ? n / t : null));
      [modelo, config] = await Promise.all([bajarNA(urlModeloNA(v), avance), bajarNA(urlModeloNA(v) + '.json', ()=>{})]);
    }
    NA.sr = await llamarNA('cargar', [v.id, modelo, config, idioma], [modelo, config], k);
    if(!$('#statusProg').hidden) hideStatus();
  })().catch(e => { if(NA.cargadas.get(clave)?.id === v.id) NA.cargadas.delete(clave); throw e; }));
  NA.cargadas.get(clave).id = v.id;
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
  NA.cub = new Uint8Array(flat.length);
  const ks = await kv.keys('pistas', pref) || [];
  if(NA.pref !== pref) return;
  for(const k of ks){
    const [i, hasta, n] = k.slice(pref.length).split('|').map(Number);
    if(!NA.hechas.has(i)){ NA.hechas.set(i, {hasta, n, k}); marcarNA(i, hasta); }
  }
  actualizarNA();
  // Se borra la voz natural de otras voces (ya no sirve) y la de libros que no se abren hace más de 14 días
  // o que ya no están en la biblioteca. Lo preparado de los demás libros se conserva («Preparar audio
  // completo» no se pierde al abrir otro libro). La clave termina en |frase|hasta|muestras, y el nombre del
  // libro puede llevar «|», así que se lee desde el final.
  const voces = `${vozNA('es').id}+${vozNA('en').id}`, libros = new Map(lib().map(x => [x.key, x])), viejo = Date.now() - 14 * 864e5;
  const borrar = new Set();
  for(const k of await kv.keys('pistas', 'na|') || []){
    if(k.startsWith(pref)) continue;
    const partes = k.split('|'), v = partes[partes.length - 4], libro = partes.slice(1, -4).join('|');
    const it = libros.get(libro);
    if(v !== voces || (libro !== 'ejemplo' && (!it || (it.opened || it.added || 0) < viejo))) borrar.add(`na|${libro}|${v}|`);
  }
  for(const p of borrar) kv.delPrefix('pistas', p).catch(()=>{});
}
// Qué frases ya están listas, en una tabla: antes se recorría la lista entera por cada frase (con un libro
// largo eso era lentísimo y la app parecía colgada al preparar o al mostrar el avance).
function marcarNA(i, hasta){
  if(!NA.cub || hasta >= NA.cub.length) return;
  for(let k = i; k <= hasta; k++) NA.cub[k] = 1;
}
let adelanteCache = {t: 0, v: 0};
const adelanteSeg = () => {
  const ahora = Date.now();
  if(ahora - adelanteCache.t < 400) return adelanteCache.v;
  let n = 0; for(const [i, h] of NA.hechas) if(i >= idx) n += h.n;
  adelanteCache = {t: ahora, v: n / NA.sr};
  return adelanteCache.v;
};
function despertarNA(){ const d = NA.dormidos; NA.dormidos = []; d.forEach(r => r()); }
function mostrarAdelanto(){
  const el = $('#naAdelanto');
  if(!el || $('#scrim').hidden || modo !== 'natural' || !doc || isAudioDoc() || NA.pref !== firmaNA()) return;
  const s = adelanteSeg();
  el.textContent = s > 30 ? `Listo por adelantado en este libro: ~${fmtTime(s / rate)}.` : '';
}

const fraseHechaNA = i => !!NA.cub && NA.cub[i] === 1;
const paginaListaNA = p => {
  const f = frasesDePagina(p);
  return f.length > 0 && f.every(fraseHechaNA);
};
function actualizarNA(){
  const box = $('#naPrepBox');
  if(!box) return;
  box.hidden = !doc || isAudioDoc();
  if(!doc || isAudioDoc()) return;
  const conTexto = doc.pages.map((_, p) => p).filter(p => frasesDePagina(p).length);
  const listas = conTexto.filter(paginaListaNA).length;
  $('#naBar').style.width = Math.round(listas / Math.max(1, conTexto.length) * 100) + '%';
  let t = `${listas} de ${conTexto.length} páginas listas con voz natural.`;
  if(NA.prep) t += NA.falta != null ? ` Preparando… faltan ~${fmtTime(NA.falta)}. Deja LectorLibre abierta y el teléfono cargando.` : ' Preparando…';
  else if(listas < conTexto.length) t += ' Toca «Preparar audio completo» para no tener cortes.';
  else t += ' Audio completo listo: sonará de corrido aunque bloquees la pantalla.';
  $('#naEstado').textContent = t;
  $('#naPrep').textContent = NA.prep ? 'Detener' : (listas ? (listas === conTexto.length ? 'Repreparar audio completo' : 'Seguir preparando') : 'Preparar audio completo');
}
async function prepararLibroNA(){
  if(NA.prep){ NA.prep = false; NA.prepTok++; actualizarNA(); return; }
  if(!doc || isAudioDoc()) return;
  NA.prep = true;
  const tok = ++NA.prepTok, d = doc;   // turno propio: leer mientras se prepara no la corta (ni al revés)
  holdScreen(true);
  try{
    await discoNA();
    const orden = [];
    for(let i = idx; i < flat.length; i++) if(!fraseHechaNA(i)) orden.push(i);
    for(let i = 0; i < idx; i++) if(!fraseHechaNA(i)) orden.push(i);
    const t0 = performance.now(); let letras = 0;
    const pref = firmaNA(), letrasTotal = orden.reduce((x, i) => x + flat[i].t.length, 0);

    for(let k = 0; k < orden.length; k++){
      const i = orden[k];
      if(tok !== NA.prepTok || doc !== d) break;
      if(fraseHechaNA(i)) continue;
      const hasta = finUnidad(i), s = flat[i];
      let texto = textoNA(s); for(let j = i + 1; j <= hasta; j++) texto += ' ' + textoNA(flat[j]);
      await cargarVozNA(s.l, 0);
      if(tok !== NA.prepTok || doc !== d) break;
      const a = await llamarNA('hablar', [vozNA(s.l).id, texto], [], 0);
      if(tok !== NA.prepTok || doc !== d || firmaNA() !== pref) break;
      const v = empacar(recortarNA(a)), clave = pref + String(i).padStart(7, '0') + '|' + hasta + '|' + v.n;
      await kv.put('pistas', clave, v);
      NA.hechas.set(i, {hasta, n: v.n, k: clave}); marcarNA(i, hasta);
      let letrasUnidad = 0; for(let j = i; j <= hasta; j++) letrasUnidad += flat[j].t.length;
      letras += letrasUnidad;
      NA.falta = letras ? (performance.now() - t0) / 1000 / letras * (letrasTotal - letras) : null;
      actualizarNA(); mostrarAdelanto();
    }
  }catch(e){
    diag('error preparando libro natural: ' + (e && e.message || e));
    $('#naEstado').textContent = (e && e.message) || String(e);
  }finally{
    if(tok === NA.prepTok){ NA.prep = false; NA.falta = null; }
    if(!playing) holdScreen(false);
    actualizarNA();
  }
}

async function generarNA(desde){
  const tok = ++NA.tok; NA.pos = desde; NA.corre = true;
  let reservadas = 0;
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
      if(i >= flat.length || reservadas >= NA.limite) return;
      // la primera de cada tanda va sola (sin juntar trozos): así empieza a sonar antes
      const s = flat[i], hasta = reservadas === 0 ? i : finUnidad(i);
      reservadas++;
      NA.pos = hasta + 1; NA.enCurso.set(i, hasta);
      try{
        let texto = textoNA(s); for(let j = i + 1; j <= hasta; j++) texto += ' ' + textoNA(flat[j]);
        await cargarVozNA(s.l, k);
        if(tok !== NA.tok && !NA.esperas.has(i)) return;
        const t0 = performance.now();
        const a = await llamarNA('hablar', [vozNA(s.l).id, texto], [], k);
        const ms = performance.now() - t0;
        if(!doc || firmaNA() !== pref) return;               // cambiaste de libro o de voz
        const v = empacar(recortarNA(a)), clave = pref + String(i).padStart(7, '0') + '|' + hasta + '|' + v.n;
        await kv.put('pistas', clave, v);
        NA.hechas.set(i, {hasta, n: v.n, k: clave}); marcarNA(i, hasta); soltar();
        const w = NA.esperas.get(i); if(w){ NA.esperas.delete(i); w.res(); }
        // Fuera de la app, el iPhone cierra a la que usa mucho procesador por un minuto: se genera una frase
        // y se descansa 1,5 veces lo que tomó (40 % del procesador; igual va más rápido que la lectura).
        if(document.visibilityState === 'hidden'){
          diag(`generó ${(v.n / NA.sr).toFixed(0)} s de voz en ${(ms / 1000).toFixed(1)} s · listo ${Math.round(adelanteSeg())} s`);
          if(!NA.esperas.size) await new Promise(r => setTimeout(r, ms * 1.5));
        }
        mostrarAdelanto();
      }catch(e){
        if(tok !== NA.tok || !doc || firmaNA() !== pref){ if(i < NA.pos) NA.pos = i; return; }   // cambiaste de voz a mitad
        diag('error de la voz: ' + (e && e.message || e));
        if(k === 0) throw e;
        NA.max = 1;                                           // el segundo proceso no pudo: sigue uno solo
        if(i < NA.pos) NA.pos = i;
        return;
      }finally{ NA.enCurso.delete(i); }
    }
  };
  try{ await Promise.all(Array.from({length: NA.max}, (_, k) => trabajar(k))); }
  catch(e){ if(tok === NA.tok){ for(const w of NA.esperas.values()) w.rej(e); NA.esperas.clear(); } }
  finally{ if(tok === NA.tok) NA.corre = false; }
}
// Al abrir un libro (o cambiar de voz) con la voz natural ya bajada: se carga la voz y se deja un adelanto
// listo (no solo la primera frase), para que al tocar «Leer» suene al instante y no se corte al empezar.
// (No baja nada nuevo y se detiene solo al llegar al adelanto.)
const PRECALENTADO_SEG = 25;
function unidadesNA(desde, seg = PRECALENTADO_SEG){
  const n = [];
  let t = 0;
  for(let k = desde; k < flat.length && t < seg; ){
    const h = finUnidad(k);
    let letras = 0; for(let j = k; j <= h; j++) letras += flat[j].t.length;
    n.push(k); t += letras / 15;                 // ~15 letras por segundo de lectura
    k = h + 1;
  }
  return Math.max(1, n.length);
}
let precalentando = null;
function precalentarNA(yLeer, espera){
  clearTimeout(precalentando);
  precalentando = setTimeout(async ()=>{
    NA.seguir = false;
    if(!esNatural() || !flat.length || (playing && !yLeer)) return;
    try{
      const tieneModelo = v.id === 'mi-voz-entrenada' ? !!(await kv.get('voz', 'modelo_cifrado')) : !!(await c.match(urlModeloNA(v)));
      if(!tieneModelo){ if(yLeer) play(); return; }
      await discoNA();
      if(yLeer){ play(); return; }
      await cargarVozNA(l, 0);
      if(!playing && !NA.corre && !NA.hechas.has(idx)){ NA.limite = unidadesNA(idx); generarNA(idx); }
    }catch(e){}
  }, espera ?? (yLeer ? 0 : 400));
}
function pararNA(limpiar){
  NA.tok++; NA.corre = false;
  despertarNA();
  for(const w of NA.esperas.values()) w.rej(new Error('detenido'));
  NA.esperas.clear();
  if(limpiar){ NA.pref = null; NA.hechas = new Map(); NA.cub = null; adelanteCache.t = 0; }
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
  get sr(){ return NA.sr; }, max: 600,
  lista: i => NA.hechas.has(i),
  async primera(i){ await discoNA(); await esperarNA(i); },
  async audio(i){
    const h = NA.hechas.get(i); if(!h) return null;
    const a = desempacar(await kv.get('pistas', h.k));
    return a && {a: aEntero(a), hasta: h.hasta};
  },
  usada(i){
    despertarNA();
  },
};

/* ================= Escuchar como audio: «Mi voz» en vivo y la voz natural ================= */
// Varias frases seguidas forman un solo audio (un «bloque»), con las pausas de lectura y el tiempo de cada
// frase. Mientras más largo el bloque, menos veces tiene que despertarse la app con el teléfono bloqueado o
// en otra app (gasta menos batería y hay menos riesgo de corte al cambiar de audio). Con la voz natural el
// primer bloque es corto (empieza a sonar enseguida) y los siguientes crecen a medida que el generador se adelanta.

/* ---------- «Mi voz» en vivo: generar por delante para que no haya esperas entre frases ---------- */
// Tres cosas hacían que la lectura con tu voz se cortara: cada frase se generaba dos veces (la pedían a la
// vez la reproducción y el adelanto), el motor trabajaba con un solo proceso aunque el teléfono aguantara
// más, y el audio tenía que ir al disco antes de sonar. Aquí se arreglan las tres: una sola generación por
// frase, los procesos que ya se midieron en «Pre-generar con mi voz», y el audio pasa a la lectura por
// memoria mientras se guarda en el teléfono.
async function asegurarCfgMV(){
  if(!MV.cfg){
    MV.cfg = (async ()=>{
      await motorMV(avanceMV);
      // sin Kokoro queda memoria para 2 procesos de timbre (con 1 solo, el timbre no alcanza el ritmo de la lectura)
      const conf = MV.M.usaGPU() ? [1, 1] : [1, Math.max(2, (store.get('mvProcesos', null) || [1, 2])[1])];
      // Abrir los procesos de más se hace de fondo: si se esperara, la primera frase tardaría varios
      // segundos más (cada proceso extra carga sus modelos). La frase 1 ya sale con los que hay.
      // Si hay una pre-generación en curso, ella manda: es la que está midiendo cuántos procesos convienen.
      if(!MV.prep) Promise.resolve().then(() => MV.M.ajustar(...conf)).then(
        () => diag('«Mi voz» en vivo: ' + conf[0] + ' de voz y ' + conf[1] + ' de timbre a la vez'),
        () => {});
      return conf;
    })();
    MV.cfg.catch(()=>{ MV.cfg = null; });
  }
  return MV.cfg;
}
const listaMV = i => MV.enDisco.has(i) || MV.mem.has(i);
// Una sola generación por frase, aunque la pidan a la vez la reproducción y el adelanto.
function asegurarFraseMV(i){
  if(listaMV(i)) return Promise.resolve();
  const ya = MV.enCurso.get(i);
  if(ya) return ya;
  const d = doc;
  const p = (async ()=>{
    await asegurarCfgMV();
    // la firma se toma después de elegir la voz base: justo después de grabar tu voz, esa elección cambia la
    // firma y antes las primeras frases se descartaban (y la lectura esperaba a que se hicieran otra vez)
    if(doc !== d) return null;
    const pref = firmaMV(), clave = claveMV(i);
    if(!MV.base) throw new Error('Primero graba tu voz.');
    const s = flat[i], b = MV.base[s.l] || MV.base.es;
    const crudo = await hablarBaseMV(textoNA(s), s.l, b);
    const a = await MV.M.convertir(crudo, b.se, MV.tgt);
    if(doc !== d || firmaMV() !== pref) return null;
    MV.mem.set(i, a);                                   // lista para sonar ya mismo
    while(MV.mem.size > 10) MV.mem.delete(MV.mem.keys().next().value);
    kv.put('pistas', clave, empacar(a)).then(() => MV.enDisco.add(i))
      .catch(e => diag('no se pudo guardar tu voz: ' + (e && e.message || e)));
    actualizarMV();
    return a;
  })();
  MV.enCurso.set(i, p);
  p.then(()=>{}, ()=>{}).then(()=>{ if(MV.enCurso.get(i) === p) MV.enCurso.delete(i); });
  return p;
}
// Pide varias frases seguidas: así los procesos del motor trabajan en paralelo en vez de una por una.
const MV_VENTANA = 6;
function pedirMV(desde, ventana = MV_VENTANA){
  for(let i = Math.max(0, desde), fin = Math.min(flat.length, desde + ventana); i < fin; i++)
    asegurarFraseMV(i).catch(()=>{});
}
// Mientras se escucha, mantiene llena la ventana de frases por delante (cada una se pide una sola vez).
function adelantoMV(){
  clearTimeout(MV.tick);
  const paso = ()=>{
    if(!playing || !esMiVoz() || !store.get('vozSE')){ MV.tick = null; return; }
    const desde = (ST.sb && !ST.fin) ? ST.sig : (MV.pag ? MV.pag.ult + 1 : idx);
    if(desde < flat.length && !(ST.sb && cargadoST() > CARGADO_SEG - 15)) pedirMV(desde);
    MV.tick = setTimeout(paso, 300);
  };
  MV.tick = setTimeout(paso, 0);
}

const fuenteMV = {
  sr: SRV, max: 600,
  lista: listaMV,
  async primera(i){
    if(listaMV(i)) return;
    if(!store.get('vozSE')) throw new Error('Primero graba tu voz.');
    await asegurarFraseMV(i);
  },
  async audio(i){
    if(!listaMV(i) && store.get('vozSE')) await asegurarFraseMV(i);
    const mem = MV.mem.get(i);
    if(mem){ MV.mem.delete(i); return {a: aEntero(mem), hasta: i}; }   // sin pasar por el disco
    let a = desempacar(await kv.get('pistas', claveMV(i)));
    if(!a && store.get('vozSE')){                                       // el guardado no llegó: se genera otra vez
      MV.enDisco.delete(i);
      await asegurarFraseMV(i);
      a = MV.mem.get(i); if(a) MV.mem.delete(i);
      if(!a) a = desempacar(await kv.get('pistas', claveMV(i)));
    }
    return a && {a: aEntero(a), hasta: i};
  },
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
// bloqueada o en otra app no deja seguir, y la app se duerme). Si la voz natural todavía no alcanzó a
// generar lo que sigue, se queda dando vueltas en ese silencio hasta que esté (el audio nunca termina).
const COLA = 20;
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
  reproductores.forEach(el => { try{ el.disableRemotePlayback = true; }catch(e){} });
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
  if(MV.esperando){ MV.esperando = 0; hideStatus(); }
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
  prepararSiguiente();
}
function seguirGenerando(){
  if(esNatural()){
    NA.limite = Infinity;
    if(NA.corre || !MV.pag) return;
    const q = (MV.listo ? MV.listo.b.ult : MV.pag.ult) + 1;
    if(q < flat.length) generarNA(q);
  } else if(esMiVoz()){
    adelantoMV();
  }
}
// El bloque siguiente se arma apenas empieza este (con la pantalla bloqueada, el iPhone puede tardar en
// avisar que el audio va terminando) y queda cargado en el otro reproductor.
function prepararSiguiente(){
  const b = MV.pag;
  if(!b || MV.sig || MV.listo || !playing) return;
  const q = b.ult + 1;
  if(q >= flat.length) return;
  const p = MV.sig = (async ()=>{
    if(esMiVoz()){ await discoMV(); if(!fuenteMV.lista(q) && store.get('vozSE')) await fuenteMV.primera(q).catch(()=>null); }
    const nb = await armarBloque(q);
    if(!nb) return null;
    if(MV.pag !== b){ soltarBloque(nb, null); return null; }
    const el = otroReproductor();
    el.src = nb.url; el.playbackRate = rate; el.load();
    MV.listo = {b: nb, el};
    if(audioVoz.currentTime >= b.fin - 0.15) relevar();      // ya estaba esperando en el silencio final
    else programarRelevo();
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
  if(!MV.listo) prepararSiguiente();
  if(MV.listo){
    if(quedan <= 0.15){
      if(MV.esperando){ MV.silencioSeg += (Date.now() - MV.esperando) / 1000; MV.esperando = 0; hideStatus(); }
      relevar();
    }
    return;
  }
  // la voz todavía no tiene lo que sigue: esperar dando vueltas en el silencio final (así el audio nunca
  // «termina», que es lo que el iPhone no deja continuar con la pantalla bloqueada), y anotar la espera
  if(quedan < 0 && b.ult + 1 < flat.length){
    if(!MV.esperando){ MV.esperando = Date.now(); MV.silencios++; diag('esperando la voz (en silencio)'); if(document.visibilityState === 'visible') showStatus('Generando la voz… (sigue sola en cuanto esté lista)'); }
    if(Date.now() - MV.esperando > 3 * 60 * 1000){ MV.esperando = 0; idx = b.ult + 1; stop(); showStatus('La voz se detuvo. Toca reproducir para seguir.'); return; }
    if(audioVoz.currentTime > b.fin + COLA - 6) audioVoz.currentTime = b.fin + 0.5;
  }
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
    diag(`${SISTEMA} no dejó seguir con el bloque siguiente: ` + (e && e.name));
    stop(); showStatus('El teléfono detuvo la lectura. Toca reproducir para seguir.'); return;
  }
  viejo.pause(); soltarBloque(bViejo, viejo);
  MV.ultimoRelevo = Date.now();
  if(document.visibilityState === 'hidden') diag(`siguiente bloque: ${Math.round(L.b.fin)} s`);
  seguirGenerando();
  prepararSiguiente();
  save(true);
  if(document.visibilityState === 'visible') showSentence(true);
}
// Al cambiar de libro, de voz o de tipo de voz, lo ya armado no sirve.
function olvidarBloques(){
  if(CONTINUO) cerrarST();
  clearTimeout(MV.relevoT); MV.relevoT = null;
  if(MV.listo){ soltarBloque(MV.listo.b, MV.listo.el); MV.listo = null; }
  if(MV.pag){ soltarBloque(MV.pag, audioVoz); MV.pag = null; }
  MV.url = null; MV.sig = null;
}
/* ---------- Un solo reproductor continuo (MediaSource con MP3) ---------- */
// La voz se convierte a MP3 y se le va agregando al final a un mismo audio mientras suena: nunca hay que
// cambiar de audio ni de reproductor (el iPhone tomaba esos cambios como una pausa fuera de la app), y si la
// voz todavía no alcanza, se agrega silencio en vez de dejar que el audio termine. En iPhone usa
// ManagedMediaSource (iOS 17.1 o más nuevo); donde no exista, quedan los dos reproductores de arriba.
const MSE = window.ManagedMediaSource || window.MediaSource;
const CONTINUO = !!MSE && MSE.isTypeSupported('audio/mpeg') && store.get('continuo', true);
const RETRASO_MP3 = 1105;          // muestras que el codificador MP3 agrega al comienzo
const CARGADO_SEG = 300;           // cuánto audio se deja cargado por delante en el reproductor (más puede pasar el límite del iPhone)
const ST = {tok: 0, ms: null, sb: null, url: null, sr: 0, muestras: 0, linea: [], sig: 0, fin: false, motivoFin: '', alimentando: false,
            w: null, n: 0, pend: new Map(), limpiado: 0};

function llamarMP3(fn, extra = {}, transferir = []){
  if(!ST.w){
    ST.w = new Worker('voz/mp3-worker.js');
    ST.w.onmessage = e => { const p = ST.pend.get(e.data.id); if(!p) return; ST.pend.delete(e.data.id); e.data.ok ? p.res(e.data.r) : p.rej(new Error(e.data.error)); };
    ST.w.onerror = e => { for(const p of ST.pend.values()) p.rej(new Error('MP3: ' + (e.message || 'falló'))); ST.pend.clear(); ST.w = null; };
  }
  return new Promise((res, rej) => { const id = ++ST.n; ST.pend.set(id, {res, rej}); ST.w.postMessage({id, fn, ...extra}, transferir); });
}
const rangoST = () => {
  const b = ST.sb && ST.sb.buffered, t = audioVoz.currentTime;
  if(!b || !b.length) return null;
  for(let k = 0; k < b.length; k++) if(b.start(k) <= t + 0.3 && t < b.end(k)) return [b.start(k), b.end(k)];
  return [b.start(b.length - 1), b.end(b.length - 1)];
};
const cargadoST = () => { const r = rangoST(); return r ? Math.max(0, r[1] - audioVoz.currentTime) : 0; };
const enBufferST = t => { const b = ST.sb && ST.sb.buffered; if(!b) return false; for(let k = 0; k < b.length; k++) if(b.start(k) <= t && t < b.end(k) - 0.2) return true; return false; };
function cerrarST(){
  ST.tok++; ST.alimentando = false;
  if(ST.url){ const u = ST.url; setTimeout(() => URL.revokeObjectURL(u), 3000); }
  ST.ms = ST.sb = ST.url = null; ST.linea = []; ST.fin = false; ST.motivoFin = '';
}
function agregarST(bytes){
  const sb = ST.sb;
  return new Promise((res, rej) => {
    const listo = () => { sb.removeEventListener('updateend', listo); sb.removeEventListener('error', mal); res(); };
    const mal = () => { sb.removeEventListener('updateend', listo); sb.removeEventListener('error', mal); rej(new Error('no se pudo agregar el audio')); };
    sb.addEventListener('updateend', listo); sb.addEventListener('error', mal);
    try{ sb.appendBuffer(bytes); }catch(e){ sb.removeEventListener('updateend', listo); sb.removeEventListener('error', mal); rej(e); }
  });
}
async function agregarConEspacioST(bytes){
  try{ await agregarST(bytes); }
  catch(e){
    if(e.name !== 'QuotaExceededError') throw e;
    await borrarAtrasST(5); await agregarST(bytes);
  }
}
// Lo ya escuchado se saca del reproductor (menos memoria), dejando un poco para retroceder.
function borrarAtrasST(margen){
  const hasta = audioVoz.currentTime - margen;
  if(!ST.sb || hasta < 5 || ST.sb.updating) return Promise.resolve();
  return new Promise(res => { ST.sb.addEventListener('updateend', res, {once: true}); try{ ST.sb.remove(0, hasta); }catch(e){ res(); } });
}
async function abrirST(desde){
  cerrarST();
  const tok = ST.tok, F = fuenteAU();
  ST.alimentando = true;                                   // nadie más agrega audio hasta que esté la primera frase
  let primera = null;
  if(esMiVoz() && MV.arranque){ await asegurarCfgMV(); primera = await audioBaseST(desde); }   // voz base: ~1 s
  else await F.primera(desde);                             // la voz cargada y la primera frase lista
  if(tok !== ST.tok) throw new Error('detenido');
  const ms = new MSE();
  ST.ms = ms; ST.sr = F.sr; ST.muestras = 0; ST.linea = []; ST.sig = desde; ST.fin = false;
  audioVoz.disableRemotePlayback = true;                   // lo pide el reproductor continuo del iPhone
  ST.url = URL.createObjectURL(ms);
  audioVoz.src = ST.url; audioVoz.playbackRate = rate; audioVoz.preservesPitch = true;
  await new Promise(r => ms.addEventListener('sourceopen', r, {once: true}));
  if(tok !== ST.tok) throw new Error('detenido');
  ST.sb = ms.addSourceBuffer('audio/mpeg'); ST.sb.mode = 'sequence';
  ms.addEventListener('startstreaming', () => alimentarST());
  await llamarMP3('nuevo', {sr: ST.sr});
  await agregarUnidadST(tok, primera);
  ST.alimentando = false;
}
/* ---------- «Mi voz»: empezar al instante con la voz base ---------- */
// Ponerle tu timbre a una frase tarda más que escucharla (medido: 5,6 s por 4 s de audio en el procesador).
// Para no esperar al tocar «Leer», las primeras frases suenan con la voz base (la que después recibe tu
// timbre), avisando en pantalla, y apenas hay una frase con tu voz se sigue con ella (sin volver a la base).
// Arrancar con la voz base mientras se prepara la tuya solo tiene sentido si HAY una voz tuya grabada.
// Si no (por ejemplo después del borrado de seguridad), se avisa que hay que grabar.
const arranqueMV = () => !!store.get('vozSE') && store.get('mvArranque', true);
async function audioBaseST(i){
  const s = flat[i], b = MV.base[s.l] || MV.base.es;
  return {a: aEntero(await hablarBaseMV(textoNA(s), s.l, b)), hasta: i, base: true};
}
async function agregarUnidadST(tok, dado){
  const F = fuenteAU(), i = ST.sig;
  const r = dado || await F.audio(i);
  if(!r) throw new Error('vacío');
  if(tok !== ST.tok) throw new Error('detenido');
  if(!dado) F.usada(i);
  // una frase generada entera puede cubrir varios trozos: el tiempo de cada uno, según sus letras
  const {a, hasta} = r, sr = ST.sr, base = (ST.muestras + RETRASO_MP3) / sr, dur = a.length / sr;
  let letras = 0, acc = 0; for(let k = i; k <= hasta; k++) letras += flat[k].t.length;
  for(let k = i; k <= hasta; k++){ ST.linea.push({i: k, s: base + dur * acc / letras}); acc += flat[k].t.length; }
  if(ST.linea.length > 3000) ST.linea.splice(0, ST.linea.length - 2000);
  const pcm = new Int16Array(a.length + Math.round(pausaTras(hasta) * sr)); pcm.set(a);
  ST.muestras += pcm.length; ST.sig = hasta + 1;
  const mp3 = await llamarMP3('codificar', {pcm}, [pcm.buffer]);
  if(tok !== ST.tok) throw new Error('detenido');
  await agregarConEspacioST(mp3);
}
async function silencioST(tok, seg){
  const pcm = new Int16Array(Math.round(seg * ST.sr));
  ST.muestras += pcm.length;
  const mp3 = await llamarMP3('codificar', {pcm}, [pcm.buffer]);
  if(tok === ST.tok) await agregarConEspacioST(mp3);
}
async function terminarST(tok, motivo){
  const mp3 = await llamarMP3('terminar');
  if(tok !== ST.tok) return;
  if(mp3.length) await agregarConEspacioST(mp3);
  ST.fin = true; ST.motivoFin = motivo || '';
  try{ if(ST.ms.readyState === 'open') ST.ms.endOfStream(); }catch(e){}
}
const dormir = ms => new Promise(r => setTimeout(r, ms));
// Agrega audio por delante de lo que suena, hasta tener CARGADO_SEG listos.
async function alimentarST(){
  if(ST.alimentando || !ST.sb || ST.fin || !playing) return;
  ST.alimentando = true;
  const tok = ST.tok;
  try{
    while(tok === ST.tok && playing && cargadoST() < CARGADO_SEG){
      if(ST.sig >= flat.length){ await terminarST(tok); break; }
      const F = fuenteAU();
      if(esMiVoz() && MV.arranque){
        if(F.lista(ST.sig)){
          MV.arranque = false;
          diag(`«Mi voz»: desde la frase ${ST.sig + 1}, con tu voz (antes, ${MV.fBase} con la voz base)`);
          if(document.visibilityState === 'visible'){ showStatus('Desde aquí, con tu voz.'); setTimeout(() => { if($('#statusText').textContent === 'Desde aquí, con tu voz.') hideStatus(); }, 4000); }
        } else {
          if(cargadoST() > 1.5){ pedirMV(ST.sig + 1, 3); await dormir(200); continue; }   // la base cubre solo lo justo
          await agregarUnidadST(tok, await audioBaseST(ST.sig)); MV.fBase++;
          pedirMV(ST.sig, 3);                      // tu voz, para lo que viene después de esta frase
          continue;
        }
      }
      if(!F.lista(ST.sig)){
        if(esMiVoz() && !store.get('vozSE')){ await terminarST(tok, 'sin preparar'); break; }
        if(esMiVoz()) pedirMV(ST.sig);   // pide varias frases: el motor trabaja en paralelo y la espera es la mitad
        // La voz todavía no tiene lo que sigue: se espera y, solo si el audio está por vaciarse, se agrega
        // micro-silencio. El pedido se reintenta cada medio segundo (pedir dos veces la misma frase no
        // cuesta: se genera una sola vez). Antes bastaba con que un pedido terminara sin dejar el audio
        // para que la espera se quedara girando para siempre, agregando silencio sin fin.
        let pedido = null, pedidoT = 0;
        while(tok === ST.tok && playing && !F.lista(ST.sig)){
          if(!pedido && Date.now() - pedidoT > 500){
            pedidoT = Date.now();
            if(esMiVoz()) pedirMV(ST.sig);
            pedido = F.primera(ST.sig).then(()=>{}, ()=>{}).then(() => { pedido = null; });
          }
          const fuera = document.visibilityState === 'hidden';
          // en pantalla basta un margen corto; fuera de ella el iPhone despierta la app cada ~1 s o más,
          // así que se deja más silencio por delante para que el audio nunca se vacíe
          if(cargadoST() < (fuera ? 3 : 0.35) && audioVoz.currentTime > 0.1){
            if(!MV.esperando){
              MV.esperando = Date.now(); MV.silencios++;
              diag(`esperando la voz: frase ${ST.sig} de ${flat.length} · listas ${MV.enDisco.size} · en curso ${MV.enCurso.size} · memoria ${MV.mem.size}`);
              // si el teléfono no alcanza a generar al ritmo de la lectura, se ofrece la vía segura: preparar todo
              if(document.visibilityState === 'visible'){
                // Si la voz no alcanza el ritmo de la lectura, se ofrece la vía que sí funciona: preparar
                // todo el libro por adelantado (sirve para «Mi voz» y para una voz natural lenta).
                const ofrecer = esMiVoz() ? !MV.prep : (esNatural() && !NA.prep);
                const aviso = esMiVoz() ? 'Generando tu voz… (sigue sola en cuanto esté lista)' : 'Generando la voz… (sigue sola en cuanto esté lista)';
                showStatus(aviso, null, null, ofrecer ? 'Pre-generar el libro' : null,
                  ofrecer ? ()=>{ hideStatus(); if(esMiVoz()) prepararMV(); else prepararLibroNA(); } : null);
              }
            }
            if(Date.now() - MV.esperando > 3 * 60 * 1000){ MV.esperando = 0; stop(); showStatus('La voz se detuvo. Toca reproducir para seguir.'); return; }
            const seg = fuera ? 2 : 0.3;
            MV.silencioSeg += seg;
            await silencioST(tok, seg);
          }
          await Promise.race([pedido || dormir(fuera ? 500 : 100), dormir(fuera ? 500 : 100)]);   // nunca gira en vacío
        }
        if(tok !== ST.tok || !playing) break;
      }
      if(MV.esperando){ MV.esperando = 0; hideStatus(); }
      await agregarUnidadST(tok);
    }
    if(tok === ST.tok && audioVoz.currentTime - ST.limpiado > 120){ ST.limpiado = audioVoz.currentTime; await borrarAtrasST(30); }
  }catch(e){
    if(tok === ST.tok && e.message !== 'detenido') diag('no se pudo agregar audio: ' + (e.message || e.name));
  }finally{
    if(tok === ST.tok) ST.alimentando = false;
  }
}
async function playST(){
  const i = idx;
  // seguir donde quedó la pausa, sin rearmar nada
  const x = ST.linea.find(y => y.i === i);
  if(ST.sb && !ST.fin && x && enBufferST(x.s)){
    sincronizarAU();
    if(idx !== i){ idx = i; try{ audioVoz.currentTime = x.s; }catch(e){} }
    playing = true; setPlayIcon();
    try{ await audioVoz.play(); generarAdelanteST(); alimentarST(); return; }
    catch(e){ playing = false; setPlayIcon(); }
  }
  if(esMiVoz()){
    await discoMV();
    if(!store.get('vozSE')){ avisoSinPreparar(); openSheet(); return; }
    // tu voz parte antes de arrancar; si se empieza con la voz base, después de su primera frase (comparten
    // el proceso de Piper: si no, la frase de la base esperaba en la fila detrás de las de tu voz)
    if(!(arranqueMV() && !fuenteMV.lista(i))) pedirMV(i);
  }
  playing = true; setPlayIcon();
  const yo = ++MV.turno;
  try{
    if(esNatural()){
      NA.limite = Infinity;
      await discoNA();
      if(!NA.hechas.has(i)) showStatus('Preparando la voz…');
    } else if(esMiVoz()){
      MV.arranque = arranqueMV() && !fuenteMV.lista(i); MV.fBase = 0;
      if(MV.arranque){
        await asegurarCfgMV();
        showStatus(`Empieza con la voz base (${MV.base.es.nombre}) mientras se prepara la tuya; en unos segundos sigue con tu voz.`);
        diag('«Mi voz»: empieza con la voz base mientras se prepara la tuya');
      } else if(!fuenteMV.lista(i)){
        showStatus('Iniciando tu voz…');
        // sin la voz base: empezar con dos frases listas (si no, hay una pausa justo después de la primera)
        if(i + 1 < flat.length && !fuenteMV.lista(i + 1)) await Promise.race([asegurarFraseMV(i + 1).catch(()=>{}), dormir(10000)]);
      }
    }
    await abrirST(i);
    if(yo !== MV.turno || !playing) return;
    if(MV.arranque) pedirMV(i + 1, 3); else hideStatus();
    await audioVoz.play();
    generarAdelanteST();
    alimentarST();
  }catch(e){
    if(yo !== MV.turno) return;
    playing = false; setPlayIcon();
    if(e && e.message === 'detenido') return;
    if(e && e.message === 'sin preparar'){ avisoSinPreparar(); return; }
    diag('no se pudo reproducir: ' + (e && (e.message || e.name)));
    const txt = e && e.name === 'NotAllowedError' ? 'El teléfono no dejó reproducir. Toca el botón otra vez.' : (e && e.message) || 'No se pudo reproducir.';
    if(esMiVoz()) avisoMiVoz('No pude leer con tu voz: ' + txt, true);
    showStatus(txt, e && e.name === 'NotAllowedError' ? null : 'err');
  }
}
async function saltarST(i){
  if(!playing){ showSentence(true, true); save(); return; }
  const x = ST.linea.find(y => y.i === i);
  if(x && enBufferST(x.s) && !audioVoz.paused){ audioVoz.currentTime = x.s; showSentence(true, true); return; }
  MV.turno++;
  if(!audioVoz.paused){ MV.callar = true; audioVoz.pause(); }
  showSentence(true, true);
  await playST();
}
// la voz se sigue generando/preparando por adelantado desde lo que viene (pipelining continuo)
function generarAdelanteST(){
  if(esNatural()){
    NA.limite = Infinity;
    if(!NA.corre && ST.sig < flat.length) generarNA(ST.sig);
  } else if(esMiVoz()){
    adelantoMV();
  }
}
function terminadoST(){
  if(!playing) return;
  if(ST.motivoFin === 'sin preparar'){
    idx = Math.min(ST.sig, flat.length - 1); stop(); showSentence(true, true); save(true);
    showStatus('Primero graba tu voz en el panel «Mi voz» para seguir.');
  } else if(ST.sig >= flat.length) finished();
  else { stop(); showStatus('La voz se detuvo. Toca reproducir para seguir.'); }
}

function avisoSinPreparar(){
  if(!store.get('vozSE')){
    avisoMiVoz(`Todavía no hay una voz grabada: toca «Grabar mi voz» (o usa un audio grabado con ${GRABADORA}).`, true);
    showStatus('Primero graba tu voz en el panel «Mi voz» para poder leer con ella.');
  } else {
    showStatus('Iniciando tu voz…');
  }
}
async function playAU(){
  desbloquearAudio();
  if(CONTINUO) return playST();
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
    if(!store.get('vozSE')){ avisoSinPreparar(); openSheet(); return; }
    pedirMV(i);                      // la generación parte antes de arrancar: la primera frase no espera sola
  }
  playing = true; setPlayIcon();
  const yo = ++MV.turno;
  try{
    if(esNatural()){
      NA.limite = Infinity;
      await discoNA();
      if(!NA.hechas.has(i)) showStatus('Preparando la voz…');
    } else if(esMiVoz() && !fuenteMV.lista(i)){
      showStatus('Iniciando tu voz…');
    }
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
    diag('no se pudo reproducir: ' + (e && (e.message || e.name)));
    const txt = e && e.name === 'NotAllowedError' ? 'El teléfono no dejó reproducir. Toca el botón otra vez.' : (e && e.message) || 'No se pudo reproducir.';
    if(esMiVoz()) avisoMiVoz('No pude leer con tu voz: ' + txt, true);
    showStatus(txt, e && e.name === 'NotAllowedError' ? null : 'err');
  }
}
// Frase que está sonando, según el tiempo del audio.
function sincronizarAU(){
  const tiempos = CONTINUO ? ST.linea : MV.pag && MV.pag.tiempos;
  if(!usaAudio() || !tiempos || !tiempos.length) return false;
  const t = audioVoz.currentTime; let cur = tiempos[0];
  for(const x of tiempos){ if(x.s <= t + 0.05) cur = x; else break; }
  if(cur && cur.i !== idx){ idx = cur.i; return true; }
  return false;
}
// Solo cuenta lo que hace el reproductor que está sonando (el otro espera su turno), y nunca el silencio
// que se usa para desbloquear el audio: ese termina al instante y antes detenía la lectura recién empezada.
const actual = (fn) => e => {
  if(e.target !== audioVoz || !usaAudio()) return;
  if(!e.target.src || String(e.target.src).startsWith('data:')) return;
  fn(e);
};
for(const el of reproductores){
  // Con la app fuera de pantalla solo se revisa el relevo; la posición se calcula al volver o al pausar.
  el.addEventListener('timeupdate', actual(()=>{
    if(CONTINUO){ if(cargadoST() < CARGADO_SEG - 10) alimentarST(); }
    else revisarRelevo();
    if(document.visibilityState !== 'visible' || !$('#blackout').hidden) return;
    if(sincronizarAU()){
      showSentence(true);
      if(Date.now() - MV.guardado > 3000){ MV.guardado = Date.now(); save(); }
    }
  }));
  // Si el relevo no alcanzó (el teléfono se demoró), se hace al terminar.
  el.addEventListener('ended', actual(async ()=>{
    if(CONTINUO){ terminadoST(); return; }
    if(!playing || !MV.pag) return;
    const b = MV.pag;
    if(b.ult + 1 >= flat.length){ finished(); return; }
    if(MV.listo){ relevar(); return; }
    prepararSiguiente();
    if(esNatural()){
      // volver al silencio final y esperar ahí: si el audio queda detenido, el iPhone no deja seguir
      try{ audioVoz.currentTime = b.fin + 0.5; audioVoz.play().catch(()=>{}); }catch(e){}
      if(!MV.esperando) MV.esperando = Date.now();
      showStatus('Generando la voz… (sigue sola en cuanto esté lista)');
      return;
    }
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
    if(!playing || el.ended || el.currentTime <= 0.2) return;
    diag('el audio se pausó solo · sesión de audio: ' + estadoSesion());
    // Si no fuiste tú (tus pausas pasan por stop()), fue el sistema: una notificación, una llamada, Siri.
    // Mientras dure, se espera; al terminar, sigue sola. Si no es una interrupción (por ejemplo, sacaste
    // los audífonos), queda en pausa.
    setTimeout(()=>{
      if(!playing || el !== audioVoz || !el.paused) return;
      const interrupcion = sesionInterrumpida() || Date.now() - (MV.ultimaInterrupcion || 0) < 3000
        || (!navigator.audioSession && document.visibilityState === 'hidden');
      if(interrupcion){ MV.interrumpido = Date.now(); diag('interrupción del sistema (notificación, llamada…): espera'); reintentar(); return; }
      diag('pausa desde fuera (audífonos, centro de control…)');
      playing = false; setPlayIcon(); save(true); pararNA(false); clearTimeout(MV.relevoT);
    }, 350);
  }));
  el.addEventListener('play', actual(()=>{ if(!playing && el.src !== SILENCIO){ playing = true; setPlayIcon(); } }));
}
const estadoSesion = () => { try{ return navigator.audioSession ? navigator.audioSession.state + '/' + navigator.audioSession.type : 'sin datos'; }catch(e){ return '?'; } };
const sesionInterrumpida = () => { try{ return navigator.audioSession && navigator.audioSession.state === 'interrupted'; }catch(e){ return false; } };
// Retoma después de una interrupción: apenas el sistema devuelve el audio (o al volver a la app). Se rinde a
// los 10 minutos (si era una llamada larga, no conviene que siga sola mucho después).
function reintentar(){
  clearTimeout(MV.reintento);
  if(!MV.interrumpido || !playing) return;
  if(Date.now() - MV.interrumpido > 10 * 60 * 1000){ MV.interrumpido = 0; playing = false; setPlayIcon(); save(true); return; }
  if(!sesionInterrumpida()){
    audioVoz.play().then(()=>{ MV.interrumpido = 0; diag('siguió tras la interrupción'); programarRelevo(); }).catch(()=>{});
  }
  MV.reintento = setTimeout(reintentar, sesionInterrumpida() ? 3000 : 1500);
}
try{ navigator.audioSession && navigator.audioSession.addEventListener('statechange', ()=>{
  if(playing || MV.interrumpido) diag(`sesión de audio de ${SISTEMA}: ` + estadoSesion());
  if(sesionInterrumpida()) MV.ultimaInterrupcion = Date.now();
  else if(MV.interrumpido) reintentar();
}); }catch(e){}
document.addEventListener('visibilitychange', ()=>{
  if(playing) diag((document.visibilityState === 'hidden' ? '→ saliste de la app' : '← volviste a la app') + (usaAudio() && CONTINUO && ST.sb ? ` · cargado ${Math.round(cargadoST())} s · listo ${Math.round(adelanteSeg())} s` : usaAudio() && MV.pag ? ` · bloque ${Math.round(audioVoz.currentTime)}/${Math.round(MV.pag.fin)} s · listo ${Math.round(adelanteSeg())} s` : ''));
  if(document.visibilityState === 'visible' && MV.interrumpido) reintentar();
  if(!usaAudio() || !(CONTINUO ? ST.sb : MV.pag)) return;
  sincronizarAU();
  if(document.visibilityState === 'visible') showSentence(true); else save(true);
});
async function saltarAU(i){
  if(CONTINUO) return saltarST(i);
  if(!playing){ showSentence(true, true); save(); return; }
  const x = MV.pag && MV.pag.tiempos.find(y => y.i === i);
  if(x && !audioVoz.paused){ audioVoz.currentTime = x.s; showSentence(true, true); programarRelevo(); return; }
  MV.turno++;
  if(!audioVoz.paused){ MV.callar = true; audioVoz.pause(); }
  showSentence(true, true);
  await playAU();
}

/* ---------- Grabar tu voz ---------- */
// Dos caminos: grabar con el micrófono del navegador, o usar un audio ya grabado (por ejemplo con la app
// Notas de Voz del iPhone). El segundo existe porque muchos navegadores del teléfono no dan el micrófono
// (Chrome en iPhone lo autoriza aparte, en Ajustes › Chrome) y porque ahí getUserMedia falla en silencio.
let grabando = null;
const esIOS = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const esChromeIOS = /CriOS/.test(navigator.userAgent);
// Los avisos de «Mi voz» (micrófono y errores al leer) van dentro del panel: el aviso general queda
// detrás de esta ventana, así que un fallo ahí no se veía y parecía que la app no hacía nada.
function avisoMiVoz(msg, malo){
  const el = $('#recAviso'); if(!el) return;
  el.hidden = !msg; el.textContent = msg || '';
  el.style.color = malo ? '#c0392b' : '';
}
function ayudaMicrofono(){
  if(esChromeIOS) return 'Para darle micrófono a Chrome: Ajustes del iPhone › Chrome › activa «Micrófono». Si antes dijiste «No permitir», iOS no vuelve a preguntar, así que hay que activarlo a mano.';
  if(esIOS) return 'Para darle micrófono a Safari: Ajustes del iPhone › Safari › Micrófono (y Ajustes › Privacidad › Micrófono). Si antes dijiste «No permitir», iOS no vuelve a preguntar.';
  if(PLAT === 'android') return 'Para darle micrófono: toca el candado junto a la dirección › Permisos › Micrófono › Permitir (y en Ajustes › Apps › Chrome › Permisos › Micrófono).';
  if(PLAT === 'windows') return 'Para darle micrófono: haz clic en el candado junto a la dirección › Micrófono › Permitir, y revisa Configuración › Privacidad y seguridad › Micrófono (que los navegadores tengan acceso).';
  return 'Revisa el permiso de micrófono de esta página en el navegador.';
}
// Convierte un audio (de la grabación o de un archivo) en tu huella de voz y lo guarda en el teléfono.
// ctx: si viene de la grabación, se reusa el AudioContext que ya se creó con el toque; si no, se crea uno.
async function guardarVoz(blob, ctx){
  const propio = !ctx;
  const c = ctx || new (window.AudioContext || window.webkitAudioContext)();
  try{
    let pcm;
    try{ pcm = await c.decodeAudioData(await blob.arrayBuffer()); }
    catch(e){ throw new Error(`No pude leer ese audio. Prueba con un archivo grabado con ${GRABADORA} (.m4a, .wav o .mp3).`); }
    if(pcm.duration < 15) throw new Error(`El audio dura ${Math.round(pcm.duration)} segundos y es muy corto: lee el texto completo (unos 50 segundos).`);
    if(!MV.M) MV.M = await import('./voz/motor.js');
    let a = MV.M.recortar(pcm.getChannelData(0));
    let pico = 0; for(const v of a) pico = Math.max(pico, Math.abs(v));
    if(pico > 0) a = a.map(v => v * 0.95 / pico);             // nivel parejo, sin importar la distancia al micrófono
    avisoMiVoz('Analizando tu voz… (la primera vez baja el modelo, puede tardar un poco)');
    showStatus('Analizando tu voz…');
    const se = await MV.M.huellaDe(a, pcm.sampleRate);
    await kv.put('voz', 'grabacion', blob);
    store.set('vozSE', Array.from(se)); store.set('vozHash', Date.now().toString(36)); store.del('vozBase');
    await elegirBase();
    MV.pref = null; if(doc) await discoMV();
    hideStatus(); avisoMiVoz('');
    return true;
  }catch(e){
    hideStatus();
    avisoMiVoz((e && e.message) || 'No pude procesar ese audio. Intenta otra vez.', true);
    throw e;
  }finally{ if(propio){ try{ c.close(); }catch(e){} } }
}
/* ---------- Grabación guiada: frases cortas y similitud medida ---------- */
// En vez de un texto largo, frases cortas (caben enteras en la pantalla del teléfono), una por ventana.
// Cada grabación aporta su huella de voz; tu voz es el promedio de todas. Después de cada frase se mide:
// la voz clonada lee esa misma frase (armada SIN esa grabación, para que la medida sea honesta) y se compara
// su huella con la de tu grabación real. La barra se llena cuando grabar más ya no cambia tu huella
// (dos frases seguidas con un cambio menor a 0,001): desde ahí la similitud ya no puede mejorar con más frases.
const FRASES_VOZ = [
  'El sol de la mañana entraba despacio por la ventana de la cocina.',
  '¿Quién dejó las llaves encima de la mesa del comedor?',
  'Mi abuela guardaba cartas viejas en una caja de madera.',
  '¡Qué alegría verte otra vez después de tantos años!',
  'Necesito comprar pan, queso, tomates y un poco de café.',
  'El tren de las ocho y media llegó con veinte minutos de retraso.',
  'Cuando llueve, el camino hacia el pueblo se llena de barro.',
  'La jueza escuchó con atención a cada uno de los testigos.',
  '¿Te parece si mañana salimos a caminar junto al río?',
  'Guillermo arregló la bicicleta con una llave inglesa.',
  'Hay que leer el contrato completo antes de firmarlo.',
  'Ayer cociné una sopa de zapallo con jengibre y limón.',
  '¡Cuidado, que el piso está mojado y te puedes resbalar!',
  'Ella sonrió, cerró el libro y apagó la luz de la lámpara.',
  'En invierno las noches son largas y frías en el sur.',
  '¿Cuántos kilómetros faltan para llegar a la costa?',
  'El viejo reloj de la torre marcaba las doce en punto.',
  'Fuimos al mercado y volvimos cargados de frutas y verduras.',
  'La profesora explicó la lección con paciencia y buen humor.',
  'Siempre que viajo llevo un cuaderno para anotar lo que veo.',
];
const GUIA_MIN = 5, GUIA_MAX = 16, GUIA_ESTABLE = 0.999;
const GV = {abierta: false, stream: null, ctx: null, an: null, rec: null, raf: 0, n: 0, emb: [], sims: [], estables: 0,
            completo: false, cola: Promise.resolve(), pend: 0, motor: null, huellas: null, grabando: false, midiendo: 0, porMedir: null};

function cargarGuia(){
  const g = store.get('vozGuia', null);
  GV.emb = g ? g.emb.map(x => Float32Array.from(x)) : [];
  GV.sims = g ? g.sims.slice() : [];
  GV.n = g ? g.n : 0; GV.estables = g ? g.estables : 0; GV.completo = !!(g && g.completo);
}
function guardarGuia(){
  store.set('vozGuia', {emb: GV.emb.map(x => Array.from(x)), sims: GV.sims, n: GV.n, estables: GV.estables, completo: GV.completo});
}
const promedioHuellas = l => { const m = new Float32Array(l[0].length); for(const e of l) for(let k = 0; k < m.length; k++) m[k] += e[k] / l.length; return m; };
// similitud mostrada: el promedio de las últimas 3 frases (una sola frase puede salir alta o baja por azar)
const simGuia = () => { const u = GV.sims.slice(-3); return u.length ? u.reduce((x, y) => x + y, 0) / u.length : null; };

// El motor (voz natural + conversor de timbre), sin exigir una voz ya grabada.
function cargarMotorGuia(){
  if(!GV.motor){
    GV.motor = (async ()=>{
      const avance = (msg, n, t) => {
        $('#guiaDescarga').textContent = t > 1000 ? `${msg}: ${Math.round(n / 1e6)} de ${Math.round(t / 1e6)} MB (solo la primera vez; usa Wi-Fi).` : msg + '…';
      };
      await motorBaseMV(avance);
      $('#guiaDescarga').textContent = 'Motor de voz listo.';
    })();
    GV.motor.catch(e => { GV.motor = null; $('#guiaDescarga').textContent = 'No se pudo bajar el motor de voz: ' + (e.message || e) + '. Revisa la conexión y vuelve a abrir esta ventana.'; });
  }
  return GV.motor;
}
async function baseDesde(tgt){ return (await basesMasParecidas(tgt)).es; }

function pantallaGuia(cual){
  for(const id of ['guiaIntro', 'guiaFrase', 'guiaFin']) $('#' + id).hidden = id !== cual;
}
function pintarSimilitud(){
  if(GV.modo === 'entrenar'){ pintarEnt(); return; }
  const s = simGuia(), pct = s == null ? null : Math.max(0, Math.min(100, Math.round(s * 100)));
  $('#guiaSimVal').textContent = pct == null ? '—' : pct + '%';
  $('#guiaSimBar').style.width = (GV.completo ? 100 : pct || 0) + '%';
  $('#guiaSim').classList.toggle('lleno', GV.completo);
  let nota;
  if(GV.completo) nota = 'Máxima similitud alcanzada.';
  else if(GV.midiendo) nota = `Midiendo la similitud con la frase ${GV.midiendo}… puedes seguir grabando.`;
  else if(GV.pend) nota = 'Analizando lo que grabaste…';
  else if(!GV.sims.length) nota = 'Graba la primera frase para medirla.';
  else if(GV.emb.length < GUIA_MIN){ const f = GUIA_MIN - GV.emb.length; nota = `Falta${f === 1 ? '' : 'n'} al menos ${f} frase${f === 1 ? '' : 's'} para afinar tu voz.`; }
  else nota = GV.estables ? 'Casi: tu voz ya casi no cambia con más frases.' : 'Cada frase afina tu voz. Sigue grabando.';
  $('#guiaSimNota').textContent = nota;
}
function mostrarFrase(){
  pantallaGuia('guiaFrase');
  if(GV.modo === 'entrenar'){
    GV.iEnt = sigEnt(GV.iEnt || 0);
    if(GV.iEnt < 0){ cerrarGuia(); $('#entNota').textContent = '¡Grabaste todas las frases! Ahora toca «Exportar grabaciones».'; return; }
    $('#guiaNum').textContent = `Frase ${GV.iEnt + 1} de ${FRASES_ENT.length}`;
    $('#guiaTexto').textContent = FRASES_ENT[GV.iEnt];
  } else {
    $('#guiaNum').textContent = `Frase ${GV.n + 1}`;
    $('#guiaTexto').textContent = FRASES_VOZ[GV.n % FRASES_VOZ.length];
  }
  $('#guiaGrabar').textContent = '● Grabar'; $('#guiaGrabar').classList.remove('on'); $('#guiaGrabar').disabled = false;
  $('#guiaNivel').style.width = '0%';
  pintarSimilitud();
}function avisoGrabacionDesactivada(){
  showStatus('La grabación y entrenamiento de voz están pausados preventivamente para proteger tus datos biométricos contra ciberataques.', 'err');
}

async function abrirGuia(modo = 'similitud'){
  avisoGrabacionDesactivada();
  return;
  $('#guiaTit').textContent = modo === 'entrenar' ? 'Entrenar tu voz' : 'Graba tu voz';
  $('#guiaPasosSim').hidden = modo === 'entrenar'; $('#guiaPasosEnt').hidden = modo !== 'entrenar';
  $('#guiaSim .fila span').textContent = modo === 'entrenar' ? 'Frases grabadas' : 'Similitud con tu voz';
  if(modo === 'entrenar'){
    await cargarEnt();
    const n = ENT.hechas.size;
    $('#guiaEmpezar').textContent = n ? `Seguir (${n} de ${FRASES_ENT.length})` : 'Empezar';
    $('#guiaDeCero').hidden = true;
    $('#guiaDescarga').textContent = 'Todo queda solo en este teléfono hasta que lo exportes.';
    pantallaGuia('guiaIntro');
    return;
  }
  $('#guiaDescarga').textContent = 'La primera vez se baja el motor de voz (unos 140 MB): usa Wi-Fi.';
  cargarGuia();
  const s = simGuia();
  if(GV.completo){
    $('#guiaEmpezar').textContent = 'Grabar de nuevo desde cero'; $('#guiaDeCero').hidden = true;
    $('#guiaAviso').hidden = false; $('#guiaAviso').textContent = `Ya llegaste a la máxima similitud (${Math.round(s * 100)}%).`;
  } else if(GV.emb.length){
    $('#guiaEmpezar').textContent = `Seguir (${GV.emb.length} frases grabadas)`; $('#guiaDeCero').hidden = false;
  } else { $('#guiaEmpezar').textContent = 'Empezar'; $('#guiaDeCero').hidden = true; }
  pantallaGuia('guiaIntro');
  cargarMotorGuia();
}
async function empezarGuia(deCero){
  if(deCero && GV.modo !== 'entrenar'){ GV.emb = []; GV.sims = []; GV.n = 0; GV.estables = 0; GV.completo = false; guardarGuia(); }
  const aviso = t => { $('#guiaAviso').hidden = !t; $('#guiaAviso').textContent = t || ''; };
  if(!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || !window.MediaRecorder){
    aviso('Este navegador no deja grabar desde la app. ' + ayudaMicrofono()); return;
  }
  try{
    aviso('Abriendo el micrófono…');
    // si el micrófono no contesta (otra app lo está usando, o el navegador se trabó), no esperar para siempre
    if(!GV.stream) GV.stream = await Promise.race([
      navigator.mediaDevices.getUserMedia({audio: {echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1}}),
      dormir(15000).then(() => { throw Object.assign(new Error('el micrófono no respondió'), {name: 'TimeoutError'}); })]);
    aviso('');
  }catch(e){
    aviso(e && e.name === 'NotAllowedError' ? 'El navegador no dio permiso para el micrófono. ' + ayudaMicrofono()
      : e && (e.name === 'TimeoutError' || e.name === 'NotReadableError') ? 'El micrófono no respondió: puede que otra app lo esté usando (una llamada, un audio de WhatsApp). Ciérrala y toca Empezar otra vez.'
      : 'No pude usar el micrófono. ' + ayudaMicrofono()); return;
  }
  if(!GV.ctx){
    GV.ctx = new (window.AudioContext || window.webkitAudioContext)();
    GV.an = GV.ctx.createAnalyser(); GV.an.fftSize = 1024;
    GV.ctx.createMediaStreamSource(GV.stream).connect(GV.an);
  }
  GV.ctx.resume().catch(()=>{});
  mostrarFrase();
}
// Graba una frase. Se detiene sola tras 1,2 s de silencio después de hablar (o con un toque, o a los 15 s).
function grabarFrase(){
  if(GV.grabando){ GV.rec && GV.rec.state !== 'inactive' && GV.rec.stop(); return; }
  const texto = $('#guiaTexto').textContent, partes = [], rec = new MediaRecorder(GV.stream);
  GV.rec = rec; GV.grabando = true;
  rec.ondataavailable = e => { if(e.data.size) partes.push(e.data); };
  const b = $('#guiaGrabar'); b.textContent = '■ Listo'; b.classList.add('on');
  $('#guiaEstado').textContent = 'Lee la frase en voz alta…';
  const buf = new Float32Array(GV.an.fftSize), t0 = performance.now();
  let hablo = false, silencioDesde = 0;
  const tic = ()=>{
    if(!GV.grabando) return;
    GV.an.getFloatTimeDomainData(buf);
    let r = 0; for(const v of buf) r += v * v; r = Math.sqrt(r / buf.length);
    $('#guiaNivel').style.width = Math.min(100, r * 900) + '%';
    const ahora = performance.now();
    if(r > 0.02){ hablo = true; silencioDesde = 0; }
    else if(hablo){ if(!silencioDesde) silencioDesde = ahora; else if(ahora - silencioDesde > 900) return rec.stop(); }
    if(ahora - t0 > 15000 || (!hablo && ahora - t0 > 7000)) return rec.stop();
    GV.raf = requestAnimationFrame(tic);
  };
  rec.onstop = async ()=>{
    GV.grabando = false; cancelAnimationFrame(GV.raf);
    b.textContent = '● Grabar'; b.classList.remove('on'); $('#guiaNivel').style.width = '0%';
    if(!GV.abierta) return;
    const nFrase = GV.modo === 'entrenar' ? GV.iEnt + 1 : GV.n + 1, iEnt = GV.iEnt;
    if(GV.modo === 'entrenar') GV.iEnt = iEnt + 1; else GV.n++;
    if(!GV.completo) mostrarFrase();                         // sin esperar: la revisión sigue por detrás
    const blob = new Blob(partes, {type: rec.mimeType || 'audio/mp4'});
    const malo = msg => { $('#guiaEstado').textContent = `La frase ${nFrase} no se usó: ${msg}`; };
    let pcm;
    try{ pcm = await GV.ctx.decodeAudioData(await blob.arrayBuffer()); }
    catch(e){ malo('no pude leer la grabación.'); return; }
    const d = pcm.getChannelData(0);
    let pico = 0, recortes = 0; for(const v of d){ const a = Math.abs(v); if(a > pico) pico = a; if(a > 0.99) recortes++; }
    const voz = MV.M ? MV.M.recortar(d).length / pcm.sampleRate : pcm.duration;
    if(pico < 0.03 || voz < 1.2){ malo('no se escuchó bien (acércate un poco al teléfono).'); return; }
    if(recortes > d.length * 0.01){ malo('se escuchó muy fuerte (aléjate un poco).'); return; }
    if(GV.modo === 'entrenar'){ guardarEnt(iEnt, texto, d, pcm.sampleRate).catch(e => malo('no se pudo guardar (' + (e.message || e) + ').')); return; }
    kv.put('voz', 'grabacion', blob).catch(()=>{});            // «Escuchar grabación» toca la última
    kv.put('voz', 'comparar', {blob, texto}).catch(()=>{});     // «Comparar»: tu grabación y la copia, misma frase
    encolarAnalisis({texto, pcm: Float32Array.from(d), sr: pcm.sampleRate});
  };
  rec.start(); tic();
}
// Cada grabación: su huella se calcula al tiro (es rápida) y decide cuándo se llena la barra. La medida con
// la voz clonada es lenta (en el teléfono, más que grabar una frase), así que se hace siempre con la grabación
// más reciente y se saltan las que quedaron atrás: la barra va al día aunque grabes rápido.
function encolarAnalisis(f){
  GV.pend++; pintarSimilitud();
  GV.cola = GV.cola.then(() => huellaFrase(f))
    .catch(e => { diag('no se pudo analizar una frase: ' + (e && e.message || e)); $('#guiaEstado').textContent = 'No se pudo analizar una frase: ' + (e && e.message || e); })
    .finally(() => { GV.pend--; medirUltima(); if(GV.abierta) pintarSimilitud(); });
}
async function huellaFrase({texto, pcm, sr}){
  await cargarMotorGuia();
  let a = MV.M.recortar(pcm);
  let pico = 0; for(const v of a) pico = Math.max(pico, Math.abs(v));
  if(pico > 0) a = a.map(v => v * 0.95 / pico);
  const real = Float32Array.from(await MV.M.huellaDe(a, sr));
  const antes = GV.emb.length ? promedioHuellas(GV.emb) : null;
  GV.emb.push(real);
  const tgt = promedioHuellas(GV.emb);
  const cambio = antes ? MV.M.parecido(tgt, antes) : 0;
  GV.estables = GV.emb.length >= 3 && cambio >= GUIA_ESTABLE ? GV.estables + 1 : 0;
  GV.porMedir = {texto, real, i: GV.emb.length - 1};
  diag(`grabación guiada: frase ${GV.emb.length} · cambio de la huella ${(1 - cambio).toFixed(5)}`);
  // tu voz queda lista para leer desde ya (y mejora con cada frase)
  store.set('vozSE', Array.from(tgt)); store.set('vozHash', Date.now().toString(36)); store.del('vozBase');
  MV.pref = null; MV.cfg = null;
  guardarGuia(); actualizarMV();
  if(!GV.completo && ((GV.emb.length >= GUIA_MIN && GV.estables >= 2) || GV.emb.length >= GUIA_MAX)) completarGuia();
}
// La medida: la voz clonada (armada sin esa grabación) lee la misma frase y su huella se compara con la tuya.
async function medirUltima(){
  if(GV.midiendo || !GV.porMedir) return;
  if(GV.grabando){ clearTimeout(GV.medirT); GV.medirT = setTimeout(medirUltima, 400); return; }
  const m = GV.porMedir; GV.porMedir = null; GV.midiendo = m.i + 1;
  if(GV.abierta) pintarSimilitud();
  try{
    const sin = GV.emb.length > 1 ? promedioHuellas(GV.emb.filter((_, k) => k !== m.i)) : GV.emb[0];
    const base = await baseDesde(sin);
    const crudo = await hablarBaseMV(m.texto, 'es', base, (n, t) => { $('#guiaDescarga').textContent = `Bajando la voz base ${base.nombre}: ${Math.round(n / 1e6)} de ${Math.round((t || base.mb * 1e6) / 1e6)} MB`; });
    const clon = await MV.M.convertir(crudo, base.se, sin);
    const sim = MV.M.parecido(Float32Array.from(await MV.M.huellaDe(clon, MV.M.SR)), m.real);
    GV.sims.push(sim); guardarGuia(); actualizarMV();
    diag(`grabación guiada: similitud medida con la frase ${m.i + 1}: ${Math.round(sim * 100)}%`);
  }catch(e){ diag('no se pudo medir la similitud: ' + (e && e.message || e)); }
  finally{
    GV.midiendo = 0;
    if(GV.abierta){ pintarSimilitud(); if(GV.completo) pintarFin(); }
    medirUltima();
  }
}
function completarGuia(){
  GV.completo = true; guardarGuia();
  if(GV.rec && GV.rec.state !== 'inactive'){ GV.rec.onstop = null; GV.rec.stop(); GV.grabando = false; }
  soltarMicGuia();
  if(!GV.abierta) return;
  pintarFin();
  pantallaGuia('guiaFin');
}
function pintarFin(){
  const s = simGuia();
  $('#guiaFinVal').textContent = s == null ? '…' : Math.round(s * 100) + '%';
  $('#guiaFinNota').textContent = (GV.midiendo || GV.porMedir ? 'Terminando de medir la última frase… ' : '') +
    `Con ${GV.emb.length} frases grabadas. Ya puedes leer tus libros con tu voz en «Mi voz».`;
}
function soltarMicGuia(){
  cancelAnimationFrame(GV.raf);
  if(GV.stream){ GV.stream.getTracks().forEach(t => t.stop()); GV.stream = null; }
  if(GV.ctx){ try{ GV.ctx.close(); }catch(e){} GV.ctx = null; GV.an = null; }
}
function cerrarGuia(){
  GV.abierta = false;
  if(GV.rec && GV.rec.state !== 'inactive'){ GV.rec.onstop = null; GV.rec.stop(); }
  GV.grabando = false;
  soltarMicGuia();
  $('#guia').hidden = true;
  actualizarMV();
}
$('#guiaEmpezar').onclick = ()=> empezarGuia(GV.completo);
$('#guiaDeCero').onclick = ()=> empezarGuia(true);
$('#guiaGrabar').onclick = grabarFrase;
$('#guiaOtra').onclick = ()=>{ if(GV.grabando) return; if(GV.modo === 'entrenar') GV.iEnt = (GV.iEnt || 0) + 1; else GV.n++; mostrarFrase(); };
$('#guiaTerminar').onclick = cerrarGuia;
$('#guiaCerrar').onclick = cerrarGuia;
$('#guiaListo').onclick = cerrarGuia;
// «Comparar»: suena tu grabación de una frase y después tu voz clonada diciendo la misma frase, para
// juzgar de oído (la similitud de la barra mide el timbre, no el acento ni el ritmo).
async function compararVoz(nota, btn){
  const c = await kv.get('voz', 'comparar');
  if(!c){ nota.textContent = 'Primero graba tu voz con «Grabar mi voz».'; return; }
  btn.disabled = true;
  const a = new Audio(); a.src = SILENCIO; a.play().catch(()=>{});   // con el toque: el teléfono deja sonar lo que sigue
  const sonar = url => new Promise(res => { a.src = url; a.playbackRate = 1; a.onended = res; a.onerror = res; a.play().catch(res); });
  try{
    nota.textContent = 'Preparando la comparación (tu voz clonada lee la misma frase)…';
    await motorMV(()=>{});
    const b = MV.base.es;
    const clon = await MV.M.convertir(await hablarBaseMV(c.texto, 'es', b), b.se, MV.tgt);
    nota.textContent = `▶ A: tu grabación — «${c.texto}»`;
    await sonar(URL.createObjectURL(c.blob));
    nota.textContent = `▶ B: tu voz clonada (voz base ${b.nombre}) — la misma frase`;
    await sonar(URL.createObjectURL(wav16(clon)));
    nota.textContent = 'A = tu grabación · B = tu voz clonada. Toca «Comparar» para escucharlas otra vez.';
  }catch(e){ nota.textContent = 'No pude comparar: ' + (e.message || e); }
  finally{ btn.disabled = false; }
}
if($('#guiaComparar')) $('#guiaComparar').onclick = ()=> compararVoz($('#guiaFinNota'), $('#guiaComparar'));
if($('#mvComparar')) $('#mvComparar').onclick = ()=> compararVoz($('#mvTestNote'), $('#mvComparar'));
$('#guiaProbar').onclick = async ()=>{
  const btn = $('#guiaProbar'); btn.disabled = true;
  const prueba = new Audio(); prueba.src = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YQAAAAA='; prueba.play().catch(()=>{});
  try{
    $('#guiaFinNota').textContent = 'Preparando la prueba…';
    await motorMV(()=>{});
    const b = MV.base.es;
    const a = await MV.M.convertir(await hablarBaseMV('Hola. Así suena mi voz leyendo mis libros, con calma y sin apuro.', 'es', b), b.se, MV.tgt);
    prueba.src = URL.createObjectURL(wav16(a)); prueba.playbackRate = rate; await prueba.play();
    $('#guiaFinNota').textContent = '';
  }catch(e){ $('#guiaFinNota').textContent = e.message || String(e); }
  finally{ btn.disabled = false; }
};

/* ---------- Entrenar mi voz: grabar frases con su texto, exportarlas y usar el modelo entrenado ---------- */
// La clonación al vuelo copia el timbre, no el acento ni el ritmo. Para eso hay que entrenar un modelo con tu
// voz: aquí se graban ~230 frases (cada una se guarda solo en este teléfono, como WAV 22 050 Hz con su texto),
// se exportan en un .zip para entrenar en el computador, y el modelo resultante (.onnx + .onnx.json) se carga
// de vuelta como una voz más de «Natural» (lee tan rápido como esas).
let FRASES_ENT = null;
const ENT = {hechas: new Set(), seg: 0};
const pad3 = i => String(i).padStart(3, '0');
async function cargarEnt(){
  if(!FRASES_ENT) FRASES_ENT = (await import('./voz/frases-entrenamiento.js')).FRASES_ENTRENAMIENTO;
  const ks = await kv.keys('voz', 'ent:') || [];
  ENT.hechas = new Set(ks.map(k => +k.slice(4)));
  ENT.seg = store.get('entSeg', 0);
}
const sigEnt = desde => { for(let k = 0; k < FRASES_ENT.length; k++){ const i = (desde + k) % FRASES_ENT.length; if(!ENT.hechas.has(i)) return i; } return -1; };
function pintarEnt(){
  const n = ENT.hechas.size, t = FRASES_ENT ? FRASES_ENT.length : 230, min = ENT.seg / 60;
  $('#guiaSimVal').textContent = `${n} de ${t}`;
  $('#guiaSimBar').style.width = Math.round(n / t * 100) + '%';
  $('#guiaSim').classList.toggle('lleno', n >= t);
  $('#guiaSimNota').textContent = `${min < 1 ? 'Menos de 1' : Math.floor(min)} min de voz grabada (se recomiendan 15 o más). Puedes parar cuando quieras: lo grabado queda guardado.`;
  const caja = $('#entEstado'); if(caja){
    caja.textContent = n ? `${n} de ${t} frases grabadas (${Math.max(1, Math.round(min))} min).` + (n >= 150 ? ' Ya puedes exportarlas para entrenar.' : '') : 'Todavía no hay frases grabadas.';
    $('#entBar').style.width = Math.round(n / t * 100) + '%';
  }
}
// Deja solo la voz (con un margen de 0,25 s) y la lleva a 22 050 Hz, el formato con que se entrena.
async function aWavEntrenamiento(d, sr){
  let pico = 0; for(const v of d) pico = Math.max(pico, Math.abs(v));
  const u = pico * 0.04; let i = 0, j = d.length - 1;
  while(i < j && Math.abs(d[i]) < u) i++;
  while(j > i && Math.abs(d[j]) < u) j--;
  const m = Math.round(sr * 0.25), a = d.subarray(Math.max(0, i - m), Math.min(d.length, j + m));
  const n = Math.ceil(a.length * 22050 / sr), oc = new OfflineAudioContext(1, n, 22050);
  const buf = oc.createBuffer(1, a.length, sr); buf.copyToChannel(Float32Array.from(a), 0);
  const src = oc.createBufferSource(); src.buffer = buf; src.connect(oc.destination); src.start();
  const r = (await oc.startRendering()).getChannelData(0);
  const g = pico > 0 ? 0.9 / pico : 1;
  return {wav: wav16(r.map(v => v * g), 22050), seg: r.length / 22050};
}
async function guardarEnt(i, texto, d, sr){
  const {wav, seg} = await aWavEntrenamiento(d, sr);
  await kv.put('voz', 'ent:' + pad3(i), {texto, wav});
  ENT.hechas.add(i); ENT.seg += seg; store.set('entSeg', ENT.seg);
  if(GV.abierta) pintarEnt();
}
// .zip sin comprimir (los WAV casi no se comprimen): wav/ent-NNN.wav, metadata.csv (archivo|texto) y LEEME.txt
function zipSinComprimir(archivos){
  const crcT = new Uint32Array(256).map((_, n) => { let c = n; for(let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = b => { let c = 0xFFFFFFFF; for(const x of b) c = crcT[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };
  const enc = new TextEncoder(), partes = [], central = []; let off = 0;
  for(const [nombre, datos] of archivos){
    const nb = enc.encode(nombre), c = crc(datos);
    const h = new DataView(new ArrayBuffer(30));
    h.setUint32(0, 0x04034b50, true); h.setUint16(4, 20, true); h.setUint16(6, 0x0800, true); h.setUint32(14, c, true);
    h.setUint32(18, datos.length, true); h.setUint32(22, datos.length, true); h.setUint16(26, nb.length, true);
    partes.push(new Uint8Array(h.buffer), nb, datos);
    const ce = new DataView(new ArrayBuffer(46));
    ce.setUint32(0, 0x02014b50, true); ce.setUint16(4, 20, true); ce.setUint16(6, 20, true); ce.setUint16(8, 0x0800, true);
    ce.setUint32(16, c, true); ce.setUint32(20, datos.length, true); ce.setUint32(24, datos.length, true); ce.setUint16(28, nb.length, true); ce.setUint32(42, off, true);
    central.push(new Uint8Array(ce.buffer), nb);
    off += 30 + nb.length + datos.length;
  }
  const tc = central.reduce((x, b) => x + b.length, 0), fin = new DataView(new ArrayBuffer(22));
  fin.setUint32(0, 0x06054b50, true); fin.setUint16(8, archivos.length, true); fin.setUint16(10, archivos.length, true); fin.setUint32(12, tc, true); fin.setUint32(16, off, true);
  return new Blob([...partes, ...central, new Uint8Array(fin.buffer)], {type: 'application/zip'});
}
async function armarZipEnt(){
  const enc = new TextEncoder(), archivos = []; let csv = '';
  for(const i of [...ENT.hechas].sort((a, b) => a - b)){
    const v = await kv.get('voz', 'ent:' + pad3(i)); if(!v) continue;
    const nombre = `ent-${pad3(i)}.wav`;
    archivos.push(['wav/' + nombre, new Uint8Array(await v.wav.arrayBuffer())]);
    csv += `${nombre}|${v.texto}\n`;
  }
  archivos.push(['metadata.csv', enc.encode(csv)]);
  archivos.push(['LEEME.txt', enc.encode('Grabaciones de tu voz hechas con LectorLibre (cada WAV con su texto en metadata.csv).\n' +
    'Para entrenar tu voz: en LectorLibre usa «Entrenar en mi computador», o abre el Entrenador en tu computador.\n' +
    'Estas grabaciones son tuyas: no se subieron a ningún servidor.\n')]);
  return zipSinComprimir(archivos);
}
async function exportarEnt(){
  const nota = $('#entNota');
  await cargarEnt();
  if(!ENT.hechas.size){ nota.textContent = 'Todavía no hay frases grabadas.'; return; }
  nota.textContent = 'Armando el archivo…';
  const fecha = new Date().toISOString().slice(0, 10);
  const archivo = new File([await armarZipEnt()], `LectorLibre-mi-voz-${fecha}.zip`, {type: 'application/zip'});
  try{
    if(navigator.canShare && navigator.canShare({files: [archivo]})){ await navigator.share({files: [archivo], title: 'Grabaciones de mi voz'}); nota.textContent = 'Listo. Pásalo al computador (AirDrop, Archivos, cable…) para entrenar.'; return; }
  }catch(e){ if(e && e.name === 'AbortError'){ nota.textContent = ''; return; } }
  const a = document.createElement('a'); a.href = URL.createObjectURL(archivo); a.download = archivo.name; document.body.appendChild(a); a.click(); a.remove();
  nota.textContent = `Se descargó «${archivo.name}» (${Math.round(archivo.size / 1e6)} MB). Pásalo al computador para entrenar.`;
}
// El modelo entrenado quedaba en el teléfono y aparecía como voz de «Natural». Estaba definida DOS veces
// (error de sintaxis que impedía cargar la app). Ahora hay una sola y está apagada.
function vozEntrenadaNA(){
  if(!VOZ_SENSIBLE_ACTIVA) return null;
  const m = store.get('vozEntrenada', null); if(!m) return null;
  return {id: 'mi-voz-entrenada', nombre: 'Mi voz entrenada (🔒 Face ID / Huella)', mb: m.mb, cifrado: true};
}

function actualizarBovedaUI(){
  if(!VOZ_SENSIBLE_ACTIVA){
    // No se usa nada de esto: se oculta y se explica. Los datos siguen guardados, en cuarentena.
    for(const sel of ['#entBox', '#entTren']){ const el = $(sel); if(el) el.hidden = true; }
    const av = $('#entAviso');
    if(av){
      av.hidden = false;
      av.textContent = '🔒 La voz entrenada y la conexión con el Entrenador están desactivadas mientras se rediseña su seguridad. ' +
        'Los datos de voz de esta función se borran al abrir la app (no quedan guardados) y nada de esto se ejecuta ni sale a la red.';
    }
    return;
  }
  const tiene = !!store.get('vozEntrenada');
  const btnBorrar = $('#btnBorrarVozBio');
  if(btnBorrar) btnBorrar.hidden = !tiene;
  const nota = $('#entNota');
  if(nota && tiene && !nota.textContent){
    nota.textContent = '🔒 Voz protegida con ' + BovedaBiometrica.nombreBiometria() + ' (AES-256-GCM). Lista para reproducir.';
  }
}

async function usarVozEntrenada(files){
  const nota = $('#entNota');
  if(!VOZ_SENSIBLE_ACTIVA){
    nota.textContent = 'Esta función está desactivada por seguridad mientras se rediseña. No se importó nada.';
    return;
  }
  nota.textContent = 'Procesando paquete de voz…';
  let onnxBuffer = null, jsonBuffer = null;

  try {
    const lista = [...files];
    const zipFile = lista.find(f => /\.(lectoravoz|zip)$/i.test(f.name));

    if(zipFile){
      nota.textContent = 'Leyendo paquete «' + zipFile.name + '»…';
      const z = await readZipEntries(zipFile);
      const onnxEnt = Object.values(z).find(e => /\.onnx$/i.test(e.name));
      const jsonEnt = Object.values(z).find(e => /\.json$/i.test(e.name) && !e.name.includes('metadata'));
      if(!onnxEnt || !jsonEnt) throw new Error('El paquete no contiene voz.onnx y su configuración .json.');
      onnxBuffer = await leerZip(onnxEnt);
      jsonBuffer = await leerZip(jsonEnt);
    } else {
      const onnxF = lista.find(f => /\.onnx$/i.test(f.name));
      const jsonF = lista.find(f => /\.json$/i.test(f.name));
      if(!onnxF || !jsonF){
        nota.textContent = 'Elige el archivo «mi-voz.lectoravoz» o los dos archivos .onnx y .onnx.json juntos.';
        return;
      }
      onnxBuffer = await onnxF.arrayBuffer();
      jsonBuffer = await jsonF.arrayBuffer();
    }

    const cfg = JSON.parse(new TextDecoder().decode(jsonBuffer));
    if(!cfg.audio || !cfg.audio.sample_rate || !(cfg.espeak || cfg.phoneme_id_map)){
      throw new Error('Ese archivo .json no parece de una voz Piper.');
    }

    // Registro biométrico de hardware (Face ID / Touch ID / Huella)
    const bioDisp = await BovedaBiometrica.disponible();
    if(!bioDisp){
      throw new Error('Para proteger tu voz contra extracción y ciberataques, este dispositivo debe contar con ' + BovedaBiometrica.nombreBiometria() + ' activo. Configúralo en los Ajustes del sistema.');
    }

    nota.textContent = 'Verifica tu identidad con ' + BovedaBiometrica.nombreBiometria() + ' para vincular y cifrar tu voz…';
    const { meta, cryptoKey } = await BovedaBiometrica.registrar('Mi voz');

    nota.textContent = 'Cifrando modelo en reposo con AES-256-GCM…';
    const paquete = BovedaBiometrica.empaquetar(onnxBuffer, jsonBuffer);
    const cifrado = await BovedaBiometrica.cifrar(paquete, cryptoKey);

    // Guardar estrictamente cifrado en IndexedDB
    await kv.put('voz', 'modelo_cifrado', cifrado);
    await kv.put('voz', 'boveda_meta', meta);

    const mb = Math.round(onnxBuffer.byteLength / 1e6);
    store.set('vozEntrenada', {mb, fecha: Date.now(), cifrado: true});
    VOCES_NA.es = VOCES_NA.es.filter(v => v.id !== 'mi-voz-entrenada');
    VOCES_NA.es.unshift(vozEntrenadaNA());

    if(vozNA('es').id === 'mi-voz-entrenada' && !playing){ soltarNA(); olvidarBloques(); }
    store.set('na:es', 'mi-voz-entrenada');
    if(playing) stop();

    actualizarBovedaUI();
    diag('Mi voz entrenada cifrada y vinculada a hardware (' + mb + ' MB)');
    nota.textContent = '¡Listo! Tu voz quedó cifrada con AES-256 y protegida por ' + BovedaBiometrica.nombreBiometria() + '. Al leer, se descifrará únicamente en RAM.';
    setModo('natural'); llenarNA();
  } catch(err) {
    nota.textContent = err.message || String(err);
    console.error('Error importando voz:', err);
  }
}

// Botones de la Bóveda Biométrica
const btnImpBio = $('#btnImportarBio');
if(btnImpBio) btnImpBio.onclick = () => $('#entArchivos').click();

const btnBorrarBio = $('#btnBorrarVozBio');
if(btnBorrarBio){
  btnBorrarBio.onclick = async () => {
    if(!confirm('¿Destruir tu voz entrenada? Se sobrescribirá 3 veces con ruido criptográfico y se eliminarán todas las claves de este dispositivo.')) return;
    await BovedaBiometrica.autocorromper('Usuario solicitó destrucción voluntaria');
    VOCES_NA.es = VOCES_NA.es.filter(v => v.id !== 'mi-voz-entrenada');
    soltarNA(); olvidarBloques();
    actualizarBovedaUI();
    $('#entNota').textContent = 'Tu voz ha sido destruida de forma segura y permanente.';
    llenarNA();
  };
}

const inputEntArchivos = $('#entArchivos');
if(inputEntArchivos){
  inputEntArchivos.onchange = e => {
    const f = e.target.files;
    if(f && f.length) usarVozEntrenada(f);
    e.target.value = '';
  };
}

if(VOZ_SENSIBLE_ACTIVA){
  if($('#recBtn')) $('#recBtn').onclick = avisoGrabacionDesactivada;
  if($('#entGrabar')) $('#entGrabar').onclick = avisoGrabacionDesactivada;
  if($('#entExportar')) $('#entExportar').onclick = exportarEnt;
  if($('#entUsar')) $('#entUsar').onclick = avisoGrabacionDesactivada;
}

actualizarBovedaUI();
if($('#mvAcento')) $('#mvAcento').value = store.get('mvAcento', 'latino');
if($('#mvArranque')){ $('#mvArranque').checked = arranqueMV(); $('#mvArranque').onchange = e => store.set('mvArranque', e.target.checked); }
if($('#mvAcento')) $('#mvAcento').onchange = e => {
  if(playing && esMiVoz()) stop();
  store.set('mvAcento', e.target.value); store.del('vozBase');
  MV.base = null; MV.cfg = null; MV.pref = null; olvidarBloques();
  diag('acento de «Mi voz»: ' + (e.target.value === 'espana' ? 'España' : 'latinoamericano'));
};
$('#recBtn').onclick = async ()=>{
  if(grabando){ grabando.terminar(); return; }
  avisoMiVoz('');
  if(!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia){
    avisoMiVoz('Este navegador no da acceso al micrófono. ' + ayudaMicrofono() + ' Mientras tanto, graba con Notas de Voz y toca «Usar un audio grabado».', true);
    return;
  }
  if(!window.MediaRecorder){
    avisoMiVoz('Este navegador no puede grabar desde la app. Graba con la app Notas de Voz del iPhone, compártelo a Archivos y toca «Usar un audio grabado».', true);
    return;
  }
  let stream;
  try{ stream = await navigator.mediaDevices.getUserMedia({audio: {echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1}}); }
  catch(e){
    const que = e && e.name === 'NotAllowedError' ? 'El navegador no dio permiso para el micrófono.' : 'No pude usar el micrófono (' + ((e && e.name) || 'error') + ').';
    avisoMiVoz(que + ' ' + ayudaMicrofono() + ' También puedes grabar con Notas de Voz y tocar «Usar un audio grabado».', true);
    return;
  }
  try{
    $('#recLive').hidden = false; $('#recEmpty').hidden = false; $('#recDone').hidden = true;
    const partes = [], rec = new MediaRecorder(stream);
    rec.ondataavailable = e => { if(e.data.size) partes.push(e.data); };
    const ctx = new (window.AudioContext || window.webkitAudioContext)(); ctx.resume().catch(()=>{});
    const an = ctx.createAnalyser(); an.fftSize = 512; ctx.createMediaStreamSource(stream).connect(an);
    const buf = new Uint8Array(an.fftSize), t0 = Date.now(); let raf;
    // La duración sale del texto de prueba: así, si el texto se alarga, la grabación también
    // (y la voz queda mejor: el timbre se saca de una muestra más larga).
    const guion = ($('#recTexto') && $('#recTexto').textContent || '').trim();
    const DUR = Math.max(30, Math.min(90, Math.round((guion.length || 600) / 12)));
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
        await guardarVoz(new Blob(partes, {type: rec.mimeType || 'audio/mp4'}), ctx);
      }catch(e){ /* el aviso ya quedó en el panel */ }
      finally{ try{ ctx.close(); }catch(e){} $('#recBtn').disabled = false;
        $('#recBtn').textContent = store.get('vozSE') ? '● Grabar de nuevo' : '● Grabar mi voz'; actualizarMV(); }
    };
    rec.start(); tic();
  }catch(e){
    stream.getTracks().forEach(t => t.stop());
    avisoMiVoz('No pude empezar a grabar (' + ((e && e.message) || e) + '). Usa «Usar un audio grabado».', true);
  }
};
if($('#recPick')) $('#recPick').onclick = () => {
  if(VOZ_SENSIBLE_ACTIVA) return avisoGrabacionDesactivada();
  $('#recFile').click();
};
if($('#recFile')) $('#recFile').onchange = async e => {
  const f = e.target.files && e.target.files[0]; e.target.value = '';
  if(!f) return;
  avisoMiVoz('Leyendo «' + f.name + '»…');
  try{ await guardarVoz(f); }
  catch(err){ /* el aviso ya quedó en el panel */ }
  finally{ actualizarMV(); }
};
if($('#recPlay')) $('#recPlay').onclick = async ()=>{
  const b = await kv.get('voz', 'grabacion'); if(!b) return;
  new Audio(URL.createObjectURL(b)).play().catch(()=>{});
};
if($('#mvTest')) $('#mvTest').onclick = async ()=>{
  const btn = $('#mvTest'); btn.disabled = true;
  const prueba = new Audio(); prueba.src = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YQAAAAA='; prueba.play().catch(()=>{});
  try{
    if($('#mvTestNote')) $('#mvTestNote').textContent = 'Preparando la prueba (la primera vez descarga la voz)…';
    await motorMV(avanceMV); if($('#mvDescarga')) $('#mvDescarga').textContent = '';
    const b = MV.base.es;
    const a = await MV.M.convertir(await hablarBaseMV('Hola. Así suena mi voz leyendo mis libros, con calma y sin apuro.', 'es', b), b.se, MV.tgt);
    prueba.src = URL.createObjectURL(wav16(a)); prueba.playbackRate = rate; await prueba.play();
    if($('#mvTestNote')) $('#mvTestNote').textContent = '';
  }catch(e){ if($('#mvTestNote')) $('#mvTestNote').textContent = e.message || String(e); }
  finally{ btn.disabled = false; }
};

/* ---------- Elegir entre la voz del teléfono y la tuya ---------- */
function setModo(m){
  if(m !== modo && playing) stop();
  if(m !== modo){
    olvidarBloques();
    if(m === 'natural') setTimeout(() => precalentarNA(), 0);
    if(m === 'mivoz') setTimeout(() => precalentarMV(), 0);
  }
  if(m === 'telefono') soltarNA();
  modo = m; store.set('modo', m);
  document.querySelectorAll('.seg button').forEach(b => b.setAttribute('aria-pressed', b.dataset.modo === m ? 'true' : 'false'));
  document.querySelectorAll('[data-panel]').forEach(p => p.hidden = p.dataset.panel !== m);
  $('#blackBtn').hidden = !doc || isAudioDoc() || m !== 'telefono';
  updateVoiceBtn();
  if(m === 'mivoz' && doc && !isAudioDoc()) discoMV().then(actualizarMV); else actualizarMV();
  if(m === 'mivoz') cargarEnt().then(pintarEnt).catch(()=>{});
  if(m === 'natural' && doc && !isAudioDoc()) discoNA().then(actualizarNA); else actualizarNA();
}
document.querySelectorAll('.seg button').forEach(b => b.onclick = () => setModo(b.dataset.modo));

/* ---------- Elegir la voz natural ---------- */
// Aviso para las voces que no alcanzan el ritmo de lectura (Daniela · Argentina): sin preparar el libro
// por adelantado, la lectura hace una pausa en cada frase (medido: tarda 1,45 veces lo que dura el audio).
function avisoVozLenta(){
  const el = $('#naNote'); if(!el) return;
  const lenta = ['es', 'en'].map(l => vozNA(l)).find(v => v && v.lenta);
  el.textContent = lenta ? `${lenta.nombre} tarda más en generarse que en leerse: prepara el libro completo antes de escuchar, o elige otra voz.` : '';
}
function llenarNA(){
  const prepBtn = $('#naPrep');
  if(prepBtn) prepBtn.onclick = prepararLibroNA;
  avisoVozLenta();
  actualizarNA();
  for(const l of ['es', 'en']){
    const sel = $(l === 'es' ? '#naEs' : '#naEn'), elegida = vozNA(l).id; sel.innerHTML = '';
    for(const v of VOCES_NA[l]){
      const o = document.createElement('option'); o.value = v.id;
      o.textContent = `${v.nombre} (${v.mb} MB)` + (v.lenta ? ' · genera lento, conviene preparar el libro' : '');
      o.selected = v.id === elegida; sel.appendChild(o);
    }
    sel.onchange = ()=>{
      const seguia = playing || NA.seguir; if(playing) stop();
      store.set('na:' + l, sel.value); olvidarBloques(); soltarNA(); updateVoiceBtn();
      diag('cambiaste la voz a ' + vozNA(l).nombre);
      avisoVozLenta();
      NA.seguir = seguia; precalentarNA(seguia, 800);       // si cambias varias veces seguidas, carga solo la última
    };
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
  diag('▶ leer (' + modo + ')'); store.set('sonando', true);
  if(isAudioDoc()){
    if(!(await ensureZipAudio())) return;
    playing = true; setPlayIcon();
    try{ await audioZip.play(); }catch(e){ playing = false; setPlayIcon(); showStatus('El teléfono no dejó reproducir. Toca el botón otra vez.'); }
    return;
  }
  if(usaAudio()){ primeAudio(); await playAU(); return; }
  if(!synth){ showStatus('Este navegador no puede leer en voz alta con las voces del sistema. Usa la voz «Natural», o abre la app en Safari (iPhone), Chrome (Android) o Edge/Chrome (Windows).', 'err'); return; }
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
  if(was) diag('■ detenida' + (document.visibilityState === 'hidden' ? ' (fuera de la app)' : ''));
  store.set('sonando', false);
  playing = false; token++; vigilar(false); clearTimeout(negroTimer);
  if(synth) synth.cancel();
  if(!audioZip.paused) audioZip.pause();
  if(!audioVoz.paused) audioVoz.pause();
  MV.turno++; pararNA(false); clearTimeout(MV.relevoT); clearTimeout(MV.reintento); MV.interrumpido = 0;
  clearTimeout(MV.tick); MV.tick = null;
  // queda anotado cuánto se hizo esperar tu voz (sirve para el diagnóstico si la lectura se corta)
  const esperas = MV.silencios - (MV.dicho || 0);
  if(esperas > 0){ MV.dicho = MV.silencios; diag(`tu voz se hizo esperar ${esperas} ${esperas === 1 ? 'vez' : 'veces'} (${MV.silencioSeg.toFixed(1)} s de silencio en total)`); }
  if(!MV.prep && !NA.prep) holdScreen(false);
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
  h('play', ()=>{ diag('▶ desde la pantalla bloqueada o el centro de control'); play(); });
  // El iPhone también manda «pausa» cuando otra app toma el audio (un video con sonido, una llamada).
  // Si coincide con una interrupción, se espera y sigue sola; si no, es una pausa tuya.
  h('pause', ()=>{
    const interrupcion = sesionInterrumpida() || Date.now() - (MV.ultimaInterrupcion || 0) < 3000;
    diag(`pausa pedida por ${SISTEMA} · sesión de audio: ${estadoSesion()}` + (MV.ultimoRelevo ? ` · ${Math.round((Date.now() - MV.ultimoRelevo) / 1000)} s desde el último bloque` : ''));
    if(usaAudio() && playing && interrupcion){ MV.interrumpido = Date.now(); diag('→ era una interrupción: espera y sigue sola'); reintentar(); return; }
    stop();
  });
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
      showStatus(`Con la voz del sistema, ${SISTEMA} puede pausar la lectura cuando sales de LectorLibre (sigue sola al volver). Para escuchar mientras usas otras apps o con la pantalla bloqueada, usa la voz «Natural» o «Mi voz».`);
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
// Versión del código que está corriendo: sirve para saber si el teléfono se quedó con una copia vieja
// (tiene que coincidir con CACHE en sw.js; si no coincide, cierra la app y vuelve a abrirla con internet).
const VERSION_APP = 'v53';
function verVersion(){
  const el = $('#verApp'); if(!el) return;
  if(!self.caches){ el.textContent = 'Versión de la app: ' + VERSION_APP; return; }
  try{
    caches.keys().then(ks => {
      const guardado = ks.find(k => /^lectora-v\d+$/.test(k)) || 'sin copia guardada';
      el.textContent = `Versión de la app: ${VERSION_APP} · guardada en este teléfono: ${guardado}` +
        (guardado === 'lectora-' + VERSION_APP ? '' : ' (falta actualizar: cierra la app y ábrela otra vez con internet)');
    }).catch(()=>{});
  }catch(e){ el.textContent = 'Versión de la app: ' + VERSION_APP; }
}
// Qué está haciendo «Mi voz» con este libro: si la voz está grabada, qué voces base usa para español e
// inglés (si sale una voz con acento ajeno, aquí se ve si el libro se está leyendo en el idioma equivocado)
// y cuántas frases detectó en cada idioma.
function verMiVoz(){
  const el = $('#verMiVoz'); if(!el) return;
  if(!doc || isAudioDoc()){ el.textContent = ''; return; }
  const n = {es: 0, en: 0};
  for(const f of flat) n[f.l === 'en' ? 'en' : 'es']++;
  const b = MV.base || store.get('vozBase');
  const base = b ? `${b.es.id} (español) / ${b.en.id} (inglés)` : 'sin elegir todavía';
  el.textContent = `Mi voz: ${store.get('vozSE') ? 'voz grabada' : 'sin grabar'} · voces base: ${base} · ` +
    `frases del libro: ${n.es} en español, ${n.en} en inglés` +
    (n.en && n.es ? ' (cada frase se lee con la voz del idioma que se le detecta)' : '');
}
function openSheet(){
  const a = isAudioDoc();
  $('#engineBox').hidden = a; $('#audioNote').hidden = !a;
  setModo(modo); llenarNA();
  $('#diagTexto').textContent = store.get('diag', []).slice().reverse().join('\n') || 'Todavía no hay nada anotado.';
  verVersion(); verMiVoz();
  // Las llamadas al Entrenador (pcConf/pcRevisar) no existían: rompían la apertura de esta ventana.
  if(modo === 'mivoz' && VOZ_SENSIBLE_ACTIVA) cargarEnt().then(pintarEnt).catch(()=>{});
  if(modo === 'natural' && doc && !isAudioDoc()) discoNA().then(()=>{ mostrarAdelanto(); actualizarNA(); });
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
function showStatus(msg, kind, frac, actionText, onAction){
  $('#statusText').textContent = msg; $('#status').className = 'status' + (kind ? ' '+kind : ''); $('#status').hidden = false;
  const pr = $('#statusProg'); pr.hidden = frac == null; if(frac != null) pr.firstChild.style.width = Math.round(frac*100) + '%';
  const act = $('#statusAction');
  if(act){
    act.hidden = !actionText;
    if(actionText){ act.textContent = actionText; act.onclick = onAction || null; }
  }
}
function hideStatus(){
  $('#status').hidden = true;
  const act = $('#statusAction'); if(act) act.hidden = true;
}

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
    if(d){ setDoc(d, store.get('pos:'+d.key, 0)); showReader(); precalentarNA(); return; }
  }
  showLibrary();
})().then(()=> retomarPreparacion());
window.lectora = {estado: () => ({idx, playing, modo, sig: ST.sig,
  cargado: +cargadoST().toFixed(1), listasMV: MV.enDisco.size, generandoMV: MV.enCurso.size,
  sinGuardarMV: MV.mem.size, esperasMV: MV.silencios, esperaSegMV: +MV.silencioSeg.toFixed(1),
  listasNA: NA.hechas.size, generandoNA: NA.enCurso.size})};


