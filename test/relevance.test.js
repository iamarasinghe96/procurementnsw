/**
 * The gate between "answer from sources" and "answer unverified".
 *
 * Raw BM25 scores are not comparable across queries, so relevance is judged on
 * coverage (how much of the question's distinctive vocabulary a hit explains)
 * and topical coverage (how much of that landed in the chunk's curated labels
 * rather than incidentally in its prose). These cases are the regression set.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Index, relevant } from '../server/retrieval.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const kb = JSON.parse(readFileSync(join(root, 'data', 'knowledge-base.json'), 'utf8'));
const index = new Index(kb);
const accepts = (q, audience) => relevant(index.search(q, { audience, limit: 8 })).length > 0;
const top = (q, audience) => relevant(index.search(q, { audience, limit: 8 }))[0]?.chunk.id;

test('off-topic questions are not treated as answerable from the knowledge base', () => {
  const offTopic = [
    ['What is the capital of France?', 'council'],
    ['recipe for banana bread', null],
    ['who won the cricket', null],
    ['tell me a joke', null],
    // Matches "application" in "fresh applications from interested persons".
    ['how do I write a good job application', 'council'],
    // "tomorrow" appears once, in a probity checklist line.
    ['what is the weather tomorrow', 'council'],
    // LPG is not in the knowledge base; LGP is, but they are different things.
    ['What is LPG and can we buy it?', 'council'],
  ];
  for (const [q, audience] of offTopic) {
    assert.equal(accepts(q, audience), false, `"${q}" should not be answered from sources`);
  }
});

test('real procurement questions are answerable from sources', () => {
  const onTopic = [
    ['Do I have to go to tender for a $300,000 contract?', 'council'],
    ['kerbside collection contract management meetings', 'council'],
    ['when will I get paid', 'supplier'],
    ['how do I report corruption', null],
    ['what checks do I run on a supplier', 'agency'],
    ['how do I register to sell to NSW government', 'supplier'],
    ['my brother works for one of the bidders', 'agency'],
    ['what is an RFQ', 'agency'],
    ['do we need a probity adviser', 'council'],
    ['can we buy off an LGP panel', 'council'],
    ['what goes in our contracts register', 'council'],
    ['modern slavery obligations', 'council'],
    ['how long should a tender be open', 'agency'],
    ['what is my agency accredited to buy', 'agency'],
    ['how do I debrief an unsuccessful supplier', 'agency'],
  ];
  for (const [q, audience] of onTopic) {
    assert.equal(accepts(q, audience), true, `"${q}" should be answerable`);
  }
});

test('a chunk that is ABOUT the question beats one that merely mentions it', () => {
  // councils.lgp-panels uses the phrase "value for money" twice in prose and
  // gets a council jurisdiction boost, so it used to win. It must not.
  for (const audience of ['council', 'agency']) {
    assert.notEqual(top('what is value for money', audience), 'councils.lgp-panels');
  }
  // An agency gets the Framework definition; a council gets the OLG guidance it
  // is bound to consider. Same question, different binding source.
  assert.equal(top('what is value for money', 'agency'), 'objectives.value-for-money');
  assert.equal(top('what is value for money', 'council'), 'olg.value-for-money-factors');
});

test('a figure in the question does not count against understanding it', () => {
  // "$300,000" is a value the reader supplied, not vocabulary the knowledge
  // base must contain.
  const withFigure = index.search('Do I have to go to tender for a $300,000 contract?', {
    audience: 'council', limit: 1,
  })[0];
  assert.ok(withFigure.coverage > 0.9, `coverage was ${withFigure.coverage}`);
});

test('stemming links a term to its inflections', () => {
  // "accredited" and "accreditation" must reach the same place.
  assert.ok(accepts('what is my agency accredited to buy', 'agency'));
  assert.ok(accepts('accreditation levels', 'agency'));
});

test('coverage and topical coverage are reported on every hit', () => {
  for (const hit of index.search('do we have to tender', { audience: 'council', limit: 5 })) {
    assert.ok(hit.coverage >= 0 && hit.coverage <= 1);
    assert.ok(hit.topicalCoverage >= 0 && hit.topicalCoverage <= hit.coverage + 1e-9);
  }
});
