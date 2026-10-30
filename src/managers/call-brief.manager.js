const fs = require('fs');
const path = require('path');
const localRetrievalService = require('../services/local-retrieval.service');
const ollamaService = require('../services/ollama.service');
const sessionManager = require('./session.manager');

/**
 * Call Brief Manager
 * Manages in-memory client call brief state, options, retrieval integration, and session isolation.
 */
class CallBriefManager {
  constructor() {
    this.activeBrief = null; // { filename, content, parsedCount, loadedAt }
    this.callTitle = '';
    this.callNotes = '';
    this.answerLength = 'short'; // 'very-short' | 'short' | 'standard'
    this.answerStyle = 'markdown-instructions'; // 'markdown-instructions' | 'natural-concise' | 'friendly-conversational' | 'technical-easy' | 'sales-discovery' | 'formal-professional'
    this.isCallActive = false;
  }

  /**
   * Load brief from local Markdown file (stored in memory only)
   */
  loadBriefFromFile(filePath) {
    if (!filePath || typeof filePath !== 'string') {
      throw new Error('No client brief file path provided.');
    }

    const ext = path.extname(filePath).toLowerCase();
    if (ext !== '.md' && ext !== '.markdown') {
      throw new Error('Invalid file type. Only .md or .markdown files are accepted.');
    }

    if (!fs.existsSync(filePath)) {
      throw new Error('File does not exist.');
    }

    const stats = fs.statSync(filePath);
    if (!stats.isFile()) {
      throw new Error('Selected path is not a regular file.');
    }

    // Disallow unexpectedly large files (> 2MB) for low memory footprint
    if (stats.size > 2 * 1024 * 1024) {
      throw new Error('Selected Markdown file is too large for lightweight call mode (> 2MB).');
    }

    const content = fs.readFileSync(filePath, 'utf-8');
    if (!content || !content.trim()) {
      throw new Error('The selected Markdown file is empty.');
    }

    const filename = path.basename(filePath);
    const sections = localRetrievalService.parseMarkdown(content);

    const count = sections.length;
    this.activeBrief = {
      filename,
      filePath,
      content,
      parsedCount: count,
      headingsCount: count,
      loadedAt: new Date().toISOString()
    };

    return {
      success: true,
      filename,
      parsedCount: count,
      headingsCount: count,
      stored: 'Memory only'
    };
  }

  /**
   * Extract proper nouns and domain terms from brief for Whisper initial_prompt
   */
  getVocabularyPrompt() {
    if (!this.activeBrief || !this.activeBrief.content) {
      return "AI, software, engineering, client call";
    }

    const words = this.activeBrief.content.match(/\b[A-Z][a-zA-Z0-9_-]{2,}\b/g) || [];
    const uniqueTerms = new Set();

    // Include brief filename words
    const baseName = this.activeBrief.filename ? this.activeBrief.filename.replace(/\.md$/i, '').replace(/[^a-zA-Z0-9]/g, ' ') : '';
    baseName.split(/\s+/).forEach(w => {
      if (w.length > 2) uniqueTerms.add(w);
    });

    for (const word of words) {
      const lower = word.toLowerCase();
      if (!['the', 'and', 'for', 'that', 'this', 'with', 'from', 'your', 'have', 'are', 'not'].includes(lower)) {
        uniqueTerms.add(word);
      }
      if (uniqueTerms.size >= 15) break;
    }

    return Array.from(uniqueTerms).join(', ');
  }

  /**
   * Get active brief status & summary
   */
  getBriefStatus() {
    const count = this.activeBrief ? (this.activeBrief.parsedCount || 0) : 0;
    return {
      hasBrief: !!this.activeBrief,
      filename: this.activeBrief ? this.activeBrief.filename : null,
      parsedCount: count,
      headingsCount: count,
      stored: 'Memory only',
      isCallActive: this.isCallActive,
      callTitle: this.callTitle,
      callNotes: this.callNotes,
      answerLength: this.answerLength,
      answerStyle: this.answerStyle
    };
  }

