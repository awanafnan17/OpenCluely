const http = require('http');

/**
 * Local Ollama Service
 * Provides HTTP streaming integration with Ollama server bound exclusively to 127.0.0.1:11434.
 */
class OllamaService {
  constructor() {
    this.host = '127.0.0.1';
    this.port = 11434;
    this.defaultModel = 'qwen3:1.7b'; // Fallback if qwen3:1.7b-q4_K_M is not present
    this.activeModel = null;
    this.activeController = null;
  }

  /**
   * Resolve active Ollama model from available installed tags
   */
  async resolveActiveModel() {
    try {
      const models = await this.listModels();
      const preferredTag = 'qwen3:1.7b-q4_K_M';
      const fallbackTag = 'qwen3:1.7b';

      if (models.includes(preferredTag)) {
        this.activeModel = preferredTag;
      } else if (models.includes(fallbackTag)) {
        this.activeModel = fallbackTag;
      } else if (models.length > 0) {
        // Match any qwen3 1.7b variant first
        const qwenMatch = models.find(m => m.includes('qwen3') && m.includes('1.7b'));
        this.activeModel = qwenMatch || models[0];
      } else {
        this.activeModel = fallbackTag;
      }
      return this.activeModel;
    } catch (_) {
      this.activeModel = this.defaultModel;
      return this.defaultModel;
    }
  }

