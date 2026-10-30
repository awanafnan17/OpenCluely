# Troubleshooting

| Symptom | What to check |
|---|---|
| Ollama not running | Open Ollama or run `ollama serve`; check `ollama list` and port 11434 |
| Model missing | Run `ollama pull qwen3:1.7b`, then refresh the status |
| Whisper exits immediately | Check `.venv-whisper/bin/python` exists and can `import whisper` |
| Whisper readiness timeout | Pre-download `base.en` using the README command; first download may exceed 35 seconds |
| MPS errors | Retry with `WHISPER_DEVICE=cpu npm start`; CPU may be slower |
| No transcript | Confirm BlackHole is installed, the Multi-Output Device is selected, audio is actually playing and FFmpeg is on PATH |
| No audible meeting sound | Include headphones/speakers in the Multi-Output Device; BlackHole alone does not play sound |
| Microphone/screenshot permission denied | Grant the relevant macOS Privacy & Security permission and fully restart the app |
| Unrelated answer | Confirm the correct brief is loaded, test a typed question, and end/purge before switching contexts |
| Optional cloud request fails | Check the selected provider, current model availability and your locally configured key |
| App launches as a Node process | Use `npm start`, which removes `ELECTRON_RUN_AS_NODE` |

## Manual smoke test

Use a synthetic brief and a short sample recording. Confirm (1) local model ready, (2) brief heading count populated, (3) typed question grounded in the brief, (4) audio-frame activity, (5) partial/final transcript, (6) answer streaming and (7) successful end/purge. Do not use a live client call as the first installation test.

## Test scope

`npm test` covers offline Markdown retrieval and call-brief lifecycle. Live model checks need Ollama; Electron/Playwright checks need an interactive desktop; audio checks need permissions and correctly routed sound. Existing scripts may depend on specific local runtime conditions and are not all a portable CI suite. Report failures with redacted messages and versions; do not attach private briefs or raw logs.
