// Motor de voz dentro del teléfono: Kokoro (voz natural) + conversor de timbre (tu voz).
// Todo corre en el aparato; los modelos se descargan una vez y quedan guardados.
//
// Con tarjeta gráfica (WebGPU) el cálculo va en un proceso aparte (voz-worker.js) y la pantalla no se congela.
// Sin ella, corre en la página con varios núcleos del procesador: más lento, y la pantalla se traba un poco
// mientras genera.
import { fonemasEs } from './es-fonemas.js';
import { remuestrear } from './nucleo.js';
export { remuestrear };

const HF = 'https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/main/';
const CACHE = 'lectora-modelos-v1';
export const SR = 24000;          // Kokoro
const SR_CONV = 22050;            // conversor de timbre
export const VOCES = {
  es: [{id:'ef_dora', nombre:'Dora', tipo:'mujer'}, {id:'em_alex', nombre:'Álex', tipo:'hombre'}],
  en: [{id:'af_heart', nombre:'Heart', tipo:'mujer'}, {id:'af_bella', nombre:'Bella', tipo:'mujer'},
       {id:'am_michael', nombre:'Michael', tipo:'hombre'}, {id:'am_fenrir', nombre:'Fenrir', tipo:'hombre'}],
};

let GPU = false;
export function configurar({gpu = false} = {}){ GPU = gpu; }
export const usaGPU = () => GPU;
const modeloKokoro = () => HF + 'onnx/' + (GPU ? 'model.onnx' : 'model_quantized.onnx');
export const tamanoVoz = () => GPU ? 326 : 92;   // MB que se descargan la primera vez
// ¿Está todo descargado? Sirve para precalentar al abrir la app sin gastar datos.
export async function modelosGuardados(conConversor){
  try{
    const c = await caches.open(CACHE);
    const urls = [modeloKokoro(), HF + 'tokenizer.json'];
    if(conConversor){ const base = new URL('./', import.meta.url).href; for(const p of ['conv_a', 'conv_b', 'conv_c']) urls.push(base + p + '.onnx', base + p + '.f16'); }
    for(const u of urls) if(!(await c.match(u))) return false;
    return true;
  }catch(e){ return false; }
}

/* ---------- descargas con memoria ---------- */
async function traer(url, alAvanzar){
  let cache = null;
  try{ cache = await caches.open(CACHE); const hit = await cache.match(url); if(hit) return new Uint8Array(await hit.arrayBuffer()); }catch(e){}
  const r = await fetch(url);
  if(!r.ok) throw new Error('No se pudo descargar ' + url.split('/').pop() + ' (' + r.status + '). Revisa tu conexión.');
  const total = +r.headers.get('content-length') || 0;
  let datos;
  if(r.body && total && alAvanzar){
    const lector = r.body.getReader(); datos = new Uint8Array(total); let n = 0;
    for(;;){ const {done, value} = await lector.read(); if(done) break;
      if(n + value.length > datos.length){ const d2 = new Uint8Array(Math.max(datos.length*2, n+value.length)); d2.set(datos); datos = d2; }
      datos.set(value, n); n += value.length; alAvanzar(n, total); }
    datos = datos.subarray(0, n);
  } else datos = new Uint8Array(await r.arrayBuffer());
  try{ if(cache) await cache.put(url, new Response(datos, {headers:{'content-type':'application/octet-stream'}})); }catch(e){}
  return datos;
}
// ArrayBuffer transferible. Si el Uint8Array ocupa todo su buffer se entrega tal cual: copiar los 326 MB
// del modelo solo agregaba segundos y memoria al arranque.
const copia = u8 => (u8.byteOffset === 0 && u8.byteLength === u8.buffer.byteLength) ? u8.buffer : u8.slice().buffer;

