/**
 * Exercises the full ask() pipeline with a stubbed Groq endpoint, so prompt
 * construction, model fallback, guardrails and the high-demand path are all
 * covered without a network call.
 */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Answerer } from '../server/answer.js';
import { RateLimiter } from '../server/rateLimit.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const kb = JSON.parse(readFileSync(join(root, 'data', 'knowledge-base.json'), 'utf8'));

const realFetch = globalThis.fetch;
const realKey = process.env.GROQ_API_KEY;
let captured = [];

const stub = (handler) => {
  globalThis.fetch = async (url, init) => {
    captured.push({ url: String(url), body: JSON.parse(init.body) });
    return handler(captured.length);
  };
};

const jsonResponse = (payload, status = 200, headers = {}) =>
  new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });

const completion = (obj, model = 'llama-3.3-70b-versatile') =>
  jsonResponse({ choices: [{ message: { content: JSON.stringify(obj) } }], model, usage: { total_tokens: 900 } });

beforeEach(() => {
  captured = [];
  process.env.GROQ_API_KEY = 'test-key-not-real';
});

afterEach(() => {
  globalThis.fetch = realFetch;
  if (realKey === undefined) delete process.env.GROQ_API_KEY;
  else process.env.GROQ_API_KEY = realKey;
});

test('the model is given retrieved sources and never asked a bare question', async () => {
  stub(() => completion({ direct_answer: 'Yes.', sources: ['S1'], confidence: 'high' }));
  const answerer = new Answerer(kb);
  await answerer.ask({ question: 'do we have to tender for a $300,000 waste contract', audience: 'council' });

  assert.equal(captured.length, 1);
  const userMessage = captured[0].body.messages.find((m) => m.role === 'user').content;
  assert.match(userMessage, /SOURCES:/);
  assert.match(userMessage, /\[S1\]/);
  assert.match(userMessage, /Local Government Act/, 'council question must carry council sources');

  const systemMessage = captured[0].body.messages.find((m) => m.role === 'system').content;
  assert.match(systemMessage, /Answer ONLY from the numbered SOURCES/);
  assert.equal(captured[0].body.response_format.type, 'json_object');
});

test('a question with no matching content never reaches the model', async () => {
  stub(() => { throw new Error('the model should not have been called'); });
  const answerer = new Answerer(kb);
  const result = await answerer.ask({ question: 'purple monkey dishwasher xyzzy', audience: 'council' });

  assert.equal(captured.length, 0);
  assert.equal(result.status, 'no_match');
  assert.equal(result.answer.out_of_scope, true);
  assert.ok(result.answer.suggestions.length > 0);
});

test('a 429 from Groq becomes a high-demand error the UI can render', async () => {
  stub(() => jsonResponse({ error: 'rate limited' }, 429, { 'retry-after': '45' }));
  const answerer = new Answerer(kb);
  await assert.rejects(
    () => answerer.ask({ question: 'do we have to tender', audience: 'council' }),
    (err) => {
      assert.equal(err.kind, 'high_demand');
      assert.equal(err.retryAfter, 45);
      return true;
    }
  );
});

test('an unavailable model falls back to the next one in the chain', async () => {
  process.env.GROQ_FALLBACK_MODELS = 'llama-3.1-8b-instant';
  stub((call) =>
    call === 1
      ? jsonResponse({ error: { message: 'model has been decommissioned' } }, 404)
      : completion({ direct_answer: 'Answered by the fallback.', sources: ['S1'] }, 'llama-3.1-8b-instant')
  );
  const answerer = new Answerer(kb);
  const result = await answerer.ask({ question: 'do we have to tender', audience: 'council' });

  assert.equal(captured.length, 2);
  assert.equal(captured[0].body.model, 'llama-3.3-70b-versatile');
  assert.equal(captured[1].body.model, 'llama-3.1-8b-instant');
  assert.equal(result.answer.direct_answer, 'Answered by the fallback.');
  delete process.env.GROQ_FALLBACK_MODELS;
});

