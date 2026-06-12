"""Audio utilities: format conversion, best-segment extraction, WAV export."""

import subprocess
import tempfile
from pathlib import Path


def get_ffmpeg() -> str:
    import os
    return os.environ.get("NARRAVOZ_FFMPEG", "ffmpeg")


def extract_audio_from_video(video_path: str, out_wav: str, ffmpeg: str = None) -> str:
    """Extract full audio track from video as mono 22050 Hz WAV."""
    ff = ffmpeg or get_ffmpeg()
    subprocess.run(
        [ff, "-y", "-i", video_path,
         "-vn", "-acodec", "pcm_s16le", "-ar", "22050", "-ac", "1",
         out_wav],
        check=True,
        capture_output=True,
    )
    return out_wav


def convert_to_wav(src_path: str, out_wav: str, ffmpeg: str = None) -> str:
    """Convert any audio format to mono 22050 Hz WAV suitable for XTTS v2."""
    ff = ffmpeg or get_ffmpeg()
    subprocess.run(
        [ff, "-y", "-i", src_path,
         "-acodec", "pcm_s16le", "-ar", "22050", "-ac", "1",
         out_wav],
        check=True,
        capture_output=True,
    )
    return out_wav


def get_duration(audio_path: str, ffmpeg: str = None) -> float:
    """Return duration in seconds via ffprobe."""
    ff = (ffmpeg or get_ffmpeg()).replace("ffmpeg", "ffprobe")
    result = subprocess.run(
        [ff, "-v", "error", "-show_entries", "format=duration",
         "-of", "default=noprint_wrappers=1:nokey=1", audio_path],
        capture_output=True, text=True, check=True,
    )
    return float(result.stdout.strip())


def extract_best_segment(src_wav: str, out_wav: str, target_duration: float = 30.0, ffmpeg: str = None) -> str:
    """
    Extract the best-quality segment from a WAV for voice cloning.
    Strategy: pick the loudest (highest RMS) window of target_duration seconds.
    Falls back to the full file if it's shorter.
    """
    ff = ffmpeg or get_ffmpeg()
    duration = get_duration(src_wav, ffmpeg)

    if duration <= target_duration:
        # File is short enough — use as-is but still convert to ensure format
        subprocess.run(
            [ff, "-y", "-i", src_wav,
             "-acodec", "pcm_s16le", "-ar", "22050", "-ac", "1",
             out_wav],
            check=True, capture_output=True,
        )
        return out_wav

    # Sample a few windows and pick the loudest via volumedetect
    step = max(1.0, (duration - target_duration) / 10)
    best_start = 0.0
    best_mean  = -999.0

    t = 0.0
    while t + target_duration <= duration:
        result = subprocess.run(
            [ff, "-y", "-ss", str(t), "-t", str(target_duration), "-i", src_wav,
             "-af", "volumedetect", "-f", "null", "-"],
            capture_output=True, text=True,
        )
        for line in result.stderr.splitlines():
            if "mean_volume" in line:
                try:
                    mean_db = float(line.split("mean_volume:")[1].split("dB")[0].strip())
                    if mean_db > best_mean:
                        best_mean  = mean_db
                        best_start = t
                except ValueError:
                    pass
        t += step

    subprocess.run(
        [ff, "-y", "-ss", str(best_start), "-t", str(target_duration), "-i", src_wav,
         "-acodec", "pcm_s16le", "-ar", "22050", "-ac", "1",
         out_wav],
        check=True, capture_output=True,
    )
    return out_wav


def get_video_duration(video_path: str, ffmpeg: str = None) -> float:
    ff = (ffmpeg or get_ffmpeg()).replace("ffmpeg", "ffprobe")
    result = subprocess.run(
        [ff, "-v", "error", "-show_entries", "format=duration",
         "-of", "default=noprint_wrappers=1:nokey=1", video_path],
        capture_output=True, text=True, check=True,
    )
    return float(result.stdout.strip())
