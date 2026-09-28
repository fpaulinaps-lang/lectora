// Guarda la app en el teléfono para que abra sin internet, y la aísla (COOP/COEP)
// para que la voz pueda usar varios núcleos del procesador.
const CACHE = 'lectora-v11';                // la app: se renueva con cada versión
const EXTRA = 'lectora-archivos';           // lo que se guarda al usarlo (motor de voz, etc.): sobrevive a las versiones
const FILES = ['./', 'index.html', 'app.js', 'manifest.webmanifest', 'vendor/pdf.min.js', 'vendor/pdf.worker.min.js',
  'voz/motor.js', 'voz/es-fonemas.js', 'voz/nucleo.js', 'voz/voz-worker.js', 'vendor/phonemizer.js',
  'vendor/ort/ort.wasm.min.mjs', 'vendor/ort/ort.webgpu.min.mjs',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png'];
// Los modelos de voz los guarda el propio motor (voz/motor.js, caché lectora-modelos-v1); aquí no se duplican.
const GRANDES = /\.(onnx|f16|bin)$/;
const ESPERA_RED = 4000;                    // con mala señal, no esperar más que esto antes de usar la copia guardada

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  // Solo se borran las versiones viejas de la app; el motor de voz y los modelos se conservan.
  // (Las versiones anteriores guardaban el motor junto con la app: se rescata antes de borrar.)
  e.waitUntil((async () => {
    const extra = await caches.open(EXTRA);
    for (const k of await caches.keys()) {
      if (!/^lectora-v\d+$/.test(k) || k === CACHE) continue;
      const vieja = await caches.open(k);
      for (const req of await vieja.keys()) {
        if (/\/vendor\/ort\//.test(req.url) && !(await extra.match(req))) { const r = await vieja.match(req); if (r) await extra.put(req, r); }
      }
      await caches.delete(k);
    }
    await self.clients.claim();
  })());
});

function aislar(r){
  if(!r || r.type === 'opaque' || r.status === 0 || r.status === 304 || r.status === 204 || r.status === 205) return r;
  const h = new Headers(r.headers);
  h.set('Cross-Origin-Opener-Policy', 'same-origin');
  h.set('Cross-Origin-Embedder-Policy', 'require-corp');
  h.set('Cross-Origin-Resource-Policy', 'same-origin');
  return new Response(r.body, {status: r.status, statusText: r.statusText, headers: h});
}

// Primero la red, para que las mejoras lleguen; sin conexión (o si tarda demasiado), la copia guardada.
async function redPrimero(req, clave, cacheNombre){
  const peticion = (typeof req === 'string' || req.mode === 'navigate') ? (req.url || req) : req;
  const guardada = caches.match(clave);
  try{
    const red = fetch(peticion).then(r => {
      if (r && r.ok) { const copia = r.clone(); caches.open(cacheNombre).then(c => c.put(clave, copia)).catch(()=>{}); }
      return r;
    });
    // con mala señal, si tarda más de ESPERA_RED y ya tenemos copia guardada, usarla de inmediato
    const timeout = new Promise(res => setTimeout(res, ESPERA_RED, 'timeout'));
    const ganadora = await Promise.race([red, timeout]);
    if (ganadora !== 'timeout') return aislar(ganadora);
    const c = await guardada;
    if (c) return aislar(c);
    return aislar(await red);
  }catch(err){
    const c = await guardada;
    if (c) return aislar(c);
    throw err;
  }
}

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);
  if (url.origin !== self.location.origin) return;   // fuentes y modelos externos: directo (vienen con CORS)
  if (GRANDES.test(url.pathname)) {                  // modelos: el motor ya los guarda; aquí solo se aíslan
    e.respondWith(fetch(e.request).then(aislar));
    return;
  }
  if (e.request.mode === 'navigate') {
    e.respondWith(redPrimero(e.request, new URL('index.html', self.registration.scope).href, CACHE));
    return;
  }
  e.respondWith(redPrimero(e.request, e.request.url, EXTRA));
});
