require('dotenv').config();
const fs = require('fs');
const path = require('path');
const assert = require('assert');

// 1. Verify preload.js exposures
function testPreloadExposures() {
  console.log('--- Test 1: Verifying preload.js Copilot API Exposures ---');
  const preloadContent = fs.readFileSync(path.join(__dirname, '../preload.js'), 'utf-8');

  const requiredAPIs = [
    'getAIProvider',
    'setAIProvider',
    'checkOllamaStatus',
    'testOllamaModel',
    'selectCallBrief',
    'getCallBriefStatus',
    'getCallBriefPreview',
    'setCallBriefOptions',
    'startNewCall',
    'endCallAndPurge',
    'createBriefTemplate',
    'sendAudioChunk',
    'startSpeechRecognition',
    'stopSpeechRecognition'
  ];

  for (const api of requiredAPIs) {
    assert(preloadContent.includes(api), `preload.js MUST expose '${api}'`);
  }
  console.log('🟢 All 14 Copilot & Speech APIs verified exposed in preload.js!\n');
}

// 2. Verify legacy DSA fallback is absent from llm.service.js
function testLegacyDsaAbsence() {
  console.log('--- Test 2: Verifying Absence of Legacy DSA Fallback ---');
  const llmServiceContent = fs.readFileSync(path.join(__dirname, '../src/services/llm.service.js'), 'utf-8');
  assert(!llmServiceContent.includes('sounds like a ${activeSkill} question'), 'llm.service.js MUST NOT contain legacy DSA string');
  console.log('🟢 Legacy DSA fallback verified absent!\n');
}

// 3. Verify speech service 5-second watchdog
async function testSpeechWatchdog() {
  console.log('--- Test 3: Verifying Speech Service 5-Second No-Audio Timeout ---');
  const speechService = require('../src/services/speech.service');
  speechService.provider = 'whisper';
  speechService._initializeWhisperClient();

  let timeoutTriggered = false;
  let statusMsg = '';

  speechService.on('error', (err) => {
    console.log('   [TEST OBSERVED ERROR EVENT]:', err);
  });

  speechService.on('status', (msg) => {
    statusMsg = msg;
    if (msg.includes('no audio data was received')) {
      timeoutTriggered = true;
    }
  });

  speechService.startRecording();
  assert.strictEqual(speechService.state, 'recording', 'State should be recording');

  console.log('   Waiting 5.5 seconds without sending audio chunks...');
  await new Promise(r => setTimeout(r, 5600));

  assert.strictEqual(timeoutTriggered, true, 'Watchdog should trigger 5s no-audio timeout');
  assert.strictEqual(speechService.state, 'idle', 'State should reset to idle after timeout');
  console.log(`   Watchdog status message: "${statusMsg}"`);
  console.log('🟢 5-second no-audio timeout watchdog verified!\n');
}

async function runAllFixTests() {
  console.log('==================================================');
  console.log('Phase 10: Live Electron Fixes Regression Suite');
  console.log('==================================================\n');

  testPreloadExposures();
  testLegacyDsaAbsence();
  await testSpeechWatchdog();

  console.log('==================================================');
  console.log('✅ ALL LIVE ELECTRON FIX REGRESSION TESTS PASSED!');
  console.log('==================================================');
}

runAllFixTests().catch(err => {
  console.error('Live electron fix test failed:', err);
  process.exit(1);
});
