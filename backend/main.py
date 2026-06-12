"""NarraVoz FastAPI backend — starts as a subprocess managed by Electron."""

import asyncio
import os
import shutil
import tempfile
import threading
import uuid
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Optional

import uvicorn
from fastapi import FastAPI, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from audio_utils import (
    convert_to_wav,
    extract_audio_from_video,
    extract_best_segment,
    get_video_duration,
)
from tts_engine import (
    get_device_info,
    get_setup_status,
    install_model,
    is_ready,
    load_model_if_ready,
    synthesize,
)
from video_utils import AudioBlock, compose_video, strip_markup
from voice_manager import VoiceManager

# ── Config from env ────────────────────────────────────────────────────────
PORT              = int(os.environ.get("NARRAVOZ_PORT", "8765"))
VOICES_BUILTIN    = Path(os.environ.get("NARRAVOZ_VOICES_BUILTIN", "./assets/voices"))
VOICES_USER       = Path(os.environ.get("NARRAVOZ_VOICES_USER", "./data/voices"))
TEMP_DIR          = Path(os.environ.get("NARRAVOZ_TEMP", "./data/temp"))
OUTPUT_DIR        = Path(os.environ.get("NARRAVOZ_OUTPUT", "./data/output"))
FFMPEG            = os.environ.get("NARRAVOZ_FFMPEG", "ffmpeg")
SCRIPTS_DIR       = Path(os.environ.get("NARRAVOZ_SCRIPTS", "./scripts"))

TEMP_DIR.mkdir(parents=True, exist_ok=True)
OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

# ── Capture text ───────────────────────────────────────────────────────────
_CAPTURE_TEXT_PATH = Path(__file__).parent.parent / "assets" / "capture_text.txt"
if not _CAPTURE_TEXT_PATH.exists():
    _CAPTURE_TEXT_PATH = SCRIPTS_DIR.parent / "assets" / "capture_text.txt"

_CAPTURE_TEXT = (
    _CAPTURE_TEXT_PATH.read_text(encoding="utf-8").strip()
    if _CAPTURE_TEXT_PATH.exists()
    else "Lee este texto para capturar tu voz: La brisa fresca del amanecer despertó a Xavier."
)

# ── App ────────────────────────────────────────────────────────────────────
@asynccontextmanager
async def lifespan(app: FastAPI):
    threading.Thread(target=load_model_if_ready, daemon=True).start()
    yield

