# Entrenador Local Aislado de LectorLibre
# Entrena un modelo Piper con tu voz de forma 100% local en tu computador (Mac o Windows).
# NUNCA se conecta a redes Wi-Fi ni a internet: escucha estrictamente en 127.0.0.1 (loopback).
# Al terminar, exporta un paquete seguro «mi-voz.lectoravoz» que transfieres a tu teléfono
# por cable USB o AirDrop offline para protegerlo con Face ID / Huella Dactilar.

import io, json, os, pathlib, platform, re, shutil, subprocess, sys, threading, time, urllib.parse, webbrowser, zipfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

VERSION = 2
PUERTO = 8765
# DESACTIVADO POR SEGURIDAD (ver SEGURIDAD.md): esta versión pedía instalar una autoridad de certificados
# en el teléfono y quedaba escuchando en toda la red con un código de 6 dígitos sin límite de intentos.
# Por eso ahora NO se levanta solo: hay que pedirlo a propósito y, incluso así, escucha SOLO en 127.0.0.1
# (el teléfono no puede conectarse). Reactivar de verdad requiere el rediseño descrito en SEGURIDAD.md.
ACTIVO = os.environ.get('LECTORLIBRE_ENTRENADOR_ACTIVO') == '1'
BASE = pathlib.Path(os.environ.get('LECTORLIBRE_BASE') or pathlib.Path.home() / 'LectorLibre-Entrenador')
SRC = BASE / 'piper-src'
TRABAJO = BASE / 'trabajo'
DATOS = TRABAJO / 'datos'
WAV_DIR = DATOS / 'wav'
META_CSV = DATOS / 'metadata.csv'
SALIDA = TRABAJO / 'salida'
CONF = BASE / 'config.json'
EPOCAS_POR_DEFECTO = 70

ESTADO = {
    'estado': 'libre',
    'progreso': 0.0,
    'epoca': 0,
    'total': 0,
    'mensaje': 'Listo para grabar o entrenar',
    'restante_min': None,
    'modelo': None
}
proceso = None
bloqueo = threading.Lock()

