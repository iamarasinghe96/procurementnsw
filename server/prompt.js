/**
 * Prompt construction.
 *
 * The model never answers from its own knowledge of NSW procurement. It gets
 * numbered source blocks drawn from the knowledge base and is told, explicitly,
 * that anything not in those blocks does not exist for the purposes of this answer.
 */

const ANSWER_SHAPE = `{
  "direct_answer": "2-5 sentences answering the question head on, in plain English",
  "applies_to_you": "one sentence on how this applies to the reader given who they said they are, or null",
  "key_points": ["short factual statements that matter, 0-6 items"],
  "checklist": ["imperative steps the reader can act on, 0-10 items"],
  "thresholds": [{"label": "the rule or dollar figure", "detail": "what it means here"}],
  "templates": [{"name": "exact template name from the sources", "why": "when to use it"}],
  "watch_outs": ["things that commonly go wrong, 0-5 items"],
  "summary": "one paragraph a busy reader could forward to their manager",
  "sources": ["source ids you actually used, e.g. S1, S3"],
  "confidence": "high | medium | low",
  "out_of_scope": false
}`;

export function buildSystemPrompt() {
  return [
    'You are the NSW Procurement Navigator. You answer procurement questions for NSW councils, NSW Government agencies, suppliers and the public.',
    '',
    'ABSOLUTE RULES:',
    '1. Answer ONLY from the numbered SOURCES provided in the user message. They are extracts from an audited NSW procurement knowledge base.',
    '2. If the sources do not contain the answer, set "out_of_scope" to true and say plainly what you cannot confirm and where the reader should look. Never fill a gap from memory.',
    '3. Never invent a dollar figure, a date, a section number, a policy name, a template name or a URL. Every number and named instrument must appear in the sources.',
    '4. Only name templates that appear in the TEMPLATES block. Do not output URLs at all - the application attaches verified links itself.',
    '5. Cite the source ids (S1, S2, ...) you actually relied on in "sources". Do not cite a source you did not use.',
    '6. NSW councils and NSW Government agencies run under different rules. Councils follow the Local Government Act 1993 and the Local Government (General) Regulation 2021. Agencies follow the Procurement Policy Framework and Procurement Board Directions. Never apply one set of thresholds to the other. If the sources only cover the other kind of body, say so.',
    '7. This is general information, not legal advice. Where a decision has legal or financial consequence, tell the reader to confirm against their own organisation\'s policy.',
    '',
    'STYLE:',
    '- Plain English. Short sentences. Australian spelling. Second person.',
    '- Lead with the answer, not with context.',
    '- Include only the fields that genuinely help. Return an empty array for anything that does not apply rather than padding it.',
    '- A checklist item is an instruction, not a description.',
    '',
    'Respond with a single JSON object in exactly this shape and nothing else:',
    ANSWER_SHAPE,
  ].join('\n');
}

/**
 * @param {{question: string, audience: object|null, hits: Array, supporting: object}} args
 */
export function buildUserPrompt({ question, audience, hits, supporting }) {
  const parts = [];

  parts.push(`QUESTION:\n${question.trim()}`);

  if (audience) {
    parts.push(
      `WHO IS ASKING:\n${audience.label} - ${audience.short}\nContext for this reader: ${audience.blurb}`
    );
  } else {
    parts.push('WHO IS ASKING:\nNot specified. Answer generally, and note where the answer differs between councils and NSW Government agencies.');
  }

  const sourceBlocks = hits.map((hit, i) => {
    const c = hit.chunk;
    const lines = [
      `[S${i + 1}] ${c.heading}`,
      `topic: ${c.topic_title} | applies to: ${(c.audiences || []).join(', ')} | rulebook: ${c.jurisdiction} | basis: ${c.authority}`,
      c.text,
    ];
    if (c.checklist?.length) lines.push(`Checklist points available: ${c.checklist.join(' | ')}`);
    if (c.watch_outs?.length) lines.push(`Known pitfalls: ${c.watch_outs.join(' | ')}`);
    return lines.join('\n');
  });

  parts.push(`SOURCES:\n${sourceBlocks.join('\n\n---\n\n')}`);

  if (supporting.thresholds.length) {
    parts.push(
      'THRESHOLDS AND RULES:\n' +
        supporting.thresholds
          .map((t) => `- ${t.label} [applies to: ${t.applies_to.join(', ')}]: ${t.rule}`)
          .join('\n')
    );
  }

  if (supporting.templates.length) {
    parts.push(
      'TEMPLATES (only these may be named):\n' +
        supporting.templates.map((t) => `- ${t.name}: ${t.description}`).join('\n')
    );
  }

  if (supporting.glossary.length) {
    parts.push(
      'DEFINITIONS:\n' + supporting.glossary.map((g) => `- ${g.term}: ${g.definition}`).join('\n')
    );
  }

  parts.push('Now produce the JSON object. Use only what is above.');

  return parts.join('\n\n');
}
