// Proceso aparte que genera la voz con el procesador (teléfonos sin tarjeta gráfica para la web, como iOS 18).
// Un hilo por proceso: ONNX Runtime se cuelga si usa varios hilos dentro de un proceso aparte, así que la app
// abre dos procesos y reparte el trabajo entre ellos.
import * as ort from '../vendor/ort/ort.wasm.min.mjs';
import { crearNucleo } from './nucleo.js';

ort.env.wasm.wasmPaths = new URL('../vendor/ort/', import.meta.url).href;
ort.env.wasm.numThreads = 1;
const nucleo = crearNucleo(ort, false);

self.onmessage = async (e) => {
  const {id, fn, args} = e.data;
  try{
    const r = await nucleo[fn](...args);
    self.postMessage({id, ok: true, r}, r instanceof Float32Array ? [r.buffer] : []);
  }catch(err){
    self.postMessage({id, ok: false, error: fn + ': ' + String(err && err.message || err)});
  }
};
self.postMessage({listo: true, gpu: false});