// Pesos guardados en media precisión: se expanden a float32 al cargar.
const MITAD = (()=>{
  const t = new Float32Array(65536);
  for(let h = 0; h < 65536; h++){
    const s = h & 0x8000 ? -1 : 1, e = (h >> 10) & 0x1f, f = h & 0x3ff;
    t[h] = e === 0 ? s * Math.pow(2, -14) * (f / 1024) : e === 31 ? (f ? NaN : s * Infinity) : s * Math.pow(2, e - 15) * (1 + f / 1024);
  }
  return t;
})();
function expandir(u8){
  const buf = (u8.byteOffset % 2 === 0) ? u8.buffer : u8.slice().buffer;
  const off = (u8.byteOffset % 2 === 0) ? u8.byteOffset : 0;
  const u16 = new Uint16Array(buf, off, Math.floor(u8.byteLength / 2));
  const f = new Float32Array(u16.length);
  for(let i = 0; i < u16.length; i++) f[i] = MITAD[u16[i]];
  return f.buffer;
}

/* ---------- procesos aparte: la voz nunca se calcula en la página (la congelaría) ---------- */
// Con tarjeta gráfica: un proceso (voz-worker.js) hace todo en la GPU.
// Sin ella (iPhone con iOS 18 o anterior): dos procesos con el procesador, uno por núcleo, que trabajan en
// paralelo. Con tu voz, uno genera la voz natural y el otro le pone tu timbre; con la voz natural, los dos
// generan frases distintas. (ONNX Runtime se cuelga si usa varios hilos dentro de un proceso aparte.)
function crearProceso(url){
  const w = new Worker(url, {type:'module'});
  const pendientes = new Map(); let n = 0;
  const p = {carga: 0, kokoro: false, conversor: false};
  p.listo = new Promise((res, rej)=>{
    w.onmessage = e => {
      if(e.data.listo){ res(e.data); return; }
      const q = pendientes.get(e.data.id); if(!q) return; pendientes.delete(e.data.id); p.carga--;
      e.data.ok ? q.res(e.data.r) : q.rej(new Error(e.data.error));
    };
    w.onerror = e => rej(new Error('No se pudo iniciar el motor de voz: ' + (e.message || 'error')));
  });
  p.llamar = (fn, ...args) => new Promise((res, rej)=>{
    const id = ++n; pendientes.set(id, {res, rej}); p.carga++;
    // los buffers (también los que van dentro de un objeto) se transfieren en vez de copiarse
    const bufs = args.flatMap(x => x instanceof ArrayBuffer ? [x] : (x && typeof x === 'object' && !ArrayBuffer.isView(x)) ? Object.values(x).filter(v => v instanceof ArrayBuffer) : []);
    w.postMessage({id, fn, args}, bufs);
  });
  p.terminar = () => w.terminate();
  return p;
}
let procP = null;
function procesos(){
  if(procP) return procP;
  procP = (async ()=>{
    if(GPU){
      const w = crearProceso(new URL('./voz-worker.js', import.meta.url));
      const info = await w.listo;
      if(info.gpu) return {gpu: true, voz: [w], conv: w, todos: [w]};
      w.terminar(); GPU = false;
    }
    const a = crearProceso(new URL('./voz-worker-cpu.js', import.meta.url));
    const b = crearProceso(new URL('./voz-worker-cpu.js', import.meta.url));
    await Promise.all([a.listo, b.listo]);
    return {gpu: false, voz: [a], conv: b, extra: b, todos: [a, b]};
  })();
  procP.catch(()=>{ procP = null; });
  return procP;
}

