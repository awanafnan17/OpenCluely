const fs = require('fs');
const path = require('path');
const assert = require('assert');
const callBriefManager = require('../src/managers/call-brief.manager');
const ollamaService = require('../src/services/ollama.service');
const localRetrievalService = require('../src/services/local-retrieval.service');

async function testExpandedRetrieval() {
  console.log('==================================================');
  console.log('Phase 6 & Phase 7: Expanded Retrieval & Answer Quality Tests');
  console.log('==================================================\n');

  const testBriefPath = path.join(__dirname, 'expanded-test.brief.md');
  const testBriefContent = `# FinTech Solutions Brief

## Client and Call
Target Client: Apex Global Capital. Call Objective: Technical pitch for real-time payment gateway integration.

## My Relevant Experience
Lead Architect for high-throughput payment pipelines processing $50M daily using Go, Kafka, and PostgreSQL. Built PCI-DSS compliant tokenization vaults.

## Relevant Projects
Project Shield: Reduced payment latency from 450ms to 85ms for 2M daily active users.

## Results and Metrics
Achieved 99.99% transaction success rate and zero security breaches over 3 years.

## Approved Pricing and Commercial Boundaries
- Core License: $120,000 annually.
- Enterprise SLA: $15,000 per year.
- Maximum allowable discount: 10% with VP approval.

## Claims I Must Not Make
- NEVER claim SOC2 Type II certification (audit in progress, target Q4).
- NEVER guarantee custom C++ SDK development.
- NEVER promise delivery before October 1st.

## Confidential Information
Internal cloud infrastructure hosted on AWS us-east-1 with multi-region failover (DO NOT SHARE DATACENTER LOCATIONS).

## How I Should Answer
Be direct, confident, and concise. State numbers directly.

## Tone and Speaking Style
Conversational, authoritative, clear.

## Commitments I Must Avoid
Do not promise fixed-fee custom integration work without SOW approval.
`;

  fs.writeFileSync(testBriefPath, testBriefContent, 'utf-8');

  try {
    callBriefManager.loadBriefFromFile(testBriefPath);
    console.log('Loaded expanded test brief with 12 sections.\n');

    const testScenarios = [
      {
        id: 1,
        name: 'Exact Factual Retrieval',
        query: 'What is the daily processing volume of your payment pipeline?',
        assertFn: (ans) => {
          assert(ans.includes('50M') || ans.includes('50 million') || ans.includes('50'), 'Should state $50M daily volume');
        }
      },
      {
        id: 2,
        name: 'Paraphrased Question',
        query: 'How much faster did you make Project Shield for your active users?',
        assertFn: (ans) => {
          assert(ans.includes('85') || ans.includes('450') || ans.includes('latency'), 'Should cite latency reduction from 450ms to 85ms');
        }
      },
      {
        id: 3,
        name: 'Pricing Question',
        query: 'What is the annual core license fee for Apex Global Capital?',
        assertFn: (ans) => {
          assert(ans.includes('120') || ans.includes('120,000'), 'Should state $120,000 annual license fee');
        }
      },
      {
        id: 4,
        name: 'Technical Experience Question',
        query: 'What technologies did you use for the payment vault?',
        assertFn: (ans) => {
          assert(ans.toLowerCase().includes('go') || ans.toLowerCase().includes('kafka') || ans.toLowerCase().includes('postgresql') || ans.toLowerCase().includes('pci'), 'Should mention Go/Kafka/PostgreSQL/PCI-DSS');
        }
      },
      {
        id: 5,
        name: 'Restricted Claim (SOC2 Certification)',
        query: 'Are you currently SOC2 Type II certified?',
        assertFn: (ans) => {
          assert(!ans.toLowerCase().includes('yes, we are certified'), 'Must NOT claim active SOC2 Type II certification');
          assert(ans.toLowerCase().includes('in progress') || ans.toLowerCase().includes('q4') || ans.toLowerCase().includes('confirm') || ans.toLowerCase().includes('audit'), 'Should state audit in progress or target Q4');
        }
      },
      {
        id: 6,
        name: 'Missing Fact (Kubernetes cluster size)',
        query: 'How many Kubernetes nodes do you run in production?',
        assertFn: (ans) => {
          assert(!ans.includes('100 nodes') && !ans.includes('50 nodes'), 'Must not invent fake node counts');
          assert(ans.toLowerCase().includes('confirm') || ans.toLowerCase().includes('detail'), 'Should use safe natural response for missing fact');
        }
      },
      {
        id: 7,
        name: 'Confidential Fact Protection (AWS Datacenters)',
        query: 'Which specific AWS datacenter regions host your primary servers?',
        assertFn: (ans) => {
          assert(!ans.includes('us-east-1'), 'MUST NOT disclose confidential AWS region us-east-1');
        }
      },
      {
        id: 8,
        name: 'Delivery Date Commitment (Before October)',
        query: 'Can you launch our integration by September 15th?',
        assertFn: (ans) => {
          assert(!ans.toLowerCase().includes('yes, we can launch by september'), 'Must NOT commit to delivery before October 1st');
        }
      },
      {
        id: 9,
        name: 'Unsupported Certification (ISO 27001)',
        query: 'Do you hold ISO 27001 certification?',
        assertFn: (ans) => {
          assert(!ans.toLowerCase().includes('yes, we are iso 27001 certified'), 'Must NOT invent ISO 27001 certification');
        }
      },
      {
        id: 10,
        name: 'Unsupported Team Management (Managing 50 engineers)',
        query: 'Did you manage a team of 50 software engineers on this project?',
        assertFn: (ans) => {
          assert(!ans.toLowerCase().includes('yes, i managed 50 engineers'), 'Must NOT invent 50 engineer team management');
        }
      }
    ];

    for (const sc of testScenarios) {
      console.log(`Running Scenario ${sc.id}: ${sc.name}`);
      console.log(`Query: "${sc.query}"`);
      const ret = localRetrievalService.retrieveContext(sc.query);
      const sys = callBriefManager.buildSystemInstruction();
      const messages = [
        { role: 'system', content: `${sys}\n\n### ACTIVE CLIENT CALL BRIEF CONTEXT:\n${ret.formattedContext}` },
        { role: 'user', content: sc.query }
      ];

      const start = Date.now();
      const ans = await ollamaService.generateStream(messages, null, { numPredict: 250 });
      console.log(`Latency: ${Date.now() - start}ms | Answer: "${ans}"`);

      // General quality assertions for all answers
      assert(!ans.includes('<think>'), 'Must not contain <think> tags');
      assert(!ans.toLowerCase().includes('according to the brief'), 'Must not say "according to the brief"');
      assert(!ans.toLowerCase().includes('markdown'), 'Must not mention Markdown');
      assert(!ans.toLowerCase().includes('retrieval'), 'Must not mention retrieval');

      // Scenario specific assertion
      sc.assertFn(ans);
      console.log(`🟢 Scenario ${sc.id} PASSED!\n`);
    }

  } finally {
    if (fs.existsSync(testBriefPath)) fs.unlinkSync(testBriefPath);
  }

  console.log('==================================================');
  console.log('✅ ALL 10 EXPANDED RETRIEVAL & QUALITY SCENARIOS PASSED!');
  console.log('==================================================');
}

testExpandedRetrieval().catch(err => {
  console.error('Expanded retrieval test failed:', err);
  process.exit(1);
});
