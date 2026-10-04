// Guarda la app en el teléfono para que abra sin internet.
const CACHE = 'lectora-v35';                // la app: se renueva con cada versión
const EXTRA = 'lectora-archivos';           // lo que se guarda al usarlo: sobrevive a las versiones
const FILES = ['./', 'index.html', 'app.js', 'manifest.webmanifest', 'vendor/pdf.min.js', 'vendor/pdf.worker.min.js',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png'];
const GRANDES = /\.(onnx|f16|bin)$/;
const ESPERA_RED = 4000;                    // con mala señal, no esperar más que esto antes de usar la copia guardada

// GitHub Pages deja los archivos 10 minutos en la memoria del navegador. Para que una versión nueva no
// mezcle archivos viejos y nuevos, se piden con ?v=<versión> (sin opciones de fetch, que Safari rechaza)
// y se guardan con su dirección normal.
// Las librerías de vendor/ no cambian nunca (y el motor pesa 33 MB): esas no se vuelven a pedir.
const fresco = url => /\/vendor\//.test(url) ? url : url + (url.includes('?') ? '&' : '?') + 'v=' + CACHE;

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => Promise.all(FILES.map(async f => {
    const url = new URL(f, self.registration.scope).href;
    const r = await fetch(fresco(url));
    if (!r.ok) throw new Error('No se pudo guardar ' + f);
    await c.put(url, r);
  }))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  // Se borran las versiones viejas de la app; lo guardado al usarlo (motor de «Mi voz», OCR) se conserva.
  e.waitUntil((async () => {
    for (const k of await caches.keys()) {
      if (/^lectora-v\d+$/.test(k) && k !== CACHE) await caches.delete(k);
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
  const peticion = fresco(typeof req === 'string' ? req : req.url);
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
  if (/\/vendor\//.test(url.pathname)) {             // librerías (no cambian nunca): primero la copia guardada
    e.respondWith(caches.match(e.request.url).then(c => c ? aislar(c) : redPrimero(e.request, e.request.url, EXTRA)));
    return;
  }
  e.respondWith(redPrimero(e.request, e.request.url, EXTRA));
});
