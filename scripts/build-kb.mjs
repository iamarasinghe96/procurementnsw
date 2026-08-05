#!/usr/bin/env node
/**
 * Merges data/kb/*.json into a single data/knowledge-base.json and validates it.
 *
 * Validation is deliberately strict: the merged file is what grounds every AI
 * answer, so a broken reference here becomes a hallucinated citation at runtime.
 */
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const kbDir = join(root, 'data', 'kb');
const outFile = join(root, 'data', 'knowledge-base.json');

const errors = [];
const warnings = [];

const files = readdirSync(kbDir).filter((f) => f.endsWith('.json')).sort();
if (!files.length) {
  console.error('No knowledge base parts found in data/kb');
  process.exit(1);
}

let registry = null;
const topics = [];

for (const file of files) {
  const raw = readFileSync(join(kbDir, file), 'utf8');
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    errors.push(`${file}: invalid JSON - ${err.message}`);
    continue;
  }
  if (parsed.meta && parsed.audiences) {
    registry = parsed;
  } else if (parsed.topic && Array.isArray(parsed.chunks)) {
    topics.push({ file, ...parsed });
  } else {
    errors.push(`${file}: expected either a registry (meta + audiences) or a topic (topic + chunks)`);
  }
}

if (!registry) {
  console.error('No registry file found (expected data/kb/00-registry.json)');
  process.exit(1);
}

const audienceIds = new Set(registry.audiences.map((a) => a.id));
const thresholdIds = new Set(registry.thresholds.map((t) => t.id));
const templateIds = new Set(registry.templates.map((t) => t.id));

const chunks = [];
const seenChunkIds = new Set();
const allowedUrls = new Set();

const addUrl = (url) => {
  if (typeof url === 'string' && /^https?:\/\//i.test(url)) allowedUrls.add(url);
};

registry.templates.forEach((t) => addUrl(t.url));
registry.meta.primary_sources.forEach((s) => addUrl(s.url));
registry.thresholds.forEach((t) => (t.citations || []).forEach((c) => addUrl(c.url)));

for (const topic of topics) {
  const t = topic.topic;
  for (const key of ['id', 'title', 'path', 'summary']) {
    if (!t[key]) errors.push(`${topic.file}: topic missing "${key}"`);
  }
  for (const chunk of topic.chunks) {
    for (const key of ['id', 'path', 'heading', 'text', 'summary']) {
      if (!chunk[key]) errors.push(`${topic.file}: chunk "${chunk.id || '?'}" missing "${key}"`);
    }
    if (seenChunkIds.has(chunk.id)) errors.push(`Duplicate chunk id: ${chunk.id}`);
    seenChunkIds.add(chunk.id);

    (chunk.audiences || []).forEach((a) => {
      if (!audienceIds.has(a)) errors.push(`${chunk.id}: unknown audience "${a}"`);
    });
    (chunk.thresholds || []).forEach((id) => {
      if (!thresholdIds.has(id)) errors.push(`${chunk.id}: unknown threshold "${id}"`);
    });
    (chunk.templates || []).forEach((id) => {
      if (!templateIds.has(id)) errors.push(`${chunk.id}: unknown template "${id}"`);
    });
    (chunk.citations || []).forEach((c) => {
      if (!c.label || !c.url) errors.push(`${chunk.id}: citation missing label or url`);
      addUrl(c.url);
    });

    if (chunk.text && chunk.text.length < 120) {
      warnings.push(`${chunk.id}: text is very short (${chunk.text.length} chars)`);
    }

    chunks.push({
      ...chunk,
      topic_id: t.id,
      topic_title: t.title,
      topic_path: t.path,
      stage: chunk.stage || t.stage || 'all',
      audiences: chunk.audiences && chunk.audiences.length ? chunk.audiences : t.audiences || [],
      jurisdiction: chunk.jurisdiction || 'both',
      authority: chunk.authority || 'guidance',
      source_document: t.source_document || null,
    });
  }
}

const kb = {
  meta: {
    ...registry.meta,
    built_at: new Date().toISOString(),
    topic_count: topics.length,
    chunk_count: chunks.length,
  },
  audiences: registry.audiences,
  thresholds: registry.thresholds,
  templates: registry.templates,
  glossary: registry.glossary,
  topics: topics.map((t) => ({
    ...t.topic,
    chunk_ids: t.chunks.map((c) => c.id),
  })),
  chunks,
  // Every URL the answering layer is permitted to surface. Anything the model
  // invents that is not in this list gets stripped before it reaches a user.
  allowed_urls: [...allowedUrls].sort(),
};

if (errors.length) {
  console.error('Knowledge base validation failed:\n' + errors.map((e) => `  - ${e}`).join('\n'));
  process.exit(1);
}

writeFileSync(outFile, JSON.stringify(kb, null, 2) + '\n');

if (warnings.length) {
  console.warn('Warnings:\n' + warnings.map((w) => `  - ${w}`).join('\n'));
}

console.log(
  `Built ${outFile}\n` +
    `  topics:     ${kb.topics.length}\n` +
    `  chunks:     ${kb.chunks.length}\n` +
    `  thresholds: ${kb.thresholds.length}\n` +
    `  templates:  ${kb.templates.length}\n` +
    `  glossary:   ${kb.glossary.length}\n` +
    `  audiences:  ${kb.audiences.length}\n` +
    `  URLs:       ${kb.allowed_urls.length}`
);
