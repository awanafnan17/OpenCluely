# Models and configuration

Copy `env.example` to `.env`. Never commit `.env` or real provider keys.

| Setting / component | Current behavior |
|---|---|
| Ollama endpoint | Fixed local `127.0.0.1:11434` in `src/services/ollama.service.js` |
| Local LLM preference | `qwen3:1.7b-q4_K_M`, then `qwen3:1.7b`, then installed fallback |
| Live-call Whisper | `base.en`, selected in `main.js` and the streaming service |
| Live worker Python | macOS `.venv-whisper/bin/python`; Windows `.venv-whisper/Scripts/python.exe` |
| Live model directory | Repository-local `.whisper-models` |
| `WHISPER_DEVICE` | Optional `cpu`, `mps` or `cuda` override for the streaming worker |
| `WHISPER_INITIAL_PROMPT` | Vocabulary hint; the selected brief may supply it automatically |
| `SPEECH_PROVIDER` | Legacy speech route: `whisper` or `azure` |
| `WHISPER_COMMAND` | Executable for the legacy microphone transcription route |
| `WHISPER_MODEL` | Legacy microphone route model; default `turbo`, not the live-call model |
| `WHISPER_LANGUAGE` | Legacy route language, default `en` |
| `WHISPER_SEGMENT_MS` | Legacy segmentation limit, default `4000` |
| `GEMINI_API_KEY` | Optional Gemini text/image assistance credential |
| `AZURE_SPEECH_KEY`, `AZURE_SPEECH_REGION` | Optional Azure Speech credentials |

The source's Gemini configuration currently lists `gemini-3.1-flash-lite`, with `gemini-2.5-flash-lite` and `gemini-3.5-flash` fallbacks. These are **identifiers present in this source snapshot**, not an assertion that every identifier is available to your account. Verify availability with the provider before enabling the optional cloud path; edit `src/core/config.js` when necessary.

The local Qwen/Whisper workflow does not use an API key. Downloaded model weights are not included in Git. Dependencies declared in `package.json`/`package-lock.json` describe the Node installation; Python installation is currently documented rather than fully pinned.

## Experimental ScreenCaptureKit helper

On a compatible macOS/Xcode Command Line Tools installation, the Swift source can be compiled locally:

```bash
mkdir -p bin
swiftc src/native/sck_audio_capturer.swift -o bin/sck_audio_capturer -framework ScreenCaptureKit -framework AVFoundation -framework CoreMedia -framework CoreAudio
```

This does not switch the main live-call flow away from BlackHole or establish compatibility on every macOS version.
