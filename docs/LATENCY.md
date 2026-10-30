# Measuring latency on your computer

The application stages are capture → silence endpoint → Whisper transcription → question detection/retrieval → Ollama first token → completed answer. Startup separately loads two models. The README reports component timings observed on one Apple M2 with 8 GB RAM; Windows hardware remains unmeasured.

## Language model

Start Ollama and ensure `qwen3:1.7b` is installed. From the repository root:

```bash
node scripts/measure-ollama-latency.js
```

This runs a fictional, context-grounded prompt three times, reporting first-token and complete-answer latency. The first run can include model load. The model should stay warm for the next two runs. No private brief or transcript is sent.

## Speech model

Prepare a non-sensitive 16 kHz mono signed 16-bit PCM WAV recording of a spoken question. On macOS, one way is:

```bash
say -o sample.aiff 'Can you explain the technology in this project?'
ffmpeg -i sample.aiff -ar 16000 -ac 1 -c:a pcm_s16le sample.wav
.venv-whisper/bin/python scripts/measure-whisper-latency.py sample.wav
```

On Windows, record a short sample using a tool of your choice, convert it to the format above if needed, then run:

```powershell
.\.venv-whisper\Scripts\python.exe scripts\measure-whisper-latency.py sample.wav
```

The script reports model load and three transcription runs. It does not print the recognized words. Delete the sample when finished if it contains private speech.

## Reading the results

The worker's current silence endpoint is 280 ms after speech, in 20 ms frames. That is a configured delay, not a measured operating-system delay. Full live-call latency also includes audio-device buffers, scheduling, brief lookup and UI updates. A 5-second question takes 5 seconds to speak before any post-speech latency starts. On Windows, SoundCard/WASAPI can add variable buffering depending on the device and driver. A real end-to-end hardware test is required to make a latency claim for a specific Windows machine.

For hardware planning, the official Whisper `base.en` model table estimates about 1 GB of GPU memory. Ollama lists the Qwen3 1.7B model download at about 1.4 GB. Runtime memory is larger than download size; keep enough free memory for Electron, Python/PyTorch and other open applications.
