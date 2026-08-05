#!/usr/bin/env node
/**
 * Retrieval evaluation harness.
 *
 * Fixing a bad answer one query at a time hides the class of problem behind it.
 * This runs a broad set of realistic questions - long, messy, full of commodity
 * nouns the knowledge base has never heard of, which is how people actually ask
 * - plus deliberate off-topic negatives, and reports what breaks.
 *
 *   node scripts/evaluate.mjs            summary
 *   node scripts/evaluate.mjs --verbose  every case
 *   node scripts/evaluate.mjs --tune     sweep the gate threshold
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Index, relevant, MIN_TOPICAL_MASS } from '../server/retrieval.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const kb = JSON.parse(readFileSync(join(root, 'data', 'knowledge-base.json'), 'utf8'));
const index = new Index(kb);

/**
 * [question, audience, expectation]
 *   expectation is a chunk id, a topic id, or null for "must be rejected".
 * A chunk id demands that exact section rank first; a topic id accepts any
 * section within it, which is the honest bar for most questions.
 */
export const CASES = [
  // ── Suppliers: how people actually phrase it ──────────────────────
  ['how to become a supplier to supply office laptops to government institutions?', 'supplier', 'suppliers'],
  ['I want to sell IT equipment to councils, where do I start', 'supplier', 'suppliers'],
  ['how do I register to sell to NSW Government', 'supplier', 'suppliers.getting-registered'],
  ['we make office furniture and want government contracts', 'supplier', 'suppliers'],
  ['how does a small cleaning company get on a government panel', 'supplier', 'suppliers'],
  ['when will I get paid for my invoice', 'supplier', 'suppliers.getting-paid'],
  ['government has not paid my invoice for 6 weeks what do I do', 'supplier', 'suppliers.getting-paid'],
  ['why did I lose the tender and can I get feedback', 'supplier', 'suppliers.debriefs-and-complaints'],
  ['how do I complain about an unfair procurement process', 'supplier', 'suppliers.debriefs-and-complaints'],
  ['what makes a good tender response', 'supplier', 'suppliers.writing-a-response'],
  ['how do I get recognised as an Aboriginal business', 'nfp', 'suppliers.aboriginal-social-enterprise'],
  ['we are a social enterprise, can government buy from us directly', 'nfp', 'suppliers'],

  // ── Councils ──────────────────────────────────────────────────────
  ['Do I have to go to tender for a $300,000 contract?', 'council', 'councils.tender-threshold'],
  ['do we need to tender for a new playground construction', 'council', 'councils'],
  ['can we avoid tendering in an emergency', 'council', 'councils.tender-exemptions'],
  ['what happens if we get no acceptable tenders', 'council', 'councils.accepting-tenders'],
  ['can we buy off an LGP panel instead of tendering', 'council', 'councils.lgp-panels'],
  ['manage the kerbside collection contract and performance meetings', 'council', 'councils.waste-contract-management'],
  ['our garbage contractor keeps missing streets, what are our options', 'council', 'councils'],
  ['what has to go in our contracts register', 'council', 'councils.transparency-obligations'],
  ['modern slavery reporting obligations for councils', 'council', 'councils.transparency-obligations'],
  ['how long does a council tender have to be advertised', 'council', 'councils.tender-methods'],
  ['do procurement board directions apply to councils', 'council', 'councils.different-rulebook'],

  // ── Agency buyers ─────────────────────────────────────────────────
  ['what is my agency accredited to buy', 'agency', 'governance.accreditation'],
  ['do I have to use a whole of government contract for stationery', 'agency', 'governance'],
  ['which market approach should I use for a new payroll system', 'agency', 'sourcing'],
  ['difference between an RFQ and an RFT', 'agency', 'sourcing.market-approach-types'],
  ['how long should I leave a tender open', 'agency', 'sourcing.systems-and-tender-periods'],
  ['can I issue an addendum three days before close', 'agency', 'sourcing.running-the-process'],
  ['someone submitted their tender late, can I accept it', 'agency', 'sourcing.running-the-process'],
  ['how do I set evaluation criteria and weightings', 'agency', 'sourcing.evaluation-criteria'],
  ['do I need to give first consideration to an Aboriginal business', 'agency', 'objectives.preferencing-suppliers'],
  ['when do the enforceable procurement provisions apply', 'agency', 'legislation.epp'],
  ['what do I need before I can approach the market', 'agency', 'sourcing.authorisation'],
  ['buying laptops for the office, do I need three quotes', 'agency', 'governance'],
  ['how do I write a procurement strategy', 'agency', 'planning.procurement-strategy'],
  ['what records do I have to keep for a purchase', 'agency', 'governance.recordkeeping'],
  ['how do I analyse the supply market before buying', 'agency', 'planning.market-analysis'],

  // ── Integrity ─────────────────────────────────────────────────────
  ['a supplier offered me tickets to the football', 'council', 'corruption.improper-influence-gifts'],
  ['my brother works for one of the bidders', 'agency', 'corruption.conflicts-of-interest'],
  ['a bidder asked me who else is tendering', 'agency', 'corruption.misuse-of-information'],
  ['how do I report suspected corruption', null, 'corruption.ethical-obligations-reporting'],
  ['what is corrupt conduct', null, 'corruption.what-is-corrupt-conduct'],
  ['do we need a probity adviser for this project', 'council', 'probity.advisers-auditors'],
  ['what does probity actually mean', 'agency', 'probity'],
  ['what checks should I run on a new supplier', 'agency', 'due-diligence'],
  ['the supplier wants to change their bank details', 'agency', 'managing.post-engagement-due-diligence'],
  ['how do I know if a supplier is a real business', 'agency', 'due-diligence'],

  // ── Contract management ───────────────────────────────────────────
  ['how do I manage supplier performance against KPIs', 'agency', 'managing'],
  ['do I have to publish this contract', 'agency', 'managing.disclosure-reporting'],
  ['contract is expiring soon what do I do', 'council', 'managing.renewal'],
  ['goods arrived damaged, can I reject them', 'agency', 'managing.receiving-goods'],
  ['how quickly must I pay a small business', 'agency', 'managing.paying-suppliers'],

  // ── Foundations and public ────────────────────────────────────────
  ['what is value for money', 'council', 'objectives.value-for-money'],
  ['what is value for money', 'agency', 'objectives.value-for-money'],
  ['what procurement information must be published', 'public', 'managing.disclosure-reporting'],
  ['how do I see what my council has contracted', 'public', 'councils.transparency-obligations'],
  ['who oversees NSW government procurement', 'public', 'governance'],
  ['what laws govern NSW procurement', 'agency', 'legislation'],
  ['what are the five procurement objectives', 'agency', 'objectives.five-objectives'],
  ['how does sustainable procurement work', 'agency', 'objectives.sustainable-procurement'],

  // ── Must be rejected: not procurement questions ───────────────────
  ['What is the capital of France?', 'council', null],
  ['recipe for banana bread', null, null],
  ['who won the cricket last night', null, null],
  ['tell me a joke', null, null],
  ['what is the weather tomorrow', 'council', null],
  ['how do I write a good job application', 'council', null],
  ['best restaurants in Sydney', 'public', null],
  ['how do I reset my email password', 'agency', null],
  ['what time does the library open', 'public', null],
  ['convert 50 kg to pounds', null, null],
];

