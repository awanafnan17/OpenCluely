param(
    [string]$PythonVersion = '3.11'
)

$ErrorActionPreference = 'Stop'
Set-Location (Split-Path -Parent $PSScriptRoot)

if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
    throw 'Node.js/npm is missing. Install Node.js 22 LTS, reopen PowerShell, and retry.'
}
if (-not (Get-Command py -ErrorAction SilentlyContinue)) {
    throw 'Python Launcher is missing. Install Python 3.11 with the launcher enabled.'
}
if (-not (Get-Command ollama -ErrorAction SilentlyContinue)) {
    throw 'Ollama is missing. Install Ollama for Windows and reopen PowerShell.'
}

npm ci
if ($LASTEXITCODE -ne 0) { throw 'npm ci failed.' }

if (-not (Test-Path '.env')) { Copy-Item 'env.example' '.env' }

& py "-$PythonVersion" -m venv '.venv-whisper'
if ($LASTEXITCODE -ne 0) { throw 'Could not create the Python environment.' }
$python = Join-Path (Get-Location) '.venv-whisper\Scripts\python.exe'
& $python -m pip install --upgrade pip
if ($LASTEXITCODE -ne 0) { throw 'pip upgrade failed.' }
& $python -m pip install 'openai-whisper' 'soundcard==0.4.6'
if ($LASTEXITCODE -ne 0) { throw 'Whisper or Windows audio dependency installation failed.' }

& ollama pull 'qwen3:1.7b'
if ($LASTEXITCODE -ne 0) { throw 'Could not download the local language model.' }

& $python -c "import whisper; whisper.load_model('base.en', device='cpu', download_root='.whisper-models')"
if ($LASTEXITCODE -ne 0) { throw 'Could not download the speech model.' }

Write-Host 'Setup complete. Start Ollama, then run: npm start'
