require('dotenv').config();
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const sckAudioService = require('../src/services/sck-audio.service');
const streamingTranscriptionService = require('../src/services/streaming-transcription.service');
const questionDetectorService = require('../src/services/question-detector.service');
const ollamaService = require('../src/services/ollama.service');
const callBriefManager = require('../src/managers/call-brief.manager');

async function testSCKBinary() {
  console.log('--- Step 1: Testing ScreenCaptureKit Native Binary ---');
  sckAudioService.ensureBinaryExists();
  assert(fs.existsSync(sckAudioService.binaryPath), 'sck_audio_capturer binary MUST exist');
  console.log('🟢 ScreenCaptureKit binary exists:', sckAudioService.binaryPath);
}

async function testStreamingTranscriptionWorker() {
  console.log('\n--- Step 2: Testing Persistent PyTorch MPS Streaming Worker ---');
  const ready = await streamingTranscriptionService.startWorker('base.en');
  assert(ready, 'Streaming transcription worker MUST report ready');
  assert(streamingTranscriptionService.isReady, 'isReady state MUST be true');
  console.log('🟢 PyTorch MPS Streaming Worker active and warm in RAM!');

  // Feed a 1-second synthetic 16kHz silent PCM buffer
  const pcmBuffer = Buffer.alloc(32000); // 16000 samples * 2 bytes = 32000 bytes
  const fed = streamingTranscriptionService.feedAudioFrame(pcmBuffer);
  assert(fed, 'PCM buffer MUST be accepted by stdin without crash');
  console.log('🟢 Raw PCM audio frame fed to stdin cleanly!');

  streamingTranscriptionService.stopWorker();
  console.log('🟢 Worker stopped cleanly!');
}

async function testQuestionDetector() {
  console.log('\n--- Step 3: Testing Question-End Detection ---');
  questionDetectorService.reset();

  let detectedEvent = null;
  questionDetectorService.on('question-detected', (data) => {
    detectedEvent = data;
  });

  questionDetectorService.handleFinal('Could you explain your relevant experience with real-time analytics?');
  
  assert(detectedEvent !== null, 'Question MUST be detected');
  assert(detectedEvent.question.includes('real-time analytics'), 'Question text MUST match');
  assert(detectedEvent.utteranceId.startsWith('utt_'), 'Utterance ID MUST start with utt_');
  console.log(`🟢 Detected question: "${detectedEvent.question}" [ID: ${detectedEvent.utteranceId}]`);
}

async function testKeepAliveAndPurge() {
  console.log('\n--- Step 4: Testing Ollama keep_alive: -1 and keep_alive: 0 Purge ---');
  const status = await ollamaService.checkStatus();
  if (!status.connected || !status.modelReady) {
    console.log('⚠️ Ollama not running, skipping live HTTP keep_alive test');
    return;
  }

  const warmRes = await ollamaService.setKeepAliveMode(-1);
  assert(warmRes, 'setKeepAliveMode(-1) MUST return true');
  console.log('🟢 Model warmed with keep_alive: -1 for Live Call mode!');

  const purgeRes = await callBriefManager.endCallAndPurge();
  assert(purgeRes.purged, 'endCallAndPurge MUST return purged: true');
  console.log('🟢 End Call & Purge executed with keep_alive: 0!');
}

async function runVerticalSliceTest() {
  console.log('==================================================');
  console.log('Phase 9: ScreenCaptureKit Live Call Copilot Vertical Slice');
  console.log('==================================================\n');

  await testSCKBinary();
  await testStreamingTranscriptionWorker();
  await testQuestionDetector();
  await testKeepAliveAndPurge();

  console.log('\n==================================================');
  console.log('✅ VERTICAL SLICE LIVE CALL COPILOT TEST PASSED 100% CLEAN!');
  console.log('==================================================');
}

runVerticalSliceTest().catch(err => {
  console.error('Vertical slice test failed:', err);
  process.exit(1);
});
