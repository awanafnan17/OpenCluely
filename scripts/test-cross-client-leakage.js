const fs = require('fs');
const path = require('path');
const assert = require('assert');
const callBriefManager = require('../src/managers/call-brief.manager');
const ollamaService = require('../src/services/ollama.service');
const localRetrievalService = require('../src/services/local-retrieval.service');

async function runCrossClientLeakageTest() {
  console.log('==================================================');
  console.log('Phase 5: Genuine Cross-Client Leakage Test');
  console.log('==================================================\n');

  // Paths for Client A and Client B brief files
  const briefAPath = path.join(__dirname, 'client-A.brief.md');
  const briefBPath = path.join(__dirname, 'client-B.brief.md');

  const briefAContent = `# Client A — FinTech Dashboard Brief
## Relevant Experience
Lead developer for React and Node.js real-time analytics dashboard with WebSockets. Built scalable Micro-frontends for financial reporting.
`;

  const briefBContent = `# Client B — E-Commerce Brief
## Relevant Experience
Lead developer for WordPress and WooCommerce custom plugin integration, PHP REST APIs, and storefront optimization.
`;

  fs.writeFileSync(briefAPath, briefAContent, 'utf-8');
  fs.writeFileSync(briefBPath, briefBContent, 'utf-8');

  try {
    // ------------------------------------------------------------------
    // STEP 1: Load Client A and query experience
    // ------------------------------------------------------------------
    console.log('--- Step 1: Loading Client A (React & Node.js Dashboard) ---');
    callBriefManager.loadBriefFromFile(briefAPath);
    assert.strictEqual(callBriefManager.getBriefStatus().filename, 'client-A.brief.md');

    const retA = localRetrievalService.retrieveContext('What is my relevant experience?');
    const sysA = callBriefManager.buildSystemInstruction();
    const msgA = [
      { role: 'system', content: `${sysA}\n\n### ACTIVE CLIENT CALL BRIEF CONTEXT:\n${retA.formattedContext}` },
      { role: 'user', content: 'What is my relevant experience for this call?' }
    ];

    const ansA = await ollamaService.generateStream(msgA, null, { numPredict: 250 });
    console.log('Client A Answer:', JSON.stringify(ansA));
    assert(ansA.toLowerCase().includes('react') || ansA.toLowerCase().includes('node') || ansA.toLowerCase().includes('dashboard'), 'Client A answer should mention React/Node/dashboard');
    assert(!ansA.toLowerCase().includes('wordpress'), 'Client A answer MUST NOT mention WordPress');

    // ------------------------------------------------------------------
    // STEP 2: End Call & Purge Client A
    // ------------------------------------------------------------------
    console.log('\n--- Step 2: Purging Client A Session ---');
    const purgeA = await callBriefManager.endCallAndPurge();
    assert.strictEqual(purgeA.purged, true);
    assert.strictEqual(callBriefManager.getBriefStatus().hasBrief, false);

    // ------------------------------------------------------------------
    // STEP 3: Load Client B and query experience
    // ------------------------------------------------------------------
    console.log('\n--- Step 3: Loading Client B (WordPress & WooCommerce) ---');
    callBriefManager.loadBriefFromFile(briefBPath);
    assert.strictEqual(callBriefManager.getBriefStatus().filename, 'client-B.brief.md');

    const retB = localRetrievalService.retrieveContext('What is my relevant experience?');
    const sysB = callBriefManager.buildSystemInstruction();
    const msgB = [
      { role: 'system', content: `${sysB}\n\n### ACTIVE CLIENT CALL BRIEF CONTEXT:\n${retB.formattedContext}` },
      { role: 'user', content: 'What is my relevant experience for this call?' }
    ];

    const ansB = await ollamaService.generateStream(msgB, null, { numPredict: 250 });
    console.log('Client B Answer:', JSON.stringify(ansB));

    // CRITICAL ASSERTIONS: Client B answer MUST contain WordPress/WooCommerce and MUST NOT contain React/Node/Dashboard
    assert(ansB.toLowerCase().includes('wordpress') || ansB.toLowerCase().includes('woocommerce'), 'Client B answer should mention WordPress/WooCommerce');
    assert(!ansB.toLowerCase().includes('react'), 'Client B answer MUST NOT contain React leakage from Client A!');
    assert(!ansB.toLowerCase().includes('node'), 'Client B answer MUST NOT contain Node.js leakage from Client A!');
    assert(!ansB.toLowerCase().includes('dashboard'), 'Client B answer MUST NOT contain Dashboard leakage from Client A!');

    console.log('🟢 ZERO LEAKAGE VERIFIED: Client B response contains no facts from Client A!');

    // ------------------------------------------------------------------
    // STEP 4: Purge Client B and query with NO brief loaded
    // ------------------------------------------------------------------
    console.log('\n--- Step 4: Purging Client B and testing with NO brief ---');
    await callBriefManager.endCallAndPurge();
    assert.strictEqual(callBriefManager.getBriefStatus().hasBrief, false);

    const retNone = localRetrievalService.retrieveContext('What is my relevant experience?');
    const sysNone = callBriefManager.buildSystemInstruction();
    const msgNone = [
      { role: 'system', content: `${sysNone}\n\n### ACTIVE CLIENT CALL BRIEF CONTEXT:\n${retNone.formattedContext}` },
      { role: 'user', content: 'What is my relevant experience for this call?' }
    ];

    const ansNone = await ollamaService.generateStream(msgNone, null, { numPredict: 250 });
    console.log('No-Brief Answer:', JSON.stringify(ansNone));

    assert(!ansNone.toLowerCase().includes('react'), 'No-brief answer MUST NOT contain Client A facts');
    assert(!ansNone.toLowerCase().includes('woocommerce'), 'No-brief answer MUST NOT contain Client B facts');

    console.log('🟢 ZERO LEAKAGE VERIFIED: No-brief response contains facts from neither client!');

  } finally {
    // Cleanup temporary files
    if (fs.existsSync(briefAPath)) fs.unlinkSync(briefAPath);
    if (fs.existsSync(briefBPath)) fs.unlinkSync(briefBPath);
  }

  console.log('\n==================================================');
  console.log('✅ CROSS-CLIENT LEAKAGE TEST PASSED 100% CLEANLY!');
  console.log('==================================================');
}

runCrossClientLeakageTest().catch(err => {
  console.error('Cross-client leakage test failed:', err);
  process.exit(1);
});
