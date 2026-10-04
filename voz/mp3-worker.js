// Convierte la voz a MP3 en un proceso aparte (sin trabar la pantalla). Un solo codificador por lectura:
// así los trozos quedan pegados sin cortes ni chasquidos.
importScripts('../vendor/lame/lame.min.js');
let enc = null;
const KBPS = 56;                 // voz mono: 56 kbps sobra (~0,4 MB por minuto)
function juntar(partes){
  const n = partes.reduce((x, p) => x + p.length, 0), o = new Uint8Array(n); let k = 0;
  for(const p of partes){ o.set(p, k); k += p.length; }
  return o;
}
self.onmessage = e => {
  const {id, fn, sr, pcm} = e.data;
  try{
    let r = null;
    if(fn === 'nuevo') enc = new lamejs.Mp3Encoder(1, sr, KBPS);
    else if(fn === 'codificar'){
      const partes = [];
      for(let k = 0; k < pcm.length; k += 11520){ const b = enc.encodeBuffer(pcm.subarray(k, k + 11520)); if(b.length) partes.push(b); }
      r = juntar(partes);
    }
    else if(fn === 'terminar'){ const b = enc.flush(); r = juntar([b]); enc = null; }
    self.postMessage({id, ok: true, r}, r ? [r.buffer] : []);
  }catch(err){ self.postMessage({id, ok: false, error: String(err && err.message || err)}); }
};