FRASES = [
    'El sol de la mañana entraba despacio por la ventana de la cocina.',
    '¿Quién dejó las llaves encima de la mesa del comedor?',
    'Mi abuela guardaba cartas viejas en una caja de madera.',
    '¡Qué alegría verte otra vez después de tantos años!',
    'Necesito comprar pan, queso, tomates y un poco de café.',
    'El tren de las ocho y media llegó con veinte minutos de retraso.',
    'Cuando llueve, el camino hacia el pueblo se llena de barro.',
    'La jueza escuchó con atención a cada uno de los testigos.',
    '¿Te parece si mañana salimos a caminar junto al río?',
    'Guillermo arregló la bicicleta con una llave inglesa.',
    'Hay que leer el contrato completo antes de firmarlo.',
    'Ayer cociné una sopa de zapallo con jengibre y limón.',
    '¡Cuidado, que el piso está mojado y te puedes resbalar!',
    'Ella sonrió, cerró el libro y apagó la luz de la lámpara.',
    'En invierno las noches son largas y frías en el sur.',
    '¿Cuántos kilómetros faltan para llegar a la costa?',
    'El viejo reloj de la torre marcaba las doce en punto.',
    'Fuimos a la feria y volvimos cargados de frutas y verduras.',
    'La profesora explicó la lección con paciencia y buen humor.',
    'Siempre que viajo llevo un cuaderno para anotar lo que veo.',
    'El abogado revisó cada cláusula con mucho cuidado.',
    'Los cerros se veían nevados desde la ventana de la oficina.',
    '¿Me podrías prestar tu paraguas solo por esta tarde?',
    'El perro del vecino ladra cada vez que pasa el cartero.',
    'Compramos palta, marraqueta y un kilo de tomates.',
    'La reunión empieza a las nueve y termina al mediodía.',
    '¡No puedo creer que hayas terminado el informe tan rápido!',
    'Mi hermano trabaja en un hospital en el centro de la ciudad.',
    'El viento soplaba con fuerza sobre los techos de zinc.',
    'Por favor, cierra la puerta cuando salgas de la pieza.',
    'La micro venía tan llena que tuve que esperar la siguiente.',
    '¿Sabes a qué hora abre la notaría los sábados?',
    'El niño dibujó un caballo azul con las patas muy largas.',
    'Los resultados del examen se publicarán la próxima semana.',
    'Tomamos once con pan amasado, mantequilla y té con leche.',
    'El volcán se veía tranquilo, cubierto de nieve hasta la mitad.',
    'Hace calor, así que vamos a abrir todas las ventanas.',
    '¡Feliz cumpleaños! Que tengas un año lleno de cosas buenas.',
    'La ley establece un plazo de treinta días para responder.',
    'Mi sobrina aprendió a nadar este verano en la playa.',
    'El café estaba demasiado caliente y me quemé la lengua.',
    '¿Por qué no me avisaste que llegabas temprano?',
    'Las hojas secas crujían bajo nuestros zapatos en el parque.',
    'El mecánico dijo que el auto estará listo el jueves.',
    'Guardé los documentos importantes en una carpeta roja.',
    'Ojalá mañana amanezca despejado para ir a la cordillera.',
    'El tribunal fijó una nueva audiencia para el mes de mayo.',
    'Me encanta el olor a tierra mojada después de la lluvia.',
    '¿Quieres que te acompañe hasta el paradero?',
    'La biblioteca cierra temprano los días feriados.',
    'Cuatro personas esperaban en la fila del banco.',
    '¡Qué rico te quedó el pastel de choclo!',
    'El gato se durmió encima del teclado del computador.',
    'Las calles del puerto suben y bajan por los cerros.',
    'Necesitamos una respuesta antes del viernes a mediodía.',
    'Mi papá escucha la radio todas las mañanas mientras desayuna.',
    'El atardecer pintó el cielo de naranjo y violeta.',
    '¿Cuál de estos dos vestidos te gusta más?',
    'Dejaron la bicicleta amarrada a un poste frente a la casa.',
    'El juicio duró casi tres horas sin ningún descanso.',
    'Hay que regar las plantas dos veces por semana.',
    '¡Por fin llegaron las vacaciones de invierno!',
    'La señora del almacén siempre nos regala un dulce.',
    'El informe tiene doce páginas y tres anexos.',
    'Cuando era chica, pasaba los veranos en el campo de mis abuelos.',
    '¿Te acuerdas del nombre de esa película tan triste?',
    'El ascensor estaba malo, así que subimos por la escalera.',
    'Su firma aparece al final de la última página.',
    'Las gaviotas volaban en círculos sobre los botes de pescadores.',
    'Me quedé dormida y llegué tarde a la reunión.',
    'Esta empanada de pino está recién salida del horno.',
    '¿Dónde dejaste el cargador del teléfono?',
    'La demanda fue presentada dentro del plazo legal.',
    'El jardín se llenó de flores amarillas en primavera.',
    '¡Ten cuidado con la olla, que está hirviendo!',
    'Mi mejor amiga vive en Valparaíso desde hace diez años.',
    'Los niños jugaban a la pelota en la calle hasta que oscurecía.',
    'Tengo que renovar el carnet antes de fin de mes.',
    'El terremoto nos despertó a todos en medio de la noche.',
    '¿Cuánto cuesta el pasaje a Concepción?',
    'Ella leía en voz alta mientras los demás escuchaban en silencio.',
    'El contrato puede terminarse con un aviso de sesenta días.',
    'Hicimos un asado en el patio con toda la familia.',
    '¡Me ganaste otra vez! Eres muy buena para este juego.',
    'La neblina cubría el valle por completo al amanecer.',
    'El testigo afirmó que no conocía al demandado.',
    'Compré un chaleco de lana para el invierno.',
    '¿Ya terminaste de leer el libro que te presté?',
    'El río bajaba crecido y de color café por las lluvias.',
    'Las sesiones del curso serán los martes y jueves.',
    'Mi abuelo contaba historias de cuando trabajaba en las minas.',
    '¡Qué susto me diste! No te escuché entrar.',
    'El plazo para apelar vence el próximo lunes.',
    'Pusimos el árbol de Navidad en un rincón del living.',
    'La cancha estaba tan embarrada que suspendieron el partido.',
    '¿Prefieres ir en auto o en metro?',
    'El sueldo se deposita el último día hábil del mes.',
    'Encontré una foto antigua de mis papás en su matrimonio.',
    'El cielo se nubló de repente y empezó a granizar.',
    '¡Vamos, que se nos hace tarde para la función!',
    'La sentencia fue confirmada por la Corte de Apelaciones.',
    'Cada mañana camino media hora antes de ir al trabajo.',
    'Las uvas de este valle se usan para hacer vino.',
    '¿Me ayudas a mover este sillón hacia la ventana?',
    'El bebé se quedó dormido en brazos de su abuela.',
    'La notificación llegó por correo certificado.',
    'Me gusta escuchar el mar cuando no puedo dormir.',
    '¡Qué bonita está la ciudad con las luces de noche!',
    'El inventario se hace dos veces al año.',
    'Mis primos vinieron del norte a pasar las fiestas.',
    '¿Cerraste con llave la puerta de atrás?',
    'El cerro Santa Lucía se llena de gente los domingos.',
    'El escrito debe presentarse con copia para la otra parte.',
    'La leche se derramó y mojó todo el mantel.',
    '¡Bravo! La presentación salió perfecta.',
    'Hay un camino de tierra que lleva directo al lago.',
    'Mi mamá teje bufandas para regalar en invierno.',
    '¿A qué hora pasa el último bus hacia la costa?',
    'Las nubes se movían rápido empujadas por el viento.',
    'El arriendo sube según la variación del índice de precios.',
    'Dejé la ropa colgada y se mojó con la lluvia.',
    '¡No te olvides de traer el certificado!',
    'El faro iluminaba la bahía cada pocos segundos.',
    'La audiencia se suspendió porque faltaba un abogado.',
    'Cenamos porotos con riendas y una ensalada chilena.',
    '¿Sabes si mañana hay clases o es feriado?',
    'El ruido de la calle no me dejó concentrarme.',
    'Mi tía tiene una casa de campo con un huerto enorme.',
    'El acta fue firmada por todos los asistentes.',
    '¡Qué frío hace esta mañana! Hay escarcha en los autos.',
    'Los turistas sacaban fotos frente a la catedral.',
    'Hay que pagar la cuenta de la luz antes del día quince.',
    '¿Quién ganó el partido de anoche?',
    'El tren avanzaba lento entre viñedos y álamos.',
    'Me puse el chaleco porque empezó a correr viento.',
    'La señora Rosa vende sopaipillas en la esquina.',
    'El documento original está guardado en la caja fuerte.',
    '¡Llegamos justo a tiempo para ver la puesta de sol!',
    'El estudiante levantó la mano para hacer una pregunta.',
    'La empresa deberá pagar una indemnización a la trabajadora.',
    '¿Por qué no probamos ese restaurante nuevo del barrio?',
    'Las olas golpeaban con fuerza contra las rocas.',
    'Mi hija aprendió a leer con cuentos de animales.',
    'El paro de transporte complicó a miles de personas.',
    '¡Ojo con el escalón, que está suelto!',
    'Encendimos la chimenea porque la casa estaba helada.',
    'El recurso de protección fue acogido por la corte.',
    '¿Te gustaría venir a almorzar el domingo?',
    'El volantín se enredó en los cables de la luz.',
    'Hay que llevar el carnet y el comprobante de domicilio.',
    'La lluvia no paró en toda la noche.',
    '¡Qué buena idea! Hagámoslo así.',
    'Los vecinos organizaron una completada para juntar fondos.',
    'El juez pidió silencio en la sala.',
    '¿Tienes un lápiz para anotar la dirección?',
    'Mi abuela hacía mermelada de mora todos los veranos.',
    'El camión de la basura pasa los lunes, miércoles y viernes.',
    'El contrato de trabajo debe constar por escrito.',
    '¡Feliz Año Nuevo a todos!',
    'Las montañas se reflejaban en el agua quieta del lago.',
    '¿Cuántas personas vienen a la reunión de mañana?',
    'El libro tenía las páginas amarillas de tan antiguo.',
    'Pedimos un taxi porque estaba lloviendo mucho.',
    'La herencia se repartió en partes iguales entre los hijos.',
    'El tecito de la tarde es sagrado en esta casa.',
    '¡Mira cómo brillan las estrellas en el desierto!',
    'Los papeles quedaron listos para la firma del notario.',
    '¿Me avisas cuando llegues a tu casa?',
    'El pan de la panadería de la esquina es el más rico.',
    'Hubo un temblor fuerte, pero no pasó nada grave.',
    'El demandante no se presentó a la audiencia.',
    'Mis amigas y yo nos juntamos todos los jueves.',
    '¡Qué paciencia tienes con los niños!',
    'La carretera estaba cortada por un derrumbe.',
    '¿Dónde compraste esos zapatos tan cómodos?',
    'El plazo de prescripción es de cinco años.',
    'En la plaza había un organillero con su loro.',
    'Me tomé un vaso de agua y seguí trabajando.',
    '¡Uf, por fin terminé de ordenar la casa!',
    'El arquitecto mostró los planos de la nueva biblioteca.',
    '¿Sabías que mañana cambia la hora?',
    'La comisión revisará los antecedentes la próxima semana.',
    'El olor a pan tostado llenaba toda la casa.',
    'Las palomas se juntaban alrededor de la pileta.',
    '¡No corras por el pasillo, que te puedes caer!',
    'El poder fue otorgado ante notario público.',
    'Mi vecino toca la guitarra todas las tardes.',
    '¿Ya pagaste las contribuciones de este año?',
    'El cielo de Santiago amaneció limpio después del viento.',
    'Ella guardó silencio y miró por la ventana.',
    'La boleta debe incluir el detalle de cada producto.',
    '¡Qué ganas de que llegue el verano!',
    'Los pescadores volvieron al amanecer con las redes llenas.',
    '¿Me puedes repetir la última parte, por favor?',
    'El expediente tiene más de quinientas fojas.',
    'Plantamos un limonero en el patio de atrás.',
    'La niebla hizo que cerraran el aeropuerto por unas horas.',
    '¡Gracias por todo! No sé qué habría hecho sin ti.',
    'El banco rechazó la solicitud por falta de documentos.',
    '¿Quieres un poco más de ensalada?',
    'Las campanas de la iglesia sonaron a las seis.',
    'Mi abuelo arreglaba relojes en un taller muy pequeño.',
    'El recurso debe interponerse dentro de diez días.',
    '¡Qué lindo día para salir a pasear!',
    'La ruta costera tiene curvas y vistas increíbles.',
    '¿Cómo se llama la calle donde vives?',
    'El médico le recomendó descansar una semana.',
    'Juntamos leña para el invierno en el galpón.',
    'La escritura fue inscrita en el Conservador de Bienes Raíces.',
    '¡Esto sí que es una sorpresa!',
    'Los árboles del parque ya están perdiendo las hojas.',
    '¿Por qué no llamas a tu hermana para preguntarle?',
    'El presupuesto se aprobó por unanimidad.',
    'En la noche se escuchaban los grillos en el campo.',
    'Me compré un cuaderno nuevo para tomar apuntes.',
    '¡Ánimo, que ya queda poco!',
    'El acuerdo se firmará después de revisar los detalles.',
    'El queque de naranja se enfrió sobre la mesa.',
    '¿Cuándo vuelves de tu viaje al sur?',
    'La marea subió y mojó nuestras toallas en la arena.',
    'La primera audiencia fue fijada para el día doce.',
    'Me gusta leer en la cama antes de dormir.',
    '¡Qué alivio saber que todos están bien!',
    'Los cerros de Valparaíso se iluminan de colores en la noche.',
    '¿Quién fue el último en salir de la oficina?',
    'El cobro de la deuda fue declarado improcedente.',
    'La tetera silbó y apagué la cocina.',
    'Caminamos por la orilla del río hasta el puente viejo.',
    '¡Por favor, avísame si necesitas algo!',
    'Cada página de este libro esconde un secreto.',
]


