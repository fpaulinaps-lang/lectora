"""Estudio Lectora: convierte PDFs en audio (con tu voz o una voz natural) para la app Lectora.

Deja los PDF en la carpeta `entrada`, ejecuta `Convertir.command` y el resultado queda en `listos`
como un .zip que se abre en la app del celular (audio + texto para ir marcando las frases).
"""
import hashlib, json, os, re, shutil, subprocess, sys, time, zipfile
from pathlib import Path

import numpy as np

BASE = Path(__file__).resolve().parent
ENTRADA, LISTOS, MI_VOZ, CACHE = BASE / "entrada", BASE / "listos", BASE / "mi-voz", BASE / "cache"
SR = 24000
PAUSA_FRASE, PAUSA_PAGINA = 0.28, 0.7
AUDIO_EXT = (".m4a", ".wav", ".mp3", ".aac", ".caf", ".aiff")

# ---------------------------------------------------------------- texto
def page_lines(text):
    return [re.sub(r"\s+", " ", l).strip() for l in text.splitlines() if l.strip()]

def is_page_num(l):
    return re.fullmatch(r"[-–—\s]*(p[aá]g(ina)?\.?\s*|page\s*)?\d+(\s*(de|of|/)\s*\d+)?[-–—\s]*", l, re.I) is not None

def norm(l):
    return re.sub(r"\s+", " ", re.sub(r"\d+", "#", l.lower())).strip()

def strip_repeats(pages):
    count = {}
    for ls in pages:
        for k in {norm(l) for l in ls[:2] + ls[-2:]}:
            count[k] = count.get(k, 0) + 1
    thr = max(3, len(pages) * 0.3)
    out = []
    for ls in pages:
        keep = []
        for i, l in enumerate(ls):
            if is_page_num(l):
                continue
            edge = i < 2 or i >= len(ls) - 2
            if len(pages) >= 4 and edge and len(l) < 120 and count.get(norm(l), 0) >= thr:
                continue
            keep.append(l)
        out.append(keep)
    return out

def is_heading(l):
    return len(l) < 90 and not re.search(r"[.,;:]$", l) and l == l.upper() and re.search(r"[A-ZÁÉÍÓÚÑ]{3}", l)

def join_lines(lines):
    out, prev = "", ""
    for l in lines:
        if not out:
            out = l
        elif is_heading(prev) or is_heading(l):
            out += "\n" + l
        elif re.search(r"[A-Za-zÁÉÍÓÚáéíóúñÑ]-$", out) and re.match(r"[a-záéíóúñü]", l):
            out = out[:-1] + l
        else:
            out += " " + l
        prev = l
    return out

ABBR = re.compile(r"(?:\b(?:arts?|inc|núm|nº|n°|nro|sr|sra|srta|dr|dra|mr|mrs|ms|lic|etc|págs?|pp?|caps?|vol|ej|cfr|vid|op|cit|ss|sgtes?|ed|av|dto|dfl|ord|aprox|fig|tel|cía|ltda|vs|e\.g|i\.e|no|st|jr)|\b[A-Za-zÁÉÍÓÚÑ]|\d+)\.$", re.I)

def chop(t, maxlen=240):
    r = []
    while len(t) > maxlen:
        cut = max(t.rfind(", ", 0, maxlen), t.rfind("; ", 0, maxlen), t.rfind(": ", 0, maxlen))
        if cut < maxlen * 0.4:
            cut = t.rfind(" ", 0, maxlen)
        if cut <= 0:
            cut = maxlen
        r.append(t[:cut + 1].strip())
        t = t[cut + 1:].strip()
    if t:
        r.append(t)
    return r

def split_sentences(text):
    out = []
    for block in re.split(r"\n+", text):
        parts = re.findall(r"[^.!?…]+(?:[.!?…]+[\"'»”’)\]]*|$)", block)
        buf = ""
        for p in parts:
            buf += p
            t = buf.strip()
            if len(t) < 18 or ABBR.search(t):
                continue
            out += chop(t)
            buf = ""
        if buf.strip():
            out += chop(buf.strip())
    return [s for s in out if re.search(r"\w", s)]

def extract(pdf_path):
    from pypdf import PdfReader
    reader = PdfReader(str(pdf_path))
    raw = [page_lines(p.extract_text() or "") for p in reader.pages]
    return [split_sentences(join_lines(ls)) for ls in strip_repeats(raw)]

