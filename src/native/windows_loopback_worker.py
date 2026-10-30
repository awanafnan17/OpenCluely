"""Capture the Windows default speaker through WASAPI loopback as 16 kHz PCM.

Binary audio is written only to stdout. Diagnostics use JSON lines on stderr.
"""

import json
import sys

import numpy as np
import soundcard as sc


def status(**payload):
    sys.stderr.write(json.dumps(payload) + "\n")
    sys.stderr.flush()


def main():
    speaker = sc.default_speaker()
    if speaker is None:
        raise RuntimeError("Windows has no default output device")

    loopback = sc.get_microphone(speaker.id, include_loopback=True)
    status(status="ready", device=speaker.name)

    # Request 16 kHz; SoundCard/WASAPI performs host conversion when supported.
    # Record the device's normal channel layout (rather than one channel),
    # because some Windows WASAPI drivers return corrupt mono loopback audio.
    with loopback.recorder(samplerate=16000, blocksize=2048) as recorder:
        while True:
            frames = recorder.record(numframes=960)
            if frames is None or len(frames) == 0:
                continue
            mono = np.asarray(frames, dtype=np.float32)
            if mono.ndim == 2:
                mono = mono.mean(axis=1)
            pcm = (np.clip(mono, -1.0, 1.0) * 32767).astype("<i2")
            sys.stdout.buffer.write(pcm.tobytes())
            sys.stdout.buffer.flush()


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        pass
    except Exception as exc:
        status(status="error", error=str(exc))
        sys.exit(1)
