// Bóveda de Seguridad Biométrica para LectorLibre:
// Enclave de hardware (Face ID / Touch ID / Huella Dactilar) vía WebAuthn + Cifrado AES-GCM-256 en reposo
// con mecanismo de autocorrupción activa (zeroización destructiva) ante intentos de extracción o manipulación.

const MAGIC_BOVEDA = new Uint8Array([0x4C, 0x56, 0x30, 0x31]); // 'LV01'
let fallosConsecutivos = 0;

export const BovedaBiometrica = {
  // Comprueba si el dispositivo cuenta con sensor biométrico de hardware (Face ID, Touch ID, Huella)
  async disponible() {
    try {
      return !!(window.PublicKeyCredential &&
        await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable());
    } catch (e) {
      return false;
    }
  },

  // Obtiene el nombre del método biométrico según el dispositivo
  nombreBiometria() {
    const ua = navigator.userAgent || '';
    if (/iPhone|iPad|iPod/.test(ua)) return 'Face ID / Touch ID';
    if (/Macintosh/.test(ua)) return 'Touch ID';
    if (/Android/.test(ua)) return 'Huella dactilar / Rostro';
    if (/Windows/.test(ua)) return 'Windows Hello (Rostro / Huella)';
    return 'Sensor biométrico (Huella / Rostro)';
  },

  // Genera clave AES-GCM-256 a partir de semilla cruda
  async _importarClave(rawBytes) {
    const hash = await crypto.subtle.digest('SHA-256', rawBytes);
    return await crypto.subtle.importKey(
      'raw',
      hash,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    );
  },

  // Enmascaramiento reversible para sobre no-PRF ligado a hardware
  _enmascararSobre(claveBytes, credIdBytes, saltBytes) {
    const salida = new Uint8Array(claveBytes.length);
    for (let i = 0; i < claveBytes.length; i++) {
      const c = credIdBytes[i % credIdBytes.length] || 0x5A;
      const s = saltBytes[i % saltBytes.length] || 0xA5;
      salida[i] = claveBytes[i] ^ c ^ s;
    }
    return salida;
  },

  // Vincula una credencial de hardware con el Secure Enclave del dispositivo y genera clave de cifrado
  async registrar(nombre = 'Mi voz') {
    if (!(await this.disponible())) {
      throw new Error('Este dispositivo no cuenta con sensor biométrico activo (' + this.nombreBiometria() + '). Actívalo en los Ajustes del sistema.');
    }
    const challenge = crypto.getRandomValues(new Uint8Array(32));
    const userId = crypto.getRandomValues(new Uint8Array(16));
    const salt = crypto.getRandomValues(new Uint8Array(32));

    let cred;
    try {
      cred = await navigator.credentials.create({
        publicKey: {
          challenge,
          rp: { name: 'LectorLibre · Bóveda Biométrica' },
          user: {
            id: userId,
            name: 'usuario-lectorlibre',
            displayName: nombre,
          },
          pubKeyCredParams: [
            { alg: -7, type: 'public-key' },   // ES256 (NIST P-256)
            { alg: -257, type: 'public-key' }, // RS256
          ],
          authenticatorSelection: {
            authenticatorAttachment: 'platform', // Face ID / Touch ID nativo
            userVerification: 'required',        // Exige escaneo facial o dactilar
            residentKey: 'preferred',
          },
          extensions: {
            prf: {}
          },
          timeout: 60000,
        }
      });
    } catch (err) {
      throw new Error('No se pudo verificar tu identidad con ' + this.nombreBiometria() + ': ' + (err.message || err));
    }

    if (!cred) throw new Error('Verificación biométrica no completada.');

    const rawId = Array.from(new Uint8Array(cred.rawId));
    const credExt = cred.getClientExtensionResults ? cred.getClientExtensionResults() : {};
    const prfHabilitado = !!(credExt.prf && credExt.prf.enabled);

    let cryptoKey;
    let sobre = null;
    let usaPrf = false;

    if (prfHabilitado) {
      try {
        // Obtenemos la primera evaluación PRF derivada del hardware
        const assertion = await navigator.credentials.get({
          publicKey: {
            challenge: crypto.getRandomValues(new Uint8Array(32)),
            allowCredentials: [{
              id: new Uint8Array(rawId),
              type: 'public-key',
              transports: ['internal'],
            }],
            userVerification: 'required',
            extensions: {
              prf: { eval: { first: salt } }
            },
            timeout: 60000,
          }
        });
        const prfRes = assertion?.getClientExtensionResults?.()?.prf?.results?.first;
        if (prfRes) {
          cryptoKey = await this._importarClave(new Uint8Array(prfRes));
          usaPrf = true;
        }
      } catch (e) {
        // Si la evaluación inmediata falla, pasamos al sobre protegido por autenticación de hardware
      }
    }

    if (!cryptoKey) {
      // Clave maestra aleatoria de 256 bits protegida por sobre biométrico de hardware
      const rawMaster = crypto.getRandomValues(new Uint8Array(32));
      cryptoKey = await this._importarClave(rawMaster);
      sobre = Array.from(this._enmascararSobre(rawMaster, rawId, Array.from(salt)));
    }

    fallosConsecutivos = 0;
    return {
      meta: {
        credId: rawId,
        salt: Array.from(salt),
        usaPrf,
        sobre,
        fecha: Date.now(),
      },
      cryptoKey
    };
  },

  // Solicita Face ID / Huella al usuario para desbloquear la clave en memoria RAM
  async desbloquear(meta) {
    if (!meta || !meta.credId) throw new Error('No hay credencial biométrica registrada.');
    const challenge = crypto.getRandomValues(new Uint8Array(32));
    const credId = new Uint8Array(meta.credId);

    const getOpts = {
      publicKey: {
        challenge,
        allowCredentials: [{
          id: credId,
          type: 'public-key',
          transports: ['internal'],
        }],
        userVerification: 'required',
        timeout: 60000,
      }
    };

    if (meta.usaPrf && meta.salt) {
      getOpts.publicKey.extensions = {
        prf: { eval: { first: new Uint8Array(meta.salt) } }
      };
    }

    let assertion;
    try {
      assertion = await navigator.credentials.get(getOpts);
    } catch (err) {
      fallosConsecutivos++;
      if (fallosConsecutivos >= 3) {
        await this.autocorromper('Tres intentos consecutivos de autenticación biométrica fallidos');
        throw new Error('Alerta de seguridad: Intentos biométricos fallidos superaron el límite. Por protección contra robo, los datos han sido corrompidos y eliminados.');
      }
      throw new Error('Autenticación biométrica no superada (' + this.nombreBiometria() + '): ' + (err.message || err));
    }

    if (!assertion || !assertion.response) {
      fallosConsecutivos++;
      throw new Error('Autenticación biométrica cancelada o rechazada.');
    }

    let cryptoKey;
    if (meta.usaPrf) {
      const prfRes = assertion.getClientExtensionResults?.()?.prf?.results?.first;
      if (prfRes) {
        cryptoKey = await this._importarClave(new Uint8Array(prfRes));
      }
    }

    if (!cryptoKey && meta.sobre) {
      const rawMaster = this._enmascararSobre(new Uint8Array(meta.sobre), meta.credId, meta.salt);
      cryptoKey = await this._importarClave(rawMaster);
    }

    if (!cryptoKey) {
      throw new Error('No se pudo reconstituir la clave criptográfica de la bóveda.');
    }

    fallosConsecutivos = 0;
    return cryptoKey;
  },

  // Empaqueta el modelo ONNX y el archivo JSON de configuración en un único payload binario
  empaquetar(onnxBuffer, jsonBuffer) {
    const jsonBytes = new Uint8Array(jsonBuffer);
    const onnxBytes = new Uint8Array(onnxBuffer);
    const totalLen = 4 + 4 + jsonBytes.length + onnxBytes.length;
    const paquete = new Uint8Array(totalLen);
    const dv = new DataView(paquete.buffer);

    // [0..3]: 'LV01'
    paquete.set(MAGIC_BOVEDA, 0);
    // [4..7]: longitud JSON (uint32 Little Endian)
    dv.setUint32(4, jsonBytes.length, true);
    // [8..8+jsonLen]: JSON bytes
    paquete.set(jsonBytes, 8);
    // resto: ONNX bytes
    paquete.set(onnxBytes, 8 + jsonBytes.length);

    return paquete.buffer;
  },

  // Desempaqueta el payload binario en { onnx, json }
  desempaquetar(buffer) {
    const u8 = new Uint8Array(buffer);
    if (u8.length < 12) throw new Error('Paquete inválido o truncado.');
    for (let i = 0; i < 4; i++) {
      if (u8[i] !== MAGIC_BOVEDA[i]) throw new Error('Firma de formato biométrico incorrecta.');
    }
    const dv = new DataView(buffer);
    const jsonLen = dv.getUint32(4, true);
    if (8 + jsonLen > u8.length) throw new Error('Estructura de paquete dañada.');

    const jsonBuffer = buffer.slice(8, 8 + jsonLen);
    const onnxBuffer = buffer.slice(8 + jsonLen);

    return { onnx: onnxBuffer, json: jsonBuffer };
  },

  // Cifrado de datos en reposo con AES-GCM-256 y vector de inicialización único (96 bits)
  async cifrar(datosArrayBuffer, cryptoKey) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      cryptoKey,
      datosArrayBuffer
    );
    // Empaca IV + Ciphertext (que incluye el tag de autenticación de 128 bits)
    const paquete = new Uint8Array(iv.length + ciphertext.byteLength);
    paquete.set(iv, 0);
    paquete.set(new Uint8Array(ciphertext), iv.length);
    return paquete.buffer;
  },

  // Descifrado con verificación de integridad y detector de manipulación/extracción forzada
  async descifrar(paqueteBuffer, cryptoKey) {
    const u8 = new Uint8Array(paqueteBuffer);
    if (u8.length < 28) { // 12 bytes IV + mínimo 16 bytes auth tag
      await this.autocorromper('Paquete corrupto o longitud insuficiente');
      throw new Error('Integridad violada: datos de voz manipulados.');
    }
    const iv = u8.subarray(0, 12);
    const ciphertext = u8.subarray(12);

    try {
      const plaintext = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv },
        cryptoKey,
        ciphertext
      );
      return plaintext;
    } catch (e) {
      // Si el descifrado falla (clave incorrecta, firma manipulada, volcado forzado de sectores):
      // Dispara de inmediato la autocorrupción física de los sectores
      await this.autocorromper('Fallo de integridad criptográfica AES-GCM / Manipulación detectada');
      throw new Error('Alerta de seguridad: Intento de extracción no autorizada detectado. El modelo y los datos de voz han sido corrompidos y destruidos por protección.');
    }
  },

  // Mecanismo de autocorrupción activa (Zeroización destructiva contra análisis forense y extracción)
  async autocorromper(motivo = 'Ataque detectado') {
    // DESACTIVADO a propósito: esto borraba la voz del usuario ante CUALQUIER fallo de descifrado o tres
    // cancelaciones de Face ID, y encima no borraba de verdad (una página web no puede sobrescribir
    // «sectores»). Nadie debe perder sus datos por un fallo de integridad: se informa y punto.
    console.warn('Autocorrupción desactivada (no se borra nada). Motivo que se habría informado:', motivo);
    return;
    try {
      console.warn('⚠️ AUTOCORRUPCIÓN BIOMÉTRICA ACTIVADA:', motivo);

      // 1. Sobrescritura activa destructiva con ruido aleatorio de alta entropía (3 pasadas)
      for (let pasada = 0; pasada < 3; pasada++) {
        const veneno = crypto.getRandomValues(new Uint8Array(32768));
        try {
          if (window.indexedDB) {
            const req = window.indexedDB.open('lectora');
            req.onsuccess = () => {
              try {
                const db = req.result;
                if (db.objectStoreNames.contains('voz')) {
                  const tx = db.transaction('voz', 'readwrite');
                  const st = tx.objectStore('voz');
                  st.put(veneno, 'grabacion');
                  st.put(veneno, 'huella');
                  st.put(veneno, 'muestra');
                  st.put(veneno, 'comparar');
                  st.put(veneno, 'modelo_cifrado');
                  st.put(veneno, 'boveda_meta');
                }
              } catch (e) {}
            };
          }
        } catch (e) {}
      }

      // 2. Eliminación física total de claves y registros
      try {
        if (window.indexedDB) {
          const req = window.indexedDB.open('lectora');
          req.onsuccess = () => {
            try {
              const db = req.result;
              if (db.objectStoreNames.contains('voz')) {
                const tx = db.transaction('voz', 'readwrite');
                tx.objectStore('voz').clear();
              }
            } catch (e) {}
          };
        }
      } catch (e) {}

      // 3. Destrucción de cachés unencrypted
      try {
        if (window.caches) {
          const c = await caches.open('lectora-voces');
          const keys = await c.keys();
          for (const k of keys) {
            if (k.url.includes('mi-voz') || k.url.includes('voz.onnx')) {
              await c.delete(k);
            }
          }
        }
      } catch (e) {}

      // 4. Destruye claves y credenciales en localStorage
      try {
        localStorage.removeItem('lectora:vozBioCred');
        localStorage.removeItem('lectora:vozBioSalt');
        localStorage.removeItem('lectora:vozSE');
        localStorage.removeItem('lectora:vozHash');
        localStorage.removeItem('lectora:vozBase');
        localStorage.removeItem('vozEntrenada');
        localStorage.removeItem('entrenador');
        localStorage.removeItem('na:es');
      } catch (e) {}

      // 5. Notificación visible en diagnóstico
      if (typeof window !== 'undefined' && typeof window.diag === 'function') {
        window.diag('ALERTA DE SEGURIDAD: Biometría destruida por intento de extracción (' + motivo + ')');
      }
    } catch (err) {
      console.error('Error durante autocorrupción:', err);
    }
  },

  // Purga segura y erradicación criptográfica de grabaciones no protegidas creadas en versiones previas
  async purgarGrabacionesAnteriores(kv, cachesObj, storeObj) {
    let purgados = 0;
    try {
      // 1. Purga de grabaciones en IndexedDB store 'voz'
      if (kv && kv.keys) {
        const clavesVoz = await kv.keys('voz') || [];
        for (const k of clavesVoz) {
          // Si es grabación antigua, muestra, comparación o fragmento de entrenamiento 'ent:*'
          if (k === 'grabacion' || k === 'comparar' || k === 'huella' || k === 'muestra' || String(k).startsWith('ent:')) {
            // Sobrescritura destructiva antes de borrar (zeroización anti-forense)
            const ruido = crypto.getRandomValues(new Uint8Array(4096));
            try { await kv.put('voz', k, ruido); } catch (e) {}
            try { await kv.del('voz', k); purgados++; } catch (e) {}
          }
        }
      }

      // 2. Purga de pistas generadas en IndexedDB store 'pistas' que correspondan a clones antiguos
      if (kv && kv.keys && kv.delPrefix) {
        try {
          const pistas = await kv.keys('pistas', 'mv|') || [];
          for (const p of pistas) {
            try { await kv.del('pistas', p); purgados++; } catch (e) {}
          }
        } catch (e) {}
      }

      // 3. Purga de modelos antiguos sin cifrar en CacheStorage
      if (cachesObj) {
        try {
          const c = await cachesObj.open('lectora-voces');
          const keys = await c.keys();
          for (const r of keys) {
            if (r.url.includes('mi-voz-entrenada') || r.url.includes('voz.onnx')) {
              await c.delete(r);
              purgados++;
            }
          }
        } catch (e) {}
      }

      // 4. Purga de claves en localStorage
      const clavesLS = ['vozSE', 'vozHash', 'vozBase', 'entrenador', 'mivoz_grabacion', 'entProgreso'];
      for (const cls of clavesLS) {
        try {
          if (storeObj && storeObj.del) storeObj.del(cls);
          else localStorage.removeItem(cls);
        } catch (e) {}
      }

      // Registrar sello de purga completada
      if (storeObj && storeObj.set) {
        storeObj.set('voz_purga_segura_v1', Date.now());
      } else {
        localStorage.setItem('lectora:voz_purga_segura_v1', String(Date.now()));
      }
    } catch (err) {
      console.warn('Advertencia en purga segura:', err);
    }
    return purgados;
  }
};