# ---------------------------------------------------------------- idioma
ES = set("de la que el en y los se del las un por con una su para es al lo como más pero sus le ya o este sí porque esta entre cuando muy sin sobre también me hasta hay donde quien desde todo nos durante todos uno les ni contra otros ese eso ante ellos e esto mí antes algunos qué unos yo otro otras otra él tanto esa estos mucho quienes nada muchos cual poco ella estar estas algunas algo nosotros artículo ley será podrá deberá".split())
EN = set("the of and to in is that it for was on are as with his they at be this have from or one had by but not what all were we when your can said there use an each which she do how their if will up other about out many then them these so some her would make like him into time has look two more write go see number way could people my than first been call who its now find long down day did get come made may part shall any such".split())

def detect(sentence, default):
    if re.search(r"[ñ¿¡áéíóú]", sentence, re.I):
        return "es"
    words = re.findall(r"[a-záéíóúñü']+", sentence.lower())
    es = sum(w in ES for w in words)
    en = sum(w in EN for w in words)
    if es > en:
        return "es"
    if en > es:
        return "en"
    return default

def languages(pages):
    flat = [s for p in pages for s in p]
    doc_default = "en" if sum(detect(s, "") == "en" for s in flat) > sum(detect(s, "") == "es" for s in flat) else "es"
    langs, prev = [], doc_default
    for s in flat:
        prev = detect(s, prev)
        langs.append(prev)
    return langs, doc_default

# ---------------------------------------------------------------- voces
KOKORO_VOZ = {"es": ("e", "ef_dora"), "en": ("a", "af_heart")}

class VozNatural:
    nombre = "Voz natural"
    def __init__(self):
        from kokoro import KPipeline
        self.KPipeline, self.pipes = KPipeline, {}
    def __call__(self, text, lang, voice=None):
        code, default = KOKORO_VOZ[lang]
        if code not in self.pipes:
            self.pipes[code] = self.KPipeline(lang_code=code, repo_id="hexgrad/Kokoro-82M")
        parts = [r.audio.numpy() for r in self.pipes[code](text, voice=voice or default) if r.audio is not None]
        return np.concatenate(parts) if parts else np.zeros(1, dtype=np.float32)

# Tu voz: la voz natural lee el texto y luego un conversor (OpenVoice V2) le pone el timbre de tu grabación.
# Es liviano (corre más rápido que tiempo real en este Mac); un modelo que clona desde cero tardaba minutos por frase.
BASES = {"es": ["ef_dora", "em_alex"], "en": ["af_heart", "am_michael"]}
FRASE_BASE = {"es": "La lectura en voz alta cambia la manera en que entendemos un texto, porque cada frase tiene su ritmo y sus pausas.",
              "en": "Reading aloud changes the way we understand a text, because every sentence has its own rhythm and pauses."}

class MiVoz:
    nombre = "Mi voz"
    def __init__(self, muestra):
        import librosa, torch
        from huggingface_hub import snapshot_download
        from openvoice.api import OpenVoiceBaseClass, ToneColorConverter
        from openvoice.mel_processing import spectrogram_torch
        ck = Path(snapshot_download("myshell-ai/OpenVoiceV2", allow_patterns=["converter/*"])) / "converter"
        tc = ToneColorConverter.__new__(ToneColorConverter)  # su __init__ falla con enable_watermark
        OpenVoiceBaseClass.__init__(tc, str(ck / "config.json"), device="cpu")
        tc.watermark_model, tc.version = None, getattr(tc.hps, "_version_", "v1")
        tc.load_ckpt(str(ck / "checkpoint.pth"))
        self.tc, self.torch, self.librosa, self.spec = tc, torch, librosa, spectrogram_torch
        self.hsr = tc.hps.data.sampling_rate
        self.base = VozNatural()
        ref, _ = librosa.load(str(muestra), sr=self.hsr)
        self.tgt = self._se(ref, self.hsr)
        # Para cada idioma, usa la voz natural cuyo timbre se parece más al tuyo: la conversión queda más limpia.
        self.voz, self.src = {}, {}
        for lang, cands in BASES.items():
            best = None
            for v in cands:
                se = self._se(self.base(FRASE_BASE[lang], lang, v), SR)
                sim = torch.nn.functional.cosine_similarity(se.flatten(), self.tgt.flatten(), dim=0).item()
                if best is None or sim > best[0]:
                    best = (sim, v, se)
            self.voz[lang], self.src[lang] = best[1], best[2]

    def _spec(self, a):
        h = self.tc.hps.data
        y = self.torch.FloatTensor(a).unsqueeze(0)
        return self.spec(y, h.filter_length, h.sampling_rate, h.hop_length, h.win_length, center=False)

    def _se(self, a, sr):
        if sr != self.hsr:
            a = self.librosa.resample(a, orig_sr=sr, target_sr=self.hsr)
        with self.torch.no_grad():
            return self.tc.model.ref_enc(self._spec(a).transpose(1, 2)).unsqueeze(-1)

    def __call__(self, text, lang):
        a = self.base(text, lang, self.voz[lang])
        a = self.librosa.resample(a, orig_sr=SR, target_sr=self.hsr)
        with self.torch.no_grad():
            spec = self._spec(a)
            out = self.tc.model.voice_conversion(spec, self.torch.LongTensor([spec.size(-1)]),
                                                 sid_src=self.src[lang], sid_tgt=self.tgt, tau=0.3)[0][0, 0].numpy()
        return self.librosa.resample(out.astype(np.float32), orig_sr=self.hsr, target_sr=SR)

