const fs = require('fs');
const path = require('path');
const assert = require('assert');
const callBriefManager = require('../src/managers/call-brief.manager');
const ollamaService = require('../src/services/ollama.service');
const localRetrievalService = require('../src/services/local-retrieval.service');

async function runThreeClientIsolationTest() {
  console.log('==================================================');
  console.log('Phase 8: True Three-Client Multi-Tenant Isolation Test');
  console.log('==================================================\n');

  const pathA = path.join(__dirname, 'client-A-isolation.brief.md');
  const pathB = path.join(__dirname, 'client-B-isolation.brief.md');
  const pathC = path.join(__dirname, 'client-C-isolation.brief.md');

  const contentA = `# Client Alpha — Real-Time React Dashboard
## Relevant Experience
Built high-frequency React and Node.js WebSocket dashboards for trading desks.
## Pricing
$50,000 per year.
`;

  const contentB = `# Client Beta — E-Commerce Storefront
## Relevant Experience
Developed custom WordPress plugins and WooCommerce PHP extensions for digital retail stores.
## Pricing
$15,000 per project.
`;

  const contentC = `# Client Gamma — AI Machine Learning API
## Relevant Experience
Designed Python FastAPI async backend microservices with PostgreSQL vector storage for LLMs.
## Pricing
$95,000 per contract.
`;

  fs.writeFileSync(pathA, contentA, 'utf-8');
  fs.writeFileSync(pathB, contentB, 'utf-8');
  fs.writeFileSync(pathC, contentC, 'utf-8');

  try {
    // ------------------------------------------------------------------
    // CLIENT A
    // ------------------------------------------------------------------
    console.log('1. Testing Client A (React & Node.js Dashboard)...');
    callBriefManager.loadBriefFromFile(pathA);

    const retA = localRetrievalService.retrieveContext('What is my stack and pricing?');
    const sysA = callBriefManager.buildSystemInstruction();
    const msgA = [
      { role: 'system', content: `${sysA}\n\n### ACTIVE CLIENT CALL BRIEF CONTEXT:\n${retA.formattedContext}` },
      { role: 'user', content: 'What is my stack and annual pricing?' }
    ];

    const ansA = await ollamaService.generateStream(msgA, null, { numPredict: 250 });
    console.log('   Client A Output:', JSON.stringify(ansA));

    assert(ansA.toLowerCase().includes('react') || ansA.toLowerCase().includes('50,000') || ansA.toLowerCase().includes('websocket'), 'Client A must mention React/50,000/WebSockets');
    assert(!ansA.toLowerCase().includes('wordpress'), 'Client A must not mention WordPress');
    assert(!ansA.toLowerCase().includes('fastapi'), 'Client A must not mention FastAPI');

    const purgeA = await callBriefManager.endCallAndPurge();
    assert.strictEqual(purgeA.purged, true);
    assert.strictEqual(callBriefManager.getBriefStatus().hasBrief, false);
    assert.strictEqual(localRetrievalService.sections.length, 0, 'Retrieval cache must be cleared');

    // ------------------------------------------------------------------
    // CLIENT B
    // ------------------------------------------------------------------
    console.log('\n2. Testing Client B (WordPress & WooCommerce)...');
    callBriefManager.loadBriefFromFile(pathB);

    const retB = localRetrievalService.retrieveContext('What is my stack and pricing?');
    const sysB = callBriefManager.buildSystemInstruction();
    const msgB = [
      { role: 'system', content: `${sysB}\n\n### ACTIVE CLIENT CALL BRIEF CONTEXT:\n${retB.formattedContext}` },
      { role: 'user', content: 'What is my stack and project pricing?' }
    ];

    const ansB = await ollamaService.generateStream(msgB, null, { numPredict: 250 });
    console.log('   Client B Output:', JSON.stringify(ansB));

    assert(ansB.toLowerCase().includes('wordpress') || ansB.toLowerCase().includes('15,000') || ansB.toLowerCase().includes('woocommerce'), 'Client B must mention WordPress/WooCommerce/15,000');
    assert(!ansB.toLowerCase().includes('react'), 'Client B MUST NOT contain React leakage from Client A!');
    assert(!ansB.toLowerCase().includes('fastapi'), 'Client B MUST NOT contain FastAPI leakage!');

    const purgeB = await callBriefManager.endCallAndPurge();
    assert.strictEqual(purgeB.purged, true);
    assert.strictEqual(callBriefManager.getBriefStatus().hasBrief, false);

    // ------------------------------------------------------------------
    // CLIENT C
    // ------------------------------------------------------------------
    console.log('\n3. Testing Client C (Python FastAPI & PostgreSQL)...');
    callBriefManager.loadBriefFromFile(pathC);

    const retC = localRetrievalService.retrieveContext('What is my stack and pricing?');
    const sysC = callBriefManager.buildSystemInstruction();
    const msgC = [
      { role: 'system', content: `${sysC}\n\n### ACTIVE CLIENT CALL BRIEF CONTEXT:\n${retC.formattedContext}` },
      { role: 'user', content: 'What is my stack and contract pricing?' }
    ];

    const ansC = await ollamaService.generateStream(msgC, null, { numPredict: 250 });
    console.log('   Client C Output:', JSON.stringify(ansC));

    assert(ansC.toLowerCase().includes('python') || ansC.toLowerCase().includes('fastapi') || ansC.toLowerCase().includes('95,000'), 'Client C must mention Python/FastAPI/95,000');
    assert(!ansC.toLowerCase().includes('react'), 'Client C MUST NOT contain React leakage from Client A!');
    assert(!ansC.toLowerCase().includes('wordpress'), 'Client C MUST NOT contain WordPress leakage from Client B!');

    const purgeC = await callBriefManager.endCallAndPurge();
    assert.strictEqual(purgeC.purged, true);
    assert.strictEqual(callBriefManager.getBriefStatus().hasBrief, false);

    // ------------------------------------------------------------------
    // NO BRIEF STATE
    // ------------------------------------------------------------------
    console.log('\n4. Testing Post-Purge (NO BRIEF ACTIVE)...');
    const retNone = localRetrievalService.retrieveContext('What is my pricing?');
    const sysNone = callBriefManager.buildSystemInstruction();
    const msgNone = [
      { role: 'system', content: `${sysNone}\n\n### ACTIVE CLIENT CALL BRIEF CONTEXT:\n${retNone.formattedContext}` },
      { role: 'user', content: 'What is my pricing?' }
    ];

    const ansNone = await ollamaService.generateStream(msgNone, null, { numPredict: 250 });
    console.log('   No-Brief Output:', JSON.stringify(ansNone));

    assert(!ansNone.includes('50,000'), 'No-brief answer must not leak Client A pricing');
    assert(!ansNone.includes('15,000'), 'No-brief answer must not leak Client B pricing');
    assert(!ansNone.includes('95,000'), 'No-brief answer must not leak Client C pricing');

    console.log('\n🟢 THREE-CLIENT MULTI-TENANT ISOLATION VERIFIED 100% CLEAN!');

  } finally {
    if (fs.existsSync(pathA)) fs.unlinkSync(pathA);
    if (fs.existsSync(pathB)) fs.unlinkSync(pathB);
    if (fs.existsSync(pathC)) fs.unlinkSync(pathC);
  }

  console.log('==================================================');
  console.log('✅ THREE-CLIENT ISOLATION TEST PASSED CLEANLY!');
  console.log('==================================================');
}

runThreeClientIsolationTest().catch(err => {
  console.error('Three-client isolation test failed:', err);
  process.exit(1);
});