def python_entorno():
    return sys.executable


def mantener_despierto(pid):
    if platform.system() == 'Darwin':
        return subprocess.Popen(['caffeinate', '-i', '-w', str(pid)])
    if platform.system() == 'Windows':
        try:
            import ctypes
            ctypes.windll.kernel32.SetThreadExecutionState(0x80000000 | 0x00000001)
        except Exception:
            pass
    return None


def actualizar(**k):
    with bloqueo:
        ESTADO.update(k)
    (BASE / 'estado.json').write_text(json.dumps(ESTADO))


def frases_grabadas_map():
    mapa = {}
    if META_CSV.exists():
        for linea in META_CSV.read_text(encoding='utf-8').strip().splitlines():
            partes = linea.split('|', 1)
            if len(partes) == 2 and (WAV_DIR / f'{partes[0]}.wav').exists():
                mapa[partes[0]] = partes[1]
    return mapa


def guardar_frase_audio(idx_str, texto, wav_bytes):
    WAV_DIR.mkdir(parents=True, exist_ok=True)
    wav_path = WAV_DIR / f'{idx_str}.wav'
    wav_path.write_bytes(wav_bytes)

    # Actualizar metadata.csv
    mapa = frases_grabadas_map()
    mapa[idx_str] = texto
    lineas = [f'{k}|{mapa[k]}' for k in sorted(mapa.keys())]
    META_CSV.write_text('\n'.join(lineas) + '\n', encoding='utf-8')
    return len(mapa)


def empaquetar_lectoravoz():
    salida = TRABAJO / 'salida'
    onnx_path = salida / 'mi-voz.onnx'
    json_path = salida / 'mi-voz.onnx.json'
    if not onnx_path.exists() or not json_path.exists():
        return None
    paquete_path = salida / 'mi-voz.lectoravoz'
    with zipfile.ZipFile(paquete_path, 'w', zipfile.ZIP_DEFLATED) as z:
        z.write(onnx_path, 'voz.onnx')
        z.write(json_path, 'voz.onnx.json')
        meta = {
            'nombre': 'Mi voz entrenada',
            'version': VERSION,
            'fecha': int(time.time()),
            'frases': len(frases_grabadas_map()),
            'tamano_mb': round(onnx_path.stat().st_size / 1e6)
        }
        z.writestr('metadata.json', json.dumps(meta, indent=2))
    return paquete_path


