#!/usr/bin/env node
const { execSync } = require('child_process');
const sckAudioService = require('../src/services/sck-audio.service');
const streamingTranscriptionService = require('../src/services/streaming-transcription.service');
const callBriefManager = require('../src/managers/call-brief.manager');
const ollamaService = require('../src/services/ollama.service');

function checkHealth() {
  console.log('==================================================');
  console.log('OPENCLUELY LIVE CALL COPILOT DIAGNOSTIC HEALTH SUMMARY');
  console.log('==================================================');

  // Helper processes
  let sckPids = [];
  try {
    const sckOut = execSync('pgrep -fl sck_audio_capturer || true').toString().trim();
    if (sckOut) sckPids = sckOut.split('\n');
  } catch (_) {}

  let whisperPids = [];
  try {
    const wOut = execSync('pgrep -fl whisper_streaming_worker || true').toString().trim();
    if (wOut) whisperPids = wOut.split('\n');
  } catch (_) {}

  const briefStatus = callBriefManager.getBriefStatus();

  console.log(`Timestamp           : ${new Date().toISOString()}`);
  console.log(`Selected Brief      : ${briefStatus.filename || '(None selected)'} (${briefStatus.headingsCount || 0} headings parsed)`);
  console.log(`Active Ollama Model : ${ollamaService.activeModel || 'qwen3:1.7b-q4_K_M'}`);
  console.log(`SCK Helper PIDs     : ${sckPids.length > 0 ? sckPids.join(', ') : '(None running)'}`);
  console.log(`Whisper Worker PIDs : ${whisperPids.length > 0 ? whisperPids.join(', ') : '(None running)'}`);
  console.log(`SCK Capture Active  : ${sckAudioService.isCapturing}`);
  console.log(`SCK Ready Handshake : ${sckAudioService.sckReady}`);
  console.log(`First PCM Received  : ${sckAudioService.firstPcmReceived}`);
  console.log(`PCM Frames Received : ${sckAudioService.metrics.sckFrames}`);
  console.log(`PCM Bytes Received  : ${sckAudioService.metrics.pcmBytes} bytes`);
  console.log(`Whisper Chunks Sent : ${sckAudioService.metrics.whisperChunks}`);
  console.log(`Last PCM Timestamp  : ${sckAudioService.metrics.lastPcmTimestamp ? new Date(sckAudioService.metrics.lastPcmTimestamp).toLocaleTimeString() : 'N/A'}`);
  console.log('==================================================');
}

checkHealth();
