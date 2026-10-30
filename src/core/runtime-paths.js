const fs = require('fs');
const path = require('path');

function getUserDataDir() {
  try {
    const electron = require('electron');
    if (electron && electron.app && typeof electron.app.getPath === 'function') {
      return electron.app.getPath('userData');
    }
  } catch (_) { /* Running outside Electron, such as an offline unit test. */ }
  return null;
}

function sourceRoot() {
  return path.resolve(__dirname, '../..');
}

function resolveRuntimePython(platform = process.platform) {
  if (process.env.OPENCLUELY_PYTHON) return process.env.OPENCLUELY_PYTHON;
  const relative = platform === 'win32'
    ? path.join('.venv-whisper', 'Scripts', 'python.exe')
    : path.join('.venv-whisper', 'bin', 'python');
  const local = path.join(sourceRoot(), relative);
  if (fs.existsSync(local)) return local;
  const userData = getUserDataDir();
  return userData ? path.join(userData, relative) : local;
}

function resolveModelDir() {
  if (process.env.WHISPER_MODEL_DIR && path.isAbsolute(process.env.WHISPER_MODEL_DIR)) {
    return process.env.WHISPER_MODEL_DIR;
  }
  const local = path.join(sourceRoot(), '.whisper-models');
  if (fs.existsSync(local)) return local;
  const userData = getUserDataDir();
  return userData ? path.join(userData, '.whisper-models') : local;
}

function resolveNativeScript(filename) {
  const script = path.join(__dirname, '..', 'native', filename);
  return script.replace(/app\.asar([/\\])/, 'app.asar.unpacked$1');
}

module.exports = { resolveRuntimePython, resolveModelDir, resolveNativeScript };
