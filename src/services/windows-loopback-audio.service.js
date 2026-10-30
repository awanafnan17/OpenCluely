const { spawn } = require('child_process');
const EventEmitter = require('events');
const { resolveRuntimePython, resolveNativeScript } = require('../core/runtime-paths');

const FRAME_BYTES = 640; // 20 ms of mono 16 kHz signed 16-bit PCM.

class WindowsLoopbackAudioService extends EventEmitter {
  constructor(options = {}) {
    super();
    this.platform = options.platform || process.platform;
    this.spawnProcess = options.spawnProcess || spawn;
    this.process = null;
    this.buffer = Buffer.alloc(0);
    this.frames = 0;
  }

  startCapture() {
    if (this.platform !== 'win32') {
      return Promise.reject(new Error('WASAPI loopback capture requires Windows.'));
    }
    if (this.process) {
      return Promise.reject(new Error('WASAPI loopback capture is already running.'));
    }

    const python = resolveRuntimePython('win32');
    const worker = resolveNativeScript('windows_loopback_worker.py');
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;

    this.buffer = Buffer.alloc(0);
    this.frames = 0;

    return new Promise((resolve, reject) => {
      let settled = false;
      let lastError = '';
      let stderrBuffer = '';
      const finish = (error, source) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) {
          this.stopCapture();
          reject(error);
        } else {
          resolve({ success: true, source: { type: 'windows-loopback', name: source || 'Default speaker (WASAPI)' } });
        }
      };
      const timer = setTimeout(() => finish(new Error(lastError || 'No speaker audio reached the app within 10 seconds. Play sample audio and check the default output device.')), 10000);

      this.process = this.spawnProcess(python, [worker], { stdio: ['ignore', 'pipe', 'pipe'], env });
      this.process.on('error', error => finish(new Error(`Could not start Windows audio worker: ${error.message}`)));
      this.process.on('exit', (code) => {
        this.process = null;
        if (!settled) finish(new Error(lastError || `Windows audio worker exited with code ${code}`));
        else this.emit('status', { capturing: false, code });
      });

      this.process.stderr.on('data', chunk => {
        stderrBuffer += chunk.toString('utf8');
        const lines = stderrBuffer.split('\n');
        stderrBuffer = lines.pop();
        for (const line of lines) {
          try {
            const message = JSON.parse(line);
            if (message.status === 'error') lastError = message.error;
          } catch (_) { /* Diagnostics are optional. */ }
        }
      });

      this.process.stdout.on('data', chunk => {
        this.buffer = Buffer.concat([this.buffer, chunk]);
        while (this.buffer.length >= FRAME_BYTES) {
          const pcm = this.buffer.subarray(0, FRAME_BYTES);
          this.buffer = this.buffer.subarray(FRAME_BYTES);
          let energy = 0;
          for (let i = 0; i < FRAME_BYTES; i += 2) {
            const sample = pcm.readInt16LE(i) / 32768;
            energy += sample * sample;
          }
          this.frames += 1;
          this.emit('audio-frame', { pcm, rms: Math.sqrt(energy / (FRAME_BYTES / 2)) });
        }
        if (this.frames >= 5) finish(null, 'Default speaker (WASAPI)');
      });
    });
  }

  stopCapture() {
    const child = this.process;
    this.process = null;
    if (child) child.kill();
    this.buffer = Buffer.alloc(0);
    this.frames = 0;
  }
}

module.exports = new WindowsLoopbackAudioService();
module.exports.WindowsLoopbackAudioService = WindowsLoopbackAudioService;
