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

function stem(token) {
  if (token.length <= 4) return token;
  return token
    .replace(/(ies)$/, 'y')
    .replace(/(sses|ches|shes|xes)$/, '')
    .replace(/([^s])s$/, '$1')
    .replace(/(ing|ed|ment|tion|sion)$/, '');
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
  const add = (value, weight) => {
    for (const raw of tokenize(value)) {
      for (const token of [raw, stem(raw)]) {
        bag.set(token, (bag.get(token) || 0) + weight);
      }
    }
  };
  add(chunk.heading, FIELD_WEIGHTS.heading);
  add((chunk.keywords || []).join(' '), FIELD_WEIGHTS.keywords);
  add(chunk.summary, FIELD_WEIGHTS.summary);
  add(chunk.topic_title, FIELD_WEIGHTS.topic_title);
  add((chunk.checklist || []).join(' '), FIELD_WEIGHTS.checklist);
  add((chunk.watch_outs || []).join(' '), FIELD_WEIGHTS.watch_outs);
  add(chunk.text, FIELD_WEIGHTS.text);
  return bag;
}

export class Index {
  constructor(kb) {
    this.kb = kb;
    this.docs = kb.chunks.map((chunk) => {
      const bag = fieldTokens(chunk);
      let length = 0;
      for (const v of bag.values()) length += v;
      return { chunk, bag, length };
    });

    this.avgLength = this.docs.reduce((a, d) => a + d.length, 0) / (this.docs.length || 1);

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

    const scored = [];
    for (const doc of this.docs) {
      let score = 0;
      let matchedTerms = 0;
      for (const [token, qf] of counts) {
        const tf = doc.bag.get(token);
        if (!tf) continue;
        matchedTerms += 1;
        const numerator = tf * (BM25_K1 + 1);
        const denominator = tf + BM25_K1 * (1 - BM25_B + BM25_B * (doc.length / this.avgLength));
        score += this.idf(token) * (numerator / denominator) * Math.min(qf, 2);
      }
      if (score <= 0) continue;

      // Reward covering more of the question rather than hammering one rare word.
      score *= 1 + Math.min(matchedTerms / Math.max(counts.size, 1), 1) * 0.35;

      const chunk = doc.chunk;

      if (audience) {
        if ((chunk.audiences || []).includes(audience)) score *= 1.35;
        else score *= 0.75;

        // Councils and state agencies run under genuinely different rulebooks.
        // Serving one the other's thresholds is the worst failure this tool can make.
        if (rulebook === 'local-government') {
          if (chunk.jurisdiction === 'local-government') score *= 1.5;
          else if (chunk.jurisdiction === 'nsw-government') score *= 0.55;
        } else if (rulebook === 'nsw-government') {
          if (chunk.jurisdiction === 'nsw-government') score *= 1.2;
          else if (chunk.jurisdiction === 'local-government') score *= 0.5;
        }
      }

      if (intent.wantsChecklist && chunk.checklist?.length) score *= 1.2;
      if (intent.wantsTemplates && chunk.templates?.length) score *= 1.3;
      if (intent.wantsThresholds && chunk.thresholds?.length) score *= 1.25;
      if (intent.wantsRisks && chunk.watch_outs?.length) score *= 1.2;

      scored.push({ chunk, score, matchedTerms });
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
