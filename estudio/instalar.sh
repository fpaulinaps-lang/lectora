#!/bin/zsh
# Instala el Estudio Lectora en ~/LectoraEstudio (necesita Homebrew con uv y ffmpeg).
set -e
D=~/LectoraEstudio
mkdir -p $D/entrada $D/listos $D/mi-voz
cp "$(dirname "$0")"/{estudio.py,Convertir.command,"Grabar mi voz.command",LEEME.txt} $D/
cd $D
export PATH="/opt/homebrew/bin:$PATH"
uv venv -q --python 3.11 .venv
uv pip install -q --python .venv/bin/python kokoro pypdf librosa "setuptools<81" inflect unidecode eng-to-ipa pypinyin jieba cn2an
uv pip install -q --python .venv/bin/python --no-deps "git+https://github.com/myshell-ai/OpenVoice.git"
echo "Listo. Abre $D"
