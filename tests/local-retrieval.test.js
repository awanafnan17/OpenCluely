const assert = require('assert');
const localRetrievalService = require('../src/services/local-retrieval.service');

console.log('--- Testing Local Retrieval Service ---');

// Test 1: Markdown Heading Parsing
const sampleMarkdown = `
# Apex Software Systems Brief

## Key Selling Points
Apex CRM reduces response times by 50% and automates follow-ups.

## Claims I Must Not Make
Never guarantee 100% uptime or commit to custom features without approval.

### Approved Pricing
Standard tier is $49 per user per month.

## Tone and Speaking Style
Professional, empathetic, and clear.
`;

const sections = localRetrievalService.parseMarkdown(sampleMarkdown);
console.log('Parsed headings count:', sections.length);
assert.strictEqual(sections.length, 4, 'Should parse 4 heading sections');
assert.strictEqual(sections[1].title, 'Claims I Must Not Make');
assert.strictEqual(sections[1].isRestricted, true, 'Claims I Must Not Make should be marked restricted');

// Test 2: BM25/Keyword Retrieval with Priority for Restricted Content
const retrieval = localRetrievalService.retrieveContext('What is the uptime guarantee and pricing?');
console.log('Retrieved sections count:', retrieval.retrievedSections.length);
assert(retrieval.retrievedSections.length > 0, 'Should retrieve relevant sections');

// Restricted section must be included
const hasRestricted = retrieval.retrievedSections.some(s => s.isRestricted);
assert.strictEqual(hasRestricted, true, 'Restricted claims section must be prioritized');

// Test 3: Formatting Context Payload
assert(retrieval.formattedContext.toLowerCase().includes('claims i must not make'), 'Formatted context should contain restricted claims heading');

console.log('✅ Local Retrieval Service tests PASSED!');
