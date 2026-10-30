const { spawn, execSync } = require('child_process');
const EventEmitter = require('events');
const logger = console;

class BlackHoleAudioService extends EventEmitter {
  constructor() {
    super();
    this.process = null;
    this.isCapturing = false;
    this.bufferRemainder = Buffer.alloc(0);
    this.sequenceNum = 0;
    this.deviceIndex = null;
    this.deviceName = 'BlackHole 2ch';
    
    this.metrics = {
      blackholeFrames: 0,
      blackholeBytes: 0,
      lastFrameTimestamp: 0,
      recentRms: 0,
      recentPeak: 0,
      signalSeenRecently: false
    };

    this.healthInterval = null;
  }

  /**
   * Dynamically discover AVFoundation audio index for BlackHole 2ch
   */
  discoverBlackHoleIndex() {
    try {
      const output = execSync('ffmpeg -hide_banner -f avfoundation -list_devices true -i "" 2>&1', {
        encoding: 'utf-8',
        timeout: 5000
      });

      const lines = output.split('\n');
      let inAudioSection = false;

      for (const line of lines) {
        if (line.includes('AVFoundation audio devices:')) {
          inAudioSection = true;
          continue;
        }
        if (inAudioSection && line.includes('AVFoundation video devices:')) {
          inAudioSection = false;
          continue;
        }

        if (inAudioSection && (line.includes('BlackHole 2ch') || line.includes('BlackHole'))) {
          const match = line.match(/\[(\d+)\]\s+BlackHole/i);
          if (match && match[1] !== undefined) {
            const index = parseInt(match[1], 10);
            logger.info(`[BLACKHOLE] Discovered BlackHole AVFoundation audio index: :${index}`);
            return index;
          }
        }
      }
    } catch (err) {
      // FFmpeg returns exit code 251 when listing devices, output is captured in stderr/stdout
      const output = (err.stdout || '') + (err.stderr || '');
      const lines = output.split('\n');
      let inAudioSection = false;

      for (const line of lines) {
        if (line.includes('AVFoundation audio devices:')) {
          inAudioSection = true;
          continue;
        }
        if (inAudioSection && line.includes('AVFoundation video devices:')) {
          inAudioSection = false;
          continue;
        }

        if (inAudioSection && (line.includes('BlackHole 2ch') || line.includes('BlackHole'))) {
          const match = line.match(/\[(\d+)\]\s+BlackHole/i);
          if (match && match[1] !== undefined) {
            const index = parseInt(match[1], 10);
            logger.info(`[BLACKHOLE] Discovered BlackHole AVFoundation audio index from err output: :${index}`);
            return index;
          }
        }
      }
    }

    logger.warn('[BLACKHOLE] Could not dynamically locate BlackHole 2ch in AVFoundation audio devices.');
    return null;
  }

  resetState() {
    this.bufferRemainder = Buffer.alloc(0);
    this.sequenceNum = 0;
    this.metrics = {
      blackholeFrames: 0,
      blackholeBytes: 0,
      lastFrameTimestamp: 0,
      recentRms: 0,
      recentPeak: 0,
      signalSeenRecently: false
    };
  }

  startCapture() {
    if (this.isCapturing) {
      logger.info('[BLACKHOLE] Capture session already running.');
      return Promise.resolve({ success: true, source: 'BlackHole 2ch' });
    }

    const index = this.discoverBlackHoleIndex();
    if (index === null) {
      const err = new Error('BlackHole 2ch audio device not found in AVFoundation. Please install BlackHole 2ch.');
      err.code = 'BLACKHOLE_NOT_FOUND';
      return Promise.reject(err);
    }

    this.deviceIndex = index;
    this.resetState();

    logger.info(`[BLACKHOLE] Spawning FFmpeg capture for AVFoundation audio index :${index}...`);

    return new Promise((resolve, reject) => {
      let isResolved = false;

      const args = [
        '-hide_banner',
        '-loglevel', 'error',
        '-f', 'avfoundation',
        '-i', `:${index}`,
        '-ac', '1',
        '-ar', '16000',
        '-f', 's16le',
        'pipe:1'
      ];

      const startupTimer = setTimeout(() => {
        if (!isResolved) {
          if (this.metrics.blackholeFrames >= 5) {
            isResolved = true;
            this.isCapturing = true;
            this.startHealthMetricsLogging();
            resolve({ success: true, source: 'BlackHole System Audio (Meeting Recommended)', index });
          } else {
            this.stopCapture();
            reject(new Error('BlackHole FFmpeg capture timed out waiting for audio frames (10s).'));
          }
        }
      }, 10000);

      try {
        this.process = spawn('ffmpeg', args, {
          stdio: ['ignore', 'pipe', 'pipe']
        });
      } catch (spawnErr) {
        clearTimeout(startupTimer);
        return reject(new Error(`Failed to spawn FFmpeg: ${spawnErr.message}`));
      }

      this.process.on('error', (err) => {
        logger.error('[BLACKHOLE] FFmpeg process error:', err.message);
        if (!isResolved) {
          clearTimeout(startupTimer);
          reject(err);
        } else {
          this.emit('error', err);
        }
      });

      this.process.on('exit', (code, signal) => {
        logger.warn('[BLACKHOLE] FFmpeg exited', { code, signal });
        this.isCapturing = false;
        if (!isResolved) {
          clearTimeout(startupTimer);
          reject(new Error(`FFmpeg exited prematurely with code ${code}`));
        } else {
          this.emit('status', { capturing: false, code, signal });
        }
      });

      this.process.stdout.on('data', (chunk) => {
        this._handleBufferData(chunk);

        if (!isResolved && this.metrics.blackholeFrames >= 5) {
          isResolved = true;
          clearTimeout(startupTimer);
          this.isCapturing = true;
          this.startHealthMetricsLogging();
          resolve({ success: true, source: 'BlackHole System Audio (Meeting Recommended)', index });
        }
      });

      this.process.stderr.on('data', (data) => {
        logger.debug('[BLACKHOLE-FFMPEG-STDERR]', data.toString('utf-8').trim());
      });
    });
  }

