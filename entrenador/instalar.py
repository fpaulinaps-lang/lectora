# Instala lo necesario para entrenar tu voz en este computador (Mac o Windows). Se ejecuta solo la primera vez
# (y si falta algo). No pide cuentas: baja el código de Piper (GitHub), la pieza de pronunciación (PyPI) y el
# punto de partida, la voz Ald (Hugging Face, dominio público).
import io, json, os, pathlib, platform, sys, urllib.request, zipfile

BASE = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else pathlib.Path.home() / 'LectorLibre-Entrenador')
PIPER_COMMIT = '40ecf92760e0e13a3f9916497d0a1ad5b8075eee'      # la versión de piper1-gpl con la que se probó
CKPT_URL = 'https://huggingface.co/datasets/rhasspy/piper-checkpoints/resolve/main/es/es_MX/ald/medium/epoch%3D9999-step%3D1753600.ckpt'
SRC = BASE / 'piper-src'
PKG = SRC / 'piper'


def bajar(url, destino=None, nombre=''):
    print(f'   bajando {nombre or url} …', flush=True)
    with urllib.request.urlopen(url) as r:
        total = int(r.headers.get('Content-Length') or 0)
        datos = io.BytesIO() if destino is None else open(destino, 'wb')
        n = 0
        while True:
            b = r.read(1 << 20)
            if not b: break
            datos.write(b); n += len(b)
            if total: print(f'\r   {n * 100 // total}% de {total // 1_000_000} MB', end='', flush=True)
        print()
        if destino is None: return datos.getvalue()
        datos.close()


def codigo_piper():
    if (PKG / 'train' / '__main__.py').exists(): return
    print('== Código de entrenamiento de Piper (piper1-gpl, GPL-3.0)')
    z = zipfile.ZipFile(io.BytesIO(bajar(f'https://github.com/OHF-Voice/piper1-gpl/archive/{PIPER_COMMIT}.zip', nombre='piper1-gpl')))
    raiz = f'piper1-gpl-{PIPER_COMMIT}/src/piper/'
    for n in z.namelist():
        if n.startswith(raiz) and not n.endswith('/'):
            d = PKG / n[len(raiz):]
            d.parent.mkdir(parents=True, exist_ok=True)
            d.write_bytes(z.read(n))


def pronunciacion():
    if any(PKG.glob('espeakbridge.*')) and (PKG / 'espeak-ng-data').exists(): return
    print('== Pronunciación (espeak-ng, ya compilada en la rueda oficial de piper-tts)')
    info = json.load(urllib.request.urlopen('https://pypi.org/pypi/piper-tts/1.8.0/json'))
    so, maq = platform.system(), platform.machine().lower()
    clave = {'Windows': 'win_amd64', 'Linux': 'manylinux_2_17_x86_64' if maq in ('x86_64', 'amd64') else 'manylinux_2_17_aarch64'}.get(so)
    if so == 'Darwin': clave = 'macosx_11_0_arm64' if maq == 'arm64' else 'macosx_10_9_x86_64'
    url = next(u['url'] for u in info['urls'] if clave in u['filename'])
    z = zipfile.ZipFile(io.BytesIO(bajar(url, nombre='piper-tts')))
    for n in z.namelist():
        if n.startswith('piper/espeakbridge') or n.startswith('piper/espeak-ng-data/'):
            if n.endswith('/'): continue
            d = PKG / n[len('piper/'):]
            d.parent.mkdir(parents=True, exist_ok=True)
            d.write_bytes(z.read(n))


def parchar(ruta, viejo, nuevo, marca):
    p = PKG / ruta
    s = p.read_text(encoding='utf-8')
    if marca in s: return
    assert viejo in s, f'No encontré lo que había que cambiar en {ruta}'
    p.write_text(s.replace(viejo, nuevo, 1), encoding='utf-8')


def parches():
    print('== Ajustes de compatibilidad')
    # 1) La alineación en C (Cython) necesita compilador: si no está, la misma lógica con numba (sin compilar).
    parchar('train/vits/monotonic_align/__init__.py',
            'from .monotonic_align.core import maximum_path_c\n',
            '''try:
    from .monotonic_align.core import maximum_path_c
except ImportError:  # LectorLibre: sin compilador (Windows), la misma búsqueda con numba
    import numba

    @numba.njit(cache=True)
    def _maximum_path_each(path, value, t_y, t_x):
        max_neg_val = -1e9
        index = t_x - 1
        for y in range(t_y):
            for x in range(max(0, t_x + y - t_y), min(t_x, y + 1)):
                v_cur = max_neg_val if x == y else value[y - 1, x]
                if x == 0:
                    v_prev = 0.0 if y == 0 else max_neg_val
                else:
                    v_prev = value[y - 1, x - 1]
                value[y, x] += max(v_prev, v_cur)
        for y in range(t_y - 1, -1, -1):
            path[y, index] = 1
            if index != 0 and (index == y or value[y - 1, index] < value[y - 1, index - 1]):
                index = index - 1

    @numba.njit(cache=True)
    def maximum_path_c(paths, values, t_ys, t_xs):
        for i in range(paths.shape[0]):
            _maximum_path_each(paths[i], values[i], t_ys[i], t_xs[i])
''', 'LectorLibre: sin compilador')
    # 2) PyTorch 2.9+ exporta con el exportador nuevo por defecto, que falla con este modelo.
    parchar('train/export_onnx.py', '        opset_version=OPSET_VERSION,\n',
            '        opset_version=OPSET_VERSION,\n        dynamo=False,  # LectorLibre\n', 'dynamo=False')
    # 3) El guardado por «val_mos» se cae con Lightning reciente si esa medida no existe (y no se usa).
    p = PKG / 'train/__main__.py'
    s = p.read_text(encoding='utf-8')
    if 'LectorLibre: sin val_mos' not in s:
        i = s.index('    ModelCheckpoint(\n        monitor="val_mos"')
        j = s.index('    ),\n]', i) + len('    ),\n')
        p.write_text(s[:i] + '    # LectorLibre: sin val_mos\n' + s[j:], encoding='utf-8')


def punto_de_partida():
    limpio = BASE / 'ald-limpio.ckpt'
    if limpio.exists(): return
    print('== Voz de partida: Ald (español de México, dominio público, 846 MB)')
    crudo = BASE / 'ald.ckpt'
    if not crudo.exists() or crudo.stat().st_size < 800_000_000: bajar(CKPT_URL, crudo, 'checkpoint de Ald')
    import inspect, torch
    sys.path.insert(0, str(SRC))
    from piper.train.vits.lightning import VitsModel
    validos = set(inspect.signature(VitsModel.__init__).parameters)

    def limpiar(x):
        if isinstance(x, pathlib.PurePath): return str(x)
        if isinstance(x, dict): return {k: limpiar(v) for k, v in x.items()}
        if isinstance(x, (list, tuple)): return type(x)(limpiar(v) for v in x)
        return x
    # el checkpoint es el oficial de Piper (rhasspy/piper-checkpoints): se carga una vez en su formato antiguo
    ck = limpiar(torch.load(crudo, weights_only=False, map_location='cpu'))
    ck['hyper_parameters'] = {k: v for k, v in ck.get('hyper_parameters', {}).items() if k in validos}
    ck.pop('callbacks', None)
    torch.save(ck, limpio)
    torch.load(limpio, weights_only=True, map_location='cpu')
    crudo.unlink()


if __name__ == '__main__':
    BASE.mkdir(parents=True, exist_ok=True)
    codigo_piper(); pronunciacion(); parches(); punto_de_partida()
    print('== Instalación lista.')
