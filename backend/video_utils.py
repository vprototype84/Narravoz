"""Video composition: merge narration audio blocks onto source video."""

import json
import os
import subprocess
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Optional


import re

# El marcado *énfasis* es solo para subtítulos; no debe sintetizarse en voz.
_EMPHASIS_RE = re.compile(r"\*([^*]+)\*")


def strip_markup(text: str) -> str:
    """Quita el marcado *énfasis* dejando el texto plano para TTS."""
    return _EMPHASIS_RE.sub(r"\1", text or "")


def get_ffmpeg() -> str:
    return os.environ.get("NARRAVOZ_FFMPEG", "ffmpeg")


def get_ffprobe() -> str:
    """Derive the ffprobe path from the configured ffmpeg path."""
    ff = get_ffmpeg()
    base = os.path.basename(ff).lower()
    if base.startswith("ffmpeg"):
        probe = base.replace("ffmpeg", "ffprobe", 1)
        cand = os.path.join(os.path.dirname(ff), probe) if os.path.dirname(ff) else probe
        return cand
    return "ffprobe"


@dataclass
class AudioBlock:
    wav_path: str
    start_seconds: float
    end_seconds: Optional[float]
    text: Optional[str] = None


# Tamaño relativo de subtítulo → px sobre vídeo de referencia 720p (igual que el frontend)
_SUB_SIZE_PX = {"small": 26, "medium": 34, "large": 46}
_SUB_MAX_WORDS = 4  # palabras por frase en pantalla (debe coincidir con el frontend)

# *grupo enfatizado* | palabra normal  (mismo criterio que tokenizeEmphasis en JS)
_TOKEN_RE = re.compile(r"\*([^*]+)\*|(\S+)")


def _tokenize_emphasis(text: str) -> list[dict]:
    tokens = []
    for m in _TOKEN_RE.finditer(text or ""):
        if m.group(1) is not None:
            for w in m.group(1).split():
                tokens.append({"word": w, "emph": True})
        elif m.group(2) is not None:
            tokens.append({"word": m.group(2), "emph": False})
    return tokens


def _chunk_subtitles(text: str, block_start: float, block_end: float) -> list[dict]:
    """Trocea en frases de ≤ _SUB_MAX_WORDS palabras con reparto proporcional al nº de caracteres."""
    tokens = _tokenize_emphasis(text)
    if not tokens:
        return []
    groups = [tokens[i:i + _SUB_MAX_WORDS] for i in range(0, len(tokens), _SUB_MAX_WORDS)]
    weights = [sum(len(t["word"]) + 1 for t in g) for g in groups]
    total_w = sum(weights) or 1
    span = max(0.001, block_end - block_start)
    segs = []
    acc = block_start
    for g, w in zip(groups, weights):
        dur = span * (w / total_w)
        segs.append({"tokens": g, "start": acc, "end": acc + dur})
        acc += dur
    return segs


def _probe_video(video_path: str) -> tuple[int, int, Optional[float]]:
    """Return (width, height, duration_seconds). Falls back to (1280, 720, None)."""
    try:
        out = subprocess.run(
            [get_ffprobe(), "-v", "error",
             "-select_streams", "v:0",
             "-show_entries", "stream=width,height",
             "-show_entries", "format=duration",
             "-of", "json", video_path],
            check=True, capture_output=True, text=True,
        ).stdout
        data = json.loads(out)
        stream = (data.get("streams") or [{}])[0]
        w = int(stream.get("width") or 1280)
        h = int(stream.get("height") or 720)
        dur = data.get("format", {}).get("duration")
        return w, h, (float(dur) if dur is not None else None)
    except Exception:
        return 1280, 720, None


def _hex_to_ass(hex_color: str) -> str:
    """#RRGGBB → ASS &H00BBGGRR (alpha 00 = opaque)."""
    h = (hex_color or "#FFFFFF").lstrip("#")
    if len(h) != 6:
        h = "FFFFFF"
    rr, gg, bb = h[0:2], h[2:4], h[4:6]
    return f"&H00{bb}{gg}{rr}".upper()