  _handleBufferData(chunk) {
    this.bufferRemainder = Buffer.concat([this.bufferRemainder, chunk]);

    // Exact 640-byte framing (320 Int16 samples @ 16kHz = 20ms per frame)
    const FRAME_SIZE = 640;
    while (this.bufferRemainder.length >= FRAME_SIZE) {
      const pcmFrame = this.bufferRemainder.subarray(0, FRAME_SIZE);
      this.bufferRemainder = this.bufferRemainder.subarray(FRAME_SIZE);

      this.sequenceNum++;
      this.metrics.blackholeFrames++;
      this.metrics.blackholeBytes += FRAME_SIZE;
      this.metrics.lastFrameTimestamp = Date.now();

      // Compute RMS & Peak energy
      let sumSq = 0;
      let peak = 0;
      const sampleCount = FRAME_SIZE / 2;

      for (let i = 0; i < sampleCount; i++) {
        const sample = pcmFrame.readInt16LE(i * 2);
        const absSample = Math.abs(sample);
        if (absSample > peak) peak = absSample;
        const norm = sample / 32768.0;
        sumSq += norm * norm;
      }

      const rms = Math.sqrt(sumSq / sampleCount);
      this.metrics.recentRms = rms;
      this.metrics.recentPeak = peak;

      if (rms > 0.01) {
        this.metrics.signalSeenRecently = true;
      }

      this.emit('audio-frame', {
        pcm: pcmFrame,
        sequence: this.sequenceNum,
        rms,
        peak,
        timestamp: this.metrics.lastFrameTimestamp
      });
    }
  }

  startHealthMetricsLogging() {
    if (this.healthInterval) clearInterval(this.healthInterval);
    let isStalled = false;

    this.healthInterval = setInterval(() => {
      if (this.isCapturing) {
        const ageMs = this.metrics.lastFrameTimestamp ? Date.now() - this.metrics.lastFrameTimestamp : 999999;
        logger.info(`[BLACKHOLE-HEALTH] frames=${this.metrics.blackholeFrames} bytes=${this.metrics.blackholeBytes} rms=${this.metrics.recentRms.toFixed(4)} ageMs=${ageMs}`);

        if (ageMs > 2500 && !isStalled && this.metrics.blackholeFrames > 0) {
          isStalled = true;
          logger.warn(`[BLACKHOLE] Audio stream stalled ageMs=${ageMs}`);
          this.emit('audio-stalled', { ageMs });
        } else if (ageMs <= 2500 && isStalled) {
          isStalled = false;
          logger.info('[BLACKHOLE] Audio stream recovered');
          this.emit('audio-recovered');
        }
      }
    }, 2000);
  }

  stopCapture() {
    if (this.healthInterval) {
      clearInterval(this.healthInterval);
      this.healthInterval = null;
    }

    if (this.process) {
      try {
        this.process.kill('SIGINT');
        setTimeout(() => {
          if (this.process) {
            try { this.process.kill('SIGKILL'); } catch (_) {}
          }
        }, 500);
      } catch (_) {}
      this.process = null;
    }

    this.isCapturing = false;
    logger.info('[BLACKHOLE] Audio capture stopped.');
  }
}

module.exports = new BlackHoleAudioService();
