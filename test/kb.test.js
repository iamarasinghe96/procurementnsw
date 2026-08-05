import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const kb = JSON.parse(readFileSync(join(root, 'data', 'knowledge-base.json'), 'utf8'));

test('knowledge base has content across all topics', () => {
  assert.ok(kb.chunks.length >= 60, 'expected a substantial number of chunks');
  assert.ok(kb.topics.length >= 10);
  for (const topic of kb.topics) {
    const owned = kb.chunks.filter((c) => c.topic_id === topic.id);
    assert.ok(owned.length > 0, `topic ${topic.id} has no chunks`);
  }
});

test('every chunk id is unique and every chunk has a path', () => {
  const ids = new Set();
  for (const chunk of kb.chunks) {
    assert.ok(!ids.has(chunk.id), `duplicate chunk id ${chunk.id}`);
    ids.add(chunk.id);
    assert.match(chunk.path, /^[a-z0-9-]+(\/[a-z0-9-]+)*$/, `bad path on ${chunk.id}`);
  }
});

test('every referenced threshold and template exists', () => {
  const thresholds = new Set(kb.thresholds.map((t) => t.id));
  const templates = new Set(kb.templates.map((t) => t.id));
  for (const chunk of kb.chunks) {
    for (const id of chunk.thresholds || []) assert.ok(thresholds.has(id), `${chunk.id} -> ${id}`);
    for (const id of chunk.templates || []) assert.ok(templates.has(id), `${chunk.id} -> ${id}`);
  }
});

test('every URL anywhere in the knowledge base is in allowed_urls', () => {
  const allowed = new Set(kb.allowed_urls);
  const check = (url, where) => assert.ok(allowed.has(url), `${where} has unlisted URL ${url}`);
  for (const chunk of kb.chunks) for (const c of chunk.citations || []) check(c.url, chunk.id);
  for (const t of kb.templates) check(t.url, t.id);
  for (const t of kb.thresholds) for (const c of t.citations || []) check(c.url, t.id);
});

test('every audience referenced by a chunk is defined', () => {
  const audiences = new Set(kb.audiences.map((a) => a.id));
  for (const chunk of kb.chunks) {
    assert.ok((chunk.audiences || []).length > 0, `${chunk.id} has no audiences`);
    for (const id of chunk.audiences) assert.ok(audiences.has(id), `${chunk.id} -> ${id}`);
  }
});

test('council and NSW agency content are both present and separable', () => {
  const council = kb.chunks.filter((c) => c.jurisdiction === 'local-government');
  const agency = kb.chunks.filter((c) => c.jurisdiction === 'nsw-government');
  assert.ok(council.length >= 5, 'expected dedicated council content');
  assert.ok(agency.length >= 10, 'expected dedicated NSW agency content');
});

test('the council tendering threshold is recorded and distinct from agency rules', () => {
  const councilRule = kb.thresholds.find((t) => t.id === 'thr-council-tender-250k');
  assert.ok(councilRule);
  assert.ok(councilRule.applies_to.includes('council'));
  assert.ok(!councilRule.applies_to.includes('agency'), 'council tender threshold must not be offered to agencies');
  assert.match(councilRule.rule, /Local Government Act/);
});