app = FastAPI(title="NarraVoz Backend", version="1.0.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

voice_manager = VoiceManager(str(VOICES_BUILTIN), str(VOICES_USER))

# Background tasks registry: {task_id: {"status": ..., "progress": ..., "message": ..., "output_path": ...}}
_tasks: dict[str, dict] = {}


# ── Health ─────────────────────────────────────────────────────────────────
@app.get("/health")
def health():
    return {"status": "ok"}


# ── Setup ──────────────────────────────────────────────────────────────────
@app.get("/setup/status")
def setup_status():
    st = get_setup_status()
    st["ready"] = is_ready()
    return st


@app.get("/setup/device")
def setup_device():
    return get_device_info()


@app.post("/setup/install")
def setup_install():
    if is_ready():
        return {"message": "Ya instalado"}

    def run():
        install_model()

    t = threading.Thread(target=run, daemon=True)
    t.start()
    return {"message": "Instalación iniciada"}


# ── Voices ─────────────────────────────────────────────────────────────────
@app.get("/voices")
def list_voices():
    return {"voices": voice_manager.list_all()}


@app.get("/voices/{voice_id}/sample")
def get_voice_sample(voice_id: str):
    wav = voice_manager.get_wav_path(voice_id)
    if not wav:
        raise HTTPException(404, "Muestra de voz no encontrada")
    return FileResponse(str(wav), media_type="audio/wav")


class PatchVoiceBody(BaseModel):
    name: str


@app.patch("/voices/{voice_id}")
def rename_voice(voice_id: str, body: PatchVoiceBody):
    try:
        voice_manager.rename_voice(voice_id, body.name)
        return {"ok": True}
    except ValueError as e:
        raise HTTPException(400, str(e))


@app.delete("/voices/{voice_id}")
def delete_voice(voice_id: str):
    try:
        voice_manager.delete_voice(voice_id)
        return {"ok": True}
    except ValueError as e:
        raise HTTPException(400, str(e))


# ── Add voice from audio ───────────────────────────────────────────────────
class AddVoiceBody(BaseModel):
    name: str
    source_path: str
    source: str = "audio"   # 'mic' | 'audio'


@app.post("/voices/from-audio")
def add_voice_from_audio(body: AddVoiceBody):
    src = Path(body.source_path)
    if not src.exists():
        raise HTTPException(400, f"Archivo no encontrado: {src}")

    tmp_wav = TEMP_DIR / f"voice_src_{uuid.uuid4().hex}.wav"
    segment_wav = TEMP_DIR / f"voice_seg_{uuid.uuid4().hex}.wav"

    try:
        convert_to_wav(str(src), str(tmp_wav), ffmpeg=FFMPEG)
        extract_best_segment(str(tmp_wav), str(segment_wav), ffmpeg=FFMPEG)
        voice = voice_manager.add_voice(body.name, segment_wav, body.source)
        return {"ok": True, "voice": {"id": voice.id, "name": voice.name}}
    except Exception as e:
        raise HTTPException(500, str(e))
    finally:
        for f in [tmp_wav, segment_wav]:
            if f.exists():
                f.unlink()


class AddVoiceVideoBody(BaseModel):
    name: str
    source_path: str


@app.post("/voices/from-video")
def add_voice_from_video(body: AddVoiceVideoBody):
    src = Path(body.source_path)
    if not src.exists():
        raise HTTPException(400, f"Archivo no encontrado: {src}")

    tmp_audio = TEMP_DIR / f"vid_audio_{uuid.uuid4().hex}.wav"
    segment   = TEMP_DIR / f"vid_seg_{uuid.uuid4().hex}.wav"

    try:
        extract_audio_from_video(str(src), str(tmp_audio), ffmpeg=FFMPEG)
        extract_best_segment(str(tmp_audio), str(segment), ffmpeg=FFMPEG)
        voice = voice_manager.add_voice(body.name, segment, "video")
        return {"ok": True, "voice": {"id": voice.id, "name": voice.name}}
    except Exception as e:
        raise HTTPException(500, str(e))
    finally:
        for f in [tmp_audio, segment]:
            if f.exists():
                f.unlink()


# ── TTS preview (single block) ─────────────────────────────────────────────
class PreviewBody(BaseModel):
    text: str
    voice_id: str


@app.post("/tts/preview")
def tts_preview(body: PreviewBody):
    if not is_ready():
        raise HTTPException(503, "Motor de voz no listo")

    wav_path = voice_manager.get_wav_path(body.voice_id)
    if not wav_path:
        raise HTTPException(404, f"Voz no encontrada: {body.voice_id}")

    out = TEMP_DIR / f"preview_{uuid.uuid4().hex}.wav"
    try:
        synthesize(strip_markup(body.text), str(wav_path), str(out))
        # Return URL path relative to our static mount
        return {"audio_url": f"/temp/{out.name}"}
    except Exception as e:
        raise HTTPException(500, str(e))


# ── Video generation ───────────────────────────────────────────────────────
class BlockIn(BaseModel):
    start: float
    end: Optional[float] = None
    text: str
    voice_id: str


class SubtitleStyle(BaseModel):
    enabled: bool = True
    fontFamily: str = "Arial"
    color: str = "#FFFFFF"
    outlineColor: str = "#000000"
    fontSize: str = "large"      # small | medium | large
    position: str = "bottom"     # bottom | center | top


class GenerateBody(BaseModel):
    video_path: str
    blocks: list[BlockIn]
    keep_original_audio: bool = True
    subtitles: Optional[SubtitleStyle] = None


@app.post("/generate")
def start_generation(body: GenerateBody):
    if not is_ready():
        raise HTTPException(503, "Motor de voz no listo. Instala el modelo primero.")

    task_id = uuid.uuid4().hex
    _tasks[task_id] = {
        "status": "running",
        "progress": 0,
        "message": "Iniciando…",
        "output_path": None,
    }

    def run():
        try:
            _do_generation(task_id, body)
        except Exception as e:
            _tasks[task_id].update({"status": "error", "message": str(e)})

    threading.Thread(target=run, daemon=True).start()
    return {"task_id": task_id}


def _do_generation(task_id: str, body: GenerateBody):
    def update(pct, msg):
        _tasks[task_id].update({"progress": pct, "message": msg})

    video_path = Path(body.video_path)
    if not video_path.exists():
        raise FileNotFoundError(f"Vídeo no encontrado: {video_path}")

    audio_blocks = []
    total = len(body.blocks)

    for idx, block in enumerate(body.blocks):
        if not block.text.strip():
            continue
        update(int((idx / total) * 70), f"Generando bloque {idx + 1} de {total}…")

        wav_path = voice_manager.get_wav_path(block.voice_id)
        if not wav_path:
            raise ValueError(f"Voz no encontrada: {block.voice_id}")

        out_wav = TEMP_DIR / f"gen_{task_id}_{idx}.wav"
        # El marcado *énfasis* es solo para subtítulos: no debe leerse en voz alta.
        synthesize(strip_markup(block.text), str(wav_path), str(out_wav))
        audio_blocks.append(AudioBlock(
            wav_path=str(out_wav),
            start_seconds=block.start,
            end_seconds=block.end,
            text=block.text,  # con marcado: lo necesita el ASS para colorear
        ))

    update(72, "Mezclando audio y vídeo…")

    output_name = f"narravoz_{video_path.stem}_{task_id[:8]}.mp4"
    output_path = OUTPUT_DIR / output_name

    sub_style = (
        body.subtitles.dict()
        if body.subtitles is not None and body.subtitles.enabled
        else None
    )

    compose_video(
        str(video_path),
        audio_blocks,
        str(output_path),
        keep_original_audio=body.keep_original_audio,
        ffmpeg=FFMPEG,
        progress_callback=lambda p, m: update(72 + int(p * 0.28), m),
        subtitles=sub_style,
    )

    # Cleanup temp block WAVs
    for ab in audio_blocks:
        Path(ab.wav_path).unlink(missing_ok=True)

    _tasks[task_id].update({
        "status": "done",
        "progress": 100,
        "message": "¡Vídeo generado!",
        "output_path": str(output_path),
    })


@app.get("/generate/status/{task_id}")
def generation_status(task_id: str):
    if task_id not in _tasks:
        raise HTTPException(404, "Tarea no encontrada")
    return _tasks[task_id]


@app.delete("/generate/{task_id}")
def cancel_generation(task_id: str):
    if task_id in _tasks:
        _tasks[task_id]["status"] = "cancelled"
    return {"ok": True}


# ── Capture text ───────────────────────────────────────────────────────────
@app.get("/capture-text")
def capture_text():
    return {"text": _CAPTURE_TEXT}


# ── File helpers ───────────────────────────────────────────────────────────
class CopyBody(BaseModel):
    src: str
    dst: str


@app.post("/file/copy")
def file_copy(body: CopyBody):
    try:
        shutil.copy2(body.src, body.dst)
        return {"ok": True}
    except Exception as e:
        raise HTTPException(500, str(e))


# ── Static: serve temp audio files for preview ─────────────────────────────
app.mount("/temp", StaticFiles(directory=str(TEMP_DIR)), name="temp")


# ── Entry point ────────────────────────────────────────────────────────────
if __name__ == "__main__":
    uvicorn.run(app, host="127.0.0.1", port=PORT, log_level="info")
