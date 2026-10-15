# Entrenador de LectorLibre: recibe tus grabaciones desde el teléfono por el Wi-Fi de tu casa, entrena tu voz en
# este computador (Mac o Windows) y le entrega el modelo al teléfono cuando está listo. Nada pasa por internet.
#
# La app del teléfono se abre desde https://…github.io, así que solo puede hablar con este computador por https:
# por eso este programa crea su propio certificado (una «autoridad» que el teléfono debe aceptar una vez) y lo
# ofrece en http://<este computador>:8766 junto con las instrucciones. Para que nadie más lo use, pide un código.
import datetime, ipaddress, json, os, pathlib, platform, re, secrets, shutil, socket, ssl, subprocess, sys, threading, time, zipfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

VERSION = 1
BASE = pathlib.Path(os.environ.get('LECTORLIBRE_BASE') or pathlib.Path.home() / 'LectorLibre-Entrenador')
SRC, TRABAJO = BASE / 'piper-src', BASE / 'trabajo'
PUERTO, PUERTO_HTTP = 8765, 8766
EPOCAS_POR_DEFECTO = 70
CONF = BASE / 'config.json'
ESTADO = {'estado': 'libre', 'progreso': 0.0, 'epoca': 0, 'total': 0, 'mensaje': '', 'restante_min': None, 'modelo': None}
proceso = None
bloqueo = threading.Lock()


def config():
    c = json.loads(CONF.read_text()) if CONF.exists() else {}
    if 'codigo' not in c: c['codigo'] = f'{secrets.randbelow(10**6):06d}'
    CONF.write_text(json.dumps(c))
    return c


def ips_locales():
    ips = set()
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM); s.connect(('192.168.0.1', 9)); ips.add(s.getsockname()[0]); s.close()
    except OSError: pass
    try:
        for i in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET): ips.add(i[4][0])
    except OSError: pass
    return sorted(i for i in ips if not i.startswith('127.'))


# ---------- certificados: una autoridad propia (se acepta una vez en el teléfono) y el del servidor ----------
def certificados(ips):
    from cryptography import x509
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import ec
    from cryptography.x509.oid import NameOID, ExtendedKeyUsageOID
    ahora = datetime.datetime.now(datetime.timezone.utc)
    ca_key_p, ca_p = BASE / 'ca.key', BASE / 'ca.crt'
    if not ca_p.exists():
        k = ec.generate_private_key(ec.SECP256R1())
        nombre = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, f'LectorLibre Entrenador ({socket.gethostname()})')])
        c = (x509.CertificateBuilder().subject_name(nombre).issuer_name(nombre).public_key(k.public_key())
             .serial_number(x509.random_serial_number()).not_valid_before(ahora - datetime.timedelta(days=1))
             .not_valid_after(ahora + datetime.timedelta(days=3650))
             .add_extension(x509.BasicConstraints(ca=True, path_length=0), critical=True)
             .add_extension(x509.KeyUsage(digital_signature=True, key_cert_sign=True, crl_sign=True, content_commitment=False,
                                          key_encipherment=False, data_encipherment=False, key_agreement=False, encipher_only=False, decipher_only=False), critical=True)
             .sign(k, hashes.SHA256()))
        ca_key_p.write_bytes(k.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()))
        ca_p.write_bytes(c.public_bytes(serialization.Encoding.PEM))
    ca_key = serialization.load_pem_private_key(ca_key_p.read_bytes(), None)
    ca = x509.load_pem_x509_certificate(ca_p.read_bytes())
    # el del servidor se hace de nuevo en cada arranque (la dirección del computador puede cambiar)
    k = ec.generate_private_key(ec.SECP256R1())
    host = socket.gethostname().split('.')[0]
    alt = [x509.DNSName(host), x509.DNSName(host + '.local'), x509.DNSName('localhost')] + [x509.IPAddress(ipaddress.ip_address(i)) for i in ips + ['127.0.0.1']]
    c = (x509.CertificateBuilder().subject_name(x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, host)])).issuer_name(ca.subject)
         .public_key(k.public_key()).serial_number(x509.random_serial_number())
         .not_valid_before(ahora - datetime.timedelta(days=1)).not_valid_after(ahora + datetime.timedelta(days=390))   # iPhone: ≤ 398 días
         .add_extension(x509.SubjectAlternativeName(alt), critical=False)
         .add_extension(x509.ExtendedKeyUsage([ExtendedKeyUsageOID.SERVER_AUTH]), critical=False)
         .add_extension(x509.BasicConstraints(ca=False, path_length=None), critical=True)
         .sign(ca_key, hashes.SHA256()))
    (BASE / 'servidor.key').write_bytes(k.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()))
    (BASE / 'servidor.crt').write_bytes(c.public_bytes(serialization.Encoding.PEM) + ca_p.read_bytes())
    return ca


