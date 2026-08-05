import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Index, tokenize, detectIntent } from '../server/retrieval.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const kb = JSON.parse(readFileSync(join(root, 'data', 'knowledge-base.json'), 'utf8'));
const index = new Index(kb);

const topIds = (q, audience, n = 5) =>
  index.search(q, { audience, limit: n }).map((h) => h.chunk.id);

test('tokenizer strips stopwords and punctuation', () => {
  const tokens = tokenize('Do I have to go to tender for a $300,000 contract?');
  assert.ok(tokens.includes('tender'));
  assert.ok(tokens.includes('contract'));
  assert.ok(!tokens.includes('to'));
});

test('intent detection recognises checklist, template and threshold questions', () => {
  assert.equal(detectIntent('what are the steps to run a tender').wantsChecklist, true);
  assert.equal(detectIntent('is there a template for an evaluation plan').wantsTemplates, true);
  assert.equal(detectIntent('how much can I spend without tendering').wantsThresholds, true);
  assert.equal(detectIntent('what are the risks of a variation').wantsRisks, true);
});

test('the kerbside contract management question retrieves the waste guidance first', () => {
  const q = 'Manage procurement processes as part of the kerbside collection contract, including supporting contract management meetings and review of contract schedules and performance management';
  const ids = topIds(q, 'council');
  assert.equal(ids[0], 'councils.waste-contract-management');
  assert.ok(ids.includes('managing.contract-management-practice'));
});

test('the same tender question routes councils and agencies to different rulebooks', () => {
  const q = 'Do I have to go to tender for a $300,000 contract?';

  const councilTop = index.search(q, { audience: 'council', limit: 3 })[0].chunk;
  assert.equal(councilTop.jurisdiction, 'local-government');
  assert.equal(councilTop.id, 'councils.tender-threshold');

  const agencyHits = index.search(q, { audience: 'agency', limit: 5 });
  assert.equal(agencyHits[0].chunk.jurisdiction, 'nsw-government');
  assert.ok(
    !agencyHits.some((h) => h.chunk.jurisdiction === 'local-government'),
    'agency results must not contain council-only rules'
  );
});

test('supplier questions reach supplier-side guidance', () => {
  assert.equal(topIds('how do I register to sell to NSW government', 'supplier')[0], 'suppliers.getting-registered');
  assert.equal(topIds('when will I get paid for my invoice', 'supplier')[0], 'suppliers.getting-paid');
  assert.ok(topIds('why did I lose the tender and can I get feedback', 'supplier')
    .includes('suppliers.debriefs-and-complaints'));
});

test('integrity questions reach corruption prevention guidance', () => {
  assert.equal(topIds('a supplier offered me tickets to the football', 'council')[0], 'corruption.improper-influence-gifts');
  assert.equal(topIds('how do I report corruption', null)[0], 'corruption.ethical-obligations-reporting');
  assert.ok(topIds('my brother works for one of the bidders', 'agency')
    .includes('corruption.conflicts-of-interest'));
});

test('synonym expansion connects informal wording to the right chunk', () => {
  assert.ok(topIds('garbage and rubbish bin collection contract', 'council')
    .includes('councils.waste-contract-management'));
  assert.ok(topIds('what is a COI', 'agency').includes('corruption.conflicts-of-interest'));
  assert.ok(topIds('difference between an RFQ and an RFT', 'agency')
    .includes('sourcing.market-approach-types'));
});

test('nonsense queries return nothing above the noise floor', () => {
  const hits = index.search('purple monkey dishwasher xyzzy', { audience: 'council', limit: 5 })
    .filter((h) => h.score >= 1.2);
  assert.equal(hits.length, 0);
});

test('supporting() attaches thresholds and templates relevant to the hits', () => {
  const q = 'what templates do I need to run a tender evaluation';
  const hits = index.search(q, { audience: 'agency', limit: 6 });
  const supporting = index.supporting(q, hits, 'agency');
  assert.ok(supporting.templates.length > 0);
  assert.ok(supporting.templates.some((t) => /evaluation/i.test(t.name)));
});

test('thresholds surfaced for a council never include agency-only rules', () => {
  const q = 'what value can we spend before we have to tender';
  const hits = index.search(q, { audience: 'council', limit: 6 });
  const supporting = index.supporting(q, hits, 'council');
  for (const t of supporting.thresholds) {
    assert.ok(t.applies_to.includes('council'), `${t.id} should not be shown to councils`);
  }
});