export function evaluate({ minTopicalMass = MIN_TOPICAL_MASS } = {}) {
  const results = [];
  for (const [question, audience, expected] of CASES) {
    const hits = relevant(index.search(question, { audience, limit: 8 }), { minTopicalMass });
    const topChunk = hits[0]?.chunk;
    let ok;
    let detail;

    if (expected === null) {
      ok = hits.length === 0;
      detail = ok ? 'rejected' : `wrongly accepted -> ${topChunk.id}`;
    } else if (!hits.length) {
      ok = false;
      detail = `wrongly rejected (expected ${expected})`;
    } else if (expected.includes('.')) {
      ok = topChunk.id === expected;
      detail = ok ? topChunk.id : `got ${topChunk.id}, wanted ${expected}`;
    } else {
      ok = topChunk.topic_id === expected;
      detail = ok ? topChunk.id : `got ${topChunk.id} (topic ${topChunk.topic_id}), wanted topic ${expected}`;
    }
    results.push({ question, audience, expected, ok, detail, hits });
  }

  const negatives = results.filter((r) => r.expected === null);
  const positives = results.filter((r) => r.expected !== null);
  return {
    results,
    passed: results.filter((r) => r.ok).length,
    total: results.length,
    falseRejects: positives.filter((r) => !r.ok && r.detail.startsWith('wrongly rejected')).length,
    misroutes: positives.filter((r) => !r.ok && !r.detail.startsWith('wrongly rejected')).length,
    falseAccepts: negatives.filter((r) => !r.ok).length,
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv.includes('--tune')) {
    console.log('threshold  pass   falseReject  misroute  falseAccept');
    for (let t = 0; t <= 4.0001; t += 0.25) {
      const r = evaluate({ minTopicalMass: t });
      console.log(
        `${t.toFixed(2).padStart(8)}  ${String(`${r.passed}/${r.total}`).padStart(6)}  ` +
          `${String(r.falseRejects).padStart(11)}  ${String(r.misroutes).padStart(8)}  ${String(r.falseAccepts).padStart(11)}`
      );
    }
  } else {
    const r = evaluate();
    const verbose = process.argv.includes('--verbose');
    for (const c of r.results) {
      if (!c.ok || verbose) {
        console.log(`${c.ok ? ' ok ' : 'FAIL'}  ${c.detail}\n        "${c.question}"${c.audience ? ` [${c.audience}]` : ''}`);
      }
    }
    console.log(
      `\n${r.passed}/${r.total} passed  ` +
        `(${r.falseRejects} wrongly rejected, ${r.misroutes} misrouted, ${r.falseAccepts} wrongly accepted)`
    );
    process.exitCode = r.passed === r.total ? 0 : 1;
  }
}
