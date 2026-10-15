#!/bin/bash
# Entrenador de LectorLibre (Mac). Doble clic (la primera vez: clic derecho › Abrir).
# La primera vez instala lo necesario (~3 GB, 10 a 20 minutos). Deja la ventana abierta mientras entrena.
set -e
BASE="$HOME/LectorLibre-Entrenador"
WEB="https://fpaulinaps-lang.github.io/lectora/entrenador"
mkdir -p "$BASE" && cd "$BASE"
export PATH="$HOME/.local/bin:$PATH"
command -v uv >/dev/null || { echo "== Instalando uv (administra Python)…"; curl -LsSf https://astral.sh/uv/install.sh | sh; }
echo "== Bajando la última versión del entrenador…"
curl -fsSL "$WEB/instalar.py" -o instalar.py && curl -fsSL "$WEB/entrenador.py" -o entrenador.py
[ -d venv ] || uv venv -q -p 3.11 venv
echo "== Revisando las librerías (la primera vez tarda)…"
uv pip install -q --python venv/bin/python "torch>=2,<3" "lightning>=2,<3" "tensorboard>=2,<3" "tensorboardX>=2,<3" "jsonargparse[signatures]>=4.27.7" \
  "onnx>=1,<2" onnxscript "pysilero-vad>=2.1,<3" "librosa<1" numba cryptography "onnxruntime>=1,<2" "pathvalidate>=3,<4"
venv/bin/python instalar.py "$BASE"
venv/bin/python entrenador.py
