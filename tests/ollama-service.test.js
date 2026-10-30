const assert = require('assert');
const ollamaService = require('../src/services/ollama.service');

console.log('--- Testing Ollama Service Helper ---');

// Test 1: Service Host & Port Enforcement
assert.strictEqual(ollamaService.host, '127.0.0.1', 'Must bind strictly to host 127.0.0.1');
assert.strictEqual(ollamaService.port, 11434, 'Must bind strictly to port 11434');

// Test 2: Thinking Tag Removal Regex
const thinkSample = `<think>
This is an internal chain of thought reasoning step that should be hidden from user.
</think>The pricing for standard plan is $49/month.`;

const stripped = ollamaService.stripThinkTags(thinkSample);
assert.strictEqual(stripped, 'The pricing for standard plan is $49/month.');

// Test 3: Status Check (server is running in background)
ollamaService.checkStatus().then(status => {
    console.log('Ollama Status:', status);
    assert.strictEqual(status.connected, true, 'Ollama local server should be connected');
    console.log('✅ Ollama Service tests PASSED!');
}).catch(err => {
    console.error('Ollama status test error:', err);
    process.exit(1);
});
