/**
 * Local Retrieval Service
 * In-process, lightweight, heading-aware Markdown parser & lexical retriever.
 * Tailored for 8 GB Mac memory without vector DBs or external embedding models.
 */

class LocalRetrievalService {
  constructor() {
    this.sections = [];
    this.rawMarkdown = '';
    
    // Headings that MUST be prioritized and included if present
    this.restrictedHeadings = [
      'claims i must not make',
      'commitments i must avoid',
      'confidential information',
      'how i should answer',
      'tone and speaking style',
      'approved claims',
      'prohibited claims',
      'must not claim',
      'must not commit'
    ];
  }

  /**
   * Parse Markdown document into heading-aware sections
   * @param {string} markdownText 
   * @returns {Array<{ id: string, title: string, content: string, isRestricted: boolean, level: number }>}
   */
  parseMarkdown(markdownText) {
    this.rawMarkdown = markdownText || '';
    this.sections = [];

    if (!markdownText || typeof markdownText !== 'string' || !markdownText.trim()) {
      return this.sections;
    }

    const lines = markdownText.split('\n');
    let currentTitle = 'General Overview';
    let currentContent = [];
    let currentLevel = 1;
    let sectionIdCounter = 1;

    for (const line of lines) {
      const headingMatch = line.match(/^(#{1,6})\s+(.+)$/);
      if (headingMatch) {
        // Save previous section if it has non-empty content
        if (currentContent.length > 0) {
          const bodyText = currentContent.join('\n').trim();
          if (bodyText) {
            this.sections.push(this._createSection(
              `section-${sectionIdCounter++}`,
              currentTitle,
              bodyText,
              currentLevel
            ));
          }
        }
        currentLevel = headingMatch[1].length;
        currentTitle = headingMatch[2].trim();
        currentContent = [];
      } else {
        currentContent.push(line);
      }
    }

    // Push the final section
    if (currentContent.length > 0) {
      const bodyText = currentContent.join('\n').trim();
      if (bodyText) {
        this.sections.push(this._createSection(
          `section-${sectionIdCounter++}`,
          currentTitle,
          bodyText,
          currentLevel
        ));
      }
    }

    return this.sections;
  }

  _createSection(id, title, content, level) {
    const titleLower = title.toLowerCase();
    const isRestricted = this.restrictedHeadings.some(h => titleLower.includes(h));
    
    return {
      id,
      title,
      content,
      level,
      isRestricted,
      fullText: `### ${title}\n${content}`
    };
  }

  /**
   * Retrieve relevant sections for a query
   * @param {string} query 
   * @param {number} maxSections - Max non-restricted sections to include (default: 3)
   * @returns {{ retrievedSections: Array, formattedContext: string, totalTokensEst: number }}
   */
  retrieveContext(query = '', maxSections = 3) {
    if (!this.sections || this.sections.length === 0) {
      return {
        retrievedSections: [],
        formattedContext: '',
        totalTokensEst: 0
      };
    }

    const cleanQuery = (query || '').toLowerCase().trim();
    const queryTokens = this._tokenize(cleanQuery);

    // 1. Mandatory / Restricted sections ALWAYS included first
    const restrictedSections = this.sections.filter(s => s.isRestricted);
    const selectedIds = new Set(restrictedSections.map(s => s.id));

    // 2. Score remaining sections using BM25 / term-frequency lexical scoring
    const remainingSections = this.sections.filter(s => !selectedIds.has(s.id));
    const scoredSections = remainingSections.map(section => {
      const score = this._calculateScore(queryTokens, section);
      return { section, score };
    });

    // Sort by relevance score descending
    scoredSections.sort((a, b) => b.score - a.score);

    // Take top maxSections relevant sections (even if score is 0, ensure base context)
    const topRelevant = scoredSections.slice(0, maxSections).map(item => item.section);

    // Combine restricted + top relevant
    const finalSections = [...restrictedSections, ...topRelevant];

    // Build formatted context payload
    const formattedContext = finalSections.map(s => s.fullText).join('\n\n');
    const totalTokensEst = Math.ceil(formattedContext.length / 4);

    return {
      retrievedSections: finalSections,
      formattedContext,
      totalTokensEst
    };
  }

  /**
   * Alias for retrieveContext returning sections and latency diagnostic
   */
  retrieveRelevantSections(query = '', maxSections = 3) {
    const startTime = Date.now();
    const res = this.retrieveContext(query, maxSections);
    return {
      sections: res.retrievedSections,
      formattedContext: res.formattedContext,
      totalTokensEst: res.totalTokensEst,
      latencyMs: Date.now() - startTime
    };
  }

  /**
   * Calculate lexical relevance score for a section
   */
  _calculateScore(queryTokens, section) {
    if (!queryTokens || queryTokens.length === 0) return 0;

    const titleTokens = this._tokenize(section.title.toLowerCase());
    const contentTokens = this._tokenize(section.content.toLowerCase());

    let score = 0;

    for (const qToken of queryTokens) {
      // Title match bonus
      if (titleTokens.includes(qToken)) {
        score += 3.0;
      }
      // Content frequency score
      const contentMatches = contentTokens.filter(t => t === qToken).length;
      score += contentMatches * 1.0;
    }

    return score;
  }

  /**
   * Simple word tokenizer
   */
  _tokenize(text) {
    if (!text) return [];
    return text.toLowerCase()
      .replace(/[^\w\s]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length > 2);
  }

  /**
   * Clear all loaded sections and state
   */
  clearCache() {
    this.sections = [];
    this.rawMarkdown = '';
  }
}

module.exports = new LocalRetrievalService();
