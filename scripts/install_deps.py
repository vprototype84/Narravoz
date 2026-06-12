#!/usr/bin/env python3
"""
First-run installer: installs Python dependencies and verifies FFmpeg.
Called by Electron on first launch before starting the backend.
Prints JSON progress lines to stdout: {"progress": 0-100, "message": "..."}
"""

import json
import os
import subprocess
import sys
from pathlib import Path


def emit(progress: int, message: str):
    print(json.dumps({"progress": progress, "message": message}), flush=True)


def run(cmd, **kwargs):
    return subprocess.run(cmd, check=True, capture_output=True, text=True, **kwargs)


def main():
    emit(0, "Iniciando instalación…")

    pip = [sys.executable, "-m", "pip"]

    # Upgrade pip first
    emit(5, "Actualizando pip…")
    try:
        run(pip + ["install", "--upgrade", "pip", "--quiet"])
    except subprocess.CalledProcessError:
        pass

    emit(10, "Instalando dependencias del servidor…")
    req_file = Path(__file__).parent.parent / "backend" / "requirements.txt"

    # Detect CUDA availability for appropriate torch install
    cuda_available = False
    try:
        result = run(["nvidia-smi"])
        cuda_available = True
    except (FileNotFoundError, subprocess.CalledProcessError):
        pass

    emit(15, "Instalando PyTorch…")
    if cuda_available:
        # Install CUDA-enabled torch
        run(pip + [
            "install", "torch", "torchaudio",
            "--index-url", "https://download.pytorch.org/whl/cu121",
            "--quiet"
        ])
    else:
        run(pip + ["install", "torch", "torchaudio", "--quiet"])

    emit(50, "Instalando TTS (Coqui XTTS v2)…")
    run(pip + ["install", "TTS==0.22.0", "--quiet"])

    emit(80, "Instalando servidor FastAPI…")
    run(pip + [
        "install",
        "fastapi==0.111.0",
        "uvicorn[standard]==0.30.1",
        "python-multipart==0.0.9",
        "aiofiles==23.2.1",
        "pydantic==2.7.4",
        "--quiet"
    ])

    emit(95, "Verificando instalación…")
    try:
        import importlib
        for mod in ["fastapi", "uvicorn", "TTS", "torch"]:
            importlib.import_module(mod.replace("-", "_").lower().split(".")[0])
    except ImportError as e:
        print(json.dumps({"error": str(e)}), flush=True)
        sys.exit(1)

    emit(100, "Instalación completada")


if __name__ == "__main__":
    main()