  /**
   * Get brief preview (sanitized)
   */
  getBriefPreview() {
    if (!this.activeBrief || !this.activeBrief.content) {
      return { hasBrief: false, content: '' };
    }
    // Return content sanitized (raw HTML tags stripped)
    const sanitized = this.activeBrief.content.replace(/<[^>]*>/g, '');
    return {
      success: true,
      hasBrief: true,
      filename: this.activeBrief.filename,
      content: sanitized
    };
  }

  /**
   * Retrieve relevant call brief sections for a query
   */
  getRelevantContext(query) {
    if (!this.activeBrief) {
      return {
        retrievedSections: [],
        formattedContext: '',
        totalTokensEst: 0
      };
    }
    return localRetrievalService.retrieveContext(query, 4);
  }

  /**
   * Set call options
   */
  setOptions(options = {}) {
    if (options.answerLength) this.answerLength = options.answerLength;
    if (options.answerStyle) this.answerStyle = options.answerStyle;
    if (options.callTitle !== undefined) this.callTitle = options.callTitle;
    if (options.callNotes !== undefined) this.callNotes = options.callNotes;

    return this.getBriefStatus();
  }

  /**
   * Build non-thinking client-call system instruction
   */
  buildSystemInstruction() {
    if (!this.activeBrief) {
      return `/no_think

You are a helpful, neutral AI assistant.

Rules:
1. Answer ordinary questions naturally, directly, and concisely.
2. Do not invent personal employment, client calls, recent projects, achievements, next steps, or background work status.
3. If the user greets you (e.g. "how are you", "hello", "hi"), respond with a normal, polite, neutral greeting.
4. Do not mention client calls, recent projects, or work experience unless the user explicitly asks about them.
5. Do not append "I would want to confirm that detail before committing to it" to casual greetings or ordinary questions.
6. If the user asks about an unsupported personal or professional claim when no brief is active, state: "I would want to confirm that detail before committing to it."
7. Do not output hidden reasoning.`;
    }

    let lengthDirective = 'Keep the answer short enough to say in approximately 15 seconds (2–3 sentences).';
    if (this.answerLength === 'very-short') {
      lengthDirective = 'Keep the answer very short (1–2 sentences max).';
    } else if (this.answerLength === 'standard') {
      lengthDirective = 'Keep the answer concise but thorough (approximately 25 seconds).';
    }

    let styleDirective = 'Follow the tone and style requested in the Markdown file. If none specified, use natural conversational English.';
    if (this.answerStyle === 'natural-concise') {
      styleDirective = 'Use natural, concise, direct spoken English.';
    } else if (this.answerStyle === 'friendly-conversational') {
      styleDirective = 'Use a warm, friendly, conversational spoken tone.';
    } else if (this.answerStyle === 'technical-easy') {
      styleDirective = 'Explain technical concepts clearly in easy-to-understand spoken terms.';
    } else if (this.answerStyle === 'sales-discovery') {
      styleDirective = 'Focus on discovery, value alignment, and ask one relevant follow-up question.';
    } else if (this.answerStyle === 'formal-professional') {
      styleDirective = 'Use a polished, formal, and professional speaking style.';
    }

    return `/no_think

You are a real-time interview and call copilot assisting the user during a live client meeting.

Answer so the user can read the response aloud naturally and effortlessly during a live call.

${lengthDirective}
${styleDirective}

STRICT INSTRUCTIONS FOR LIVE CALL ANSWERS:
1. START IMMEDIATELY with a direct, 1-2 sentence spoken answer. The first 1-2 sentences MUST provide the core answer immediately so the user can begin speaking aloud instantly without hesitation.
2. Answer in natural first-person spoken language ("I worked on...", "My responsibility was...", "I handled that by...", "We used...").
3. Use short sentences and short, concise paragraphs (maximum 2-3 sentences per paragraph).
4. Keep length concise: default to 80–160 words total. Never generate long ChatGPT-style articles, introductory filler, or multi-page essays.
5. Use at most 3-5 concise bullet points when listing key responsibilities or technical facts.
6. Do NOT use robotic filler like "Certainly!", "Here is a breakdown", "Let me elaborate", "In conclusion", or "Below are the following".
7. Do NOT use emojis, tables, decorative symbols, or large Markdown headings (# or ##).
8. STRICT GROUNDING: Never invent or hallucinate technologies, cloud providers, frameworks, databases, metrics, team sizes, or architecture not explicitly listed in the context below. If a specific cloud platform, database, or tool (such as AWS, GCP, Azure, MongoDB, Python) is NOT explicitly present in the supplied context, DO NOT mention or add it.
9. Do not say "according to the brief" or "based on the document".`;
  }