def _sec_to_ass_ts(t: float) -> str:
    """Seconds → H:MM:SS.cs (centiseconds) for ASS Dialogue lines."""
    t = max(0.0, t)
    h = int(t // 3600)
    m = int((t % 3600) // 60)
    s = int(t % 60)
    cs = int(round((t - int(t)) * 100))
    if cs == 100:
        cs = 0
        s += 1
    return f"{h}:{m:02d}:{s:02d}.{cs:02d}"


def _build_ass(entries: list[tuple[float, float, str]], style: dict,
               width: int, height: int, out_path: str) -> None:
    """Write an .ass subtitle file styled from the user's preferences.

    Replica el comportamiento del frontend: trocea cada bloque en frases cortas
    (≤ _SUB_MAX_WORDS palabras) con su sub-ventana proporcional, anima cada frase
    con un pop-in y colorea las palabras marcadas con *énfasis*.
    """
    font = style.get("fontFamily", "Arial")
    primary = _hex_to_ass(style.get("color", "#FFFFFF"))
    outline_c = _hex_to_ass(style.get("outlineColor", "#000000"))
    emph_c = _hex_to_ass(style.get("emphasisColor", "#39FF14"))
    size_key = style.get("fontSize", "large")
    fontsize = int(round(_SUB_SIZE_PX.get(size_key, 34) * (height / 720.0)))
    outline = max(3, round(fontsize / 9))    # contorno grueso estilo Shorts
    shadow = max(2, round(fontsize / 18))    # sombra paralela

    pos = style.get("position", "bottom")
    alignment = {"bottom": 2, "center": 5, "top": 8}.get(pos, 2)
    margin_v = int(round(height * 0.08))

    header = f"""[Script Info]
ScriptType: v4.00+
PlayResX: {width}
PlayResY: {height}
WrapStyle: 0
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,{font},{fontsize},{primary},&H000000FF,{outline_c},&H00000000,-1,0,0,0,100,100,0,0,1,{outline},{shadow},{alignment},60,60,{margin_v},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
"""

    # Prefijo de animación pop-in (escala con ligero rebote + fundido de entrada)
    pop = r"{\fad(40,0)\fscx60\fscy60\t(0,90,\fscx108\fscy108)\t(90,160,\fscx100\fscy100)}"

    def render_tokens(tokens):
        parts = []
        for tk in tokens:
            w = tk["word"].replace("\\", "").replace("{", "(").replace("}", ")")
            if tk["emph"]:
                parts.append(f"{{\\c{emph_c}}}{w}{{\\c{primary}}}")
            else:
                parts.append(w)
        return " ".join(parts)

    lines = [header]
    for start, end, text in entries:
        if end is None or end <= start:
            end = start + 2.0
        for seg in _chunk_subtitles(text, start, end):
            body = render_tokens(seg["tokens"])
            if not body.strip():
                continue
            lines.append(
                f"Dialogue: 0,{_sec_to_ass_ts(seg['start'])},{_sec_to_ass_ts(seg['end'])},"
                f"Default,,0,0,0,,{pop}{body}\n"
            )

    Path(out_path).write_text("".join(lines), encoding="utf-8")


def _filter_path(path: str) -> str:
    """Normalize a path for use inside an ffmpeg filtergraph value.

    Se usa con comillas simples (ass='...'), así que basta con barras hacia
    delante; los dos puntos de la unidad (C:) y los espacios quedan literales
    dentro de las comillas.
    """
    return str(path).replace("\\", "/")


def compose_video(
    video_path: str,
    audio_blocks: list[AudioBlock],
    output_path: str,
    keep_original_audio: bool = True,
    ffmpeg: str = None,
    progress_callback=None,
    subtitles: Optional[dict] = None,
) -> str:
    """
    Mix narration WAV blocks onto a video at the specified timestamps.

    - Cada WAV se coloca en start_seconds (adelay) y, si end_seconds está fijado,
      se recorta a esa ventana (no-op si la ventana ya es >= audio real).
    - Si la narración termina después del final del vídeo, el vídeo se extiende
      congelando el último fotograma (tpad), de modo que se oiga completa.
    - Si `subtitles` está activo, se queman subtítulos desde el texto de cada bloque.
    """
    ff = ffmpeg or get_ffmpeg()
    tmp_dir = Path(output_path).parent / "_narravoz_tmp"
    tmp_dir.mkdir(exist_ok=True)

    try:
        inputs = ["-i", video_path]
        filter_parts = []
        mix_labels = []

        # Resolución/duración reales del vídeo (para freeze-frame y subtítulos)
        vid_w, vid_h, vid_dur = _probe_video(video_path)

        # Fin de narración (segundos) considerando cada bloque
        narration_end = 0.0

        for idx, block in enumerate(audio_blocks):
            inp_idx = idx + 1  # 0 is the video

            # Trim audio if end_seconds is set
            wav_to_use = block.wav_path
            block_end = block.end_seconds
            if block.end_seconds is not None:
                max_dur = block.end_seconds - block.start_seconds
                if max_dur > 0:
                    trimmed = str(tmp_dir / f"trimmed_{idx}.wav")
                    subprocess.run(
                        [ff, "-y", "-i", block.wav_path, "-t", str(max_dur), trimmed],
                        check=True, capture_output=True,
                    )
                    wav_to_use = trimmed
            else:
                block_end = block.start_seconds  # se afinará abajo si hace falta

            narration_end = max(narration_end, (block_end or block.start_seconds))

            inputs += ["-i", wav_to_use]

            # adelay takes milliseconds; stereo uses pipe-separated values
            delay_ms = int(block.start_seconds * 1000)
            label = f"[a{idx}]"
            filter_parts.append(
                f"[{inp_idx}:a]adelay={delay_ms}|{delay_ms},aformat=sample_fmts=fltp:channel_layouts=stereo{label}"
            )
            mix_labels.append(label)

            if progress_callback:
                progress_callback(int(30 + (idx / len(audio_blocks)) * 40), f"Preparando bloque {idx + 1} de {len(audio_blocks)}…")

        # Build the amix chain
        if keep_original_audio:
            all_labels = "[0:a]" + "".join(mix_labels)
            n_inputs   = len(audio_blocks) + 1
        else:
            all_labels = "".join(mix_labels)
            n_inputs   = len(audio_blocks)

        filter_parts.append(
            f"{all_labels}amix=inputs={n_inputs}:normalize=0:duration=longest[aout]"
        )

        # ── Cadena de vídeo: freeze-frame + subtítulos (si aplica) ──────────────
        vfilters = []

        # Freeze-frame: extender el vídeo si la voz sobrepasa su final
        if vid_dur is not None:
            extra = narration_end - vid_dur
            if extra > 0.05:
                vfilters.append(f"tpad=stop_mode=clone:stop_duration={extra:.3f}")

        # Subtítulos quemados desde el texto de los bloques
        if subtitles:
            entries = [
                (b.start_seconds, b.end_seconds, b.text)
                for b in audio_blocks if (b.text or "").strip()
            ]
            if entries:
                ass_path = tmp_dir / "subs.ass"
                _build_ass(entries, subtitles, vid_w, vid_h, str(ass_path))
                ass_filter = f"ass='{_filter_path(ass_path)}'"
                fonts_dir = os.environ.get("NARRAVOZ_FONTS")
                if fonts_dir and os.path.isdir(fonts_dir):
                    ass_filter += f":fontsdir='{_filter_path(fonts_dir)}'"
                vfilters.append(ass_filter)

        video_map = "0:v"
        reencode_video = bool(vfilters)
        if vfilters:
            filter_parts.append("[0:v]" + ",".join(vfilters) + "[vout]")
            video_map = "[vout]"

        filter_complex = ";".join(filter_parts)

        if progress_callback:
            progress_callback(75, "Mezclando audio y vídeo…")

        video_codec = (
            ["-c:v", "libx264", "-pix_fmt", "yuv420p", "-preset", "veryfast", "-crf", "18"]
            if reencode_video else ["-c:v", "copy"]
        )

        cmd = (
            [ff, "-y"]
            + inputs
            + ["-filter_complex", filter_complex,
               "-map", video_map,
               "-map", "[aout]"]
            + video_codec
            + ["-c:a", "aac",
               "-b:a", "192k",
               output_path]
        )
        subprocess.run(cmd, check=True, capture_output=True)

        if progress_callback:
            progress_callback(100, "¡Vídeo generado!")

        return output_path

    finally:
        # Clean temp files
        import shutil
        if tmp_dir.exists():
            shutil.rmtree(tmp_dir, ignore_errors=True)


def compose_video_no_audio(
    video_path: str,
    audio_blocks: list[AudioBlock],
    output_path: str,
    ffmpeg: str = None,
    progress_callback=None,
    subtitles: Optional[dict] = None,
) -> str:
    """Convenience wrapper that silences the original audio."""
    return compose_video(
        video_path, audio_blocks, output_path,
        keep_original_audio=False,
        ffmpeg=ffmpeg,
        progress_callback=progress_callback,
        subtitles=subtitles,
    )
