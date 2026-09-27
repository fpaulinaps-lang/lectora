// Núcleo de cálculo de la voz. Corre dentro de un proceso aparte (con tarjeta gráfica) o, si el teléfono
// no tiene WebGPU, en la página misma usando varios núcleos del procesador.
//
// Reparto con tarjeta gráfica: voz natural (Kokoro), parte A y parte C del conversor en la GPU;
// la parte B (flujo) en el procesador, porque la GPU calcula mal una de sus operaciones.

const SR_CONV = 22050;

function gauss(n){
  const a = new Float32Array(n);
  for(let i = 0; i < n; i += 2){
    const u = Math.random() || 1e-9, v = Math.random(), r = Math.sqrt(-2 * Math.log(u));
    a[i] = r * Math.cos(2 * Math.PI * v);
    if(i + 1 < n) a[i + 1] = r * Math.sin(2 * Math.PI * v);
  }
  return a;
}

export function remuestrear(x, de, a){
  if(de === a) return x;
  const razon = de / a, n = Math.floor(x.length / razon), y = new Float32Array(n);
  const corte = Math.min(1, 1 / razon), R = 8;
  for(let i = 0; i < n; i++){
    const c = i * razon, i0 = Math.floor(c);
    let s = 0, w = 0;
    for(let k = i0 - R + 1; k <= i0 + R; k++){
      if(k < 0 || k >= x.length) continue;
      const t = c - k, sinc = t === 0 ? 1 : Math.sin(Math.PI * t * corte) / (Math.PI * t * corte);
      const ven = 0.5 + 0.5 * Math.cos(Math.PI * t / R);
      const g = sinc * ven; s += x[k] * g; w += g;
    }
    y[i] = w ? s / w : 0;
  }
  return y;
}

export function crearNucleo(ort, gpu){
  const EP_GPU = gpu ? ['webgpu', 'wasm'] : ['wasm'];
  const EP_CPU = ['wasm'];
  let kokoro = null, a = null, b = null, c = null, huella = null;
  const ses = (bytes, ep, pesos, nombre) => ort.InferenceSession.create(new Uint8Array(bytes), {
    executionProviders: ep, graphOptimizationLevel: 'all',
    ...(pesos ? {externalData: [{path: nombre + '.bin', data: new Uint8Array(pesos)}]} : {}),
  });
  const T = (d, dims) => new ort.Tensor('float32', d, dims);
  // ONNX Runtime con tarjeta gráfica no admite dos cálculos a la vez (ni en sesiones distintas): van en fila.
  let fila = Promise.resolve();
  const turno = fn => { const p = fila.then(fn); fila = p.catch(()=>{}); return p; };
  const correr = (s, feeds) => turno(() => s.run(feeds));
  const primero = r => Object.values(r)[0].data;

  return {
    async cargarKokoro(bytes){ if(!kokoro) kokoro = await turno(() => ses(bytes, EP_GPU)); return true; },
    async kokoro(ids, estilo, velocidad){
      const n = ids.length;
      const r = await correr(kokoro, {
        input_ids: new ort.Tensor('int64', BigInt64Array.from([0, ...ids, 0].map(BigInt)), [1, n + 2]),
        style: T(Float32Array.from(estilo), [1, 256]),
        speed: T(new Float32Array([velocidad]), [1]),
      });
      return Float32Array.from(primero(r));
    },
    async cargarConversor(p){
      if(a) return true;
      a = await turno(() => ses(p.a, EP_GPU, p.aPesos, 'conv_a'));
      b = await turno(() => ses(p.b, EP_GPU, p.bPesos, 'conv_b'));
      c = await turno(() => ses(p.c, EP_GPU, p.cPesos, 'conv_c'));
      return true;
    },
    async cargarHuella(bytes){ if(!huella) huella = await turno(() => ses(bytes, EP_CPU)); return true; },
    async huella(audio, sr){
      const a22 = remuestrear(audio, sr, SR_CONV);
      return Float32Array.from(primero(await correr(huella, {audio: T(a22, [1, a22.length])})));
    },
    // audio a la frecuencia sr -> audio con tu timbre, a la misma frecuencia
    async convertir(audio, src, tgt, sr){
      const audio22 = remuestrear(audio, sr, SR_CONV);
      const L = audio22.length;
      if(L < 1024) return Float32Array.from(audio);
      const f = Math.floor((L - 256) / 256) + 1;
      const z = await correr(a, {audio: T(audio22, [1, L]), ruido: T(gauss(192 * f), [1, 192, f])});
      const zv = Object.values(z)[0];
      const zc = T(Float32Array.from(await (zv.getData ? zv.getData() : zv.data)), zv.dims);
      const zh = await correr(b, {z: zc, src: T(Float32Array.from(src), [1, 256, 1]), tgt: T(Float32Array.from(tgt), [1, 256, 1])});
      const y = await correr(c, {z: Object.values(zh)[0]});
      return Float32Array.from(remuestrear(primero(y), SR_CONV, sr));
    },
    SR_CONV,
  };
}