test('a hallucinating model is caught: fake links and templates never reach the user', async () => {
  stub(() =>
    completion({
      direct_answer: 'Download the form at https://fake.example/form.docx and read www.invented.example',
      checklist: ['Visit https://not-a-real-nsw-site.example/tender'],
      templates: [{ name: 'The Imaginary Council Mega Tender Kit', why: 'made up' }],
      sources: ['S1'],
      confidence: 'high',
    })
  );
  const answerer = new Answerer(kb);
  const result = await answerer.ask({ question: 'do we have to tender', audience: 'council' });

  const text = JSON.stringify({ d: result.answer.direct_answer, c: result.answer.checklist });
  assert.ok(!/https?:\/\//.test(text), 'model-authored URLs must be stripped');
  assert.ok(!result.answer.templates.some((t) => /Imaginary/i.test(t.name)));
  for (const template of result.answer.templates) {
    assert.ok(kb.allowed_urls.includes(template.url), `template ${template.name} must use a knowledge base URL`);
  }
  assert.ok(result.meta.removed.length > 0, 'removals should be reported for observability');
});

test('unparseable model output degrades to a knowledge base answer rather than an error', async () => {
  stub(() => jsonResponse({ choices: [{ message: { content: 'Sorry, I cannot do that.' } }] }));
  const answerer = new Answerer(kb);
  const result = await answerer.ask({ question: 'do we have to tender', audience: 'council' });

  assert.equal(result.status, 'ok');
  assert.equal(result.meta.mode, 'retrieval-only');
  assert.ok(result.answer.direct_answer.length > 0);
  assert.match(result.meta.note, /safety checks/);
});

test('a rejected API key degrades instead of taking the tool down', async () => {
  stub(() => jsonResponse({ error: 'invalid api key' }, 401));
  const answerer = new Answerer(kb);
  const result = await answerer.ask({ question: 'do we have to tender', audience: 'council' });

  assert.equal(result.status, 'ok');
  assert.equal(result.meta.mode, 'retrieval-only');
});

test('answers for a council never surface NSW-agency-only sources', async () => {
  stub(() => completion({ direct_answer: 'ok', sources: ['S1', 'S2', 'S3', 'S4', 'S5'], confidence: 'medium' }));
  const answerer = new Answerer(kb);
  const result = await answerer.ask({ question: 'do we have to go to tender for a $300,000 contract', audience: 'council' });

  assert.ok(result.answer.sources.length > 0);
  for (const source of result.answer.sources) {
    assert.notEqual(source.jurisdiction, 'nsw-government', `${source.heading} is agency-only`);
  }
});

test('rate limiter allows a normal burst then holds the line for a minute', () => {
  const limiter = new RateLimiter({ perClientPerMinute: 3, globalPerMinute: 100, maxConcurrent: 5 });
  assert.equal(limiter.take('1.2.3.4').allowed, true);
  assert.equal(limiter.take('1.2.3.4').allowed, true);
  assert.equal(limiter.take('1.2.3.4').allowed, true);

  const blocked = limiter.take('1.2.3.4');
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.reason, 'per_client');
  assert.ok(blocked.retryAfter > 0 && blocked.retryAfter <= 60);

  assert.equal(limiter.take('9.9.9.9').allowed, true, 'other visitors are unaffected');
});

test('rate limiter reports "busy" when too many requests are already in flight', () => {
  const limiter = new RateLimiter({ perClientPerMinute: 50, globalPerMinute: 500, maxConcurrent: 2 });
  limiter.enter();
  limiter.enter();
  const blocked = limiter.take('1.2.3.4');
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.reason, 'busy');
  assert.equal(blocked.retryAfter, 60);

  limiter.leave();
  assert.equal(limiter.take('1.2.3.4').allowed, true);
});
