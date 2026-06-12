"""Voice library: reads builtin voices from assets, manages user voices in userData."""

import json
import os
import shutil
import uuid
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

BUILTIN_VOICES = [
    {"id": "builtin_carlos", "name": "Carlos",  "style": "Narrador neutro",        "type": "builtin"},
    {"id": "builtin_elena",  "name": "Elena",   "style": "Presentadora enérgica",  "type": "builtin"},
    {"id": "builtin_david",  "name": "David",   "style": "Corporativo pausado",    "type": "builtin"},
    {"id": "builtin_sofia",  "name": "Sofía",   "style": "Conversacional cercana", "type": "builtin"},
    {"id": "builtin_marcos", "name": "Marcos",  "style": "Documental serio",       "type": "builtin"},
    {"id": "builtin_lucia",  "name": "Lucía",   "style": "Divulgativa amigable",   "type": "builtin"},
]


@dataclass
class UserVoice:
    id: str
    name: str
    source: str         # 'mic' | 'audio' | 'video'
    wav_path: str
    created_at: str
    type: str = "user"


class VoiceManager:
    def __init__(self, voices_builtin_dir: str, voices_user_dir: str):
        self.builtin_dir = Path(voices_builtin_dir)
        self.user_dir    = Path(voices_user_dir)
        self.user_dir.mkdir(parents=True, exist_ok=True)
        self._meta_file  = self.user_dir / "voices_meta.json"
        self._user_voices: dict[str, UserVoice] = {}
        self._load_meta()

    # ── Meta persistence ──────────────────────────────────────────────────
    def _load_meta(self):
        if self._meta_file.exists():
            try:
                data = json.loads(self._meta_file.read_text(encoding="utf-8"))
                for v in data:
                    voice = UserVoice(**v)
                    if Path(voice.wav_path).exists():
                        self._user_voices[voice.id] = voice
            except Exception:
                pass

    def _save_meta(self):
        data = [asdict(v) for v in self._user_voices.values()]
        self._meta_file.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")

    # ── Public API ────────────────────────────────────────────────────────
    def list_all(self) -> list[dict]:
        result = []
        for v in BUILTIN_VOICES:
            wav = self.builtin_dir / f"{v['id']}.wav"
            result.append({**v, "wav_available": wav.exists()})
        for v in self._user_voices.values():
            result.append(asdict(v))
        return result

    def get_wav_path(self, voice_id: str) -> Optional[Path]:
        if voice_id.startswith("builtin_"):
            p = self.builtin_dir / f"{voice_id}.wav"
            return p if p.exists() else None
        if voice_id in self._user_voices:
            p = Path(self._user_voices[voice_id].wav_path)
            return p if p.exists() else None
        return None

    def add_voice(self, name: str, source_wav: Path, source: str) -> UserVoice:
        vid = str(uuid.uuid4())
        dest = self.user_dir / f"{vid}.wav"
        shutil.copy2(source_wav, dest)
        voice = UserVoice(
            id=vid, name=name, source=source,
            wav_path=str(dest),
            created_at=datetime.now(timezone.utc).isoformat(),
        )
        self._user_voices[vid] = voice
        self._save_meta()
        return voice

    def rename_voice(self, voice_id: str, new_name: str):
        if voice_id not in self._user_voices:
            raise ValueError(f"Voice {voice_id} not found")
        self._user_voices[voice_id].name = new_name
        self._save_meta()

    def delete_voice(self, voice_id: str):
        if voice_id.startswith("builtin_"):
            raise ValueError("No se pueden eliminar las voces predefinidas")
        if voice_id not in self._user_voices:
            raise ValueError(f"Voice {voice_id} not found")
        wav = Path(self._user_voices[voice_id].wav_path)
        if wav.exists():
            wav.unlink()
        del self._user_voices[voice_id]
        self._save_meta()
