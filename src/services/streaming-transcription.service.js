const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const EventEmitter = require('events');
const logger = require('./speech.service').logger || console;

class StreamingTranscriptionService extends EventEmitter {
  constructor() {
    super();
    this.workerProcess = null;
    this.isReady = false;
    this.pythonPath = process.platform === 'win32'
      ? path.join(__dirname, '../../.venv-whisper/Scripts/python.exe')
      : path.join(__dirname, '../../.venv-whisper/bin/python');
    this.workerScript = path.join(__dirname, '../native/whisper_streaming_worker.py');
    this.modelDir = path.join(__dirname, '../../.whisper-models');
    this.activeModel = 'base.en';
  }

  buildSanitizedEnv() {
    const cleanEnv = { ...process.env };
    const varsToRemove = [
      'NODE_OPTIONS',
      'ELECTRON_RUN_AS_NODE',
      'ELECTRON_ENABLE_LOGGING',
      'ELECTRON_ENABLE_STACK_DUMPING',
      'NODE_INSPECT_RESUME_ON_START',
      'VSCODE_INSPECTOR_OPTIONS',
      'ELECTRON_NO_ATTACH_CONSOLE',
      'NODE_ENV_CONFIG'
    ];
    for (const key of varsToRemove) {
      delete cleanEnv[key];
    }
    return cleanEnv;
  }

  async startWorker(modelName = 'base.en', initialPrompt = '') {
    if (this.workerProcess) {
      if (this.activeModel === modelName) {
        logger.info('[STREAMING-WHISPER] Worker already active', { model: modelName });
        return { success: true, model: modelName };
      }
      this.stopWorker();
    }

    this.stopWorker();
    this.activeModel = modelName;
    this.isReady = false;

    logger.info('[STREAMING-WHISPER] Starting persistent PyTorch/Whisper worker...', {
      python: this.pythonPath,
      model: modelName,
      initialPrompt,
      device: process.env.WHISPER_DEVICE || 'mps'
    });

    return new Promise((resolve, reject) => {
      let isResolved = false;

      const cleanupAndReject = (message) => {
        if (isResolved) return;
        isResolved = true;
        this.stopWorker();
        reject(new Error(message));
      };

      // Timeout safety for model startup (35s max)
      const startupTimer = setTimeout(() => {
        if (!isResolved) {
          logger.warn('[STREAMING-WHISPER] Startup timeout waiting for ready signal');
          cleanupAndReject('Whisper streaming worker startup timed out waiting for ready signal (35s).');
        }
      }, 35000);

      try {
        const childEnv = this.buildSanitizedEnv();
        if (initialPrompt) childEnv.WHISPER_INITIAL_PROMPT = initialPrompt;
        this.workerProcess = spawn(this.pythonPath, [this.workerScript, modelName, this.modelDir, initialPrompt], {
          stdio: ['pipe', 'pipe', 'pipe'],
          env: childEnv
        });
      } catch (spawnErr) {
        clearTimeout(startupTimer);
        return cleanupAndReject(`Failed to spawn Whisper worker: ${spawnErr.message}`);
      }

      this.workerProcess.on('error', (procErr) => {
        logger.error('[STREAMING-WHISPER] Process error:', procErr);
        clearTimeout(startupTimer);
        cleanupAndReject(`Whisper process error: ${procErr.message}`);
      });

      let lineBuf = '';
      this.workerProcess.stdout.on('data', (chunk) => {
        lineBuf += chunk.toString('utf-8');
        const lines = lineBuf.split('\n');
        lineBuf = lines.pop(); // keep last incomplete snippet

        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const payload = JSON.parse(line.trim());
            if (payload.type === 'partial') {
              this.emit('partial-transcript', payload.text);
            } else if (payload.type === 'final') {
              this.emit('final-transcript', payload.text);
            }
          } catch (e) {
            logger.warn('[STREAMING-WHISPER] JSON parse error on worker stdout', { line: line.trim() });
          }
        }
      });

      this.workerProcess.stdout.on('error', (sErr) => {
        logger.warn('[STREAMING-WHISPER] stdout error:', sErr.message);
      });

      this.workerProcess.stderr.on('data', (chunk) => {
        const lines = chunk.toString('utf-8').split('\n');
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const statusObj = JSON.parse(line.trim());
            if (statusObj.status === 'ready') {
              if (!isResolved) {
                isResolved = true;
                clearTimeout(startupTimer);
                this.isReady = true;
                logger.info('[STREAMING-WHISPER] Worker ready and model loaded into MPS RAM!', statusObj);
                resolve(true);
              }
            } else if (statusObj.status === 'error') {
              logger.error('[STREAMING-WHISPER] Worker reported error', statusObj);
              clearTimeout(startupTimer);
              cleanupAndReject(statusObj.error || 'Whisper worker reported error');
            }
          } catch (_) {
            logger.debug('[STREAMING-WHISPER-STDERR]', line.trim());
          }
        }
      });

      this.workerProcess.stderr.on('error', (eErr) => {
        logger.warn('[STREAMING-WHISPER] stderr error:', eErr.message);
      });

      this.workerProcess.on('exit', (code, signal) => {
        logger.info('[STREAMING-WHISPER] Worker process exited', { code, signal });
        this.isReady = false;
        this.workerProcess = null;
        if (!isResolved) {
          clearTimeout(startupTimer);
          cleanupAndReject(`Whisper worker exited prematurely with code ${code}`);
        }
      });
    });
  }

  feedAudioFrame(pcmBuffer) {
    if (!this.workerProcess || !this.isReady || !this.workerProcess.stdin.writable) {
      return false;
    }
    try {
      this.workerProcess.stdin.write(pcmBuffer);
      return true;
    } catch (err) {
      logger.error('[STREAMING-WHISPER] Error writing PCM frame to worker stdin', { error: err.message });
      return false;
    }
  }

  stopWorker() {
    if (this.workerProcess) {
      logger.info('[STREAMING-WHISPER] Stopping persistent worker');
      this.isReady = false;
      try {
        this.workerProcess.kill('SIGINT');
      } catch (_) {}
      this.workerProcess = null;
    }
  }
}

module.exports = new StreamingTranscriptionService();