def perfil_ios(ca_der):
    # perfil de configuración para iPhone/iPad: instala la autoridad (después hay que activarla en Ajustes)
    import base64, uuid
    u1, u2 = str(uuid.uuid4()).upper(), str(uuid.uuid4()).upper()
    return f'''<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>PayloadContent</key><array><dict>
<key>PayloadCertificateFileName</key><string>lectorlibre-entrenador.cer</string>
<key>PayloadContent</key><data>{base64.b64encode(ca_der).decode()}</data>
<key>PayloadDisplayName</key><string>LectorLibre Entrenador</string>
<key>PayloadIdentifier</key><string>cl.lectorlibre.entrenador.ca.{u1}</string>
<key>PayloadType</key><string>com.apple.security.root</string>
<key>PayloadUUID</key><string>{u1}</string><key>PayloadVersion</key><integer>1</integer>
</dict></array>
<key>PayloadDisplayName</key><string>LectorLibre: confiar en mi computador</string>
<key>PayloadIdentifier</key><string>cl.lectorlibre.entrenador.{u2}</string>
<key>PayloadType</key><string>Configuration</string><key>PayloadUUID</key><string>{u2}</string><key>PayloadVersion</key><integer>1</integer>
</dict></plist>'''.encode()


# ---------- entrenamiento ----------
def python_entorno():
    return sys.executable


def mantener_despierto(pid):
    # el computador no se duerme mientras entrena
    if platform.system() == 'Darwin':
        return subprocess.Popen(['caffeinate', '-i', '-w', str(pid)])
    if platform.system() == 'Windows':
        import ctypes
        ctypes.windll.kernel32.SetThreadExecutionState(0x80000000 | 0x00000001)   # ES_CONTINUOUS | ES_SYSTEM_REQUIRED
    return None


def actualizar(**k):
    with bloqueo: ESTADO.update(k)
    (BASE / 'estado.json').write_text(json.dumps(ESTADO))


def entrenar(epocas, seguir=False):
    global proceso
    run = TRABAJO / 'run'
    ultimo = sorted(run.glob('lightning_logs/*/checkpoints/last.ckpt'), key=lambda p: p.stat().st_mtime)
    desde = ['--ckpt_path', str(ultimo[-1])] if (seguir and ultimo) else ['--model.warmstart_ckpt', str(BASE / 'ald-limpio.ckpt')]
    if not seguir: shutil.rmtree(run, ignore_errors=True); shutil.rmtree(TRABAJO / 'cache', ignore_errors=True)
    cmd = [python_entorno(), '-m', 'piper.train', 'fit',
           '--data.voice_name', 'mi-voz', '--data.csv_path', str(TRABAJO / 'datos' / 'metadata.csv'), '--data.audio_dir', str(TRABAJO / 'datos' / 'wav'),
           '--model.sample_rate', '22050', '--data.espeak_voice', 'es-419', '--data.cache_dir', str(TRABAJO / 'cache'),
           '--data.config_path', str(run / 'config.json'), '--data.batch_size', '8', '--data.num_workers', '0',
           '--model.mos_metric', 'none', '--trainer.accelerator', 'cpu', '--trainer.devices', '1',
           '--trainer.max_epochs', str(epocas), '--trainer.default_root_dir', str(run)] + desde
    env = dict(os.environ, PYTHONPATH=str(SRC), PYTHONUNBUFFERED='1', TORCH_FORCE_NO_WEIGHTS_ONLY_LOAD='1')
    run.mkdir(parents=True, exist_ok=True)
    actualizar(estado='entrenando', progreso=0.0, epoca=0, total=epocas, mensaje='Empezando…', restante_min=None, epocas=epocas)
    log = open(TRABAJO / 'entrenamiento.log', 'w', encoding='utf-8')
    proceso = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, env=env, cwd=str(TRABAJO))
    mantener_despierto(proceso.pid)
    t0, ep0, buf = time.time(), None, b''
    while True:
        b = proceso.stdout.read(256)
        if not b: break
        log.write(b.decode('utf-8', 'replace')); log.flush()
        buf = (buf + b)[-4000:]
        m = re.findall(rb'Epoch (\d+):\s+(\d+)%', buf)
        if m:
            ep, pct = int(m[-1][0]), int(m[-1][1])
            if ep0 is None: ep0, t0 = ep, time.time()
            hecho = (ep + pct / 100) / epocas
            avance = (ep - ep0) + pct / 100
            restante = (time.time() - t0) / avance * (epocas - ep - pct / 100) / 60 if avance > 0.05 else None
            actualizar(progreso=round(min(hecho, 0.99), 4), epoca=ep, mensaje=f'Vuelta {ep + 1} de {epocas}',
                       restante_min=round(restante) if restante else None)
    codigo = proceso.wait(); proceso = None
    if ESTADO['estado'] == 'cancelado': return
    final = sorted(run.glob('lightning_logs/*/checkpoints/last.ckpt'), key=lambda p: p.stat().st_mtime)
    if codigo != 0 or not final:
        actualizar(estado='error', mensaje='El entrenamiento se detuvo (revisa trabajo/entrenamiento.log).'); return
    actualizar(mensaje='Exportando tu voz…', progreso=0.99)
    salida = TRABAJO / 'salida'; salida.mkdir(exist_ok=True)
    r = subprocess.run([python_entorno(), '-m', 'piper.train.export_onnx', '--checkpoint', str(final[-1]), '--output-file', str(salida / 'mi-voz.onnx')],
                       env=env, cwd=str(TRABAJO), stdout=log, stderr=subprocess.STDOUT)
    if r.returncode != 0 or not (salida / 'mi-voz.onnx').exists():
        actualizar(estado='error', mensaje='No se pudo exportar la voz (revisa trabajo/entrenamiento.log).'); return
    shutil.copy(run / 'config.json', salida / 'mi-voz.onnx.json')
    actualizar(estado='listo', progreso=1.0, mensaje='Tu voz está lista.', restante_min=0,
               modelo={'fecha': int(time.time()), 'mb': round((salida / 'mi-voz.onnx').stat().st_size / 1e6)})


