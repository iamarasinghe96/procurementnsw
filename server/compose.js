/**
 * Answer composition directly from the knowledge base, with no model involved.
 *
 * Shared by the server (as its degradation path) and by the standalone
 * single-file build, which runs entirely in the browser and has no AI layer at
 * all. Keeping it here means both produce identical answers from identical
 * evidence.
 */

/** Sources are always filtered through the URL allow-list before display. */
function toSource(kb, hit) {
  const c = hit.chunk;
  return {
    id: c.id,
    heading: c.heading,
    topic: c.topic_title,
    path: c.path,
    authority: c.authority,
    jurisdiction: c.jurisdiction,
    excerpt: c.summary,
    source_document: c.source_document,
    links: (c.citations || []).filter((cite) => kb.allowed_urls.includes(cite.url)),
  };
}

export function composeFromKnowledgeBase(kb, hits, supporting, audienceMeta) {
  const top = hits[0].chunk;
  const checklist = [];
  const watchOuts = [];
  const keyPoints = [];

  for (const hit of hits.slice(0, 4)) {
    for (const item of hit.chunk.checklist || []) {
      if (checklist.length < 10 && !checklist.includes(item)) checklist.push(item);
    }
    for (const item of hit.chunk.watch_outs || []) {
      if (watchOuts.length < 5 && !watchOuts.includes(item)) watchOuts.push(item);
    }
    if (hit.chunk.id !== top.id && keyPoints.length < 5) {
      keyPoints.push(`${hit.chunk.heading}: ${hit.chunk.summary}`);
    }
  }

  return {
    direct_answer: top.summary,
    applies_to_you: audienceMeta ? audienceMeta.blurb : null,
    key_points: keyPoints,
    checklist,
    thresholds: supporting.thresholds.map((t) => ({ label: t.label, detail: t.rule })),
    templates: supporting.templates.slice(0, 5).map((t) => ({
      id: t.id,
      name: t.name,
      url: t.url,
      source: t.source,
      why: t.description,
    })),
    watch_outs: watchOuts,
    summary: top.text.length > 700 ? `${top.text.slice(0, 700).trim()}...` : top.text,
    sources: hits.slice(0, 5).map((hit) => toSource(kb, hit)),
    confidence: 'medium',
    out_of_scope: false,
  };
}

export function composeNoMatch(kb, audienceMeta) {
  const suggestions = audienceMeta
    ? audienceMeta.top_questions
    : kb.audiences.flatMap((a) => a.top_questions.slice(0, 1));

  return {
    direct_answer:
      'This knowledge base does not cover that question, so there is nothing here that can be answered without guessing.',
    applies_to_you: null,
    key_points: [
      'The knowledge base covers NSW procurement objectives, legislation and policy, governance, planning, sourcing, contract management, probity, corruption prevention, council procurement and supplier guidance.',
    ],
    checklist: [],
    thresholds: [],
    templates: [],
    watch_outs: [],
    summary: `Try rephrasing, or start from one of these: ${suggestions.slice(0, 4).join(' / ')}`,
    sources: [],
    confidence: 'low',
    out_of_scope: true,
    suggestions: suggestions.slice(0, 5),
  };
}

export { toSource };
