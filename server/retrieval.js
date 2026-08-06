/**
 * Lexical retrieval over the knowledge base.
 *
 * BM25 over weighted fields, with procurement-specific query expansion and
 * audience/jurisdiction steering. Deliberately dependency-free and deterministic:
 * the same question always retrieves the same evidence, which makes wrong answers
 * reproducible and therefore fixable.
 */

const STOPWORDS = new Set(
  ('a an and are as at be been but by can could do does for from had has have how i if in into is it its may me my of on or our shall should so' +
    ' such than that the their them then there these they this those to too us was we were what when where which while who why will with would you your' +
    ' am about above after again all also any because before being below between both during each few further here him his more most no nor not now once' +
    ' only other out over own same some through under until up very via')
    .split(/\s+/)
);

// Procurement vocabulary is full of abbreviations and near-synonyms. Without this
// map a business lead asking about "garbage collection" never reaches the waste
// contract guidance, and "COI" never reaches conflicts of interest.
const SYNONYMS = {
  rfq: ['request', 'quote', 'quotation'],
  rfp: ['request', 'proposal'],
  rft: ['request', 'tender'],
  rfi: ['request', 'information'],
  eoi: ['expression', 'interest'],
  rfx: ['tender', 'quote', 'request', 'market', 'approach'],
  coi: ['conflict', 'interest'],
  vfm: ['value', 'money'],
  wog: ['whole', 'government', 'contract'],
  po: ['purchase', 'order'],
  kpi: ['performance', 'indicator', 'measure'],
  kpis: ['performance', 'indicator', 'measure'],
  srm: ['supplier', 'relationship', 'management'],
  sme: ['small', 'medium', 'enterprise', 'business'],
  smes: ['small', 'medium', 'enterprise', 'business'],
  ade: ['disability', 'employment', 'organisation'],
  epp: ['enforceable', 'procurement', 'provision'],
  gipa: ['disclosure', 'information', 'access', 'public'],
  icac: ['corruption', 'corrupt'],
  pid: ['public', 'interest', 'disclosure', 'report'],
  app: ['aboriginal', 'procurement', 'policy'],
  olg: ['office', 'local', 'government', 'council'],
  lgp: ['local', 'government', 'procurement', 'panel'],
  lga: ['local', 'government', 'act', 'council'],
  ppf: ['procurement', 'policy', 'framework'],
  pbd: ['board', 'direction'],
  pcard: ['purchasing', 'card'],
  gst: ['tax', 'value'],
  abn: ['business', 'number', 'genuine'],
  etendering: ['tender', 'advertise', 'system'],
  garbage: ['waste', 'kerbside', 'collection', 'domestic'],
  rubbish: ['waste', 'kerbside', 'collection'],
  bin: ['waste', 'kerbside', 'collection'],
  bins: ['waste', 'kerbside', 'collection'],
  recycling: ['waste', 'kerbside', 'contamination'],
  cleansing: ['waste', 'collection', 'service'],
  procure: ['procurement', 'buy', 'purchase'],
  procuring: ['procurement', 'buy', 'purchase'],
  buying: ['procurement', 'purchase', 'buy'],
  purchasing: ['procurement', 'purchase', 'buy'],
  bid: ['tender', 'response', 'offer', 'submission'],
  bidding: ['tender', 'response', 'offer'],
  bidder: ['supplier', 'tenderer', 'respondent'],
  tendering: ['tender', 'market', 'approach'],
  vendor: ['supplier', 'contractor'],
  contractor: ['supplier'],
  panel: ['scheme', 'prequalification', 'standing', 'offer'],
  scheme: ['panel', 'prequalification'],
  invoice: ['payment', 'pay', 'paid'],
  invoices: ['payment', 'pay', 'paid'],
  paid: ['payment', 'invoice'],
  bribe: ['gift', 'benefit', 'corrupt', 'influence'],
  kickback: ['corrupt', 'bribe', 'benefit'],
  whistleblow: ['report', 'disclosure', 'corrupt'],
  whistleblower: ['report', 'disclosure', 'corrupt', 'protection'],
  probity: ['ethical', 'integrity', 'fairness', 'impartial'],
  variation: ['change', 'contract', 'scope'],
  variations: ['change', 'contract', 'scope'],
  meeting: ['meetings', 'agenda', 'minutes'],
  meetings: ['meeting', 'agenda', 'minutes'],
  schedules: ['schedule', 'annexure', 'specification'],
  schedule: ['schedules', 'annexure', 'specification'],
  council: ['local', 'government'],
  councils: ['local', 'government'],
  // People describe conflicts of interest by naming the relationship, never by
  // using the phrase "conflict of interest".
  brother: ['family', 'relative', 'conflict', 'interest'],
  sister: ['family', 'relative', 'conflict', 'interest'],
  cousin: ['family', 'relative', 'conflict', 'interest'],
  spouse: ['family', 'relative', 'conflict', 'interest'],
  partner: ['family', 'relative', 'conflict', 'interest'],
  wife: ['family', 'relative', 'conflict', 'interest'],
  husband: ['family', 'relative', 'conflict', 'interest'],
  relative: ['family', 'conflict', 'interest'],
  mate: ['friend', 'conflict', 'interest'],
  neighbour: ['friend', 'conflict', 'interest'],
  friend: ['conflict', 'interest', 'personal'],
  bidders: ['supplier', 'tenderer', 'respondent'],
  ratepayer: ['public', 'community', 'council'],
  threshold: ['limit', 'value', 'amount'],
  thresholds: ['limit', 'value', 'amount'],
  checklist: ['steps', 'process'],
  template: ['templates', 'form', 'document'],
  templates: ['template', 'form', 'document'],
};

