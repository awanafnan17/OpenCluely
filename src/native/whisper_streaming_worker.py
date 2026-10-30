import sys
import os
import json
import collections

import numpy as np
import torch
import whisper


SAMPLE_RATE = 16000
BYTES_PER_SAMPLE = 2

# 20 ms PCM frames
FRAME_MS = 20
SAMPLES_PER_FRAME = int(SAMPLE_RATE * FRAME_MS / 1000)
BYTES_PER_FRAME = SAMPLES_PER_FRAME * BYTES_PER_SAMPLE  # 640 bytes

# Meeting speech endpointing
PRE_ROLL_MS = 300
END_SILENCE_MS = 280
MIN_SPEECH_MS = 140
MAX_UTTERANCE_MS = 15000

PRE_ROLL_FRAMES = max(1, PRE_ROLL_MS // FRAME_MS)
END_SILENCE_FRAMES = max(1, END_SILENCE_MS // FRAME_MS)
MIN_SPEECH_FRAMES = max(1, MIN_SPEECH_MS // FRAME_MS)
MAX_UTTERANCE_FRAMES = max(1, MAX_UTTERANCE_MS // FRAME_MS)


def emit_stderr(obj):
    sys.stderr.write(json.dumps(obj) + "\n")
    sys.stderr.flush()


def emit_stdout(obj):
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


def rms_int16(frame_bytes):
    if not frame_bytes:
        return 0.0

    arr = np.frombuffer(frame_bytes, dtype=np.int16)

    if arr.size == 0:
        return 0.0

    x = arr.astype(np.float32) / 32768.0
    return float(np.sqrt(np.mean(x * x)))


def transcribe_utterance(model, utterance_bytes, initial_prompt):
    if not utterance_bytes:
        return ""

    # Guarantee whole int16 samples only
    usable = len(utterance_bytes) - (len(utterance_bytes) % 2)

    if usable <= 0:
        return ""

    raw_np = (
        np.frombuffer(
            bytes(utterance_bytes[:usable]),
            dtype=np.int16
        )
        .astype(np.float32)
        / 32768.0
    )

    if raw_np.size == 0:
        return ""

    duration_ms = int((raw_np.size / SAMPLE_RATE) * 1000)

    args = {
        "language": "en",
        "task": "transcribe",
        "fp16": False,
        # None disables Whisper's tqdm progress spam.
        "verbose": None,
        "temperature": 0,
        "condition_on_previous_text": False,
        "without_timestamps": True,
    }

    if initial_prompt:
        # Keep vocabulary bias, but don't allow an enormous brief-derived
        # prompt to dominate speech decoding.
        args["initial_prompt"] = initial_prompt[:600]

    emit_stderr({
        "status": "transcribing",
        "duration_ms": duration_ms
    })

    result = model.transcribe(raw_np, **args)
    text = (result.get("text") or "").strip()

    lower = text.lower()

    invalid_phrases = [
        "subtitles by",
        "amara.org",
        "thank you for watching",
        "subscribe",
        "[music]",
        "(music)"
    ]

    if any(x in lower for x in invalid_phrases):
        return ""

    return text


def main():
    model_name = sys.argv[1] if len(sys.argv) > 1 else "base.en"

    model_dir = (
        sys.argv[2]
        if len(sys.argv) > 2
        else os.path.join(os.getcwd(), ".whisper-models")
    )

    initial_prompt = (
        sys.argv[3]
        if len(sys.argv) > 3
        else os.environ.get("WHISPER_INITIAL_PROMPT", "")
    )

    device = (
        os.environ.get("WHISPER_DEVICE")
        or ("cuda" if torch.cuda.is_available() else
            "mps" if torch.backends.mps.is_available() else "cpu")
    )

    emit_stderr({
        "status": "loading",
        "model": model_name,
        "device": device,
        "initial_prompt_chars": len(initial_prompt)
    })

    try:
        model = whisper.load_model(
            model_name,
            download_root=model_dir,
            device=device
        )
    except Exception as exc:
        emit_stderr({
            "status": "error",
            "error": str(exc)
        })
        sys.exit(1)

    emit_stderr({
        "status": "ready",
        "model": model_name,
        "device": device,
        "initial_prompt_chars": len(initial_prompt)
    })

    stdin = sys.stdin.buffer

    pending = bytearray()

    pre_roll = collections.deque(
        maxlen=PRE_ROLL_FRAMES
    )

    utterance = bytearray()

    speaking = False
    voiced_frames = 0
    trailing_silence_frames = 0
    utterance_frames = 0

    # Adaptive room-noise estimate.
    # Your measured idle mic RMS is around 0.015-0.020, while actual
    # speech produced much larger peaks.
    noise_floor = 0.015

    def reset_utterance():
        nonlocal speaking
        nonlocal voiced_frames
        nonlocal trailing_silence_frames
        nonlocal utterance_frames
        nonlocal utterance

        speaking = False
        voiced_frames = 0
        trailing_silence_frames = 0
        utterance_frames = 0
        utterance = bytearray()

    def finalize():
        nonlocal utterance

        if voiced_frames < MIN_SPEECH_FRAMES:
            reset_utterance()
            return

        try:
            text = transcribe_utterance(
                model,
                utterance,
                initial_prompt
            )

            if text:
                emit_stdout({
                    "type": "final",
                    "text": text,
                    "speech_ms": voiced_frames * FRAME_MS,
                    "audio_ms": utterance_frames * FRAME_MS
                })

        except Exception as exc:
            emit_stderr({
                "status": "transcription_error",
                "error": str(exc)
            })

        reset_utterance()

    while True:
        try:
            chunk = stdin.read(3200)

            if not chunk:
                continue

            pending.extend(chunk)

            # Normalize arbitrary renderer writes into exact 20 ms
            # 640-byte frames.
            while len(pending) >= BYTES_PER_FRAME:
                frame = bytes(pending[:BYTES_PER_FRAME])
                del pending[:BYTES_PER_FRAME]

                energy = rms_int16(frame)

                if not speaking:
                    # Slowly learn quiet-room background energy only while
                    # we are not inside an utterance.
                    capped = min(energy, 0.025)
                    noise_floor = (
                        noise_floor * 0.985
                        + capped * 0.015
                    )

                enter_threshold = max(
                    0.024,
                    noise_floor * 1.55
                )

                exit_threshold = max(
                    0.018,
                    noise_floor * 1.20
                )

                if not speaking:
                    pre_roll.append(frame)

                    if energy >= enter_threshold:
                        speaking = True
                        trailing_silence_frames = 0
                        voiced_frames = 1

                        # Include ~300ms before detected onset so first
                        # syllables are not clipped.
                        for pre in pre_roll:
                            utterance.extend(pre)

                        utterance_frames = len(pre_roll)
                        pre_roll.clear()

                        emit_stderr({
                            "status": "speech_start",
                            "rms": round(energy, 4),
                            "noise_floor": round(noise_floor, 4),
                            "threshold": round(enter_threshold, 4)
                        })

                    continue

                # Already speaking
                utterance.extend(frame)
                utterance_frames += 1

                if energy >= exit_threshold:
                    voiced_frames += 1
                    trailing_silence_frames = 0
                else:
                    trailing_silence_frames += 1

                should_finalize = (
                    trailing_silence_frames >= END_SILENCE_FRAMES
                    or utterance_frames >= MAX_UTTERANCE_FRAMES
                )

                if should_finalize:
                    emit_stderr({
                        "status": "speech_end",
                        "speech_ms": voiced_frames * FRAME_MS,
                        "audio_ms": utterance_frames * FRAME_MS,
                        "trailing_silence_ms":
                            trailing_silence_frames * FRAME_MS
                    })

                    finalize()

        except KeyboardInterrupt:
            break

        except Exception as exc:
            emit_stderr({
                "status": "error",
                "error": str(exc)
            })


if __name__ == "__main__":
    main()
