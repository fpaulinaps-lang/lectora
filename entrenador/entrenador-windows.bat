@echo off
rem Entrenador de LectorLibre (Windows). Doble clic. Si Windows avisa: «Más información» › «Ejecutar de todas formas».
rem La primera vez instala lo necesario (~3 GB, 10 a 20 minutos). Deja la ventana abierta mientras entrena.
chcp 65001 >nul
setlocal
set "BASE=%USERPROFILE%\LectorLibre-Entrenador"
set "WEB=https://fpaulinaps-lang.github.io/lectora/entrenador"
if not exist "%BASE%" mkdir "%BASE%"
cd /d "%BASE%"
set "PATH=%USERPROFILE%\.local\bin;%PATH%"
where uv >nul 2>nul || (echo == Instalando uv ^(administra Python^)... & powershell -ExecutionPolicy ByPass -NoProfile -c "irm https://astral.sh/uv/install.ps1 | iex")
echo == Bajando la ultima version del entrenador...
powershell -NoProfile -c "Invoke-WebRequest %WEB%/instalar.py -OutFile instalar.py; Invoke-WebRequest %WEB%/entrenador.py -OutFile entrenador.py" || goto :error
if not exist venv uv venv -q -p 3.11 venv || goto :error
echo == Revisando las librerias (la primera vez tarda)...
uv pip install -q --python venv\Scripts\python.exe "torch>=2,<3" "lightning>=2,<3" "tensorboard>=2,<3" "tensorboardX>=2,<3" "jsonargparse[signatures]>=4.27.7" "onnx>=1,<2" onnxscript "pysilero-vad>=2.1,<3" "librosa<1" numba cryptography "onnxruntime>=1,<2" "pathvalidate>=3,<4" || goto :error
venv\Scripts\python.exe instalar.py "%BASE%" || goto :error
echo == Si Windows pregunta por el Firewall, permite el acceso en redes privadas.
venv\Scripts\python.exe entrenador.py
goto :eof
:error
echo Algo fallo. Revisa tu conexion a internet y vuelve a abrir este archivo.
pause
