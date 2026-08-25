import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateAnswer } from '../server/guardrails.js';
import { Index } from '../server/retrieval.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const kb = JSON.parse(readFileSync(join(root, 'data', 'knowledge-base.json'), 'utf8'));
const index = new Index(kb);

const context = (q = 'do we have to tender', audience = 'council') => {
  const hits = index.search(q, { audience, limit: 5 });
  return { hits, supporting: index.supporting(q, hits, audience), kb };
};

test('a well-formed answer passes through intact', () => {
  const ctx = context();
  const raw = JSON.stringify({
    direct_answer: 'Yes, above $250,000 a council must invite tenders.',
    applies_to_you: 'You are a council, so the Local Government Act applies.',
    key_points: ['Section 55 requires tendering.'],
    checklist: ['Estimate the whole contract value.'],
    thresholds: [{ label: '$250,000', detail: 'Council tendering threshold.' }],
    templates: [],
    watch_outs: ['Do not split a contract to avoid the threshold.'],
    summary: 'Tender above $250,000.',
    sources: ['S1'],
    confidence: 'high',
    out_of_scope: false,
  });
  const result = validateAnswer(raw, ctx);
  assert.equal(result.ok, true);
  assert.equal(result.answer.direct_answer, 'Yes, above $250,000 a council must invite tenders.');
  assert.equal(result.answer.confidence, 'high');
  assert.equal(result.answer.sources.length, 1);
});

test('fabricated URLs are stripped from every text field', () => {
  const ctx = context();
  const raw = JSON.stringify({
    direct_answer: 'See https://totally-made-up.example.com/rules for details.',
    key_points: ['Read the guide at www.fake-nsw-procurement.example'],
    checklist: ['Download [the form](https://evil.example/form.docx)'],
    summary: 'More at http://not-real.example',
    sources: ['S1'],
    confidence: 'high',
  });
  const result = validateAnswer(raw, ctx);
  assert.equal(result.ok, true);
  const serialised = JSON.stringify({
    d: result.answer.direct_answer,
    k: result.answer.key_points,
    c: result.answer.checklist,
    s: result.answer.summary,
  });
  assert.ok(!/https?:\/\//.test(serialised), 'no URL should survive in model-authored text');
  assert.ok(!/www\./.test(serialised));
  assert.ok(result.answer.checklist[0].includes('the form'), 'markdown link label should be kept');
  assert.ok(result.removals.some((r) => r.includes('URL')));
});

test('invented template names are dropped, real ones keep the knowledge base URL', () => {
  const ctx = context('what templates do I need for an evaluation', 'agency');
  const raw = JSON.stringify({
    direct_answer: 'Use the evaluation templates.',
    templates: [
      { name: 'Completely Invented Mega Template', why: 'nope' },
      { name: 'Evaluation report template', why: 'documents the recommendation' },
    ],
    sources: ['S1'],
    confidence: 'medium',
  });
  const result = validateAnswer(raw, ctx);
  assert.equal(result.ok, true);
  assert.ok(!result.answer.templates.some((t) => /Invented/i.test(t.name)));
  const real = result.answer.templates.find((t) => /Evaluation report/i.test(t.name));
  assert.ok(real, 'the real template should survive');
  assert.ok(kb.allowed_urls.includes(real.url), 'template URL must come from the knowledge base');
  assert.ok(result.removals.some((r) => r.includes('unknown template')));
});

test('citations to sources that were never supplied are rejected', () => {
  const ctx = context();
  const raw = JSON.stringify({
    direct_answer: 'Something.',
    sources: ['S1', 'S99', 'S42'],
    confidence: 'high',
  });
  const result = validateAnswer(raw, ctx);
  assert.equal(result.answer.sources.length, 1);
  assert.ok(result.removals.some((r) => r.includes('S99')));
});

test('an answer citing nothing valid is downgraded rather than trusted', () => {
  const ctx = context();
  const raw = JSON.stringify({ direct_answer: 'Confident nonsense.', sources: [], confidence: 'high' });
  const result = validateAnswer(raw, ctx);
  assert.equal(result.answer.confidence, 'medium');
  assert.ok(result.removals.includes('no valid source citations returned'));
  assert.ok(result.answer.sources.length > 0, 'provenance should fall back to the retrieved evidence');
});

test('JSON wrapped in prose or a code fence is still parsed', () => {
  const ctx = context();
  const raw = 'Here you go:\n```json\n{"direct_answer":"Wrapped answer.","sources":["S1"],"confidence":"medium"}\n```\nHope that helps.';
  const result = validateAnswer(raw, ctx);
  assert.equal(result.ok, true);
  assert.equal(result.answer.direct_answer, 'Wrapped answer.');
});

test('unparseable output is rejected outright', () => {
  const result = validateAnswer('I am afraid I cannot help with that.', context());
  assert.equal(result.ok, false);
});

test('list lengths are capped so one bad response cannot flood the page', () => {
  const ctx = context();
  const raw = JSON.stringify({
    direct_answer: 'ok',
    checklist: Array.from({ length: 40 }, (_, i) => `step ${i}`),
    key_points: Array.from({ length: 40 }, (_, i) => `point ${i}`),
    sources: ['S1'],
  });
  const result = validateAnswer(raw, ctx);
  assert.ok(result.answer.checklist.length <= 10);
  assert.ok(result.answer.key_points.length <= 6);
});