def recibir_zip(datos, epocas):
    datos_dir = TRABAJO / 'datos'
    shutil.rmtree(datos_dir, ignore_errors=True); datos_dir.mkdir(parents=True)
    z = zipfile.ZipFile(__import__('io').BytesIO(datos))
    for n in z.namelist():
        if n.endswith('/') or '..' in n: continue
        if n == 'metadata.csv' or (n.startswith('wav/') and n.endswith('.wav')):
            d = datos_dir / n; d.parent.mkdir(parents=True, exist_ok=True); d.write_bytes(z.read(n))
    frases = len((datos_dir / 'metadata.csv').read_text(encoding='utf-8').strip().splitlines())
    threading.Thread(target=entrenar, args=(epocas,), daemon=True).start()
    return frases


# ---------- servidor ----------
CODIGO = None


class Manejador(BaseHTTPRequestHandler):
    def log_message(self, *a): pass

    def cabeceras(self, tipo='application/json', largo=None, codigo=200):
        self.send_response(codigo)
        self.send_header('Content-Type', tipo)
        if largo is not None: self.send_header('Content-Length', str(largo))
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Headers', 'X-Clave, Content-Type')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Private-Network', 'true')   # Chrome: de una página pública a la red de la casa
        self.send_header('Cross-Origin-Resource-Policy', 'cross-origin')
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()

    def json(self, obj, codigo=200):
        b = json.dumps(obj).encode(); self.cabeceras(largo=len(b), codigo=codigo); self.wfile.write(b)

    def do_OPTIONS(self):
        self.cabeceras(largo=0, codigo=204)

    def autorizado(self):
        if self.headers.get('X-Clave') == CODIGO: return True
        self.json({'error': 'código incorrecto'}, 403); return False

    def do_GET(self):
        if self.server.server_port == PUERTO_HTTP: return self.pagina_http()
        if self.path.startswith('/hola'): return self.json({'lectorlibre': True, 'version': VERSION})
        if not self.autorizado(): return
        if self.path.startswith('/estado'): return self.json(dict(ESTADO, version=VERSION))
        if self.path.startswith('/modelo.onnx'):
            f = TRABAJO / 'salida' / ('mi-voz.onnx.json' if self.path.startswith('/modelo.onnx.json') else 'mi-voz.onnx')
            if ESTADO['estado'] != 'listo' or not f.exists(): return self.json({'error': 'todavía no está'}, 404)
            self.cabeceras('application/octet-stream', f.stat().st_size)
            with open(f, 'rb') as a: shutil.copyfileobj(a, self.wfile)
            return
        self.json({'error': 'no existe'}, 404)

    def do_POST(self):
        if self.server.server_port == PUERTO_HTTP or not self.autorizado(): return
        if self.path.startswith('/entrenar'):
            if ESTADO['estado'] == 'entrenando': return self.json({'error': 'ya está entrenando'}, 409)
            m = re.search(r'epocas=(\d+)', self.path)
            datos = self.rfile.read(int(self.headers.get('Content-Length', 0)))
            try: frases = recibir_zip(datos, int(m.group(1)) if m else EPOCAS_POR_DEFECTO)
            except Exception as e: return self.json({'error': f'no pude leer las grabaciones: {e}'}, 400)
            print(f'\n== Recibí {frases} frases. Entrenando… (puedes seguir usando el teléfono)', flush=True)
            return self.json({'ok': True, 'frases': frases})
        if self.path.startswith('/cancelar'):
            actualizar(estado='cancelado', mensaje='Cancelado.')
            if proceso: proceso.terminate()
            return self.json({'ok': True})
        self.json({'error': 'no existe'}, 404)

    def pagina_http(self):
        ca = (BASE / 'ca.crt').read_bytes()
        from cryptography import x509
        from cryptography.hazmat.primitives import serialization
        der = x509.load_pem_x509_certificate(ca).public_bytes(serialization.Encoding.DER)
        if self.path.startswith('/lectorlibre.mobileconfig'):
            b = perfil_ios(der); self.cabeceras('application/x-apple-aspen-config', len(b)); self.wfile.write(b); return
        if self.path.startswith('/lectorlibre-entrenador.crt'):
            self.cabeceras('application/x-x509-ca-cert', len(der)); self.wfile.write(der); return
        b = PAGINA.format(ips=' o '.join(ips_locales()), codigo=CODIGO).encode()
        self.cabeceras('text/html; charset=utf-8', len(b)); self.wfile.write(b)


