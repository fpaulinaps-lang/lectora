// Voz natural con Piper (voces libres, licencia MIT): pronunciación con espeak-ng y modelo VITS con ONNX Runtime.
// Corre en un proceso aparte, con el procesador; es mucho más liviano que Kokoro, así que alcanza para leer en vivo.
import * as ort from '../vendor/ort/ort.wasm.min.mjs';

ort.env.wasm.wasmPaths = new URL('../vendor/ort/', import.meta.url).href;
ort.env.wasm.numThreads = 1;   // varios hilos dentro de un proceso aparte cuelgan ONNX Runtime
const BASE = new URL('../vendor/piper/', import.meta.url).href;

let fonemP = null, salida = null;
const voces = {};
function fonemizador(){
  if(!fonemP) fonemP = (async ()=>{
    const codigo = await (await fetch(BASE + 'piper_phonemize.js')).text();
    (0, eval)(codigo + ';self.createPiperPhonemize = createPiperPhonemize;');
    return await self.createPiperPhonemize({
      print: t => salida && salida(t), printErr: () => {},
      locateFile: u => BASE + (u.endsWith('.wasm') ? 'piper_phonemize.wasm' : 'piper_phonemize.data'),
    });
  })();
  return fonemP;
}
// Texto -> números de fonemas (piper_phonemize devuelve una línea JSON por oración).
async function fonemas(texto, idioma){
  const m = await fonemizador();
  const ids = [];
  salida = t => { try{ ids.push(...JSON.parse(t).phoneme_ids); }catch(e){} };
  m.callMain(['-l', idioma, '--input', JSON.stringify([{text: texto}]), '--espeak_data', '/espeak-ng-data']);
  salida = null;
  return ids;
}

const api = {
  async cargar(id, modelo, config){
    if(!voces[id]){
      const cfg = JSON.parse(new TextDecoder().decode(config));
      voces[id] = {cfg, ses: await ort.InferenceSession.create(new Uint8Array(modelo), {executionProviders: ['wasm'], graphOptimizationLevel: 'all'})};
    }
    await fonemizador();
    return voces[id].cfg.audio.sample_rate;
  },
  // largo > 1 habla más lento (1,0 = normal); ruido = variación de la entonación
  async hablar(id, texto, largo = 1, ruido){
    const v = voces[id], inf = v.cfg.inference || {};
    const ids = await fonemas(texto, v.cfg.espeak.voice);
    if(!ids.length) return new Float32Array(0);
    const feeds = {
      input: new ort.Tensor('int64', BigInt64Array.from(ids.map(BigInt)), [1, ids.length]),
      input_lengths: new ort.Tensor('int64', BigInt64Array.from([BigInt(ids.length)]), [1]),
      scales: new ort.Tensor('float32', new Float32Array([ruido ?? inf.noise_scale ?? 0.667, (inf.length_scale ?? 1) * largo, inf.noise_w ?? 0.8]), [3]),
    };
    if(v.cfg.num_speakers > 1) feeds.sid = new ort.Tensor('int64', BigInt64Array.from([0n]), [1]);
    const r = await v.ses.run(feeds);
    return Float32Array.from(r.output.data);
  },
};
// Un pedido a la vez, en orden (ONNX Runtime no admite dos cálculos simultáneos en la misma sesión).
let fila = Promise.resolve();
self.onmessage = e => { fila = fila.then(() => atender(e.data)); };
async function atender({id, fn, args}){
  try{ const r = await api[fn](...args); self.postMessage({id, ok: true, r}, r instanceof Float32Array ? [r.buffer] : []); }
  catch(err){ self.postMessage({id, ok: false, error: fn + ': ' + String(err && err.message || err)}); }
}
self.postMessage({listo: true});
