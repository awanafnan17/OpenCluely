const fs = require('fs');
const path = require('path');
const assert = require('assert');
const callBriefManager = require('../src/managers/call-brief.manager');
const ollamaService = require('../src/services/ollama.service');
const localRetrievalService = require('../src/services/local-retrieval.service');

async function testFictionalClientCall() {
  console.log('==================================================');
  console.log('Phase 17 & 18: Fictional Client Call Integration Test');
  console.log('==================================================\n');

  // Step 1: Create a realistic fictional client brief
  const sampleBriefPath = path.join(__dirname, 'sample-client.brief.md');
  const sampleBriefContent = `# Apex Enterprise CRM — Discovery & Pitch Brief

## Purpose of Call
Initial technical discovery with Acme Financial Services to explore migrating their legacy sales workflow to Apex CRM.

## Target Audience
VP of Engineering (Dave) and Lead Product Manager (Sarah).

## Key Selling Points
- Reduces sales cycle duration by 35% through AI lead scoring.
- Automated follow-up sequences integrated with Slack and Email.
- Localized deployment options supporting EU and US data residency.

## Approved Pricing & Discount Limits
- Enterprise Tier: $79 per user / month billed annually.
- Maximum allowable discount for annual prepay: 15% (requires Sales VP approval).
- Standard implementation package: $5,000 flat fee.

## Claims I Must Not Make
- NEVER guarantee 100% SLA uptime (our SLA is 99.9%).
- NEVER promise custom C++ / native desktop extensions on the call.
- NEVER agree to a 30-day free POC without executive authorization.

## Tone and Speaking Style
Direct, empathetic, technical yet clear. Concise spoken sentences suitable for a call.
`;

  fs.writeFileSync(sampleBriefPath, sampleBriefContent, 'utf-8');
  console.log('1. Created fictional client brief file at:', sampleBriefPath);

  // Step 2: Load brief into Call Brief Manager
  const loadRes = callBriefManager.loadBriefFromFile(sampleBriefPath);
  console.log('2. Loaded brief into memory:', loadRes);
  assert.strictEqual(loadRes.success, true);
  assert.strictEqual(callBriefManager.getBriefStatus().hasBrief, true);

  // Step 3: Check Ollama Status
  const status = await ollamaService.checkStatus();
  console.log('3. Ollama Status:', status);
  assert.strictEqual(status.connected, true);
  assert.strictEqual(status.modelReady, true);

  // Step 4: Test Query 1 (General pricing query)
  const q1 = "What is the annual pricing per user for your Enterprise CRM?";
  console.log(`\n--- Test Query 1: "${q1}" ---`);
  
  const retrieval1 = localRetrievalService.retrieveContext(q1);
  const sys1 = callBriefManager.buildSystemInstruction();
  const messages1 = [
    { role: 'system', content: `${sys1}\n\n### ACTIVE CLIENT CALL BRIEF CONTEXT:\n${retrieval1.formattedContext}` },
    { role: 'user', content: q1 }
  ];

  const start1 = Date.now();
  let chunksEmitted = 0;
  const res1 = await ollamaService.generateStream(messages1, (chunk) => {
    chunksEmitted++;
    process.stdout.write(chunk);
  }, { numPredict: 400 });

  console.log(`\n\n(Query 1 completed in ${Date.now() - start1}ms | length: ${res1.length} | chunks: ${chunksEmitted})`);
  console.log('Result text:', JSON.stringify(res1));

  assert(res1.length > 0, 'Should return non-empty response for query 1');
  assert(!res1.includes('<think>'), 'Response must NOT contain <think> tags');

  // Step 5: Test Query 2 (Prohibited claim query: SLA Uptime)
  const q2 = "Can you guarantee us 100% uptime for Acme Financial Services?";
  console.log(`\n--- Test Query 2 (Restricted Claim): "${q2}" ---`);

  const retrieval2 = localRetrievalService.retrieveContext(q2);
  const sys2 = callBriefManager.buildSystemInstruction();
  const messages2 = [
    { role: 'system', content: `${sys2}\n\n### ACTIVE CLIENT CALL BRIEF CONTEXT:\n${retrieval2.formattedContext}` },
    { role: 'user', content: q2 }
  ];

  const start2 = Date.now();
  const res2 = await ollamaService.generateStream(messages2, (chunk) => {
    process.stdout.write(chunk);
  }, { numPredict: 400 });

  console.log(`\n\n(Query 2 completed in ${Date.now() - start2}ms | length: ${res2.length})`);
  console.log('Result text:', JSON.stringify(res2));

  assert(res2.length > 0, 'Should return non-empty response for query 2');
  assert(!res2.includes('100%'), 'Response MUST NOT claim 100% uptime guarantee!');
  assert(!res2.includes('<think>'), 'Response must NOT contain <think> tags');

  // Step 6: Test Session Isolation & Purge
  console.log('\n--- Step 6: Testing End Call & Memory Purge ---');
  const purgeRes = await callBriefManager.endCallAndPurge();
  console.log('Purge result:', purgeRes);
  assert.strictEqual(callBriefManager.getBriefStatus().hasBrief, false, 'Brief must be wiped from memory');

  // Clean up sample brief file
  if (fs.existsSync(sampleBriefPath)) fs.unlinkSync(sampleBriefPath);

  console.log('\n==================================================');
  console.log('✅ ALL FICTIONAL CLIENT CALL TESTS PASSED CLEANLY!');
  console.log('==================================================');
}

testFictionalClientCall().catch(err => {
  console.error('Fictional client call test failed:', err);
  process.exit(1);
});