def muestra_de_voz():
    """La grabación más reciente de la carpeta mi-voz, convertida a wav 24 kHz y recortada a 25 s."""
    MI_VOZ.mkdir(exist_ok=True)
    files = sorted((f for f in MI_VOZ.iterdir() if f.suffix.lower() in AUDIO_EXT and f.name != "_muestra.wav"),
                   key=lambda f: f.stat().st_mtime)
    if not files:
        return None
    out = MI_VOZ / "_muestra.wav"
    if not out.exists() or out.stat().st_mtime < files[-1].stat().st_mtime:
        subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", str(files[-1]), "-t", "25", "-ac", "1", "-ar", str(SR),
                        "-af", "silenceremove=start_periods=1:start_threshold=-45dB,loudnorm", str(out)], check=True)
    return out

# ---------------------------------------------------------------- conversión
def trim(a):
    """Quita silencios del principio y del final para que las pausas queden parejas."""
    idx = np.where(np.abs(a) > 0.01)[0]
    if len(idx) == 0:
        return a[:0]
    return a[max(0, idx[0] - 480): idx[-1] + 960]

def fmt(sec):
    sec = int(sec)
    return f"{sec // 3600} h {sec % 3600 // 60:02d} min" if sec >= 3600 else f"{sec // 60} min {sec % 60:02d} s"

