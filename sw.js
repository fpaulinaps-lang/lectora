// Guarda la app en el teléfono para que abra sin internet, y la aísla (COOP/COEP)
// para que la voz pueda usar varios núcleos del procesador.
const CACHE = 'lectora-v4';
const FILES = ['./', 'index.html', 'app.js', 'manifest.webmanifest', 'vendor/pdf.min.js', 'vendor/pdf.worker.min.js',
  'voz/motor.js', 'voz/es-fonemas.js', 'voz/nucleo.js', 'voz/voz-worker.js', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png'];
// Los modelos de voz los guarda el propio motor (voz/motor.js); aquí no se duplican.
const GRANDES = /\.(onnx|f16|bin)$/;

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k.startsWith('lectora-v') && k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

function aislar(r){
  if(!r || r.type === 'opaque' || r.status === 0) return r;
  const h = new Headers(r.headers);
  h.set('Cross-Origin-Opener-Policy', 'same-origin');
  h.set('Cross-Origin-Embedder-Policy', 'require-corp');
  h.set('Cross-Origin-Resource-Policy', 'same-origin');
  return new Response(r.body, {status: r.status, statusText: r.statusText, headers: h});
}

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);
  const propio = url.origin === self.location.origin;
  if (!propio) return;                       // fuentes y modelos externos: directo (vienen con CORS)
  if (GRANDES.test(url.pathname)) {          // archivos grandes: red o caché del navegador, sin copia extra
    e.respondWith(fetch(e.request).then(aislar));
    return;
  }
  // La página: primero la red (para recibir mejoras); sin conexión, la copia guardada.
  if (e.request.mode === 'navigate') {
    e.respondWith(fetch(e.request).then(r => {
      const copy = r.clone(); caches.open(CACHE).then(c => c.put('index.html', copy)); return aislar(r);
    }).catch(() => caches.match('index.html').then(aislar)));
    return;
  }
  // Lo demás: primero la red para que las mejoras lleguen; si falla, la copia guardada.
  e.respondWith(fetch(e.request).then(r => {
    if (r.ok) { const copy = r.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); }
    return aislar(r);
  }).catch(() => caches.match(e.request).then(aislar)));
});
