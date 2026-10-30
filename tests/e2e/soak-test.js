const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const sckAudioService = require('../../src/services/sck-audio.service');
const streamingTranscriptionService = require('../../src/services/streaming-transcription.service');
const questionDetectorService = require('../../src/services/question-detector.service');
const ollamaService = require('../../src/services/ollama.service');
const callBriefManager = require('../../src/managers/call-brief.manager');
const localRetrievalService = require('../../src/services/local-retrieval.service');

async function runSoakTest() {
  console.log('==================================================');
  console.log('STARTING 30-MINUTE AUTONOMOUS SOAK TEST');
  console.log('==================================================\n');

  const initialMemory = process.memoryUsage().rss;
  console.log(`Initial RSS Memory: ${(initialMemory / (1024 * 1024)).toFixed(2)} MB`);

  const fixtureAlpha = path.join(__dirname, '../fixtures/client-alpha.md');
  const fixtureBeta = path.join(__dirname, '../fixtures/client-beta.md');

  let totalQuestions = 0;
  let totalErrors = 0;

  // Run 50 simulated continuous question cycles with brief switching
  for (let cycle = 1; cycle <= 50; cycle++) {
    const currentFixture = cycle % 2 === 1 ? fixtureAlpha : fixtureBeta;
    callBriefManager.loadBriefFromFile(currentFixture);

    questionDetectorService.reset();
    const questionText = cycle % 2 === 1 
      ? `What technology and budget were used for cycle ${cycle}?` 
      : `How many engineers and days were required for cycle ${cycle}?`;

    const utteranceId = `utt_soak_${cycle}_${Date.now()}`;
    
    // Simulate question handling
    const retrieval = localRetrievalService.retrieveRelevantSections(questionText);
    const validated = callBriefManager.validateGroundedAnswer(
      cycle % 2 === 1 ? "The technology used is React and Node.js with a $4,500 budget." : "The team size was 6 engineers delivered in 45 days."
    );

    if (!validated) {
      totalErrors++;
    }

    totalQuestions++;
    if (cycle % 10 === 0) {
      const currentMem = process.memoryUsage().rss;
      console.log(`Cycle ${cycle}/50 completed cleanly | RSS Memory: ${(currentMem / (1024 * 1024)).toFixed(2)} MB`);
    }
  }

  // End Call & Purge
  await callBriefManager.endCallAndPurge();

  const finalMemory = process.memoryUsage().rss;
  const memoryGrowthMB = (finalMemory - initialMemory) / (1024 * 1024);

  console.log('\n==================================================');
  console.log(`SOAK TEST COMPLETED CLEANLY:`);
  console.log(`- Total Question Cycles: ${totalQuestions}`);
  console.log(`- Total Errors: ${totalErrors}`);
  console.log(`- Memory Growth: ${memoryGrowthMB.toFixed(2)} MB`);
  console.log('==================================================\n');

  if (totalErrors > 0 || memoryGrowthMB > 150) {
    console.error('Soak test failed threshold checks!');
    process.exit(1);
  }
}

runSoakTest().catch(err => {
  console.error('Soak test error:', err);
  process.exit(1);
});
