# SEGURIDAD — estado congelado de la voz entrenada

**Fecha:** 15-10-2026 · **Versión de la app:** v52 · **Estado:** función desactivada y datos de voz borrados.

Este documento explica qué se apagó, qué se borró, por qué, y qué falta para poder reactivarlo sin
volver a exponer la voz de quien use la app.

---

## 1. Qué queda apagado

| Pieza | Estado | Cómo |
|---|---|---|
| Bóveda «biométrica» (cifrado del modelo + Face ID) | **Apagada** | `VOZ_SENSIBLE_ACTIVA = false` en `app.js` |
| Importar paquete `.lectoravoz` | **Apagado** | la UI se oculta y `usarVozEntrenada()` no hace nada |
| Descifrar y usar la voz entrenada | **Apagado** | `cargarModeloNA()` la rechaza; no aparece en la lista de voces |
| Entrenador del computador (servidor local/red) | **Apagado** | `entrenador/entrenador.py` no arranca sin `LECTORLIBRE_ENTRENADOR_ACTIVO=1`, y aun así solo en 127.0.0.1 |
| Lanzador `~/LectorLibre-Entrenador/Abrir entrenador.command` | **Neutralizado** | solo muestra el aviso y sale (antes bajaba y arrancaba el servidor de red) |
| Autocorrupción (borrado automático ante fallos) | **Anulada** | `autocorromper()` ya no borra nada; informa y sigue |
| Purga de arranque (borraba datos sin preguntar) | **Reemplazada por el borrado explícito** (ver §2) |
| Grabación local de 50 s («Mi voz») | **Funcionando** | es local, sin red ni bóveda; se restauró el panel y sus botones |

Con esto, la app **no ejecuta ni envía a la red** nada de la función desactivada.

## 2. Datos de voz borrados (irreversible)

Borrados el 15-10-2026 de este computador (con sobrescritura de mejor esfuerzo antes de borrar):

| Ruta | Qué era | Tamaño |
|---|---|---|
| `~/LectoraEstudio/entrenar/monica/wav` | 230 grabaciones de tu voz | 24 MB |
| `~/LectoraEstudio/entrenar/monica/salida/mi-voz.onnx` + `.json` | **tu voz entrenada** (modelo exportado) | 61 MB |
| `~/LectoraEstudio/entrenar/monica/metadata.csv` | frases del entrenamiento | 16 KB |
| `~/LectoraEstudio/entrenar/datos/wav` + `metadata.csv` | 230 grabaciones (copia) | 24 MB |
| `~/LectoraEstudio/entrenar/prueba/wav` + `metadata.csv` | 60 grabaciones de prueba | 8,7 MB |
| `~/LectoraEstudio/entrenar/prueba/run` | checkpoints del entrenamiento de prueba | 1,6 GB |
| `~/LectoraEstudio/entrenar/monica-run` | checkpoints de tu voz entrenada | 4,7 GB |
| `~/LectoraEstudio/entrenar/monica.zip` | grabaciones comprimidas | 21 MB |
| `~/LectoraEstudio/entrenar/monica-entrenar.log` | registro del entrenamiento | 196 KB |
| `~/LectoraEstudio/mic-prueba.wav` | prueba de micrófono | 3,6 MB |
| `~/LectorLibre-Entrenador/config.json` | código de emparejamiento con el teléfono | 4 KB |

**Total: ~6,6 GB.** Permisos ajustados: `~/LectorLibre-Entrenador` a `700` y el checkpoint a `600`.

**En el teléfono:** la app v52 borra al arrancar las grabaciones de entrenamiento (`ent:*`), el modelo
cifrado, su llave y la huella (`vozSE`), y muestra un aviso. Hasta que el teléfono reciba esta versión,
la v49 publicada todavía guarda esas 230 grabaciones en IndexedDB: para borrarlas hay que abrir la app
actualizada una vez (o borrar los datos del sitio desde el navegador).

### Qué NO se borró (no es tu voz, es material público y re-descargable)