const FIELD_WEIGHTS = {
  heading: 4,
  keywords: 4,
  summary: 2.5,
  topic_title: 1.5,
  checklist: 1.2,
  watch_outs: 1.2,
  text: 1,
};

const BM25_K1 = 1.4;
const BM25_B = 0.72;

/**
 * Light suffix stripper.
 *
 * Not a real stemmer, just enough to make a term and its inflections meet:
 * "accreditation"/"accredited", "evaluation"/"evaluate", "acceptable"/"accept".
 * Every rule is guarded on a minimum remaining length, so "state" does not
 * become "st" and collide with unrelated words.
 */
const SUFFIXES = [
  [/ies$/, 'y', 3],
  [/(sses|ches|shes|xes)$/, '', 3],
  [/([^s])s$/, '$1', 3],
  // Before the shorter rules below, so both halves of a pair land together:
  // "accreditation" -> "accredit", "evaluation" -> "evalu".
  [/ation$/, '', 4],
  // ...and "evaluate" -> "evalu" to meet it.
  [/ate$/, '', 4],
  [/(ing|ment|tion|sion)$/, '', 4],
  [/ed$/, '', 4],
  [/(able|ible|abl|ibl)$/, '', 4],
  [/(ance|ence)$/, '', 4],
];

function stem(token) {
  if (token.length <= 4) return token;
  let out = token;
  for (const [pattern, replacement, minLength] of SUFFIXES) {
    if (!pattern.test(out)) continue;
    const candidate = out.replace(pattern, replacement);
    if (candidate.length >= minLength) out = candidate;
  }
  return out;
}