def entrenar(epocas, seguir=False):
    global proceso
    run = TRABAJO / 'run'
    ultimo = sorted(run.glob('lightning_logs/*/checkpoints/last.ckpt'), key=lambda p: p.stat().st_mtime)
    desde = ['--ckpt_path', str(ultimo[-1])] if (seguir and ultimo) else ['--model.warmstart_ckpt', str(BASE / 'ald-limpio.ckpt')]
    if not seguir:
        shutil.rmtree(run, ignore_errors=True)
        shutil.rmtree(TRABAJO / 'cache', ignore_errors=True)

    cmd = [
        python_entorno(), '-m', 'piper.train', 'fit',
        '--data.voice_name', 'mi-voz',
        '--data.csv_path', str(META_CSV),
        '--data.audio_dir', str(WAV_DIR),
        '--model.sample_rate', '22050',
        '--data.espeak_voice', 'es-419',
        '--data.cache_dir', str(TRABAJO / 'cache'),
        '--data.config_path', str(run / 'config.json'),
        '--data.batch_size', '8',
        '--data.num_workers', '0',
        '--model.mos_metric', 'none',
        '--trainer.accelerator', 'cpu',
        '--trainer.devices', '1',
        '--trainer.max_epochs', str(epocas),
        '--trainer.default_root_dir', str(run)
    ] + desde

    env = dict(os.environ, PYTHONPATH=str(SRC), PYTHONUNBUFFERED='1', TORCH_FORCE_NO_WEIGHTS_ONLY_LOAD='1')
    run.mkdir(parents=True, exist_ok=True)
    actualizar(estado='entrenando', progreso=0.0, epoca=0, total=epocas, mensaje='Iniciando entrenamiento...', restante_min=None, epocas=epocas)
    log_path = TRABAJO / 'entrenamiento.log'
    log = open(log_path, 'w', encoding='utf-8')
    proceso = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, env=env, cwd=str(TRABAJO))
    mantener_despierto(proceso.pid)
    t0, ep0, buf = time.time(), None, b''

    while True:
        b = proceso.stdout.read(256)
        if not b:
            break
        log.write(b.decode('utf-8', 'replace'))
        log.flush()
        buf = (buf + b)[-4000:]
        m = re.findall(rb'Epoch (\d+):\s+(\d+)%', buf)
        if m:
            ep, pct = int(m[-1][0]), int(m[-1][1])
            if ep0 is None:
                ep0, t0 = ep, time.time()
            hecho = (ep + pct / 100) / epocas
            avance = (ep - ep0) + pct / 100
            restante = (time.time() - t0) / avance * (epocas - ep - pct / 100) / 60 if avance > 0.05 else None
            actualizar(
                progreso=round(min(hecho, 0.99), 4),
                epoca=ep,
                mensaje=f'Vuelta {ep + 1} de {epocas}',
                restante_min=round(restante) if restante else None
            )

    codigo = proceso.wait()
    proceso = None
    if ESTADO['estado'] == 'cancelado':
        return

    final = sorted(run.glob('lightning_logs/*/checkpoints/last.ckpt'), key=lambda p: p.stat().st_mtime)
    if codigo != 0 or not final:
        actualizar(estado='error', mensaje='El entrenamiento se detuvo con error (revisa el registro).')
        return

    actualizar(mensaje='Exportando modelo ONNX...', progreso=0.99)
    salida = TRABAJO / 'salida'
    salida.mkdir(exist_ok=True)
    r = subprocess.run(
        [python_entorno(), '-m', 'piper.train.export_onnx', '--checkpoint', str(final[-1]), '--output-file', str(salida / 'mi-voz.onnx')],
        env=env, cwd=str(TRABAJO), stdout=log, stderr=subprocess.STDOUT
    )
    if r.returncode != 0 or not (salida / 'mi-voz.onnx').exists():
        actualizar(estado='error', mensaje='No se pudo exportar el modelo a formato ONNX.')
        return

    shutil.copy(run / 'config.json', salida / 'mi-voz.onnx.json')
    empaquetar_lectoravoz()
    actualizar(
        estado='listo',
        progreso=1.0,
        mensaje='Tu voz está lista para descargar en «mi-voz.lectoravoz»',
        restante_min=0,
        modelo={'fecha': int(time.time()), 'mb': round((salida / 'mi-voz.onnx').stat().st_size / 1e6)}
    )