- `ald.ckpt`, `ald-limpio.ckpt` (×3, ~2,4 GB): la voz **Ald** de Piper, de dominio público, que se usa
  como punto de partida. Se pueden borrar sin problema: el instalador los vuelve a bajar.
- `ald.onnx` (61 MB): exportación de esa misma voz pública.
- `piper1-gpl/`, `venv`, `rueda/`: código y librerías.

## 3. Por qué se apagó (hallazgos medidos)

1. **La bóveda se abría sin Face ID.** Cuando el autenticador no soporta *PRF*, la clave AES se guardaba
   enmascarada con un XOR reversible usando `credId` y `salt`… en el **mismo registro** `boveda_meta`.
   Probado: leyendo solo IndexedDB se descifró un modelo de 63 MB y el SHA-256 coincidió con el original.
   El cifrado AES-256-GCM estaba bien; la llave viajaba al lado de la caja fuerte.
2. **La purga de arranque borraba datos del usuario** (grabación, `ent:*`, `vozSE`) sin avisar.
3. **La autocorrupción** destruía la voz ante cualquier fallo de descifrado o tres cancelaciones de
   Face ID; además no borraba nada de forma verificable y usaba claves de `localStorage` sin el prefijo
   `lectora:`, así que dejaba la app en un estado inconsistente.
4. **El entrenador quedaba expuesto en toda la red** (`0.0.0.0:8765`), con un código de 6 dígitos, sin
   límite de intentos: medido **636 intentos/segundo** desde una sola página web → búsqueda completa en
   ~26 minutos. Con CORS `*` y `Access-Control-Allow-Private-Network: true`, cualquier sitio que visites
   podía intentarlo.
5. **Pedía instalar una autoridad de certificados como raíz de confianza del teléfono** (todo el
   dispositivo) con `ca.key` en permisos `644`.
6. **Error de sintaxis** (`vozEntrenadaNA` declarada dos veces) que impedía cargar la app, y referencias a
   elementos del HTML que ya no existían (la app moría a mitad de carga).
7. **Nada verificaba las descargas** (checkpoint de 846 MB con `weights_only=False`, `curl | sh` para uv).

## 4. Qué falta para reactivarlo con seguridad

- [ ] **Llave que no viaje con el dato.** Exigir *PRF* y, si no está, **no cifrar y decirlo**; o derivar
      la clave de un secreto que no se guarde junto al cifrado.
- [ ] **Sin destrucción automática.** Un fallo de integridad se informa; borrar es solo voluntario y confirmado.
- [ ] **Sin purgas de arranque.** Cualquier borrado, explícito y con confirmación.
- [ ] **Entrenador:** escuchar solo en la interfaz local (nunca `0.0.0.0`), token largo y aleatorio
      (≥ 128 bits) con límite de intentos y espera progresiva, y CORS restringido (sin `*`, sin
      `Allow-Private-Network`).
- [ ] **Certificados:** certificado autofirmado por dispositivo/host, no una CA raíz instalada; y `600`
      para las claves privadas.
- [ ] **Verificar descargas** (hash fijado) y no usar `weights_only=False`.
- [ ] **Pruebas** que verifiquen lo anterior (incluido un intento de extracción que deba fallar).

## 5. Cómo se reactiva (solo después de lo anterior)

1. Corregir los puntos de §4.
2. En `app.js`: `const VOZ_SENSIBLE_ACTIVA = true;` — y volver a poner el panel de importación y la caja
   «Bóveda» en `index.html` si se quieren ver (se quitaron las afirmaciones que no eran ciertas).
3. En el entrenador: definir `LECTORLIBRE_ENTRENADOR_ACTIVO=1` y restaurar el modo de red **solo** con el
   diseño nuevo (token largo + límite de intentos).
4. Subir la versión de `sw.js` (`CACHE`) y la de `VERSION_APP` en `app.js` para que los teléfonos reciban
   el cambio.

> Mientras `VOZ_SENSIBLE_ACTIVA` esté en `false`, la app borra los datos de voz de esa función al
> arrancar y no vuelve a leerlos ni a mostrarlos.