PAGINA = '''<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Confiar en mi computador</title>
<style>body{{font-family:-apple-system,system-ui,sans-serif;max-width:34rem;margin:0 auto;padding:16px;line-height:1.5;color:#2B1512;background:#FFFDF6}}
a.b{{display:block;text-align:center;background:#C8102E;color:#fff;padding:12px;border-radius:999px;text-decoration:none;font-weight:700;margin:10px 0}}
h1{{font-size:1.3rem}} li{{margin:6px 0}} code{{background:#FFF7E0;padding:2px 6px;border-radius:6px}}</style>
<h1>LectorLibre: confiar en este computador</h1>
<p>Esto se hace <b>una sola vez</b>, desde el teléfono. Después, en LectorLibre escribe la dirección <code>{ips}</code> y el código <code>{codigo}</code>.</p>
<h2>iPhone</h2>
<a class="b" href="/lectorlibre.mobileconfig">1. Bajar el permiso</a>
<ol start="2"><li>Abre <b>Ajustes</b>: arriba aparece «Perfil descargado» → <b>Instalar</b>.</li>
<li>Ajustes › General › Información › <b>Ajustes de confianza de certificados</b> → activa «LectorLibre Entrenador».</li></ol>
<h2>Android</h2>
<a class="b" href="/lectorlibre-entrenador.crt">1. Bajar el permiso</a>
<ol start="2"><li>Ajustes › Seguridad (o Seguridad y privacidad) › Más ajustes › Cifrado y credenciales › <b>Instalar un certificado</b> › <b>Certificado de CA</b>.</li>
<li>Elige el archivo «lectorlibre-entrenador.crt» de Descargas.</li></ol>
<p>Este permiso solo sirve para que el teléfono hable con <b>este</b> computador dentro de tu casa.</p>'''


def main():
    global CODIGO
    BASE.mkdir(parents=True, exist_ok=True); TRABAJO.mkdir(exist_ok=True)
    CODIGO = config()['codigo']
    ips = ips_locales()
    certificados(ips)
    viejo = json.loads((BASE / 'estado.json').read_text()) if (BASE / 'estado.json').exists() else {}
    if viejo.get('estado') == 'listo': ESTADO.update(viejo)
    elif viejo.get('estado') == 'entrenando':   # se apagó el computador a mitad: se sigue donde quedó
        print('== Retomo el entrenamiento que quedó a medias.')
        threading.Thread(target=entrenar, args=(viejo.get('epocas') or viejo.get('total') or EPOCAS_POR_DEFECTO, True), daemon=True).start()
    seguro = ThreadingHTTPServer(('0.0.0.0', PUERTO), Manejador)
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER); ctx.load_cert_chain(BASE / 'servidor.crt', BASE / 'servidor.key')
    seguro.socket = ctx.wrap_socket(seguro.socket, server_side=True)
    simple = ThreadingHTTPServer(('0.0.0.0', PUERTO_HTTP), Manejador)
    threading.Thread(target=simple.serve_forever, daemon=True).start()
    print('\n' + '=' * 60)
    print('  ENTRENADOR DE LECTORLIBRE — deja esta ventana abierta')
    print(f'  En la app (Voz › Mi voz › Entrenar en mi computador) escribe:')
    print(f'     Dirección: {" o ".join(ips) or "(sin red)"}')
    print(f'     Código:    {CODIGO}')
    print(f'  Primera vez: en el teléfono abre  http://{ips[0] if ips else "?"}:{PUERTO_HTTP}  para confiar en este computador.')
    print('=' * 60 + '\n', flush=True)
    seguro.serve_forever()


if __name__ == '__main__':
    main()