  /**
   * List installed models on local Ollama server
   */
  async listModels() {
    return new Promise((resolve, reject) => {
      const req = http.request({
        hostname: this.host,
        port: this.port,
        path: '/api/tags',
        method: 'GET',
        timeout: 3000
      }, (res) => {
        let body = '';
        res.on('data', chunk => body += chunk);
        res.on('end', () => {
          if (res.statusCode === 200) {
            try {
              const data = JSON.parse(body);
              const names = (data.models || []).map(m => m.name);
              resolve(names);
            } catch (err) {
              reject(err);
            }
          } else {
            reject(new Error(`HTTP ${res.statusCode}`));
          }
        });
      });

      req.on('error', err => reject(err));
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('Timeout connecting to Ollama server'));
      });
      req.end();
    });
  }

  /**
   * Set model keep_alive mode (-1 for indefinite warm RAM during live call, 0 for immediate purge)
   */
  async setKeepAliveMode(keepAliveValue = -1) {
    const model = await this.resolveActiveModel();
    const postData = JSON.stringify({
      model,
      keep_alive: keepAliveValue
    });
    return new Promise((resolve) => {
      const req = http.request({
        hostname: this.host,
        port: this.port,
        path: '/api/generate',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(postData)
        },
        timeout: 5000
      }, (res) => {
        resolve(res.statusCode === 200);
      });
      req.on('error', () => resolve(false));
      req.write(postData);
      req.end();
    });
  }

  /**
   * Check connection and model readiness
   */
  async checkStatus() {
    try {
      const models = await this.listModels();
      const resolvedModel = await this.resolveActiveModel();
      const modelReady = models.includes(resolvedModel);

      return {
        connected: true,
        modelReady,
        modelName: resolvedModel,
        availableModels: models,
        statusText: modelReady ? 'Model ready' : 'Model missing'
      };
    } catch (err) {
      return {
        connected: false,
        modelReady: false,
        modelName: this.defaultModel,
        availableModels: [],
        statusText: 'Ollama not running',
        error: err.message
      };
    }
  }

  /**
   * Run local smoke test with prompt /no_think Reply with exactly: LOCAL_OK
   */
  async testModel() {
    const startTime = Date.now();
    const model = await this.resolveActiveModel();

    return new Promise((resolve) => {
      const postData = JSON.stringify({
        model,
        messages: [
          { role: 'user', content: '/no_think Reply with exactly: LOCAL_OK' }
        ],
        think: false,
        stream: false,
        keep_alive: 0,
        options: {
          num_ctx: 2048,
          num_predict: 20,
          temperature: 0.1
        }
      });

      const req = http.request({
        hostname: this.host,
        port: this.port,
        path: '/api/chat',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(postData)
        },
        timeout: 15000
      }, (res) => {
        let body = '';
        res.on('data', chunk => body += chunk);
        res.on('end', () => {
          const latencyMs = Date.now() - startTime;
          if (res.statusCode === 200) {
            try {
              const data = JSON.parse(body);
              const content = (data.message && data.message.content) ? data.message.content.trim() : '';
              const cleanText = this.stripThinkTags(content);

              const evalCount = data.eval_count || 0;
              const evalDurationNs = data.eval_duration || 1;
              const tps = evalCount > 0 ? (evalCount / (evalDurationNs / 1e9)).toFixed(1) : 'N/A';

              resolve({
                success: true,
                model,
                text: cleanText,
                latencyMs,
                tps: parseFloat(tps) || 0,
                promptEvalDurationMs: data.prompt_eval_duration ? Math.round(data.prompt_eval_duration / 1e6) : 0,
                evalDurationMs: Math.round(evalDurationNs / 1e6)
              });
            } catch (err) {
              resolve({ success: false, model, error: `Parse error: ${err.message}`, latencyMs });
            }
          } else {
            resolve({ success: false, model, error: `HTTP ${res.statusCode}: ${body}`, latencyMs });
          }
        });
      });

      req.on('error', err => resolve({ success: false, model, error: err.message, latencyMs: Date.now() - startTime }));
      req.on('timeout', () => {
        req.destroy();
        resolve({ success: false, model, error: 'Request timeout', latencyMs: Date.now() - startTime });
      });

      req.write(postData);
      req.end();
    });
  }

  /**
   * Stream response from Ollama server for given messages
   */
  async generateStream(messages, onChunk, options = {}) {
    // Cancel any previous in-flight request
    this.cancelCurrentGeneration();

    const model = await this.resolveActiveModel();
    const numPredict = options.numPredict || 400;

    const postData = JSON.stringify({
      model,
      messages,
      think: false,
      stream: true,
      keep_alive: options.keepAlive !== undefined ? options.keepAlive : -1,
      options: {
        num_ctx: 2048,
        num_predict: numPredict,
        temperature: options.temperature || 0.25,
        top_p: options.topP || 0.85,
        repeat_penalty: 1.05
      }
    });

    return new Promise((resolve, reject) => {
      let fullText = '';
      let isAborted = false;

      const req = http.request({
        hostname: this.host,
        port: this.port,
        path: '/api/chat',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(postData)
        },
        timeout: 45000
      }, (res) => {
        if (res.statusCode !== 200) {
          let errBody = '';
          res.on('data', c => errBody += c);
          res.on('end', () => reject(new Error(`Ollama HTTP ${res.statusCode}: ${errBody}`)));
          return;
        }

        let buffer = '';
        res.on('data', (chunk) => {
          if (isAborted) return;
          buffer += chunk.toString();
          const lines = buffer.split('\n');
          buffer = lines.pop(); // Keep last partial line

          for (const line of lines) {
            if (!line.trim()) continue;
            try {
              const json = JSON.parse(line);
              if (json.message && json.message.content) {
                const delta = json.message.content;
                fullText += delta;
                if (typeof onChunk === 'function') {
                  onChunk(delta);
                }
              }
              if (json.done) {
                this.activeController = null;
                resolve(this.stripThinkTags(fullText));
              }
            } catch (_) {
              // Ignore invalid JSON chunks
            }
          }
        });

        res.on('end', () => {
          if (!isAborted) {
            this.activeController = null;
            resolve(this.stripThinkTags(fullText));
          }
        });
      });

      req.on('error', (err) => {
        this.activeController = null;
        if (!isAborted) {
          reject(new Error(`Ollama Request Failed: ${err.message}`));
        }
      });

      req.on('timeout', () => {
        req.destroy();
        this.activeController = null;
        reject(new Error('Ollama generation timed out (45s)'));
      });

      this.activeController = {
        abort: () => {
          isAborted = true;
          req.destroy();
          reject(new Error('The previous request was cancelled.'));
        }
      };

      req.write(postData);
      req.end();
    });
  }

  /**
   * Cancel currently running generation if any
   */
  cancelCurrentGeneration() {
    if (this.activeController) {
      try {
        this.activeController.abort();
      } catch (_) {}
      this.activeController = null;
    }
  }

  /**
   * Immediately unload model from RAM (keep_alive: 0)
   */
  async unloadModel() {
    this.cancelCurrentGeneration();
    const model = this.activeModel || this.defaultModel;

    return new Promise((resolve) => {
      const postData = JSON.stringify({
        model,
        messages: [{ role: 'user', content: 'unload' }],
        stream: false,
        keep_alive: 0
      });

      const req = http.request({
        hostname: this.host,
        port: this.port,
        path: '/api/chat',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(postData)
        },
        timeout: 3000
      }, () => resolve(true));

      req.on('error', () => resolve(false));
      req.on('timeout', () => { req.destroy(); resolve(false); });
      req.write(postData);
      req.end();
    });
  }

  /**
   * Strip any <think>...</think> reasoning blocks if model emits them
   */
  stripThinkTags(text) {
    if (!text || typeof text !== 'string') return '';
    return text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  }
}

module.exports = new OllamaService();
