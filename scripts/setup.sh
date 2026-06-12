#!/usr/bin/env bash
# NarraVoz — Configuración del entorno de desarrollo (macOS / Linux)
# Uso: chmod +x scripts/setup.sh && ./scripts/setup.sh

set -e

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

echo "=== NarraVoz — Setup ==="

# 1. Node.js 18+
if ! command -v node &>/dev/null; then
  echo "ERROR: Node.js no encontrado. Instálalo desde https://nodejs.org (v18+)"
  exit 1
fi
NODE_MAJOR=$(node --version | sed 's/v//' | cut -d. -f1)
if [ "$NODE_MAJOR" -lt 18 ]; then
  echo "ERROR: Se requiere Node.js 18+. Versión actual: $(node --version)"
  exit 1
fi
echo "✓ Node.js $(node --version)"

# 2. Dependencias npm
echo "→ Instalando dependencias npm..."
npm install

# 3. ffmpeg en PATH (dev: viene de brew/apt, no bundleado)
if command -v ffmpeg &>/dev/null; then
  echo "✓ ffmpeg $(ffmpeg -version 2>&1 | head -1 | awk '{print $3}')"
else
  echo "AVISO: ffmpeg no encontrado en PATH."
  if [[ "$OSTYPE" == "darwin"* ]]; then
    echo "  Instálalo con: brew install ffmpeg"
  else
    echo "  Instálalo con: sudo apt install ffmpeg  (o el gestor de tu distro)"
  fi
  echo "  La app arrancará pero el export de vídeo fallará sin ffmpeg."
fi

# 4. Python 3.11+
PYTHON=""
for cmd in python3.11 python3 python; do
  if command -v "$cmd" &>/dev/null; then
    VER=$("$cmd" --version 2>&1 | awk '{print $2}')
    MAJOR=$(echo "$VER" | cut -d. -f1)
    MINOR=$(echo "$VER" | cut -d. -f2)
    if [ "$MAJOR" -eq 3 ] && [ "$MINOR" -ge 11 ]; then
      PYTHON="$cmd"
      break
    fi
  fi
done

if [ -z "$PYTHON" ]; then
  echo "ERROR: Python 3.11+ no encontrado."
  if [[ "$OSTYPE" == "darwin"* ]]; then
    echo "  Instálalo con: brew install python@3.11"
  else
    echo "  Instálalo con: sudo apt install python3.11 python3.11-venv"
  fi
  exit 1
fi
echo "✓ $($PYTHON --version)"

# 5. Crear o actualizar .venv
if [ ! -f ".venv/bin/python" ]; then
  echo "→ Creando entorno virtual..."
  "$PYTHON" -m venv .venv
else
  echo "✓ Entorno virtual ya existe"
fi

echo "→ Instalando dependencias Python (PyTorch CPU)..."
.venv/bin/pip install --quiet --upgrade pip
.venv/bin/pip install --quiet torch torchaudio --index-url https://download.pytorch.org/whl/cpu
.venv/bin/pip install --quiet -r backend/requirements.txt

# 6. Voces placeholder
echo "→ Generando placeholders de voces..."
.venv/bin/python scripts/first_run.py

echo ""
echo "✓ Setup completado."
echo ""
echo "Para iniciar la app en modo desarrollo:"
echo "  npm run dev"
echo ""
echo "NOTA: Al abrir la app por primera vez se te pedirá descargar"
echo "      el modelo XTTS v2 (~2,3 GB). Solo se descarga una vez."
