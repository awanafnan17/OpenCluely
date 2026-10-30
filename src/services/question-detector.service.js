const EventEmitter = require('events');
const logger = require('./speech.service').logger || console;

class QuestionDetectorService extends EventEmitter {
  constructor() {
    super();
    this.reset();
  }

  reset() {
    this.partialTranscript = '';
    this.stableTranscript = '';
    this.lastSpeechTime = 0;
    this.answeredUtteranceIds = new Set();
  }

  handlePartial(text) {
    if (!text || !text.trim()) return;
    this.partialTranscript = text.trim();
    this.lastSpeechTime = Date.now();
    this.emit('partial-update', this.partialTranscript);
  }

  handleFinal(text) {
    if (!text || !text.trim()) return;
    const cleanText = text.trim();
    this.stableTranscript = cleanText;
    this.lastSpeechTime = Date.now();

    if (this.isQuestionOrRequest(cleanText)) {
      const uttId = `utt_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
      if (!this.answeredUtteranceIds.has(uttId)) {
        this.answeredUtteranceIds.add(uttId);
        logger.info('[QUESTION-DETECTOR] Finalized question detected', { uttId, text: cleanText });
        this.emit('question-detected', {
          utteranceId: uttId,
          question: cleanText,
          timestamp: Date.now()
        });
      }
    }
  }

  isQuestionOrRequest(text) {
    if (!text || text.length < 5) return false;

    const lower = text.toLowerCase();

    // Check interrogative starters & question phrases
    const questionStarters = [
      'what', 'how', 'why', 'when', 'where', 'who', 'which',
      'can you', 'could you', 'would you', 'do you', 'are you',
      'is it', 'tell me', 'explain', 'walk me through', 'describe',
      'have you', 'will you', 'should we'
    ];

    const startsWithQuestion = questionStarters.some(starter => lower.startsWith(starter) || lower.includes(` ${starter} `));
    const endsWithQuestionMark = text.endsWith('?');

    // Imperative request patterns
    const isImperativeRequest = lower.includes('tell me about') ||
                                lower.includes('explain how') ||
                                lower.includes('walk through') ||
                                lower.includes('talk about');

    return startsWithQuestion || endsWithQuestionMark || isImperativeRequest;
  }
}

module.exports = new QuestionDetectorService();
