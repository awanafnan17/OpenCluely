const assert = require('assert');
const fs = require('fs');
const path = require('path');
const callBriefManager = require('../src/managers/call-brief.manager');

async function runTests() {
  console.log('--- Testing Call Brief Manager ---');

  const testPath = path.join(__dirname, 'test-template.brief.md');

  // Test 1: Blank Template Creation
  const templateRes = callBriefManager.createCallBriefTemplate(testPath);
  assert.strictEqual(templateRes.success, true, 'Should successfully create brief template');
  assert(fs.existsSync(testPath), 'Template file must exist on disk');

  // Test 2: Brief Selection & In-Memory Storage
  const selectRes = callBriefManager.loadBriefFromFile(testPath);
  assert.strictEqual(selectRes.success, true, 'Should load valid Markdown brief');
  assert.strictEqual(callBriefManager.getBriefStatus().hasBrief, true, 'Brief state should be active');

  // Test 3: System Instruction Generation
  const systemPrompt = callBriefManager.buildSystemInstruction();
  assert(systemPrompt.includes('/no_think'), 'System prompt must include /no_think tag');
  assert(systemPrompt.includes('START IMMEDIATELY with a direct, 1-2 sentence spoken answer'), 'System prompt must mandate direct answer style');

  // Test 4: Option Selectors
  callBriefManager.setOptions({ answerLength: 'very-short', answerStyle: 'friendly-conversational' });
  assert.strictEqual(callBriefManager.answerLength, 'very-short');
  assert.strictEqual(callBriefManager.answerStyle, 'friendly-conversational');

  const updatedPrompt = callBriefManager.buildSystemInstruction();
  assert(updatedPrompt.includes('Keep the answer very short'), 'Should include very-short rule');

  // Test 5: Session Isolation & Purge
  const purgeRes = await callBriefManager.endCallAndPurge();
  assert.strictEqual(purgeRes.success, true, 'Should succeed purge');
  assert.strictEqual(callBriefManager.getBriefStatus().hasBrief, false, 'Brief memory must be wiped');

  // Cleanup test file
  if (fs.existsSync(testPath)) fs.unlinkSync(testPath);

  console.log('✅ Call Brief Manager tests PASSED!');
}

runTests().catch(err => {
  console.error('Call Brief Manager test failed:', err);
  process.exit(1);
});
