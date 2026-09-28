#!/bin/zsh
# Graba 25 segundos de tu voz para que el Estudio pueda leer como tú.
cd "$(dirname "$0")"
export PATH="/opt/homebrew/bin:$PATH"
mkdir -p mi-voz
clear
cat <<'TXT'
Vas a grabar 25 segundos. Busca un lugar sin ruido y habla con tu tono normal,
como si le leyeras a alguien. Cuando aparezca «GRABANDO», lee en voz alta:

  «La lectura en voz alta cambia la manera en que entendemos un texto. Cada
  frase tiene su ritmo, sus pausas y su intención. Por eso vale la pena leer
  con calma, sin apuro, dejando que las ideas se acomoden. Hoy voy a leer
  algunos documentos importantes, página por página, hasta terminarlos.»

Si te sobra tiempo, sigue hablando de cualquier cosa.
TXT
echo; read "?Presiona Enter para empezar… "
echo "🔴 GRABANDO (25 s)…"
ffmpeg -y -loglevel error -f avfoundation -i ":default" -t 25 -ac 1 -ar 44100 "mi-voz/mi-voz-$(date +%Y%m%d-%H%M).wav" \
  && { echo "✅ Listo. Así quedó:"; afplay "$(ls -t mi-voz/mi-voz-*.wav | head -1)"; echo "Si no te gustó, vuelve a abrir este archivo y graba otra vez (se usa la más reciente)."; } \
  || echo "No pude usar el micrófono. Ve a Ajustes del Sistema › Privacidad › Micrófono y activa Terminal. También puedes grabarte con Notas de Voz en el celular y dejar el archivo en la carpeta «mi-voz»."
echo; echo "Puedes cerrar esta ventana."
