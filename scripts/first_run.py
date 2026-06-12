#!/usr/bin/env python3
"""
Generates silent placeholder WAV files for the 6 builtin voice slots.
These are overwritten when real voice samples are recorded/provided.

Run this script once to populate assets/voices/ during development:
  python scripts/first_run.py
"""

import struct
import wave
from pathlib import Path

BUILTIN_IDS = [
    "builtin_carlos",
    "builtin_elena",
    "builtin_david",
    "builtin_sofia",
    "builtin_marcos",
    "builtin_lucia",
]

SAMPLE_RATE  = 22050
DURATION_SEC = 1
N_SAMPLES    = SAMPLE_RATE * DURATION_SEC


def write_silent_wav(path: Path):
    with wave.open(str(path), "w") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(SAMPLE_RATE)
        wf.writeframes(b"\x00\x00" * N_SAMPLES)
    print(f"  Created placeholder: {path.name}")


def main():
    voices_dir = Path(__file__).parent.parent / "assets" / "voices"
    voices_dir.mkdir(parents=True, exist_ok=True)

    print("Generating placeholder WAV files for builtin voices…")
    print("(Replace these with real recordings before shipping!)\n")

    for vid in BUILTIN_IDS:
        p = voices_dir / f"{vid}.wav"
        if p.exists():
            print(f"  Skipping {p.name} (already exists)")
        else:
            write_silent_wav(p)

    print(f"\nDone. Files are in: {voices_dir}")
    print("\nTo use real voices, record 15-30 seconds of each speaker")
    print("and replace the placeholder WAV files with the real recordings.")


if __name__ == "__main__":
    main()
