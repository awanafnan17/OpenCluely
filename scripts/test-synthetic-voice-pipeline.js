require('dotenv').config();
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { execSync } = require('child_process');
const whisperService = require('../src/services/speech.service');
const callBriefManager = require('../src/managers/call-brief.manager');
const ollamaService = require('../src/services/ollama.service');
const localRetrievalService = require('../src/services/local-retrieval.service');

async function testSyntheticVoicePipeline() {
  console.log('==================================================');
  console.log('Phase 9: Automated Synthetic Voice Pipeline Test');
  console.log('==================================================\n');

  whisperService.provider = 'whisper';
  whisperService.whisperCommand = whisperService._resolveWhisperCommand();

  const synthAiffPath = path.join(__dirname, 'synthetic_test_input.aiff');
  const synthWavPath = path.join(__dirname, 'synthetic_test_input.wav');
  const briefPath = path.join(__dirname, 'synthetic_voice_test.brief.md');

  const sampleBrief = `# Synthetic Voice Pitch Brief
## My Relevant Experience
Lead developer for high-frequency real-time analytics dashboard with React and WebSockets.
`;

  fs.writeFileSync(briefPath, sampleBrief, 'utf-8');

  try {
    // 1. Generate local synthetic audio file using macOS `say` and `afconvert`
    console.log('1. Generating local synthetic audio file using macOS `say` and `afconvert`...');
    execSync(`say "Tell me about my relevant dashboard experience." -o "${synthAiffPath}"`);
    execSync(`afconvert -f WAVE -c 1 -d LEI16@16000 "${synthAiffPath}" "${synthWavPath}"`);
    assert(fs.existsSync(synthWavPath), 'Synthetic WAV file must be created');
    console.log('   Synthetic audio file created:', synthWavPath);

    // 2. Load test brief
    console.log('2. Loading client brief...');
    callBriefManager.loadBriefFromFile(briefPath);
    assert.strictEqual(callBriefManager.getBriefStatus().hasBrief, true);

    // 3. Transcribe audio using local Whisper command
    console.log('3. Transcribing synthetic audio via local Whisper...');
    const whisperText = await whisperService._transcribeWhisperFile(synthWavPath);
    console.log('   Whisper Result Text:', JSON.stringify(whisperText));

    assert(whisperText && whisperText.trim().length > 0, 'Transcription text must be non-empty');
    console.log(`   Transcribed Text: "${whisperText.trim()}"`);

    // 4. Retrieve context for transcribed text
    console.log('4. Retrieving relevant brief context for transcription...');
    const retrieval = localRetrievalService.retrieveContext(whisperText);
    assert(retrieval.retrievedSections.length > 0, 'Should retrieve relevant sections for transcribed question');

    // 5. Generate response via Ollama at 127.0.0.1:11434
    console.log('5. Querying Local Ollama (127.0.0.1:11434)...');
    const sys = callBriefManager.buildSystemInstruction();
    const messages = [
      { role: 'system', content: `${sys}\n\n### ACTIVE CLIENT CALL BRIEF CONTEXT:\n${retrieval.formattedContext}` },
      { role: 'user', content: whisperText }
    ];

    const start = Date.now();
    const ans = await ollamaService.generateStream(messages, null, { numPredict: 250 });
    console.log(`   Ollama Response (${Date.now() - start}ms): "${ans}"`);

    assert(ans.length > 0, 'Ollama response must be non-empty');
    assert(!ans.includes('<think>'), 'Must not contain <think> tags');
    assert(ans.toLowerCase().includes('dashboard') || ans.toLowerCase().includes('react'), 'Response must contain relevant dashboard experience');

    console.log('\n🟢 SYNTHETIC VOICE PIPELINE VERIFIED 100% SUCCESSFUL!');

  } finally {
    // 6. Cleanup all temporary audio & brief files
    console.log('6. Cleaning up temporary audio and brief files...');
    if (fs.existsSync(synthAiffPath)) fs.unlinkSync(synthAiffPath);
    if (fs.existsSync(synthWavPath)) fs.unlinkSync(synthWavPath);
    if (fs.existsSync(briefPath)) fs.unlinkSync(briefPath);
    await callBriefManager.endCallAndPurge();
    console.log('   Cleanup complete.');
  }

  console.log('==================================================');
  console.log('✅ SYNTHETIC VOICE PIPELINE TEST PASSED CLEANLY!');
  console.log('==================================================');
}

testSyntheticVoicePipeline().catch(err => {
  console.error('Synthetic voice pipeline test failed:', err);
  process.exit(1);
});
