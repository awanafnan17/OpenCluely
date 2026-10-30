# Architecture

## Process boundaries

`main.js` coordinates Electron lifecycle, IPC, provider calls and the live-call state machine. Renderer code accesses the application through `preload.js`; the window configuration disables Node integration and enables context isolation. The Python transcription process receives raw audio through stdin and emits JSON messages on stdout; stderr carries readiness/error events.

## Audio and transcription

`blackhole-audio.service.js` enumerates AVFoundation devices through FFmpeg, chooses BlackHole and emits normalized PCM frames. It tracks frame count, bytes, RMS energy and stalled/recovered events. `streaming-transcription.service.js` starts one Python worker, removes Electron/Node-specific environment variables from that child's environment, waits for readiness, forwards frames, and relays partial/final transcripts. Its default startup deadline is 35 seconds.

`whisper_streaming_worker.py` loads OpenAI Whisper `base.en` once, selects a supported compute device, and processes rolling speech windows. `WHISPER_DEVICE` can request CPU or MPS. The project integrates Whisper; it does not contain custom-trained speech weights. Audio quality and speech-window settings influence latency and accuracy.

A Swift ScreenCaptureKit helper and `sck-audio.service.js` remain in the source as an alternate capture path. The current main live-call flow uses BlackHole. No precompiled helper is distributed.

## Brief retrieval and grounding

`call-brief.manager.js` accepts Markdown files up to 2 MB, holds their content in memory, derives vocabulary hints, and creates instructions based on the chosen length/style. Without a brief it selects a neutral prompt. `local-retrieval.service.js` parses headings and ranks sections with lexical/keyword matching. Restricted-claim sections are prioritized so the response can preserve boundaries from the brief. This is local retrieval, not an embedding database.

Question detection and context assembly combine the transcript with relevant brief sections. The brief manager explicitly instructs the model to avoid unsupported project/technology claims; instruction following is not a factuality guarantee.

## Local model inference

`ollama.service.js` talks only to localhost on port 11434. It prefers `qwen3:1.7b-q4_K_M`, then `qwen3:1.7b`, then another matching 1.7B Qwen tag, then the first installed model. Inspect the status UI because an available fallback may differ from the intended model. Requests disable thinking, use streamed chat output, set a 2,048-token context by default and keep the model warm during the call. The service supports canceling an in-flight generation.

## State and data lifecycle

Session history, answer settings and active brief state are coordinated by the managers. End-call/purge clears the active in-memory context. Source brief files remain on disk. Logger output can persist independently and may contain conversation text. Optional cloud features have a separate data path, described in SECURITY.md.

## Areas still needing release work

Cross-platform audio abstraction, reproducible Python dependency pinning, packaged model installation, app signing/notarization, real-device regression coverage, and a review of transcript logging/retention. This repository is a documented development snapshot, not a claim that these are already complete.
