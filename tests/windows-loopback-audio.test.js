const assert = require('assert');
const EventEmitter = require('events');
const { WindowsLoopbackAudioService } = require('../src/services/windows-loopback-audio.service');

async function main() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => child.emit('exit', 0);

  const service = new WindowsLoopbackAudioService({
    platform: 'win32',
    spawnProcess: () => child
  });
  let frames = 0;
  service.on('audio-frame', ({ pcm, rms }) => {
    frames++;
    assert.strictEqual(pcm.length, 640);
    assert(rms > 0);
  });

  const started = service.startCapture();
  const sample = Buffer.alloc(640 * 5);
  for (let offset = 0; offset < sample.length; offset += 2) sample.writeInt16LE(8192, offset);
  child.stdout.emit('data', sample.subarray(0, 700));
  child.stdout.emit('data', sample.subarray(700));
  const result = await started;
  assert.strictEqual(result.success, true);
  assert.strictEqual(frames, 5);
  service.stopCapture();
  console.log('Windows loopback PCM framing test passed');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
