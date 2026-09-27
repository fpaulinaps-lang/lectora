// Proceso aparte que genera la voz con la tarjeta gráfica, sin congelar la pantalla.
import * as ort from '../vendor/ort/ort.webgpu.min.mjs';
import { crearNucleo } from './nucleo.js';

ort.env.wasm.wasmPaths = new URL('../vendor/ort/', import.meta.url).href;
ort.env.wasm.numThreads = 1;   // con varios hilos, ONNX Runtime se queda pegado dentro de un proceso aparte
const nucleo = crearNucleo(ort, true);

self.onmessage = async (e) => {
  const {id, fn, args} = e.data;
  try{
    const r = await nucleo[fn](...args);
    self.postMessage({id, ok: true, r}, r instanceof Float32Array ? [r.buffer] : []);
  }catch(err){
    self.postMessage({id, ok: false, error: fn + ': ' + String(err && err.message || err)});
  }
};
// Avisa si este proceso puede usar la tarjeta gráfica (algunos navegadores solo la dan en la página).
(async () => {
  let gpu = false;
  try{ gpu = !!(self.navigator.gpu && await self.navigator.gpu.requestAdapter()); }catch(e){}
  self.postMessage({listo: true, gpu});
})();
