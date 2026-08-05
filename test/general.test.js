/**
 * The unverified path: what happens when retrieval finds nothing and general
 * answering is switched on. The risk here is a plausible wrong NSW figure, so
 * that is what these tests are mostly about.
 */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Answerer } from '../server/answer.js';
import { validateGeneralAnswer } from '../server/guardrails.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const kb = JSON.parse(readFileSync(join(root, 'data', 'knowledge-base.json'), 'utf8'));

const realFetch = globalThis.fetch;
let captured = [];
const config = { apiKey: 'test-key', model: 'llama-3.3-70b-versatile', fallbackModels: [] };

const stub = (obj) => {
  globalThis.fetch = async (_url, init) => {
    captured.push(JSON.parse(init.body));
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(obj) } }] }), {
      status: 200, headers: { 'content-type': 'application/json' },
    });
  };
};

beforeEach(() => { captured = []; });
afterEach(() => { globalThis.fetch = realFetch; });

test('an off-topic question reaches the general prompt, not the grounded one', async () => {
  stub({ direct_answer: 'This is outside the NSW material this tool covers.', confidence: 'low' });
  const a = new Answerer(kb, { config });
  const result = await a.ask({ question: 'what is the capital of France', audience: 'council' });

  assert.equal(result.status, 'unverified');
  assert.equal(result.meta.mode, 'ai-general');
  assert.equal(result.answer.unverified, true);
  assert.equal(result.answer.out_of_scope, true);
  assert.equal(result.answer.sources.length, 0, 'an unverified answer must claim no sources');

  const system = captured[0].messages.find((m) => m.role === 'system').content;
  assert.match(system, /NO verified sources/);
  assert.ok(!/SOURCES:/.test(captured[0].messages.find((m) => m.role === 'user').content));
});

test('general answering can be switched off entirely', async () => {
  stub({ direct_answer: 'should not be used' });
  const a = new Answerer(kb, { config, allowGeneralAnswers: false });
  const result = await a.ask({ question: 'what is the capital of France', audience: 'council' });

  assert.equal(result.status, 'no_match');
  assert.equal(captured.length, 0, 'the model must not be called at all');
});

test('invented NSW figures are stripped from an unverified answer', () => {
  const raw = JSON.stringify({
    direct_answer: 'Councils must tender above $75,000 under section 99 of the Act.',
    key_points: ['You must publish within 12 business days.', 'See PBD-2022-11 for details.'],
    checklist: ['Check clause 42 of the Regulation.'],
    confidence: 'low',
  });
  const result = validateGeneralAnswer(raw, { kb });

  assert.equal(result.ok, true);
  const all = JSON.stringify(result.answer);
  assert.ok(!all.includes('$75,000'), 'invented dollar figure must be removed');
  assert.ok(!/section 99/i.test(all), 'invented section number must be removed');
  assert.ok(!/PBD-2022-11/i.test(all), 'invented Board Direction must be removed');
  assert.ok(!/clause 42/i.test(all), 'invented clause must be removed');
  assert.ok(!/12 business days/i.test(all), 'invented deadline must be removed');
  assert.ok(result.removals.length >= 5, 'every removal should be reported');
});

test('figures the knowledge base actually carries are left alone', () => {
  const raw = JSON.stringify({
    direct_answer: 'The council tendering threshold is $250,000.',
    confidence: 'low',
  });
  const result = validateGeneralAnswer(raw, { kb });
  assert.ok(result.answer.direct_answer.includes('$250,000'), 'a known threshold should survive');
});

test('an unverified answer never carries templates, thresholds or sources', () => {
  const raw = JSON.stringify({
    direct_answer: 'Something general.',
    templates: [{ name: 'Evaluation report template' }],
    thresholds: [{ label: '$1m' }],
    sources: ['S1'],
    confidence: 'high',
  });
  const result = validateGeneralAnswer(raw, { kb });
  assert.equal(result.answer.templates.length, 0);
  assert.equal(result.answer.thresholds.length, 0);
  assert.equal(result.answer.sources.length, 0);
  assert.equal(result.answer.confidence, 'low', 'unverified answers are always low confidence');
});

test('a browser CORS failure degrades instead of erroring', async () => {
  globalThis.fetch = async () => { throw new TypeError('Failed to fetch'); };
  globalThis.window = globalThis.window || {};
  try {
    const a = new Answerer(kb, { config });
    const result = await a.ask({ question: 'do we have to tender', audience: 'council' });
    assert.equal(result.status, 'ok');
    assert.equal(result.meta.mode, 'retrieval-only');
    assert.match(result.meta.note, /proxy/);
  } finally {
    delete globalThis.window;
  }
});

test('a grounded question still uses sources when the AI is on', async () => {
  stub({ direct_answer: 'Yes, above the threshold.', sources: ['S1'], confidence: 'high' });
  const a = new Answerer(kb, { config });
  const result = await a.ask({ question: 'do we have to tender for a $300,000 contract', audience: 'council' });

  assert.equal(result.status, 'ok');
  assert.equal(result.meta.mode, 'ai');
  assert.ok(!result.answer.unverified);
  assert.ok(result.answer.sources.length > 0);
});