export function tokenize(text) {
  if (!text) return [];
  return String(text)
    .toLowerCase()
    .replace(/[‘’']/g, '')
    .replace(/[^a-z0-9$.]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .filter((t) => !STOPWORDS.has(t))
    .map((t) => t.replace(/^\.+|\.+$/g, ''))
    .filter((t) => t.length > 1 || /^\d$/.test(t));
}

function expand(tokens) {
  const out = [];
  for (const token of tokens) {
    out.push(token);
    const syns = SYNONYMS[token];
    if (syns) out.push(...syns);
    const stemmed = stem(token);
    if (stemmed !== token) out.push(stemmed);
    // "250,000" and "250000" and "$250k" should all find the same rule.
    const numeric = token.replace(/[^0-9.]/g, '');
    if (numeric.length >= 3) out.push(numeric);
  }
  return out;
}

function fieldTokens(chunk) {
  const bag = new Map();
  // Heading, keywords and summary are curated labels for what a chunk is about.
  // Body prose is not: a word can appear there incidentally. Tracking them
  // separately lets retrieval tell "this chunk is about X" from "this chunk
  // happens to contain the word X".
  const topical = new Set();
  const keyworded = new Set();
  const add = (value, weight, kind = null) => {
    for (const raw of tokenize(value)) {
      for (const token of [raw, stem(raw)]) {
        bag.set(token, (bag.get(token) || 0) + weight);
        if (kind) topical.add(token);
        if (kind === 'keyword') keyworded.add(token);
      }
    }
  };
  add(chunk.heading, FIELD_WEIGHTS.heading, 'label');
  // Single-word keywords are the hand-authored domain vocabulary: "tender",
  // "addendum", "kerbside". Multi-word ones are indexed for matching but do not
  // confer domain status on their parts - "open tender" must not make "open" a
  // procurement term, or "what time does the library open" becomes a question
  // about tendering.
  for (const keyword of chunk.keywords || []) {
    add(keyword, FIELD_WEIGHTS.keywords, keyword.includes(' ') ? 'label' : 'keyword');
  }
  add(chunk.summary, FIELD_WEIGHTS.summary, 'label');
  add(chunk.topic_title, FIELD_WEIGHTS.topic_title, 'label');
  add((chunk.checklist || []).join(' '), FIELD_WEIGHTS.checklist);
  add((chunk.watch_outs || []).join(' '), FIELD_WEIGHTS.watch_outs);
  add(chunk.text, FIELD_WEIGHTS.text);
  return { bag, topical, keyworded };
}

export class Index {
  constructor(kb) {
    this.kb = kb;
    this.docs = kb.chunks.map((chunk) => {
      const { bag, topical, keyworded } = fieldTokens(chunk);
      let length = 0;
      for (const v of bag.values()) length += v;
      return { chunk, bag, topical, keyworded, length };
    });

    this.avgLength = this.docs.reduce((a, d) => a + d.length, 0) / (this.docs.length || 1);

    // Corpus-wide domain vocabulary: every single-word curated keyword. Whether
    // "tender" is procurement vocabulary is a property of the subject, not of
    // whichever chunk happened to rank first for a given query.
    this.domainVocabulary = new Set();
    for (const chunk of kb.chunks) {
      for (const keyword of chunk.keywords || []) {
        if (keyword.includes(' ')) continue;
        for (const token of tokenize(keyword)) {
          this.domainVocabulary.add(token);
          this.domainVocabulary.add(stem(token));
        }
      }
    }

    this.df = new Map();
    for (const doc of this.docs) {
      for (const token of doc.bag.keys()) {
        this.df.set(token, (this.df.get(token) || 0) + 1);
      }
    }
    this.N = this.docs.length;
  }

  idf(token) {
    const df = this.df.get(token) || 0;
    return Math.log(1 + (this.N - df + 0.5) / (df + 0.5));
  }

  /**
   * @param {string} query
   * @param {{audience?: string, limit?: number}} options
   */
  search(query, options = {}) {
    const { audience = null, limit = 8 } = options;
    const queryTokens = expand(tokenize(query));
    if (!queryTokens.length) return [];

    const counts = new Map();
    for (const token of queryTokens) counts.set(token, (counts.get(token) || 0) + 1);

    const intent = detectIntent(query);
    const audienceMeta = audience ? this.kb.audiences.find((a) => a.id === audience) : null;
    const rulebook = audienceMeta ? audienceMeta.primary_rulebook : null;

    // Total IDF mass of the query, excluding bare numbers. A figure like
    // "$300,000" is a value the reader supplied, not vocabulary the knowledge
    // base should have to contain, so a missing match on it must not count
    // against how well the question was understood.
    const isNumeric = (t) => /^[\d.,$]+$/.test(t);
    let queryMass = 0;
    for (const token of counts.keys()) {
      if (!isNumeric(token)) queryMass += this.idf(token);
    }

    const scored = [];
    for (const doc of this.docs) {
      let score = 0;
      let matchedTerms = 0;
      let matchedMass = 0;
      let topicalMass = 0;
      let topicalTerms = 0;
      let domainTerms = 0;
      for (const [token, qf] of counts) {
        const tf = doc.bag.get(token);
        if (!tf) continue;
        matchedTerms += 1;
        if (!isNumeric(token)) {
          matchedMass += this.idf(token);
          if (doc.topical.has(token)) {
            topicalMass += this.idf(token);
            topicalTerms += 1;
            if (this.domainVocabulary.has(token)) domainTerms += 1;
          }
        }
        const numerator = tf * (BM25_K1 + 1);
        const denominator = tf + BM25_K1 * (1 - BM25_B + BM25_B * (doc.length / this.avgLength));
        score += this.idf(token) * (numerator / denominator) * Math.min(qf, 2);
      }
      if (score <= 0) continue;

      // Reward covering more of the question rather than hammering one rare word.
      score *= 1 + Math.min(matchedTerms / Math.max(counts.size, 1), 1) * 0.35;

      // Reward matching what a chunk is *about* over merely containing the word.
      // Without this, a council chunk that mentions "value for money" in passing
      // outranks the section headed "What value for money actually means",
      // because the jurisdiction preference tips it over.
      const topicalShare = queryMass > 0 ? topicalMass / queryMass : 0;
      score *= 1 + topicalShare * 0.85;

      const chunk = doc.chunk;

      if (audience) {
        const audiences = chunk.audiences || [];
        if (audiences.includes(audience)) score *= 1.35;
        else score *= 0.75;

        // Convention: a chunk lists the audience it is WRITTEN FOR first, then
        // everyone else it is merely relevant to. "Paying suppliers" and
        // "Getting paid" cover the same rule from opposite sides of the
        // transaction, and a supplier asking "when will I get paid" wants the
        // one addressed to them.
        if (audiences[0] === audience) score *= 1.35;

        // Councils and state agencies run under genuinely different rulebooks.
        // Serving one the other's thresholds is the worst failure this tool can make.
        // The penalty matters for correctness; the boost is only a preference,
        // so keep it modest or a tangential council chunk outranks the section
        // that actually answers the question.
        if (rulebook === 'local-government') {
          if (chunk.jurisdiction === 'local-government') score *= 1.22;
          else if (chunk.jurisdiction === 'nsw-government') score *= 0.55;
        } else if (rulebook === 'nsw-government') {
          if (chunk.jurisdiction === 'nsw-government') score *= 1.15;
          else if (chunk.jurisdiction === 'local-government') score *= 0.5;
        }
      }

      if (intent.wantsChecklist && chunk.checklist?.length) score *= 1.2;
      if (intent.wantsTemplates && chunk.templates?.length) score *= 1.3;
      if (intent.wantsThresholds && chunk.thresholds?.length) score *= 1.25;
      if (intent.wantsRisks && chunk.watch_outs?.length) score *= 1.2;

      scored.push({
        chunk,
        score,
        matchedTerms,
        // 0..1: share of the question's distinctive vocabulary this hit explains.
        coverage: queryMass > 0 ? matchedMass / queryMass : 0,
        // ...and how much of that landed in the chunk's curated labels rather
        // than incidentally in its prose.
        topicalCoverage: queryMass > 0 ? topicalMass / queryMass : 0,
        // Absolute IDF mass matched in those labels. Unlike the ratios above
        // this does not shrink when a question carries extra words, which is
        // what makes it usable as a relevance gate.
        topicalMass,
        topicalTerms,
        domainTerms,
      });
    }

    scored.sort((a, b) => b.score - a.score);

    // Keep the result set from collapsing into one topic when a question spans several.
    const perTopic = new Map();
    const results = [];
    for (const hit of scored) {
      const seen = perTopic.get(hit.chunk.topic_id) || 0;
      if (seen >= 3) continue;
      perTopic.set(hit.chunk.topic_id, seen + 1);
      results.push(hit);
      if (results.length >= limit) break;
    }
    return results;
  }

  /**
   * Vocabulary of short terms worth correcting towards, built once from the
   * glossary and the chunk keywords.
   */
  get vocabulary() {
    if (!this._vocab) {
      const seen = new Map();
      const add = (term, label) => {
        const key = term.toLowerCase();
        if (key.length < 2 || key.length > 6 || !/^[a-z]+$/.test(key)) return;
        if (!seen.has(key)) seen.set(key, label);
      };
      for (const entry of this.kb.glossary) add(entry.term, entry.term);
      for (const chunk of this.kb.chunks) {
        for (const keyword of chunk.keywords || []) {
          if (!keyword.includes(' ')) add(keyword, keyword);
        }
      }
      this._vocab = seen;
    }
    return this._vocab;
  }

  /**
   * When nothing matched, look for a near miss. In this domain LGP (Local
   * Government Procurement) and LPG (the fuel) are one transposition apart, and
   * a council officer will type the wrong one. Suggest rather than silently
   * rewrite: the two mean entirely different things.
   */
  didYouMean(query, limit = 3) {
    const tokens = tokenize(query).filter((t) => t.length >= 2 && t.length <= 6);
    const out = [];
    for (const token of tokens) {
      if (this.vocabulary.has(token)) continue; // already a known term
      let best = null;
      for (const [candidate, label] of this.vocabulary) {
        const distance = editDistance(token, candidate);
        if (distance > 1) continue;
        // Require the correction to actually retrieve something.
        const hits = this.search(candidate, { limit: 1 });
        if (!hits.length || hits[0].score < 5) continue;
        if (!best || distance < best.distance || hits[0].score > best.score) {
          best = { typed: token, suggestion: label, distance, score: hits[0].score, chunk: hits[0].chunk };
        }
      }
      if (best) out.push({ typed: best.typed, suggestion: best.suggestion, means: best.chunk.heading });
      if (out.length >= limit) break;
    }
    return out;
  }

  /** Thresholds and glossary entries worth attaching to the answer context. */
  supporting(query, hits, audience) {
    const tokens = new Set(expand(tokenize(query)));
    const thresholdIds = new Set();
    for (const hit of hits) for (const id of hit.chunk.thresholds || []) thresholdIds.add(id);

    for (const threshold of this.kb.thresholds) {
      if (audience && !threshold.applies_to.includes(audience)) continue;
      const bag = new Set(expand(tokenize(`${threshold.label} ${threshold.rule}`)));
      let overlap = 0;
      for (const t of tokens) if (bag.has(t)) overlap += 1;
      if (overlap >= 3) thresholdIds.add(threshold.id);
    }

    const templateIds = new Set();
    for (const hit of hits) for (const id of hit.chunk.templates || []) templateIds.add(id);

    const glossary = this.kb.glossary.filter((entry) => {
      const bag = new Set(expand(tokenize(entry.term)));
      for (const t of bag) if (tokens.has(t)) return true;
      return false;
    });

    return {
      // Audience filtering is applied last and unconditionally. Thresholds
      // arriving via a chunk reference are not exempt: showing a council an
      // agency-only dollar rule is exactly the failure this tool exists to avoid.
      thresholds: this.kb.thresholds.filter(
        (t) => thresholdIds.has(t.id) && (!audience || t.applies_to.includes(audience))
      ),
      templates: this.kb.templates.filter(
        (t) => templateIds.has(t.id) && (!audience || t.audiences.includes(audience))
      ),
      glossary: glossary.slice(0, 4),
    };
  }
}

/**
 * Damerau-Levenshtein: counts a transposition as one edit, so LPG/LGP is
 * distance 1. Plain Levenshtein scores it 2 and would miss it.
 */
function editDistance(a, b) {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > 2) return 99;
  const d = Array.from({ length: a.length + 1 }, (_, i) =>
    Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0))
  );
  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
      }
    }
  }
  return d[a.length][b.length];
}

