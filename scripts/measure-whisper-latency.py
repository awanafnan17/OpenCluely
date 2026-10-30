r"""Time local Whisper inference on a 16 kHz mono 16-bit WAV sample.

Usage: .venv-whisper/bin/python scripts/measure-whisper-latency.py sample.wav
Windows: .venv-whisper\Scripts\python.exe scripts\measure-whisper-latency.py sample.wav
"""

import json
import os
import sys
import time
import wave
from pathlib import Path

import numpy as np
import torch
import whisper


def main():
    if len(sys.argv) != 2:
        raise SystemExit("Pass one 16 kHz mono 16-bit WAV file.")
    with wave.open(sys.argv[1], "rb") as wav:
        if (wav.getframerate(), wav.getnchannels(), wav.getsampwidth()) != (16000, 1, 2):
            raise SystemExit("WAV must be 16 kHz, mono, signed 16-bit PCM.")
        audio = np.frombuffer(wav.readframes(wav.getnframes()), dtype="<i2").astype(np.float32) / 32768

    device = os.environ.get("WHISPER_DEVICE") or (
        "cuda" if torch.cuda.is_available() else
        "mps" if torch.backends.mps.is_available() else "cpu"
    )
    started = time.perf_counter()
    model = whisper.load_model("base.en", download_root=str(Path(__file__).resolve().parents[1] / ".whisper-models"), device=device)
    load_seconds = time.perf_counter() - started
    inference_seconds = []
    for _ in range(3):
        started = time.perf_counter()
        model.transcribe(audio, language="en", task="transcribe", fp16=False,
                         verbose=None, condition_on_previous_text=False, without_timestamps=True)
        inference_seconds.append(round(time.perf_counter() - started, 3))
    print(json.dumps({"device": device, "audio_seconds": round(len(audio) / 16000, 3),
                      "model_load_seconds": round(load_seconds, 3),
                      "inference_seconds": inference_seconds}, indent=2))


if __name__ == "__main__":
    main()