  /**
   * Start New Call: reset state, clear histories, retain active brief if present
   */
  startNewCall() {
    ollamaService.cancelCurrentGeneration();
    localRetrievalService.clearCache();
    
    // Re-parse active brief if loaded
    if (this.activeBrief && this.activeBrief.content) {
      localRetrievalService.parseMarkdown(this.activeBrief.content);
    }

    this.isCallActive = true;
    return this.getBriefStatus();
  }

  /**
   * Requirement O: Grounding Safety Guard
   * Deterministic check for unsupported numeric or commercial claims
   */
  validateGroundedAnswer(response) {
    if (!response || typeof response !== 'string') return '';
    const cleanText = response.trim();
    if (!this.activeBrief) return cleanText;

    const numbersInResponse = cleanText.match(/\b\d+(?:[\.,]\d+)?\b/g) || [];
    const briefContent = this.activeBrief.content || '';

    let unsupportedNumCount = 0;
    for (const num of numbersInResponse) {
      if (!briefContent.includes(num)) {
        unsupportedNumCount++;
      }
    }

    if (unsupportedNumCount > 2) {
      return 'I would want to confirm that detail before committing to it.';
    }

    return cleanText;
  }

  /**
   * End Call & Purge: strict multi-tenant isolation
   * Unloads model from RAM, clears all brief state & session history
   */
  async endCallAndPurge() {
    ollamaService.cancelCurrentGeneration();
    localRetrievalService.clearCache();

    this.activeBrief = null;
    this.callTitle = '';
    this.callNotes = '';
    this.isCallActive = false;

    // Immediately unload Ollama model from memory (keep_alive: 0)
    await ollamaService.unloadModel();

    return {
      success: true,
      purged: true,
      filename: null,
      isCallActive: false
    };
  }

  /**
   * Create Call Brief Template file without real client data
   */
  createCallBriefTemplate(targetPath) {
    const templateContent = `# Client and Call

## Client
[Client Name or Organization]

## Call Objective
[Purpose and primary goal of the call]

## Participants
[Key client stakeholders & team members]

## Products or Services Discussed
[Core products, services, or architecture under discussion]

# My Relevant Experience

## Roles
[Your role, e.g. Senior Full-Stack Engineer / Solutions Architect]

## Years of Experience
[Total years of relevant experience]

## Industries
[SaaS, E-commerce, Healthcare, Fintech, etc.]

## Technologies
[Core tech stack, frameworks, languages, databases, cloud tools]

## Relevant Projects
[1-2 bullet points describing relevant systems you built]

## Results and Metrics
[Measurable achievements, performance gains, revenue impact]

# Expected Questions
[Common or anticipated client questions]

# Approved Claims
[Facts, experience, and topics you are explicitly approved to share]

# Claims I Must Not Make
[Things you MUST NOT claim, e.g. managing large teams, unverified certs, ML models]

# Confidential Information
[Internal metrics or NDA info that must NOT be disclosed]

# Client Problems
[Known pain points or bottlenecks the client faces]

# Proposed Solutions
[Recommended technical or business solutions]

# Questions I Should Ask
[Key discovery questions to ask the client]

# How I Should Answer
[General answer strategy & response structure guidelines]

# Tone and Speaking Style
[Conversational, direct, technical, sales-oriented, formal]

# Commitments I Must Avoid
[Delivery timelines, fixed pricing, or contractual guarantees you MUST NOT make]

# Pricing or Commercial Boundaries
[Rates, discount limits, or commercial constraints]
`;

    if (!targetPath) {
      throw new Error('Target file path is required');
    }

    fs.writeFileSync(targetPath, templateContent, 'utf-8');
    return { success: true, targetPath };
  }
}

module.exports = new CallBriefManager();