/**
 * Is there enough here to answer from, or is it noise?
 *
 * The gate is the absolute IDF-weighted mass of query terms that matched a
 * chunk's curated labels - its heading, keywords and summary - rather than
 * appearing incidentally in its prose.
 *
 * Absolute, not a ratio. A ratio punishes long specific questions, which is how
 * people actually ask: "how to become a supplier to supply office laptops to
 * government institutions" contains two nouns the knowledge base has never
 * heard of, and a coverage ratio read that as an off-topic question. Length
 * must not decide relevance.
 *
 * Labels rather than prose, because "what is the weather tomorrow" matches
 * "tomorrow" in a probity checklist line, and that is not a procurement
 * question.
 */
export const MIN_TOPICAL_MASS = 0.6;
/**
 * A single term carries a question only when it is domain vocabulary.
 *
 * Rarity is the wrong test here: the most central words - "tender", "quote",
 * "contract" - appear everywhere and so have the LOWEST inverse document
 * frequency. "Do we have to tender" is one such word and a perfectly ordinary
 * question. Membership of the curated single-word keyword lists is the signal
 * that actually means "this word is procurement vocabulary".
 */

export function relevant(hits, { minTopicalMass = MIN_TOPICAL_MASS } = {}) {
  if (!hits.length) return [];
  const best = hits[0];
  if (best.topicalMass < minTopicalMass) return [];
  // "Tell me a joke" hits "tell" from the summary "...documents must tell
  // suppliers"; "what time does the library open" hits "open" from "open
  // tender". Neither is a procurement question, and neither word is domain
  // vocabulary.
  //
  // So: two matching label terms, or one that is procurement vocabulary.
  if (best.topicalTerms < 2 && best.domainTerms < 1) return [];
  // Keep supporting hits that are in the same league as the best one.
  const floor = Math.max(hits[0].score * 0.12, 1);
  return hits.filter((h) => h.score >= floor);
}

