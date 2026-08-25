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

export function composeNoMatch(kb, audienceMeta, corrections = []) {
  const suggestions = audienceMeta
    ? audienceMeta.top_questions
    : kb.audiences.flatMap((a) => a.top_questions.slice(0, 1));

  // A near-miss on an acronym is the most likely reason a real question finds
  // nothing, so lead with the correction rather than the generic apology.
  const lead = corrections.length
    ? `Nothing here matches that. Did you mean ${corrections
        .map((c) => `${c.suggestion.toUpperCase()} instead of ${c.typed.toUpperCase()}`)
        .join(', or ')}?`
    : 'This knowledge base does not cover that question, so there is nothing here that can be answered without guessing.';

  return {
    direct_answer: lead,
    corrections,
    applies_to_you: null,
    key_points: [
      ...corrections.map((c) => `${c.suggestion.toUpperCase()} - ${c.means}`),
      'The knowledge base covers NSW procurement objectives, legislation and policy, governance, planning, sourcing, contract management, probity, corruption prevention, council procurement and supplier guidance.',
    ],
    checklist: [],
    thresholds: [],
    templates: [],
    watch_outs: [],
    summary: corrections.length
      ? `If you did mean ${corrections[0].typed.toUpperCase()}, this tool covers procurement process rather than specific goods or commodities. Otherwise try: ${suggestions.slice(0, 3).join(' / ')}`
      : `Try rephrasing, or start from one of these: ${suggestions.slice(0, 4).join(' / ')}`,
    sources: [],
    confidence: 'low',
    out_of_scope: true,
    suggestions: [...corrections.map((c) => c.suggestion.toUpperCase()), ...suggestions].slice(0, 5),
  };
}

export { toSource };
