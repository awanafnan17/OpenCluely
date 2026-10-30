require('dotenv').config();

const speechService = require('../src/services/speech.service');

async function runRegressionTest() {
  console.log('--- Speech Service Idempotency & State Machine Test ---');
  
  const status = speechService.getStatus();
  console.log('Initial Speech Provider:', status.provider);
  console.log('Initial State:', speechService.state);

  let startCount = 0;
  let stopCount = 0;

  speechService.on('recording-started', () => {
    startCount++;
    console.log(`[EVENT] recording-started received (count: ${startCount})`);
  });

  speechService.on('recording-stopped', () => {
    stopCount++;
    console.log(`[EVENT] recording-stopped received (count: ${stopCount})`);
  });

  console.log('\n1. Requesting startRecording() twice in rapid succession...');
  speechService.startRecording();
  speechService.startRecording(); // Should be ignored by state machine

  console.log('Current State immediately after start requests:', speechService.state);
  if (speechService.state !== 'recording' && speechService.state !== 'starting') {
    throw new Error(`Expected state to be recording or starting, got ${speechService.state}`);
  }

  console.log('\n2. Waiting 5 seconds to verify session remains active...');
  const feedInterval = setInterval(() => {
    speechService.handleAudioChunkFromRenderer(Buffer.alloc(100));
  }, 500);
  await new Promise((resolve) => setTimeout(resolve, 5200));
  clearInterval(feedInterval);

  console.log('State after 5 seconds:', speechService.state);
  if (speechService.state !== 'recording') {
    throw new Error(`Expected state to still be recording after 5 seconds, got ${speechService.state}`);
  }

  console.log('\n3. Requesting stopRecording() twice in rapid succession...');
  speechService.stopRecording();
  speechService.stopRecording(); // Should be ignored by state machine

  await new Promise((resolve) => setTimeout(resolve, 500));

  console.log('Final State after stop:', speechService.state);
  if (speechService.state !== 'idle') {
    throw new Error(`Expected state to be idle after stop, got ${speechService.state}`);
  }

  console.log(`\nResults: startEvents=${startCount}, stopEvents=${stopCount}`);
  if (startCount !== 1 || stopCount !== 1) {
    throw new Error(`Expected exactly 1 start event and 1 stop event, got starts=${startCount}, stops=${stopCount}`);
  }

  console.log('\n✅ TEST PASSED: Speech service idempotency and 5s duration verified successfully!\n');
}

runRegressionTest().catch((err) => {
  console.error('\n❌ TEST FAILED:', err.message);
  process.exit(1);
});
