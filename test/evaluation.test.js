/**
 * Runs the retrieval evaluation set as a test, so a scoring change that helps
 * one query and quietly breaks five others fails the build.
 *
 * The cases live in scripts/evaluate.mjs, which can also be run directly for
 * a readable report and to re-tune the gate:
 *   node scripts/evaluate.mjs --verbose
 *   node scripts/evaluate.mjs --tune
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluate, CASES } from '../scripts/evaluate.mjs';

const report = evaluate();

test('every evaluation case passes', () => {
  const failures = report.results.filter((r) => !r.ok);
  assert.deepEqual(
    failures.map((f) => `${f.question} -> ${f.detail}`),
    [],
    `${failures.length} of ${report.total} retrieval cases failed`
  );
});

test('no real question is turned away', () => {
  assert.equal(report.falseRejects, 0, 'a covered question was told it is not covered');
});

test('no question is routed to the wrong section', () => {
  assert.equal(report.misroutes, 0);
});

test('no off-topic question is answered from the knowledge base', () => {
  assert.equal(report.falseAccepts, 0, 'a non-procurement question got a sourced answer');
});

test('the evaluation set stays broad enough to be meaningful', () => {
  const negatives = CASES.filter(([, , expected]) => expected === null);
  const audiences = new Set(CASES.map(([, audience]) => audience));
  assert.ok(CASES.length >= 60, 'evaluation set has shrunk');
  assert.ok(negatives.length >= 8, 'need enough off-topic cases to catch over-matching');
  assert.ok(audiences.size >= 6, 'evaluation set should span the audiences');
  // Long questions carrying words the knowledge base has never seen are the
  // case that regressed in the first place.
  assert.ok(
    CASES.some(([q]) => q.split(/\s+/).length >= 10),
    'keep at least one long, messy, real-world question'
  );
});
