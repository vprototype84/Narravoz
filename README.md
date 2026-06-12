# NarraVoz

Aplicación de escritorio para añadir narración con voz clonada a vídeos de captura de pantalla. Procesamiento 100% local con XTTS v2.

## Stack

| Capa | Tecnología |
|---|---|
| UI | Electron 28 + HTML/CSS/JS puro |
| Backend | FastAPI + Uvicorn (Python 3.11+) |
| TTS | XTTS v2 (Coqui TTS) |
| Audio/vídeo | FFmpeg |
| Build | Electron Builder + NSIS |

---

## Instalación para desarrollo

### Requisitos comunes

- **Node.js 18+** — [nodejs.org](https://nodejs.org)
- **Python 3.11+** — [python.org](https://www.python.org/downloads/)
- **Git**

### macOS / Linux

```bash
# 1. Clonar el repositorio
git clone https://github.com/vprototype84/Narravoz
cd Narravoz

# 2. Instalar ffmpeg (necesario en PATH para modo dev)
brew install ffmpeg          # macOS
# sudo apt install ffmpeg    # Ubuntu/Debian

# 3. Ejecutar el script de setup (instala npm deps + venv Python)
chmod +x scripts/setup.sh && ./scripts/setup.sh

# 4. Iniciar en modo desarrollo
npm run dev
```

### Windows

```powershell
# 1. Clonar el repositorio
git clone https://github.com/vprototype84/Narravoz
cd Narravoz

# 2. Ejecutar el script de setup
# (descarga uv.exe, ffmpeg.exe y crea el entorno Python)
.\scripts\setup.ps1

# 3. Iniciar en modo desarrollo
npm run dev
```

> **Primera apertura:** la app pedirá descargar el modelo XTTS v2 (~2,3 GB, solo una vez). En sesiones posteriores arranca directamente al editor.

---

## Voces predefinidas

Los seis slots de voz (`builtin_carlos.wav`, `builtin_elena.wav`, etc.) en `assets/voices/` son placeholders vacíos generados por `scripts/first_run.py`.

Para tener voces de verdad:

1. Graba 20-30 segundos del locutor leyendo el texto de `assets/capture_text.txt`
2. Exporta como WAV mono 22050 Hz
3. Nómbralo según el ID (`builtin_carlos.wav`, etc.) y colócalo en `assets/voices/`

XTTS v2 hará zero-shot voice cloning a partir de esa muestra.

---

## Build de producción

### Windows — instalador `.exe`

```powershell
# Requiere haber ejecutado setup.ps1 (uv.exe + ffmpeg.exe presentes)
npm run build:win
# → dist/NarraVoz-Setup-1.0.0.exe
```

El instalador resultante (~140 MB) empaqueta el código y los binarios (uv, ffmpeg). Al abrirse por primera vez descarga Python + dependencias + modelo (~2,3 GB, en `%LOCALAPPDATA%\NarraVoz`). Las reinstalaciones posteriores no vuelven a descargar nada.

El desinstalador pregunta si conservar las voces personalizadas antes de borrar todo.

### macOS — `.dmg` (futuro)

Requiere adicionalmente:
- `build/icon.icns` (generar desde `build/icon.png` con `iconutil`)
- `build/dmg-background.png` (540×380 px)
- Binarios macOS de uv y ffmpeg en `resources/mac/`

```bash
npm run build:mac
```

---

## Estructura del proyecto

```
NarraVoz/
├── electron/
│   ├── main.js          Proceso principal Electron
│   └── preload.js       Context bridge (API segura)
├── renderer/
│   ├── index.html       Shell SPA
│   ├── styles.css       Tema oscuro completo
│   ├── app.js           Controlador principal y routing
│   ├── welcome.js       Pantalla de bienvenida
│   ├── editor.js        Editor de bloques de narración
│   ├── voices.js        Biblioteca de voces
│   └── settings.js      Opciones
├── backend/
│   ├── main.py          FastAPI routes
│   ├── tts_engine.py    XTTS v2 wrapper (lazy load)
│   ├── audio_utils.py   FFmpeg audio helpers
│   ├── video_utils.py   FFmpeg video composition + subtítulos ASS
│   ├── voice_manager.py Gestión de biblioteca de voces
│   └── requirements.txt
├── assets/
│   ├── fonts/           Fuentes OFL empaquetadas (Anton, Bebas Neue, Montserrat Black)
│   ├── capture_text.txt Texto fonético para grabación de voz
│   └── voices/          WAV de voces predefinidas (gitignored; generados por first_run.py)
├── scripts/
│   ├── setup.sh         Setup dev — macOS/Linux
│   ├── setup.ps1        Setup dev — Windows
│   ├── install_deps.py  Instalador de primera ejecución (usado por main.js)
│   └── first_run.py     Generador de WAV placeholder
├── build/               Recursos para Electron Builder (iconos, licencia, NSIS)
├── resources/           Binarios empaquetados (gitignored: uv, ffmpeg)
├── package.json
└── electron-builder.yml
```

---

## API del backend

| Método | Ruta | Descripción |
|---|---|---|
| GET | `/health` | Health check |
| GET | `/setup/status` | Estado XTTS (instalado / progreso) |
| POST | `/setup/install` | Iniciar descarga del modelo |
| GET | `/setup/device` | CPU / GPU info |
| GET | `/voices` | Listar todas las voces |
| GET | `/voices/{id}/sample` | Reproducir muestra de voz |
| PATCH | `/voices/{id}` | Renombrar voz |
| DELETE | `/voices/{id}` | Eliminar voz (solo usuario) |
| POST | `/voices/from-audio` | Añadir voz desde archivo de audio |
| POST | `/voices/from-video` | Añadir voz extrayendo audio de vídeo |
| POST | `/tts/preview` | Generar audio de un bloque (preview) |
| POST | `/generate` | Iniciar generación de vídeo |
| GET | `/generate/status/{id}` | Consultar progreso |
| DELETE | `/generate/{id}` | Cancelar generación |
| GET | `/capture-text` | Texto fonético para grabación |
| POST | `/file/copy` | Copiar archivo generado a destino |

---

## Límites conocidos

- XTTS v2 requiere ~2,3 GB de descarga la primera vez (modelo ~1,8 GB + deps)
- Con CPU la generación es lenta (~1 min por frase). Se recomienda GPU NVIDIA con CUDA
- La cancelación de generación es best-effort (el hilo de Python termina el bloque actual)

## Licencia

MIT