/**
 * Who is this question actually about?
 *
 * The audience selector is a default, not a declaration. A council officer
 * researching how the other side works, or anyone who never touched the
 * dropdown, will ask a question that plainly names a different party - "if an
 * AGENCY wants to purchase..." - and answering that under the Local Government
 * Act is worse than useless.
 *
 * Only strong, unambiguous signals count, and a tie is left alone: the reader's
 * own selection wins unless the question clearly contradicts it.
 */
const AUDIENCE_SIGNALS = [
  ['agency', [
    /\ban agenc(y|ies)\b/i, /\bthe agenc(y|ies)\b/i, /\bmy agenc(y|ies)\b/i, /\bour agenc(y|ies)\b/i,
    /\bnsw government agenc/i, /\bgovernment agenc/i, /\bstate agenc/i, /\bdepartment\b/i,
    /\bprocurement board\b/i, /\bwhole[- ]of[- ]government\b/i, /\baccredit(ed|ation)\b/i,
    /\bscm\d{4}\b/i, /\bpbd[- ]?\d{4}/i,
  ]],
  ['council', [
    /\ba council\b/i, /\bthe council\b/i, /\bmy council\b/i, /\bour council\b/i, /\bcouncils\b/i,
    /\blocal government act\b/i, /\bsection 55\b/i, /\bratepayer/i, /\bkerbside\b/i,
    /\bshire\b/i, /\bjoint organisation\b/i,
  ]],
  ['supplier', [
    /\bi (want to|would like to) (sell|supply|bid|tender)\b/i, /\bmy (company|business)\b/i,
    /\bwe (sell|supply|make|manufacture|provide)\b/i, /\bas a supplier\b/i, /\bour tender\b/i,
    /\bwe want to (sell|supply|win)\b/i, /\bget paid\b/i, /\bbecome a supplier\b/i,
  ]],
  ['nfp', [
    /\baboriginal[- ]owned\b/i, /\bsocial enterprise\b/i, /\bdisability employment\b/i,
    /\bnot[- ]for[- ]profit\b/i, /\bwe are an aboriginal\b/i,
  ]],
  ['public', [
    /\bas a (member of the public|ratepayer|resident|journalist)\b/i, /\bthe public\b.*\bsee\b/i,
  ]],
];