/* ---------- voz natural ---------- */
let vocab = null, kokoroListo = null, paraleloListo = null;
async function cargarKokoroEn(p, alAvanzar){
  const modelo = await traer(modeloKokoro(), (n, t)=>alAvanzar('Descargando la voz natural', n, t));
  await p.llamar('cargarKokoro', copia(modelo));
  p.kokoro = true;
}
export function prepararVoz(alAvanzar = ()=>{}){
  if(!kokoroListo) kokoroListo = (async ()=>{
    let pr = await procesos();
    const tok = await traer(HF + 'tokenizer.json');
    vocab = JSON.parse(new TextDecoder().decode(tok)).model.vocab;
    alAvanzar('Preparando la voz', 1, 1);
    try{
      await cargarKokoroEn(pr.voz[0], alAvanzar);
    }catch(err){
      if(!pr.gpu) throw err;
      // la tarjeta gráfica falló: se sigue con el procesador (y el modelo liviano)
      pr.todos.forEach(p => p.terminar()); procP = null; GPU = false;
      pr = await procesos();
      await cargarKokoroEn(pr.voz[0], alAvanzar);
    }
    // Todas las voces pesan poco (medio MB cada una): se guardan de una vez para poder cambiar de voz sin internet.
    for(const v of [...VOCES.es, ...VOCES.en]) traer(HF + 'voices/' + v.id + '.bin').catch(()=>{});
  })();
  kokoroListo.catch(()=>{ kokoroListo = null; });
  return kokoroListo;
}
// Cuántas frases se pueden generar a la vez (procesos con la voz natural cargada).
export async function paralelo(){ const pr = await procesos(); return Math.max(1, pr.voz.filter(x => x.kokoro).length); }
// Solo sin tarjeta gráfica: un segundo proceso también genera voz natural (el doble de rápido).
// Con la voz natural se usa el segundo proceso; con tu voz ese ya está ocupado con el timbre, así que se abre un tercero.
export function vozEnParalelo(conTimbre = false){
  if(!paraleloListo) paraleloListo = (async ()=>{
    await prepararVoz();
    const pr = await procesos();
    if(pr.gpu || pr.voz.length > 1) return;
    let q = pr.extra;
    if(conTimbre){ q = crearProceso(new URL('./voz-worker-cpu.js', import.meta.url)); await q.listo; pr.todos.push(q); }
    await cargarKokoroEn(q, ()=>{});
    pr.voz.push(q);
  })();
  paraleloListo.catch(()=>{ paraleloListo = null; });
  return paraleloListo;
}
const vocesCargadas = new Map();
async function estiloDe(id){
  if(!vocesCargadas.has(id)){
    const b = await traer(HF + 'voices/' + id + '.bin');
    vocesCargadas.set(id, new Float32Array(b.slice().buffer));
  }
  return vocesCargadas.get(id);
}
let fonemasEn = null;
async function fonemas(texto, lang){
  if(lang === 'es') return fonemasEs(texto);
  if(!fonemasEn){
    const m = await import(new URL('../vendor/phonemizer.js', import.meta.url).href);
    fonemasEn = async t => {
      const partes = t.replace(/[‘’]/g, "'").replace(/[“”«»]/g, '"').split(/(\s*[;:,.!?—…"()]+\s*)/);
      let out = '';
      for(const p of partes){ if(!p) continue; out += /^[\s;:,.!?—…"()]+$/.test(p) ? p : (await m.phonemize(p, 'en-us')).join(' '); }
      return out.replace(/ʲ/g, 'j').replace(/r/g, 'ɹ').replace(/x/g, 'k').replace(/ɬ/g, 'l')
                .replace(/(?<=nˈaɪn)ti(?!ː)/g, 'di').replace(/ z(?=[;:,.!?—…" ]|$)/g, 'z').trim();
    };
  }
  return fonemasEn(texto);
}
// Devuelve el audio (24 kHz) de una frase.
export async function hablar(texto, lang, vozId, velocidad = 1){
  await prepararVoz();
  const ps = await fonemas(texto, lang);
  const ids = [...ps].map(c => vocab[c]).filter(x => x !== undefined);
  const estilo = await estiloDe(vozId);
  const pr = await procesos();
  // el proceso con voz natural cargada que esté menos ocupado
  const p = pr.voz.filter(x => x.kokoro).sort((x, y) => x.carga - y.carga)[0];
  const trozos = [];
  for(let i = 0; i < ids.length; ){                       // Kokoro acepta hasta 510 fonemas por vez
    let fin = Math.min(ids.length, i + 500);
    if(fin < ids.length){ const esp = ids.lastIndexOf(vocab[' '], fin); if(esp > i + 100) fin = esp; }
    const parte = ids.slice(i, fin), n = Math.min(parte.length, 509);
    trozos.push(await p.llamar('kokoro', parte, estilo.slice(256 * n, 256 * n + 256), velocidad));
    i = fin;
  }
  return unir(trozos);
}
function unir(ts){ const n = ts.reduce((a, t) => a + t.length, 0); const o = new Float32Array(n); let k = 0; for(const t of ts){ o.set(t, k); k += t.length; } return o; }

/* ---------- tu voz ---------- */
let huellaLista = null, convListo = null;
export function prepararHuella(){
  if(!huellaLista) huellaLista = (async ()=>{
    const h = await traer(new URL('./huella.onnx', import.meta.url).href);
    await (await procesos()).conv.llamar('cargarHuella', copia(h));
  })();
  huellaLista.catch(()=>{ huellaLista = null; });
  return huellaLista;
}
export function prepararConversor(alAvanzar = ()=>{}){
  if(!convListo) convListo = (async ()=>{
    const base = new URL('./', import.meta.url).href;
    const tam = {conv_a: 19.7e6, conv_b: 17.3e6, conv_c: 28.9e6}, hecho = {};
    const total = Object.values(tam).reduce((x, y) => x + y);
    const bajados = await Promise.all(Object.keys(tam).flatMap(p => [
      traer(base + p + '.onnx'),
      traer(base + p + '.f16', (n)=>{ hecho[p] = n; alAvanzar('Descargando el conversor de tu voz', Object.values(hecho).reduce((x, y) => x + y, 0), total); }),
    ]));
    alAvanzar('Preparando tu voz', 1, 1);
    const [a, aP, b, bP, c, cP] = bajados;
    const pr = await procesos();
    const partes = {a: copia(a), aPesos: expandir(aP), b: copia(b), bPesos: expandir(bP), c: copia(c), cPesos: expandir(cP)};
    await pr.conv.llamar('cargarConversor', partes);
    pr.conv.conversor = true;
  })();
  convListo.catch(()=>{ convListo = null; });
  return convListo;
}
// Huella del timbre (256 números) a partir de audio a cualquier frecuencia.
export async function huellaDe(audio, sr){
  await prepararHuella();
  return await (await procesos()).conv.llamar('huella', Float32Array.from(audio), sr);
}
// El cambio de frecuencia también se hace en el núcleo, para no trabar la pantalla.
export async function convertir(audio24, src, tgt){
  await prepararConversor();
  return await (await procesos()).conv.llamar('convertir', Float32Array.from(audio24), Float32Array.from(src), Float32Array.from(tgt), SR);
}
export function parecido(a, b){
  let d = 0, na = 0, nb = 0;
  for(let i = 0; i < a.length; i++){ d += a[i]*b[i]; na += a[i]*a[i]; nb += b[i]*b[i]; }
  return d / Math.sqrt(na * nb);
}

/* ---------- utilidades de audio ---------- */
export function recortar(a){
  let i = 0, j = a.length - 1;
  while(i < j && Math.abs(a[i]) < 0.01) i++;
  while(j > i && Math.abs(a[j]) < 0.01) j--;
  return a.slice(Math.max(0, i - 480), Math.min(a.length, j + 960));
}
export function wav(a, sr = SR){
  const b = new ArrayBuffer(44 + a.length * 2), v = new DataView(b);
  const w = (o, s) => { for(let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  w(0, 'RIFF'); v.setUint32(4, 36 + a.length * 2, true); w(8, 'WAVEfmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true);
  v.setUint16(22, 1, true); v.setUint32(24, sr, true); v.setUint32(28, sr * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  w(36, 'data'); v.setUint32(40, a.length * 2, true);
  for(let i = 0; i < a.length; i++) v.setInt16(44 + i * 2, Math.max(-1, Math.min(1, a[i])) * 32767, true);
  return new Blob([b], {type:'audio/wav'});
}
