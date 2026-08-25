/**
 * The audience selector is a default, not a declaration.
 *
 * A question that plainly names a different party must be answered under that
 * party's rules. Answering "if an AGENCY wants to purchase..." under the Local
 * Government Act, because a dropdown said Local council, is the worst failure
 * this tool has.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { detectAudience } from '../server/retrieval.js';
import { Answerer } from '../server/answer.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const kb = JSON.parse(readFileSync(join(root, 'data', 'knowledge-base.json'), 'utf8'));
const answerer = new Answerer(kb, { config: null });

test('a question naming an agency is detected as an agency question', () => {
  const d = detectAudience('If an agency wants to purchase a $120,000 software solution from an SME');
  assert.equal(d.id, 'agency');
});

test('a question naming a council is detected as a council question', () => {
  assert.equal(detectAudience('our council needs to retender the kerbside contract').id, 'council');
  assert.equal(detectAudience('does section 55 apply to this contract').id, 'council');
});

test('a supplier speaking in the first person is detected', () => {
  assert.equal(detectAudience('I want to sell IT equipment to government').id, 'supplier');
  assert.equal(detectAudience('we manufacture office furniture').id, 'supplier');
});

test('a neutral question leaves the reader selection alone', () => {
  assert.equal(detectAudience('what is value for money'), null);
  assert.equal(detectAudience('Do I have to go to tender for a $300,000 contract?'), null);
});

test('an ambiguous question naming both parties leaves the selection alone', () => {
  // Equal evidence on both sides: the reader's own choice should decide.
  const d = detectAudience('is the council threshold the same as the agency threshold');
  assert.equal(d, null);
});

test('the pipeline overrides a contradicting selection and says so', async () => {
  const question =
    'If an agency wants to purchase a $120,000 software solution from a local regional SME, ' +
    'but that SME is not prequalified under the mandatory ICT Services Scheme (SCM0020), ' +
    'can the agency bypass SCM0020 using the SME and Regional Procurement Policy?';
  const result = await answerer.ask({ question, audience: 'council' });

  assert.equal(result.meta.audience, 'agency', 'must answer as an agency');
  assert.equal(result.meta.audience_notice.from, 'council');
  assert.equal(result.meta.audience_notice.to, 'agency');
  assert.ok(result.meta.audience_notice.evidence, 'the reader must be told what triggered the switch');

  for (const source of result.answer.sources) {
    assert.notEqual(source.jurisdiction, 'local-government', `${source.heading} is council-only`);
  }
});

test('the scheme-versus-exemption question reaches the section that answers it', async () => {
  const question =
    'can the agency bypass the mandatory ICT Services Scheme using the SME direct-buy exemption, ' +
    'or does mandatory scheme prequalification override it?';
  const result = await answerer.ask({ question, audience: 'agency' });
  assert.equal(result.answer.sources[0].id, 'governance.exemptions-versus-mandatory-schemes');
});

test('no audience is inferred where the question gives no signal', async () => {
  const result = await answerer.ask({ question: 'what is value for money', audience: 'council' });
  assert.equal(result.meta.audience, 'council');
  assert.equal(result.meta.audience_notice, null);
});
