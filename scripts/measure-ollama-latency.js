const ollamaService = require('../src/services/ollama.service');

const messages = [
  { role: 'system', content: '/no_think Give a direct concise spoken answer. Use only supplied facts. Project: Atlas Dashboard. Built with React and Node.js. I implemented the chart interface and telemetry API. Do not invent metrics.' },
  { role: 'user', content: 'Can you explain your responsibilities and the technologies in the project?' }
];

async function main() {
  for (let run = 1; run <= 3; run++) {
    const started = performance.now();
    let firstTokenMs = null;
    let chars = 0;
    await ollamaService.generateStream(messages, chunk => {
      chars += chunk.length;
      if (firstTokenMs === null && chunk.length) firstTokenMs = performance.now() - started;
    }, { numPredict: 100, keepAlive: '5m', temperature: 0.2 });
    console.log(JSON.stringify({ run, model: ollamaService.activeModel,
      firstTokenMs: firstTokenMs === null ? null : Math.round(firstTokenMs),
      completeMs: Math.round(performance.now() - started), characters: chars }));
  }
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
