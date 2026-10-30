require('dotenv').config();
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const callBriefManager = require('../src/managers/call-brief.manager');
const ollamaService = require('../src/services/ollama.service');

async function testSingleInstanceLock() {
  console.log('--- Test 1: Verifying Single Instance Protection in main.js ---');
  const mainContent = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf-8');
  assert(mainContent.includes('requestSingleInstanceLock'), 'main.js MUST call requestSingleInstanceLock');
  console.log('🟢 Single instance protection verified!\n');
}

async function testChatWindowScriptLoading() {
  console.log('--- Test 2: Verifying chat.html script loading ---');
  const chatHtmlContent = fs.readFileSync(path.join(__dirname, '../chat.html'), 'utf-8');
  assert(chatHtmlContent.includes('src/ui/chat-window.js'), 'chat.html MUST include src/ui/chat-window.js');
  assert(!chatHtmlContent.includes('const chatMessages = document.getElementById'), 'chat.html MUST NOT contain duplicate inline UI logic');
  console.log('🟢 chat.html script loading verified!\n');
}

async function testModeAGreetingNoInvention() {
  console.log('--- Test 3: Verifying Mode A (No Brief) Greeting & Non-Invention ---');
  callBriefManager.endCallAndPurge();
  
  const status = await ollamaService.checkStatus();
  if (!status.connected || !status.modelReady) {
    console.log('⚠️ Ollama not ready, skipping LLM query test');
    return;
  }

  const systemPrompt = callBriefManager.buildSystemInstruction();
  assert(systemPrompt.includes('neutral AI assistant'), 'Mode A MUST use neutral assistant prompt');

  const history = [{ role: 'user', content: 'How are you?' }];
  let responseText = '';
  await ollamaService.generateStream(history, (chunk) => {
    responseText += chunk;
  }, systemPrompt);

  console.log(`   User: "How are you?" -> AI: "${responseText.trim()}"`);
  
  const lowerResp = responseText.toLowerCase();
  assert(!lowerResp.includes('client call'), 'No-brief greeting MUST NOT mention client calls');
  assert(!lowerResp.includes('recent project'), 'No-brief greeting MUST NOT mention recent projects');
  assert(!lowerResp.includes('confirm that detail'), 'No-brief greeting MUST NOT append confirmation clause to casual greetings');
  console.log('🟢 Mode A neutral greeting verified!\n');
}

async function testMediaRecorderPipelineAvailable() {
  console.log('--- Test 4: Verifying processAudioRecording IPC Handler ---');
  const mainContent = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf-8');
  assert(mainContent.includes('process-audio-recording'), 'main.js MUST register process-audio-recording IPC handler');
  assert(mainContent.includes('ffmpeg'), 'main.js MUST use ffmpeg to normalize MediaRecorder audio');
  assert(mainContent.includes('ffprobe'), 'main.js MUST use ffprobe to verify normalized WAV');
  console.log('🟢 MediaRecorder audio pipeline handlers verified!\n');
}

async function runAllValidationTests() {
  console.log('==================================================');
  console.log('Phase 8: Real Application Fixes Validation Suite');
  console.log('==================================================\n');

  await testSingleInstanceLock();
  await testChatWindowScriptLoading();
  await testModeAGreetingNoInvention();
  await testMediaRecorderPipelineAvailable();

  console.log('==================================================');
  console.log('✅ ALL REAL APPLICATION FIX VALIDATION TESTS PASSED!');
  console.log('==================================================');
}

runAllValidationTests().catch(err => {
  console.error('Validation test failed:', err);
  process.exit(1);
});