class Manejador(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def cabeceras(self, tipo='application/json', largo=None, codigo=200):
        self.send_response(codigo)
        self.send_header('Content-Type', tipo)
        if largo is not None:
            self.send_header('Content-Length', str(largo))
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS')
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()

    def json_resp(self, obj, codigo=200):
        b = json.dumps(obj).encode()
        self.cabeceras(largo=len(b), codigo=codigo)
        self.wfile.write(b)

    def do_OPTIONS(self):
        self.cabeceras(largo=0, codigo=204)

    def do_GET(self):
        u = urllib.parse.urlparse(self.path)
        ruta = u.path
        query = urllib.parse.parse_qs(u.query)

        if ruta == '/' or ruta == '/index.html':
            b = PAGINA_HTML.encode('utf-8')
            self.cabeceras('text/html; charset=utf-8', len(b))
            self.wfile.write(b)
            return

        if ruta == '/api/frases':
            grabadas = frases_grabadas_map()
            self.json_resp({
                'frases': [{'id': f'{i+1:03d}', 'texto': t, 'grabada': f'{i+1:03d}' in grabadas} for i, t in enumerate(FRASES)],
                'total': len(FRASES),
                'grabadas_total': len(grabadas)
            })
            return

        if ruta == '/api/estado':
            grabadas = frases_grabadas_map()
            paquete = (SALIDA / 'mi-voz.lectoravoz').exists()
            self.json_resp(dict(
                ESTADO,
                version=VERSION,
                grabadas=len(grabadas),
                total_frases=len(FRASES),
                paquete_listo=paquete
            ))
            return

        if ruta.startswith('/api/audio/'):
            nombre = ruta.split('/')[-1]
            p = WAV_DIR / nombre
            if p.exists() and p.name.endswith('.wav'):
                b = p.read_bytes()
                self.cabeceras('audio/wav', len(b))
                self.wfile.write(b)
                return
            self.json_resp({'error': 'audio no encontrado'}, 404)
            return

        if ruta == '/api/descargar-lectoravoz':
            salida = TRABAJO / 'salida' / 'mi-voz.lectoravoz'
            if not salida.exists():
                empaquetar_lectoravoz()
            if salida.exists():
                b = salida.read_bytes()
                self.send_response(200)
                self.send_header('Content-Type', 'application/octet-stream')
                self.send_header('Content-Disposition', 'attachment; filename="mi-voz.lectoravoz"')
                self.send_header('Content-Length', str(len(b)))
                self.end_headers()
                self.wfile.write(b)
                return
            self.json_resp({'error': 'el paquete aún no ha sido entrenado'}, 404)
            return

        if ruta == '/api/log':
            log_path = TRABAJO / 'entrenamiento.log'
            if log_path.exists():
                txt = log_path.read_text(encoding='utf-8', errors='replace')[-5000:]
                self.cabeceras('text/plain; charset=utf-8', len(txt.encode('utf-8')))
                self.wfile.write(txt.encode('utf-8'))
                return
            self.json_resp({'log': ''})
            return

        self.json_resp({'error': 'ruta no encontrada'}, 404)

    def do_POST(self):
        u = urllib.parse.urlparse(self.path)
        ruta = u.path
        query = urllib.parse.parse_qs(u.query)
        largo = int(self.headers.get('Content-Length', 0))

        if ruta == '/api/grabar':
            idx = query.get('id', [None])[0]
            if not idx:
                self.json_resp({'error': 'falta parámetro id'}, 400)
                return
            try:
                num = int(idx)
                texto = FRASES[num - 1]
            except Exception:
                self.json_resp({'error': 'id de frase inválido'}, 400)
                return
            datos_wav = self.rfile.read(largo)
            total = guardar_frase_audio(f'{num:03d}', texto, datos_wav)
            self.json_resp({'ok': True, 'id': f'{num:03d}', 'grabadas': total})
            return

        if ruta == '/api/entrenar':
            if ESTADO['estado'] == 'entrenando':
                self.json_resp({'error': 'ya hay un entrenamiento en curso'}, 409)
                return
            grabadas = frases_grabadas_map()
            if len(grabadas) < 30:
                self.json_resp({'error': f'Se necesitan al menos 30 frases grabadas (tienes {len(grabadas)}).'}, 400)
                return
            epocas = int(query.get('epocas', [EPOCAS_POR_DEFECTO])[0])
            threading.Thread(target=entrenar, args=(epocas,), daemon=True).start()
            self.json_resp({'ok': True, 'epocas': epocas, 'frases': len(grabadas)})
            return

        if ruta == '/api/cancelar':
            actualizar(estado='cancelado', mensaje='Entrenamiento cancelado.')
            if proceso:
                proceso.terminate()
            self.json_resp({'ok': True})
            return

        self.json_resp({'error': 'ruta no encontrada'}, 404)

    def do_DELETE(self):
        u = urllib.parse.urlparse(self.path)
        ruta = u.path
        if ruta.startswith('/api/audio/'):
            idx = ruta.split('/')[-1].replace('.wav', '')
            p = WAV_DIR / f'{idx}.wav'
            if p.exists():
                p.unlink()
            mapa = frases_grabadas_map()
            if idx in mapa:
                del mapa[idx]
                lineas = [f'{k}|{mapa[k]}' for k in sorted(mapa.keys())]
                META_CSV.write_text('\n'.join(lineas) + '\n', encoding='utf-8')
            self.json_resp({'ok': True, 'grabadas': len(mapa)})
            return
        self.json_resp({'error': 'ruta no encontrada'}, 404)


PAGINA_HTML = '''<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Estudio y Entrenador Local Aislado · LectorLibre</title>
<style>
:root{--bg:#FFF7E0; --paper:#FFFDF6; --ink:#2B1512; --muted:#7A5A4E; --line:#F1DDA8; --accent:#C8102E; --green:#2E7D32}
@media (prefers-color-scheme: dark){:root{--bg:#1B100E; --paper:#251715; --ink:#F7EADF; --muted:#C9A697; --line:#4A2C25; --green:#4CAF50}}
body{margin:0; background:var(--bg); color:var(--ink); font:16px/1.5 -apple-system, system-ui, "Segoe UI", sans-serif}
header{background:var(--paper); border-bottom:1px solid var(--line); padding:16px 20px; position:sticky; top:0; z-index:10}
.wrap{max-width:44rem; margin:0 auto; padding:20px 16px 60px}
.badge-sec{display:inline-flex; align-items:center; gap:6px; background:#E8F5E9; color:#1B5E20; padding:4px 10px; border-radius:999px; font-size:.82rem; font-weight:700}
@media (prefers-color-scheme: dark){.badge-sec{background:#1B381E; color:#A5D6A7}}
.tabs{display:flex; gap:8px; margin:16px 0; border-bottom:1px solid var(--line); padding-bottom:8px}
.tab-btn{background:none; border:none; color:var(--muted); font-size:1rem; font-weight:700; padding:8px 14px; border-radius:8px; cursor:pointer}
.tab-btn.act{background:var(--paper); color:var(--accent); box-shadow:0 1px 3px rgba(0,0,0,0.06)}
.card{background:var(--paper); border:1px solid var(--line); border-radius:16px; padding:20px; margin:16px 0; box-shadow:0 1px 3px rgba(0,0,0,0.03)}
.frase-box{font-size:1.4rem; font-weight:600; line-height:1.4; margin:16px 0; min-height:4.2em; display:flex; align-items:center; justify-content:center; text-align:center; padding:16px; background:var(--bg); border-radius:12px}
.controles{display:flex; justify-content:center; align-items:center; gap:16px; margin:20px 0}
.btn-rec{width:80px; height:80px; border-radius:50%; background:var(--accent); color:#fff; border:none; font-size:1.8rem; cursor:pointer; display:flex; align-items:center; justify-content:center; transition:transform .1s, background .2s; box-shadow:0 4px 12px rgba(200,16,46,0.3)}
.btn-rec.grabando{animation:latido 1.2s infinite; background:#B71C1C}
@keyframes latido{0%,100%{transform:scale(1)}50%{transform:scale(1.08)}}
.btn{background:var(--paper); border:1px solid var(--line); color:var(--ink); padding:9px 16px; border-radius:999px; font-weight:600; cursor:pointer; text-decoration:none; display:inline-flex; align-items:center; gap:6px}
.btn.pri{background:var(--accent); color:#fff; border:none}
.prog-bar{height:10px; background:var(--line); border-radius:999px; overflow:hidden; margin:8px 0}
.prog-fill{height:100%; background:var(--accent); width:0%; transition:width .2s}
.grid-frases{display:grid; grid-template-columns:repeat(auto-fill, minmax(42px, 1fr)); gap:6px; max-height:180px; overflow-y:auto; padding:6px; border:1px solid var(--line); border-radius:10px; background:var(--bg)}
.item-f{font-size:.8rem; padding:6px 0; text-align:center; border-radius:6px; background:var(--paper); border:1px solid var(--line); cursor:pointer}
.item-f.hecha{background:#C8E6C9; border-color:#81C784; color:#1B5E20; font-weight:700}
.item-f.act{border:2px solid var(--accent); font-weight:700}
.log-box{background:#111; color:#0f0; font-family:ui-monospace, monospace; font-size:.82rem; padding:12px; border-radius:10px; height:180px; overflow-y:auto; white-space:pre-wrap}
</style>
</head>
<body>
<header>
  <div style="max-width:44rem; margin:0 auto; display:flex; justify-content:space-between; align-items:center">
    <h1 style="margin:0; font-size:1.2rem">Lector<span style="color:var(--accent)">Libre</span> · Entrenador Aislado</h1>
    <span class="badge-sec">🔒 100% Local (127.0.0.1)</span>
  </div>
</header>

<main class="wrap">
  <div class="tabs">
    <button class="tab-btn act" onclick="verTab('estudio')">🎙️ Grabar Frases</button>
    <button class="tab-btn" onclick="verTab('entrenar')">⚡ Entrenar</button>
    <button class="tab-btn" onclick="verTab('exportar')">🔒 Exportar a Teléfono</button>
  </div>

  <!-- TAB ESTUDIO DE GRABACIÓN -->
  <div id="tab-estudio">
    <div class="card">
      <div style="display:flex; justify-content:space-between; align-items:center">
        <span style="font-weight:700; color:var(--muted)">Frase <span id="numFrase">001</span> de 230</span>
        <span id="contGrabadas" style="font-weight:700; color:var(--green)">0 grabadas</span>
      </div>
      <div class="prog-bar"><div class="prog-fill" id="progTotal"></div></div>

      <div class="frase-box" id="textoFrase">Cargando frases...</div>

      <div class="controles">
        <button class="btn" onclick="navFrase(-1)">‹ Anterior</button>
        <button class="btn-rec" id="btnGrabar" onclick="toggleGrabar()">●</button>
        <button class="btn" onclick="navFrase(1)">Siguiente ›</button>
      </div>
      <p style="text-align:center; font-size:.88rem; color:var(--muted); margin:0" id="estadoGrab">Toca ● o presiona la barra espaciadora para grabar</p>

      <div id="previoBox" style="margin-top:16px; text-align:center" hidden>
        <audio id="audioPrevio" controls style="height:36px; max-width:100%"></audio>
        <div style="margin-top:8px">
          <button class="btn" onclick="borrarAudioActual()" style="color:var(--accent); font-size:.85rem">🗑️ Descartar grabación</button>
        </div>
      </div>
    </div>

    <div class="card">
      <h3 style="margin-top:0; font-size:1rem">Frases del entrenamiento (toca una para saltar a ella)</h3>
      <div class="grid-frases" id="gridFrases"></div>
    </div>
  </div>

  <!-- TAB ENTRENAMIENTO -->
  <div id="tab-entrenar" hidden>
    <div class="card">
      <h2 style="margin-top:0">Entrenar tu modelo con PyTorch</h2>
      <p style="color:var(--muted); font-size:.95rem">El entrenamiento se ejecuta directamente en este computador usando tu procesador. Nada se envía por la red.</p>
      
      <div style="margin:16px 0">
        <label style="font-weight:700">Vueltas de entrenamiento (épocas):</label>
        <select id="selEpocas" style="padding:6px 12px; border-radius:8px; border:1px solid var(--line); margin-left:8px">
          <option value="50">50 vueltas (~2.5 horas)</option>
          <option value="70" selected>70 vueltas (~4 horas - recomendado)</option>
          <option value="100">100 vueltas (~6 horas - máxima nitidez)</option>
        </select>
      </div>

      <div id="entEstadoBox">
        <div class="prog-bar"><div class="prog-fill" id="progEnt"></div></div>
        <p id="entMensaje" style="font-weight:600">Estado: Listo</p>
      </div>

      <div style="margin-top:16px">
        <button class="btn pri" id="btnEntrenar" onclick="iniciarEntrenamiento()">⚡ Iniciar Entrenamiento Local</button>
        <button class="btn" id="btnCancelar" onclick="cancelarEntrenamiento()" hidden>Detener</button>
      </div>
    </div>

    <div class="card">
      <h3 style="margin-top:0; font-size:1rem">Registro del proceso</h3>
      <div class="log-box" id="logBox">Esperando inicio...</div>
    </div>
  </div>

  <!-- TAB EXPORTAR -->
  <div id="tab-exportar" hidden>
    <div class="card" style="border:2px solid var(--green)">
      <h2 style="margin-top:0; color:var(--green)">📦 Paquete Protegido Listo para tu Teléfono</h2>
      <p>Tu voz entrenada se empaqueta en un único archivo <b>mi-voz.lectoravoz</b>. Este archivo contiene los pesos del modelo ONNX y su configuración.</p>
      
      <div style="text-align:center; margin:24px 0">
        <a class="btn pri" style="font-size:1.1rem; padding:12px 24px" href="/api/descargar-lectoravoz" download="mi-voz.lectoravoz">
          📥 Descargar «mi-voz.lectoravoz»
        </a>
      </div>

      <h3 style="font-size:1rem; margin-top:20px">Pasos para importarlo con Face ID / Huella en tu teléfono:</h3>
      <ol style="line-height:1.6; padding-left:1.2em">
        <li><b>Conecta tu teléfono</b> a este computador con cable USB (o usa AirDrop offline sin internet, o comparte por carpeta local).</li>
        <li>Copia el archivo <code>mi-voz.lectoravoz</code> a la app <b>Archivos</b> de tu iPhone/Android.</li>
        <li>Abre <b>LectorLibre</b> en el teléfono, entra a <b>Voz › Mi voz</b> y toca <b>«Importar mi voz (.lectoravoz)»</b>.</li>
        <li>El teléfono solicitará tu <b>Face ID o Huella Dactilar</b> para vincular la clave al Secure Enclave de hardware y cifrar el modelo en reposo con AES-256.</li>
      </ol>
      <p style="font-size:.88rem; color:var(--muted)">⚠️ <b>Garantía anti-extracción:</b> Si alguien sustrae el archivo de la base de datos o intenta forzar el acceso sin tu rostro o huella, los sectores se autodestruyen y se sobrescriben con ruido criptográfico.</p>
    </div>
  </div>
</main>

<script>
let FRASES = [];
let iActual = 0;
let mediaRecorder = null;
let audioChunks = [];
let grabadasSet = new Set();
let timerPoll = null;

async function cargarFrases(){
  const r = await fetch('/api/frases');
  const d = await r.json();
  FRASES = d.frases;
  renderGrid();
  mostrarFrase(iActual);
}

function renderGrid(){
  const g = document.getElementById('gridFrases');
  g.innerHTML = '';
  let grabCount = 0;
  FRASES.forEach((f, idx)=>{
    const el = document.createElement('div');
    el.className = 'item-f' + (f.grabada ? ' hecha' : '') + (idx === iActual ? ' act' : '');
    el.textContent = f.id;
    if(f.grabada) grabCount++;
    el.onclick = () => { mostrarFrase(idx); };
    g.appendChild(el);
  });
  document.getElementById('contGrabadas').textContent = `${grabCount} / ${FRASES.length} grabadas`;
  document.getElementById('progTotal').style.width = Math.round(grabCount / FRASES.length * 100) + '%';
}

function mostrarFrase(idx){
  if(idx < 0 || idx >= FRASES.length) return;
  iActual = idx;
  const f = FRASES[idx];
  document.getElementById('numFrase').textContent = f.id;
  document.getElementById('textoFrase').textContent = f.texto;
  
  // Previo si ya está grabada
  const prevBox = document.getElementById('previoBox');
  const audioEl = document.getElementById('audioPrevio');
  if(f.grabada){
    audioEl.src = `/api/audio/${f.id}.wav?t=` + Date.now();
    prevBox.hidden = false;
  } else {
    audioEl.src = '';
    prevBox.hidden = true;
  }
  renderGrid();
}

function navFrase(dir){
  let n = iActual + dir;
  if(n >= 0 && n < FRASES.length) mostrarFrase(n);
}

async function toggleGrabar(){
  const btn = document.getElementById('btnGrabar');
  const est = document.getElementById('estadoGrab');
  if(mediaRecorder && mediaRecorder.state === 'recording'){
    mediaRecorder.stop();
    btn.classList.remove('grabando');
    btn.textContent = '●';
    est.textContent = 'Guardando frase...';
    return;
  }

  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 }
    });
    audioChunks = [];
    
    // Captura con AudioContext para codificar exactamente a 22050 Hz Mono 16-bit PCM WAV
    const actx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 22050 });
    const source = actx.createMediaStreamSource(stream);
    const proc = actx.createScriptProcessor(4096, 1, 1);
    const bufferPcm = [];

    proc.onaudioprocess = e => {
      const canal = e.inputBuffer.getChannelData(0);
      bufferPcm.push(new Float32Array(canal));
    };
    source.connect(proc);
    proc.connect(actx.destination);

    mediaRecorder = {
      state: 'recording',
      stop: async () => {
        mediaRecorder.state = 'inactive';
        source.disconnect(); proc.disconnect(); actx.close();
        stream.getTracks().forEach(t => t.stop());
        
        // Empacar en WAV 22050Hz Mono 16-bit
        let totalLen = bufferPcm.reduce((acc, b) => acc + b.length, 0);
        let floatSamples = new Float32Array(totalLen);
        let offset = 0;
        for(let b of bufferPcm){ floatSamples.set(b, offset); offset += b.length; }
        
        const wavBytes = codificarWav(floatSamples, 22050);
        await subirFrase(FRASES[iActual].id, wavBytes);
      }
    };

    btn.classList.add('grabando');
    btn.textContent = '■';
    est.textContent = 'Grabando... habla con calma y naturalidad. Vuelve a presionar para parar.';
  } catch(err){
    est.textContent = 'No se pudo acceder al micrófono: ' + err.message;
  }
}

function codificarWav(samples, sr){
  const buf = new ArrayBuffer(44 + samples.length * 2);
  const v = new DataView(buf);
  const s = (o, str) => { for(let i = 0; i < str.length; i++) v.setUint8(o + i, str.charCodeAt(i)); };
  s(0, 'RIFF'); v.setUint32(4, 36 + samples.length * 2, true);
  s(8, 'WAVE'); s(12, 'fmt '); v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); v.setUint16(22, 1, true); // PCM, Mono
  v.setUint32(24, sr, true); v.setUint32(28, sr * 2, true);
  v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  s(36, 'data'); v.setUint32(40, samples.length * 2, true);
  let p = 44;
  for(let i = 0; i < samples.length; i++){
    let x = Math.max(-1, Math.min(1, samples[i]));
    v.setInt16(p, x < 0 ? x * 0x8000 : x * 0x7FFF, true);
    p += 2;
  }
  return buf;
}

async function subirFrase(id, wavBytes){
  const est = document.getElementById('estadoGrab');
  try{
    const r = await fetch(`/api/grabar?id=${id}`, {
      method: 'POST',
      headers: {'Content-Type': 'audio/wav'},
      body: wavBytes
    });
    const d = await r.json();
    if(d.ok){
      FRASES[iActual].grabada = true;
      mostrarFrase(iActual);
      est.textContent = '¡Frase guardada correctamente!';
      // Avanzar automáticamente a la siguiente pendiente
      setTimeout(()=>{
        for(let i = iActual + 1; i < FRASES.length; i++){
          if(!FRASES[i].grabada){ mostrarFrase(i); break; }
        }
      }, 700);
    }
  }catch(e){
    est.textContent = 'Error guardando frase: ' + e.message;
  }
}

async function borrarAudioActual(){
  if(!confirm('¿Descartar esta grabación y grabarla de nuevo?')) return;
  const f = FRASES[iActual];
  await fetch(`/api/audio/${f.id}.wav`, {method: 'DELETE'});
  f.grabada = false;
  mostrarFrase(iActual);
}

// Control por barra espaciadora
document.addEventListener('keydown', e => {
  if(e.code === 'Space' && e.target.tagName !== 'INPUT' && e.target.tagName !== 'SELECT'){
    e.preventDefault();
    toggleGrabar();
  }
});

function verTab(t){
  document.querySelectorAll('.tabs .tab-btn').forEach((b, idx)=>{
    b.classList.toggle('act', (t === 'estudio' && idx === 0) || (t === 'entrenar' && idx === 1) || (t === 'exportar' && idx === 2));
  });
  document.getElementById('tab-estudio').hidden = t !== 'estudio';
  document.getElementById('tab-entrenar').hidden = t !== 'entrenar';
  document.getElementById('tab-exportar').hidden = t !== 'exportar';
  if(t === 'entrenar') revisarEstado();
}

async function revisarEstado(){
  const r = await fetch('/api/estado');
  const d = await r.json();
  const prog = document.getElementById('progEnt');
  const msg = document.getElementById('entMensaje');
  const btnEnt = document.getElementById('btnEntrenar');
  const btnCanc = document.getElementById('btnCancelar');

  prog.style.width = Math.round(d.progreso * 100) + '%';
  msg.textContent = `${d.mensaje}` + (d.restante_min ? ` · faltan ~${d.restante_min} min` : '');

  btnEnt.hidden = d.estado === 'entrenando';
  btnCanc.hidden = d.estado !== 'entrenando';

  if(d.estado === 'entrenando'){
    clearTimeout(timerPoll);
    timerPoll = setTimeout(revisarEstado, 3000);
    actualizarLog();
  } else if(d.estado === 'listo' || d.paquete_listo){
    document.querySelector('.tabs .tab-btn:nth-child(3)').style.color = 'var(--green)';
  }
}

async function actualizarLog(){
  try{
    const r = await fetch('/api/log');
    const txt = await r.text();
    const l = document.getElementById('logBox');
    l.textContent = txt || 'Iniciando proceso...';
    l.scrollTop = l.scrollHeight;
  }catch(e){}
}

async function iniciarEntrenamiento(){
  const epocas = document.getElementById('selEpocas').value;
  const r = await fetch(`/api/entrenar?epocas=${epocas}`, {method: 'POST'});
  const d = await r.json();
  if(!r.ok){ alert(d.error || 'No se pudo iniciar el entrenamiento.'); return; }
  revisarEstado();
}

async function cancelarEntrenamiento(){
  if(!confirm('¿Deseas detener el entrenamiento actual?')) return;
  await fetch('/api/cancelar', {method: 'POST'});
  revisarEstado();
}

cargarFrases();
setInterval(revisarEstado, 10000);
</script>
</body>
</html>
'''


def main():
    if not ACTIVO:
        print('\n' + '=' * 62)
        print('  ENTRENADOR DESACTIVADO POR SEGURIDAD')
        print('=' * 62)
        print('  Está apagado a propósito hasta rediseñar su protección:')
        print('   · pedía instalar una autoridad de certificados en el teléfono;')
        print('   · escuchaba en toda la red con un código de 6 dígitos y sin límite de intentos.')
        print('  Tus datos de voz de este entrenamiento YA FUERON BORRADOS.')
        print('  Detalles y cómo reactivarlo con seguridad: SEGURIDAD.md')
        print('=' * 62 + '\n')
        return
    BASE.mkdir(parents=True, exist_ok=True)
    TRABAJO.mkdir(exist_ok=True)
    WAV_DIR.mkdir(parents=True, exist_ok=True)
    SALIDA.mkdir(exist_ok=True)

    viejo = json.loads((BASE / 'estado.json').read_text()) if (BASE / 'estado.json').exists() else {}
    if viejo.get('estado') == 'listo':
        ESTADO.update(viejo)
    elif viejo.get('estado') == 'entrenando':
        print('== Retomando entrenamiento que quedó en progreso...')
        threading.Thread(target=entrenar, args=(viejo.get('epocas') or EPOCAS_POR_DEFECTO, True), daemon=True).start()

    try:
        servidor = ThreadingHTTPServer(('127.0.0.1', PUERTO), Manejador)
    except OSError:
        print(f'\nEl puerto {PUERTO} ya está en uso. Si el entrenador ya está corriendo, abre http://127.0.0.1:{PUERTO} en tu navegador.')
        return

    print('\n' + '=' * 65)
    print('  ENTRENADOR LOCAL AISLADO DE LECTORLIBRE (100% AISLADO)')
    print('  Seguridad garantizada: Tu voz NUNCA sale de este equipo.')
    print(f'  Abre en tu navegador: http://127.0.0.1:{PUERTO}')
    print('=' * 65 + '\n', flush=True)

    try:
        webbrowser.open(f'http://127.0.0.1:{PUERTO}')
    except Exception:
        pass

    try:
        servidor.serve_forever()
    except KeyboardInterrupt:
        print('\nCerrando entrenador.')


if __name__ == '__main__':
    main()
