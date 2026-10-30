const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const EventEmitter = require('events');
const logger = require('./speech.service').logger || console;

/**
 * Native ScreenCaptureKit System Audio Service
 * Spawns native Swift executable helper `bin/sck_audio_capturer` to capture system/app audio streams.
 */
class SCKAudioService extends EventEmitter {
  constructor() {
    super();
    this.binaryPath = path.join(__dirname, '../../bin/sck_audio_capturer');
    this.process = null;
    this.isCapturing = false;
    this.selectedSource = null;
    this.sckReady = false;
    this.firstPcmReceived = false;
    this.bufferRemainder = Buffer.alloc(0);

    // Audio Health Metrics
    this.metrics = {
      sckFrames: 0,
      pcmBytes: 0,
      whisperChunks: 0,
      lastPcmTimestamp: null
    };

    this.healthInterval = null;
  }

  isAvailable() {
    return process.platform === 'darwin' && fs.existsSync(this.binaryPath);
  }

  /**
   * List shareable applications using native helper `--list-apps`
   */
  async getShareableApps(timeoutMs = 5000) {
    if (!this.isAvailable()) {
      return { success: false, code: 'SCK_NOT_AVAILABLE', apps: [], error: 'ScreenCaptureKit binary not available' };
    }

    return new Promise((resolve) => {
      let isDone = false;
      let stdoutBuffer = '';

      const childEnv = { ...process.env };
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
        delete childEnv[key];
      }

      let child;
      try {
        child = spawn(this.binaryPath, ['--list-apps'], {
          stdio: ['ignore', 'pipe', 'pipe'],
          env: childEnv
        });
      } catch (err) {
        return resolve({ success: false, code: 'SPAWN_FAILED', apps: [], error: err.message });
      }

      const timer = setTimeout(() => {
        if (!isDone) {
          isDone = true;
          logger.warn(`[SCK] --list-apps process (pid=${child.pid}) timed out after ${timeoutMs}ms`);
          try { child.kill('SIGKILL'); } catch (_) {}
          resolve({ success: false, code: 'TIMEOUT', apps: [], error: 'Listing apps timed out' });
        }
      }, timeoutMs);

      child.stdout.on('data', (chunk) => {
        stdoutBuffer += chunk.toString('utf-8');
      });

      child.stderr.on('data', (chunk) => {
        logger.debug('[SCK-LIST-STDERR]', chunk.toString('utf-8').trim());
      });

      child.on('error', (err) => {
        if (!isDone) {
          isDone = true;
          clearTimeout(timer);
          resolve({ success: false, code: 'PROCESS_ERROR', apps: [], error: err.message });
        }
      });

      child.on('close', (code) => {
        if (isDone) return;
        isDone = true;
        clearTimeout(timer);

        try {
          const trimmed = stdoutBuffer.trim();
          if (!trimmed) {
            return resolve({ success: false, code: 'EMPTY_OUTPUT', apps: [], error: 'Empty output from list-apps' });
          }

          const parsed = JSON.parse(trimmed);

          if (!parsed.success) {
            const errCode = parsed.code || 'SCREEN_CAPTURE_PERMISSION_DENIED';
            return resolve({
              success: false,
              code: errCode,
              apps: [],
              error: parsed.error || 'Failed to list applications'
            });
          }

          const rawApps = Array.isArray(parsed.apps) ? parsed.apps : [];
          const appMap = new Map();

          for (const item of rawApps) {
            const pidNum = parseInt(item.pid, 10);
            if (!isNaN(pidNum) && pidNum > 0) {
              const nameStr = item.name ? item.name.toString().trim() : '';
              const bundleId = item.bundleIdentifier ? item.bundleIdentifier.toString().trim() : '';
              if (nameStr && !appMap.has(pidNum)) {
                appMap.set(pidNum, {
                  pid: pidNum,
                  name: nameStr,
                  bundleIdentifier: bundleId
                });
              }
            }
          }

          const apps = Array.from(appMap.values()).sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));

          const chromeApp = apps.find(a => a.name.toLowerCase().includes('chrome') || (a.bundleIdentifier && a.bundleIdentifier.includes('Chrome')));
          const chromePidStr = chromeApp ? `PID ${chromeApp.pid}` : 'Not running';
          logger.info(`[SCK] getShareableApps: found ${apps.length} applications (Google Chrome: ${chromePidStr})`);

          resolve({
            success: true,
            apps: apps
          });
        } catch (parseErr) {
          logger.error('[SCK] getShareableApps JSON parse error:', parseErr.message, { stdout: stdoutBuffer });
          resolve({ success: false, code: 'PARSE_ERROR', apps: [], error: parseErr.message });
        }
      });
    });
  }

  resetState() {
    this.isCapturing = false;
    this.sckReady = false;
    this.firstPcmReceived = false;
    this.bufferRemainder = Buffer.alloc(0);
    this.selectedSource = null;
    this.metrics = {
      sckFrames: 0,
      pcmBytes: 0,
      whisperChunks: 0,
      lastPcmTimestamp: null
    };
    if (this.healthInterval) {
      clearInterval(this.healthInterval);
      this.healthInterval = null;
    }
  }

  /**
   * Start capture session with explicit SCK_READY + First PCM Handshakes
   */
  async startCapture(sourceOptions = {}) {
    if (this.isCapturing || this.process) {
      logger.warn('[SCK-AUDIO] SCK Capture already active or starting');
      return { success: true, source: this.selectedSource, message: 'Session already active' };
    }

    if (!this.isAvailable()) {
      const err = new Error('ScreenCaptureKit binary not compiled or incompatible OS platform');
      err.code = 'SCK_NOT_AVAILABLE';
      throw err;
    }

    this.resetState();

    const args = [];
    if (sourceOptions.pid) {
      const targetPid = parseInt(sourceOptions.pid, 10);
      if (!isNaN(targetPid) && targetPid > 0) {
        args.push('--pid', targetPid.toString());
        this.selectedSource = { type: 'sck', name: sourceOptions.name || `Application PID ${targetPid}`, pid: targetPid };
      } else {
        this.selectedSource = { type: 'sck', name: 'Primary Display Audio (ScreenCaptureKit)' };
      }
    } else {
      this.selectedSource = { type: 'sck', name: sourceOptions.name || 'Primary Display Audio (ScreenCaptureKit)' };
    }

    logger.info('[SCK] spawning helper', { args, source: this.selectedSource, binary: this.binaryPath });

    return new Promise((resolve, reject) => {
      let isResolved = false;

      const cleanupAndReject = (code, message) => {
        if (isResolved) return;
        isResolved = true;
        this.stopCapture();
        const errObj = new Error(message);
        errObj.code = code;
        reject(errObj);
      };

      // Controlled 15-second watchdog timer for SCK_READY + First PCM proof
      const startupTimer = setTimeout(() => {
        if (!isResolved) {
          if (!this.sckReady) {
            cleanupAndReject('SCK_START_TIMEOUT', 'ScreenCaptureKit helper process failed to emit SCK_READY handshake within 15s.');
          } else if (!this.firstPcmReceived) {
            cleanupAndReject('PCM_START_TIMEOUT', 'ScreenCaptureKit stream started, but no PCM audio frames received within 15s.');
          } else {
            cleanupAndReject('SCK_STARTUP_TIMEOUT', 'ScreenCaptureKit session startup timed out.');
          }
        }
      }, 15000);

      const childEnv = { ...process.env };
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
        delete childEnv[key];
      }

      try {
        this.process = spawn(this.binaryPath, args, {
          stdio: ['ignore', 'pipe', 'pipe'],
          env: childEnv
        });
      } catch (spawnErr) {
        clearTimeout(startupTimer);
        return cleanupAndReject('HELPER_SPAWN_FAILED', `Failed to spawn SCK binary: ${spawnErr.message}`);
      }

      logger.info(`[SCK] pid=${this.process.pid} target=${this.selectedSource.name}`);

      this.process.on('error', (procErr) => {
        logger.error('[SCK] process emitted error:', procErr);
        if (!isResolved) {
          clearTimeout(startupTimer);
          cleanupAndReject('HELPER_PROCESS_ERROR', procErr.message);
        } else {
          this.emit('status', { capturing: false, error: procErr.message });
          this.stopCapture();
        }
      });

      this.process.on('exit', (code, signal) => {
        logger.warn('[SCK] helper exit', { code, signal, pid: this.process ? this.process.pid : null });
        this.isCapturing = false;
        if (!isResolved) {
          clearTimeout(startupTimer);
          cleanupAndReject('HELPER_EARLY_EXIT', `Native ScreenCaptureKit helper process exited prematurely with code=${code} signal=${signal}`);
        } else {
          this.emit('status', { capturing: false, exitCode: code, signal });
        }
      });

      this.isCapturing = true;

      // Handle binary stdout frames
      this.process.stdout.on('data', (chunk) => {
        this._handleStdoutData(chunk, (frameInfo) => {
          if (!this.firstPcmReceived) {
            this.firstPcmReceived = true;
            logger.info(`[SCK] first PCM received seq=${frameInfo.sequenceNum} bytes=${frameInfo.bytes}`);
          }
          // AUDIO_STREAM_HEALTHY GATE: Require sckReady === true AND at least 5 frames received continuously!
          if (this.sckReady && this.firstPcmReceived && this.metrics.sckFrames >= 5 && !isResolved) {
            isResolved = true;
            clearTimeout(startupTimer);
            this.startHealthMetricsLogging();
            this.emit('status', { capturing: true, source: this.selectedSource.name });
            resolve({
              success: true,
              source: this.selectedSource,
              firstFrameSequence: frameInfo.sequenceNum,
              firstFrameBytes: frameInfo.bytes
            });
          }
        });
      });

      this.process.stdout.on('error', (sErr) => {
        logger.warn('[SCK] stdout stream error:', sErr.message);
      });

      // Handle stderr JSON diagnostics
      this.process.stderr.on('data', (data) => {
        const lines = data.toString('utf-8').split('\n');
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const diag = JSON.parse(line.trim());
            logger.info('[SCK-NATIVE-LOG]', diag);

            if (diag.status === 'SCK_READY') {
              this.sckReady = true;
              logger.info(`[SCK] SCK_READY handshake received from native helper (pid=${this.process ? this.process.pid : 'unknown'})`);
              if (this.sckReady && this.firstPcmReceived && this.metrics.sckFrames >= 5 && !isResolved) {
                isResolved = true;
                clearTimeout(startupTimer);
                this.startHealthMetricsLogging();
                this.emit('status', { capturing: true, source: this.selectedSource.name });
                resolve({
                  success: true,
                  source: this.selectedSource
                });
              }
            } else if (diag.status === 'AUDIO_CALLBACK_STALLED') {
              this.emit('audio-stalled', { ageMs: diag.ageMs || 2500 });
            } else if (diag.status === 'permission-denied') {
              clearTimeout(startupTimer);
              cleanupAndReject('SCREEN_CAPTURE_PERMISSION_DENIED', 'Screen & System Audio Recording permission is required.');
            } else if (diag.status === 'error') {
              clearTimeout(startupTimer);
              cleanupAndReject('SCK_HELPER_ERROR', diag.msg || 'Native SCK helper reported error.');
            }
          } catch (_) {
            logger.debug('[SCK-NATIVE-STDERR]', line.trim());
          }
        }
      });
    });
  }

  startHealthMetricsLogging() {
    if (this.healthInterval) clearInterval(this.healthInterval);
    let isStalled = false;

    this.healthInterval = setInterval(() => {
      if (this.isCapturing) {
        logger.info(`[AUDIO-HEALTH] sckFrames=${this.metrics.sckFrames} pcmBytes=${this.metrics.pcmBytes} whisperChunks=${this.metrics.whisperChunks}`);
        const ageMs = this.metrics.lastPcmTimestamp ? Date.now() - this.metrics.lastPcmTimestamp : 999999;
        
        if (ageMs > 2500 && !isStalled && this.metrics.sckFrames > 0) {
          isStalled = true;
          logger.warn(`[SCK] AUDIO_STREAM_STALLED ageMs=${ageMs}`);
          this.emit('audio-stalled', { ageMs });
        } else if (ageMs <= 2500 && isStalled) {
          isStalled = false;
          logger.info('[SCK] AUDIO_STREAM_RECOVERED');
          this.emit('audio-recovered');
        }
      }
    }, 2000);
  }

  _handleStdoutData(chunk, onFirstFrame) {
    this.bufferRemainder = Buffer.concat([this.bufferRemainder, chunk]);

    while (this.bufferRemainder.length >= 16) {
      const payloadLen = this.bufferRemainder.readUInt32BE(0);
      const timestampNs = this.bufferRemainder.readBigUInt64BE(4);
      const sequenceNum = this.bufferRemainder.readUInt32BE(12);

      const totalPacketLen = 16 + payloadLen;
      if (this.bufferRemainder.length < totalPacketLen) break; // Incomplete packet

      const pcm = this.bufferRemainder.subarray(16, totalPacketLen);
      this.bufferRemainder = this.bufferRemainder.subarray(totalPacketLen);

      // RMS calculation for Node side audio validation
      let sumSq = 0;
      const sampleCount = pcm.length / 2;
      for (let i = 0; i < pcm.length; i += 2) {
        const val = pcm.readInt16LE(i) / 32768.0;
        sumSq += val * val;
      }
      const rms = sampleCount > 0 ? Math.sqrt(sumSq / sampleCount) : 0;

      this.metrics.sckFrames++;
      this.metrics.pcmBytes += pcm.length;
      this.metrics.lastPcmTimestamp = Date.now();

      if (sequenceNum <= 5 || sequenceNum % 50 == 0) {
        logger.info(`[SCK] frame seq=${sequenceNum} bytes=${pcm.length} rms=${rms.toFixed(4)}`);
      }

      onFirstFrame({ sequenceNum, bytes: pcm.length, timestampNs });
      this.emit('audio-frame', { pcm, sequenceNum, timestampNs, rms, sampleCount });
    }
  }

  recordWhisperChunkSubmitted() {
    this.metrics.whisperChunks++;
  }

  stopCapture() {
    logger.info('[SCK] Terminating ScreenCaptureKit helper process');
    if (this.healthInterval) {
      clearInterval(this.healthInterval);
      this.healthInterval = null;
    }
    if (this.process) {
      const proc = this.process;
      this.process = null;
      try { proc.kill('SIGTERM'); } catch (_) {}
      setTimeout(() => {
        try {
          if (!proc.killed) proc.kill('SIGKILL');
        } catch (_) {}
      }, 500);
    }
    this.resetState();
  }
}

module.exports = new SCKAudioService();