def convert(pdf, voz, voz_id):
    print(f"\n📄 {pdf.name}")
    pages = extract(pdf)
    flat = [(p, s) for p, ss in enumerate(pages) for s in ss]
    if not flat:
        print("   Este PDF no tiene texto (es un escaneo). Pásalo antes por OCR.")
        return None
    langs, doc_lang = languages(pages)
    n_en = langs.count("en")
    print(f"   {len(pages)} páginas, {len(flat)} frases · idioma: {'inglés' if doc_lang == 'en' else 'español'}"
          + (f" ({n_en} frases en inglés)" if 0 < n_en < len(flat) else ""))

    key = hashlib.sha1(pdf.read_bytes()).hexdigest()[:12] + "-" + voz_id
    cdir = CACHE / key
    cdir.mkdir(parents=True, exist_ok=True)
    t0, hechos_ahora, audio_s = time.time(), 0, 0.0
    for i, ((p, s), lang) in enumerate(zip(flat, langs)):
        f = cdir / f"{i:06d}.npy"
        if f.exists():
            continue
        a = trim(voz(s, lang))
        np.save(f, (np.clip(a, -1, 1) * 32767).astype(np.int16))
        hechos_ahora += 1
        audio_s += len(a) / SR
        el = time.time() - t0
        faltan = sum(1 for j in range(i + 1, len(flat)) if not (cdir / f"{j:06d}.npy").exists())
        eta = el / hechos_ahora * faltan
        print(f"\r   Frase {i + 1} de {len(flat)} · pág. {p + 1} · faltan ~{fmt(eta)}      ", end="", flush=True)
    print()

    # Unir todo en un solo audio y anotar dónde empieza y termina cada frase.
    raw = cdir / "todo.pcm"
    out_pages = [[] for _ in pages]
    pos = 0
    with open(raw, "wb") as out:
        prev_p = None
        for i, (p, s) in enumerate(flat):
            if prev_p is not None:
                gap = int(SR * (PAUSA_PAGINA if p != prev_p else PAUSA_FRASE))
                out.write(np.zeros(gap, dtype=np.int16).tobytes()); pos += gap
            a = np.load(cdir / f"{i:06d}.npy")
            out_pages[p].append({"t": s, "s": round(pos / SR, 2), "e": round((pos + len(a)) / SR, 2), "l": langs[i]})
            out.write(a.tobytes()); pos += len(a)
            prev_p = p
    m4a = cdir / "audio.m4a"
    print("   Comprimiendo el audio…")
    subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-f", "s16le", "-ar", str(SR), "-ac", "1", "-i", str(raw),
                    "-c:a", "aac", "-b:a", "48k", "-movflags", "+faststart", str(m4a)], check=True)
    raw.unlink()

    meta = {"v": 1, "name": pdf.stem, "voice": voz.nombre, "lang": doc_lang, "duration": round(pos / SR, 1),
            "pages": out_pages}
    LISTOS.mkdir(exist_ok=True)
    dest = LISTOS / f"{pdf.stem} ({voz.nombre}).zip"
    # Sin compresión: el audio ya viene comprimido y así la app lo abre sin librerías extra.
    with zipfile.ZipFile(dest, "w", zipfile.ZIP_STORED) as z:
        z.writestr("lectora.json", json.dumps(meta, ensure_ascii=False))
        z.write(m4a, "audio.m4a")
    shutil.rmtree(cdir)
    hechos = ENTRADA / "hechos"
    hechos.mkdir(exist_ok=True)
    shutil.move(str(pdf), hechos / pdf.name)
    print(f"   ✅ Listo: {dest.name} · {fmt(pos / SR)} de audio · {dest.stat().st_size / 1e6:.0f} MB · tardó {fmt(time.time() - t0)}")
    return dest

def elegir(opciones):
    script = ('choose from list {' + ",".join(f'"{o}"' for o in opciones) +
              '} with title "Estudio Lectora" with prompt "¿Con qué voz lo leo?" default items {"' + opciones[0] + '"}')
    try:
        r = subprocess.run(["osascript", "-e", script], capture_output=True, text=True).stdout.strip()
    except Exception:
        r = ""
    if r and r != "false":
        return r
    if r == "false":
        sys.exit("Cancelado.")
    for i, o in enumerate(opciones, 1):
        print(f"  {i}. {o}")
    return opciones[int(input("Elige un número: ") or 1) - 1]

def main():
    for d in (ENTRADA, LISTOS, MI_VOZ):
        d.mkdir(exist_ok=True)
    pdfs = sorted(ENTRADA.glob("*.pdf")) + sorted(ENTRADA.glob("*.PDF"))
    if not pdfs:
        print("No hay PDFs en la carpeta «entrada». Deja ahí los que quieras convertir y vuelve a abrir Convertir.")
        subprocess.run(["open", str(ENTRADA)])
        return
    muestra = muestra_de_voz()
    opciones = (["Mi voz"] if muestra else []) + ["Voz natural"]
    if not muestra:
        print("(Todavía no grabaste tu voz: abre «Grabar mi voz» para poder usarla.)")
    eleccion = elegir(opciones)
    print("Cargando la voz… (la primera vez tarda más)")
    if eleccion == "Mi voz":
        voz = MiVoz(muestra)
        voz_id = "mivoz-" + hashlib.sha1(muestra.read_bytes()).hexdigest()[:8]
    else:
        voz, voz_id = VozNatural(), "natural"
    listos = [d for d in (convert(p, voz, voz_id) for p in pdfs) if d]
    if listos:
        subprocess.run(["open", "-R", str(listos[-1])])
        subprocess.run(["osascript", "-e", 'display notification "Tus audios están en la carpeta listos." with title "Estudio Lectora" sound name "Glass"'])
        print("\nPásalos al celular por AirDrop (o iCloud Drive) y ábrelos en la Lectora con «Abrir».")

if __name__ == "__main__":
    main()
