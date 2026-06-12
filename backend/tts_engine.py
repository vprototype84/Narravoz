"""XTTS v2 engine wrapper — lazy-loads the model on first use."""

import os
import threading
from pathlib import Path
from typing import Optional


# Acepta automáticamente los términos de licencia de Coqui TTS (CPML no comercial).
# Sin esto, TTS pide confirmación interactiva y falla en subproceso.
os.environ.setdefault("COQUI_TOS_AGREED", "1")


def _apply_transformers_compat():
    """
    Parcha incompatibilidades entre coqui-tts y distintas versiones de transformers.

    - transformers >= 4.44 eliminó `isin_mps_friendly` de pytorch_utils.
      En GPU NVIDIA / CPU, torch.isin() es un reemplazo directo.
    """
    try:
        import torch
        import transformers.pytorch_utils as _pu
        if not hasattr(_pu, "isin_mps_friendly"):
            _pu.isin_mps_friendly = lambda elements, test_elements: torch.isin(
                elements, test_elements
            )
    except Exception:
        pass

_apply_transformers_compat()


_MODEL_NAME = "tts_models/multilingual/multi-dataset/xtts_v2"
_LANGUAGE   = "es"


def _tts_cache_dir() -> Path:
    """Directorio de caché de modelos de Coqui, respetando TTS_HOME / XDG_DATA_HOME.

    Coincide con la lógica de `get_user_data_dir` de Coqui para que el chequeo de
    "modelo descargado" use la misma ruta donde TTS lo guarda.
    """
    tts_home = os.environ.get("TTS_HOME")
    if tts_home:
        return Path(tts_home)
    xdg = os.environ.get("XDG_DATA_HOME")
    if xdg:
        return Path(xdg) / "tts"
    local = os.environ.get("LOCALAPPDATA")
    if local and Path(local).exists():
        return Path(local) / "tts"
    return Path(os.path.expanduser("~")) / ".local" / "share" / "tts"

_tts = None
_tts_lock   = threading.Lock()
_device     = None
_ready      = False
_loading    = False   # True mientras el modelo se carga en memoria
_setup_progress: dict = {"progress": 0, "message": "", "ready": False}


def _get_device():
    global _device
    if _device is None:
        try:
            import torch
            _device = "cuda" if torch.cuda.is_available() else "cpu"
        except ImportError:
            _device = "cpu"
    return _device


def is_ready() -> bool:
    return _ready


def get_setup_status() -> dict:
    return {**_setup_progress, "ready": _ready, "loading": _loading}


def get_device_info() -> dict:
    dev = _get_device()
    info = {"device": dev}
    if dev == "cuda":
        try:
            import torch
            info["gpu_name"] = torch.cuda.get_device_name(0)
        except Exception:
            pass
    return info


def install_model(progress_cb=None):
    """Download and cache the XTTS v2 model. Runs synchronously — call in a thread."""
    global _tts, _ready, _setup_progress

    def update(pct, msg):
        _setup_progress = {"progress": pct, "message": msg, "ready": False}
        if progress_cb:
            progress_cb(pct, msg)

    try:
        update(5, "Importando dependencias…")
        from TTS.api import TTS

        update(10, "Descargando modelo XTTS v2 (~1,8 GB)… (esto puede tardar varios minutos)")

        # TTS() will download the model automatically on first use
        device = _get_device()
        tts_instance = TTS(_MODEL_NAME)
        tts_instance = tts_instance.to(device)

        with _tts_lock:
            _tts = tts_instance
            _ready = True

        _setup_progress = {"progress": 100, "message": "Motor listo", "ready": True}
        if progress_cb:
            progress_cb(100, "Motor listo")

    except Exception as e:
        _setup_progress = {"progress": 0, "message": f"Error: {e}", "ready": False}
        raise


def load_model_if_ready():
    """Carga el modelo desde caché si ya fue descargado. No descarga nada nuevo."""
    global _tts, _ready, _loading, _setup_progress

    if _ready:
        return True

    _loading = True
    _setup_progress = {"progress": 5, "message": "Cargando modelo en memoria…", "ready": False}

    try:
        from TTS.api import TTS

        # Verificar si el modelo está en caché. Respeta TTS_HOME / XDG_DATA_HOME
        # (la app fija TTS_HOME a %LOCALAPPDATA%\NarraVoz\models en producción)
        # antes de caer al directorio por defecto de Coqui.
        cache_dir = _tts_cache_dir()
        model_dir_name = _MODEL_NAME.replace("/", "--").replace("\\", "--")
        model_path = cache_dir / model_dir_name

        if not model_path.exists():
            # Modelo no descargado — no hacer nada, dejar que install_model() lo haga
            _loading = False
            _setup_progress = {"progress": 0, "message": "", "ready": False}
            return False

        device = _get_device()
        _setup_progress = {"progress": 30, "message": f"Cargando en {device.upper()}…", "ready": False}

        with _tts_lock:
            _tts = TTS(_MODEL_NAME).to(device)
            _ready = True

        _setup_progress = {"progress": 100, "message": "Motor listo", "ready": True}
        return True

    except Exception as e:
        _setup_progress = {"progress": 0, "message": f"Error al cargar: {e}", "ready": False}
        return False
    finally:
        _loading = False


def synthesize(text: str, speaker_wav: str, output_wav: str) -> str:
    """Generate speech using voice cloning. Raises if model not loaded."""
    global _tts

    if not _ready or _tts is None:
        raise RuntimeError("El motor de voz no está listo. Instala el modelo primero.")

    with _tts_lock:
        _tts.tts_to_file(
            text=text,
            speaker_wav=speaker_wav,
            language=_LANGUAGE,
            file_path=output_wav,
        )
    return output_wav
