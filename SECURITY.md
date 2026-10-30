# Privacy and security

This public source snapshot intentionally excludes `.env`, provider credentials, database contents, conversation exports, recordings, private briefs, logs, backups, model weights, generated builds and the original Git history. Only fictional fixtures are included.

## Runtime data

The local call flow sends audio to a local Whisper process and brief/transcript context to local Ollama. Optional Gemini and Azure integrations send the selected content to their providers. Choosing a local model does not make every feature offline. Initial model/package downloads need internet access.

The app's logging calls can include transcription text, prompts, model replies and local filenames. Review logging and retention before using sensitive content. End Call & Purge clears in-memory session context; it does not erase source brief files, logs, provider records or operating-system traces. Settings may write credentials into local `.env`; keep the file private.

Use capture and assistance only with appropriate participant permission and in accordance with the meeting or assessment rules. Screenshot exclusion/content protection is platform-dependent and is not a guarantee of invisibility.

## Contributing safely

Never submit API keys, `.env`, raw logs, private briefs, recordings, browser/session data, database dumps, or model weights. Use synthetic examples. Run a secret scan before committing. If a real credential is exposed, revoke/rotate it with its provider; deleting a file is not sufficient.

Report vulnerabilities privately using GitHub's private vulnerability reporting if enabled; otherwise request a private reporting channel without posting sensitive exploit or credential details in a public issue.