export function detectAudience(query) {
  const text = String(query || '');
  const scores = new Map();
  const evidence = new Map();
  for (const [id, patterns] of AUDIENCE_SIGNALS) {
    for (const pattern of patterns) {
      const match = text.match(pattern);
      if (!match) continue;
      scores.set(id, (scores.get(id) || 0) + 1);
      if (!evidence.has(id)) evidence.set(id, match[0].trim());
    }
  }
  if (!scores.size) return null;

  const ranked = [...scores.entries()].sort((a, b) => b[1] - a[1]);
  // An ambiguous question - one naming both a council and an agency - is left
  // to the reader's own selection.
  if (ranked.length > 1 && ranked[0][1] === ranked[1][1]) return null;
  return { id: ranked[0][0], evidence: evidence.get(ranked[0][0]), strength: ranked[0][1] };
}

export function detectIntent(query) {
  const q = String(query || '').toLowerCase();
  return {
    wantsChecklist: /\b(checklist|check list|steps?|process|how do i|how to|what do i need|walk me through|procedure)\b/.test(q),
    wantsTemplates: /\b(template|templates|form|forms|document|documents|pro ?forma|example)\b/.test(q),
    wantsThresholds: /\b(threshold|thresholds|limit|limits|how much|value|\$|dollar|over|under|above|below|when must|do i (have|need) to)\b/.test(q),
    wantsRisks: /\b(risk|risks|watch|careful|pitfall|mistake|wrong|avoid|breach|non.?compliance|audit)\b/.test(q),
    wantsDefinition: /\b(what is|what does|meaning|define|definition|stands for)\b/.test(q),
  };
}
