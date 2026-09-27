#!/bin/zsh
# Convierte en audio los PDFs de la carpeta «entrada». Doble clic para usarlo.
cd "$(dirname "$0")"
export PATH="/opt/homebrew/bin:$PATH" PYTORCH_ENABLE_MPS_FALLBACK=1 TOKENIZERS_PARALLELISM=false
echo "Estudio Lectora — el Mac no se va a dormir mientras convierte."
caffeinate -i .venv/bin/python -W ignore estudio.py 2> errores.log || { echo; echo "Algo falló. Detalle:"; tail -5 errores.log; }
echo; echo "Puedes cerrar esta ventana."
