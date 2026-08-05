/**
 * Output guardrails.
 *
 * Everything the model returns is treated as untrusted text. This module coerces
 * it into the expected shape, strips anything that could be a fabrication (URLs,
 * unknown template names, citations to sources that were never supplied), and
 * reports what it had to remove so problems are visible rather than silent.
 */

const MAX = {
  key_points: 6,
  checklist: 10,
  thresholds: 6,
  templates: 6,
  watch_outs: 5,
  sources: 8,
};

const URL_PATTERN = /\bhttps?:\/\/\S+|\bwww\.\S+/gi;
// Markdown links: keep the label, drop the target.
const MD_LINK = /\[([^\]]+)\]\((?:[^)]*)\)/g;

function asString(value, maxLength = 1200) {
  if (typeof value !== 'string') return '';
  return value.trim().slice(0, maxLength);
}

function scrubText(value, removals) {
  let text = asString(value);
  if (!text) return '';
  const withoutMdLinks = text.replace(MD_LINK, '$1');
  if (withoutMdLinks !== text) {
    removals.push('markdown link');
    text = withoutMdLinks;
  }
  if (URL_PATTERN.test(text)) {
    URL_PATTERN.lastIndex = 0;
    removals.push('inline URL');
    text = text.replace(URL_PATTERN, '').replace(/\(\s*\)/g, '').replace(/\s{2,}/g, ' ').trim();
  }
  URL_PATTERN.lastIndex = 0;
  return text;
}

function asStringArray(value, limit, removals) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const item of value) {
    const text = scrubText(typeof item === 'string' ? item : item?.text ?? '', removals);
    if (text) out.push(text);
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * @param {string} raw            the model's response body
 * @param {object} context        { hits, supporting, kb }
 */
export function validateAnswer(raw, { hits, supporting, kb }) {
  const removals = [];
  let parsed;

  try {
    parsed = JSON.parse(raw);
  } catch {
    // Some models wrap JSON in prose or a fence despite response_format.
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) {
      return { ok: false, reason: 'The answer could not be parsed as JSON.' };
    }
    try {
      parsed = JSON.parse(match[0]);
    } catch {
      return { ok: false, reason: 'The answer could not be parsed as JSON.' };
    }
  }

  if (!parsed || typeof parsed !== 'object') {
    return { ok: false, reason: 'The answer was not a JSON object.' };
  }

  const validSourceIds = new Set(hits.map((_, i) => `S${i + 1}`));
  const templatesByName = new Map(supporting.templates.map((t) => [t.name.toLowerCase(), t]));
  const kbTemplatesByName = new Map(kb.templates.map((t) => [t.name.toLowerCase(), t]));

  const direct = scrubText(parsed.direct_answer, removals);
  if (!direct) return { ok: false, reason: 'The answer had no direct answer field.' };

  // Sources: keep only ids that were actually supplied, then map back to real chunks.
  const citedIds = [];
  if (Array.isArray(parsed.sources)) {
    for (const value of parsed.sources) {
      const id = asString(value, 8).toUpperCase().replace(/[^S0-9]/g, '');
      if (validSourceIds.has(id) && !citedIds.includes(id)) citedIds.push(id);
      else if (id) removals.push(`invalid source id "${id}"`);
      if (citedIds.length >= MAX.sources) break;
    }
  }
  // A cited-nothing answer still needs provenance, so fall back to the top hits.
  const usedIds = citedIds.length ? citedIds : hits.slice(0, 3).map((_, i) => `S${i + 1}`);
  const sources = usedIds
    .map((id) => hits[Number(id.slice(1)) - 1])
    .filter(Boolean)
    .map((hit) => ({
      id: hit.chunk.id,
      heading: hit.chunk.heading,
      topic: hit.chunk.topic_title,
      path: hit.chunk.path,
      authority: hit.chunk.authority,
      jurisdiction: hit.chunk.jurisdiction,
      excerpt: hit.chunk.summary,
      source_document: hit.chunk.source_document,
      links: (hit.chunk.citations || []).filter((c) => kb.allowed_urls.includes(c.url)),
    }));

  // Templates: the model may only name templates that exist. Links come from the KB.
  const templates = [];
  if (Array.isArray(parsed.templates)) {
    for (const item of parsed.templates) {
      const name = asString(typeof item === 'string' ? item : item?.name, 160);
      if (!name) continue;
      const match =
        templatesByName.get(name.toLowerCase()) ||
        kbTemplatesByName.get(name.toLowerCase()) ||
        findTemplateLoosely(name, supporting.templates) ||
        findTemplateLoosely(name, kb.templates);
      if (!match) {
        removals.push(`unknown template "${name}"`);
        continue;
      }
      if (templates.some((t) => t.id === match.id)) continue;
      templates.push({
        id: match.id,
        name: match.name,
        url: match.url,
        source: match.source,
        why: scrubText(typeof item === 'object' ? item?.why : '', removals) || match.description,
      });
      if (templates.length >= MAX.templates) break;
    }
  }
  // If the model named none but the retrieved evidence carries some, offer them anyway.
  if (!templates.length) {
    for (const t of supporting.templates.slice(0, 4)) {
      templates.push({ id: t.id, name: t.name, url: t.url, source: t.source, why: t.description });
    }
  }

  const thresholds = [];
  if (Array.isArray(parsed.thresholds)) {
    for (const item of parsed.thresholds) {
      const label = scrubText(typeof item === 'string' ? item : item?.label, removals);
      const detail = scrubText(typeof item === 'object' ? item?.detail : '', removals);
      if (!label) continue;
      thresholds.push({ label, detail });
      if (thresholds.length >= MAX.thresholds) break;
    }
  }

  const answer = {
    direct_answer: direct,
    applies_to_you: scrubText(parsed.applies_to_you, removals) || null,
    key_points: asStringArray(parsed.key_points, MAX.key_points, removals),
    checklist: asStringArray(parsed.checklist, MAX.checklist, removals),
    thresholds,
    templates,
    watch_outs: asStringArray(parsed.watch_outs, MAX.watch_outs, removals),
    summary: scrubText(parsed.summary, removals) || null,
    sources,
    confidence: ['high', 'medium', 'low'].includes(parsed.confidence) ? parsed.confidence : 'medium',
    out_of_scope: parsed.out_of_scope === true,
  };

  // A model that cited nothing usable is a model that was probably guessing.
  if (!citedIds.length) {
    answer.confidence = answer.confidence === 'high' ? 'medium' : answer.confidence;
    removals.push('no valid source citations returned');
  }

  return { ok: true, answer, removals };
}

function findTemplateLoosely(name, pool) {
  const needle = name.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  if (needle.length < 6) return null;
  for (const template of pool) {
    const hay = template.name.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    if (hay.includes(needle) || needle.includes(hay)) return template;
  }
  return null;
}
