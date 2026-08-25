/**
 * Guards the standalone bundle against the failure mode that shipped once: a
 * truncated favicon tag left an unterminated attribute, which swallowed the
 * <style> element and every rule after it. Every element still existed, so
 * element-count checks passed while the page rendered as raw CSS text.
 *
 * These assertions test the markup, not the element inventory.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const bundlePath = join(root, 'dist', 'procurement-navigator.html');

assert.ok(
  existsSync(bundlePath),
  'dist/procurement-navigator.html is missing - run: node scripts/build-standalone.mjs'
);
const html = readFileSync(bundlePath, 'utf8');

test('the document starts with the doctype', () => {
  assert.match(html.slice(0, 40).trimStart(), /^<!doctype html>/i);
});

test('there is exactly one stylesheet and it lives in the head', () => {
  assert.equal((html.match(/<style>/g) || []).length, 1);
  assert.equal((html.match(/<\/style>/g) || []).length, 1);
  assert.ok(html.indexOf('<style>') < html.indexOf('</head>'), '<style> must be inside <head>');
});

test('no tag before the stylesheet leaves an attribute open', () => {
  // An odd number of double quotes means a quoted value is still open when the
  // parser reaches <style>, so the stylesheet becomes attribute text.
  const preamble = html.slice(0, html.indexOf('<style>'));
  assert.equal((preamble.match(/"/g) || []).length % 2, 0, 'unbalanced double quote before <style>');
});

test('the favicon data URI has no raw angle brackets', () => {
  const favicon = html.match(/<link\s+rel="icon"[\s\S]*?>\s*$/m)?.[0]
    ?? html.split('\n').find((l) => l.includes('rel="icon"'));
  assert.ok(favicon, 'favicon link not found');
  const href = favicon.match(/href="([^"]*)"/)?.[1];
  assert.ok(href, 'favicon href must be a single complete quoted value');
  assert.ok(!href.includes('<'), 'raw < in the favicon href truncates the tag for naive parsers');
  assert.ok(!href.includes('>'), 'raw > in the favicon href truncates the tag for naive parsers');
});

test('the document skeleton is balanced', () => {
  for (const [tag, expected] of [['<head>', 1], ['</head>', 1], ['<body>', 1], ['</body>', 1], ['</html>', 1]]) {
    assert.equal((html.split(tag).length - 1), expected, `expected ${expected} of ${tag}`);
  }
});

test('the knowledge base and engine are embedded, not linked', () => {
  assert.ok(html.includes('window.__PN_EMBEDDED__'), 'embedded adapter missing');
  assert.ok(/const KB = \{/.test(html), 'knowledge base not inlined');
  assert.ok(!/<script src=/.test(html), 'bundle must not reference external scripts');
  assert.ok(!/<link rel="stylesheet"/.test(html), 'bundle must not reference an external stylesheet');
});

test('the inlined knowledge base is complete and parseable', () => {
  const start = html.indexOf('const KB = ') + 'const KB = '.length;
  const end = html.indexOf('\n</script>', start);
  const kb = JSON.parse(html.slice(start, end).replace(/;$/, ''));
  assert.ok(kb.chunks.length >= 60);
  assert.ok(kb.audiences.length >= 6);
  assert.ok(kb.allowed_urls.length > 0);
});

test('no external host is referenced outside the citation allow-list', () => {
  const start = html.indexOf('const KB = ') + 'const KB = '.length;
  const end = html.indexOf('\n</script>', start);
  const kb = JSON.parse(html.slice(start, end).replace(/;$/, ''));
  const allowed = new Set(kb.allowed_urls);

  // Anything the browser would fetch at load time, as opposed to links a
  // reader can choose to click.
  const fetched = [...html.matchAll(/(?:src|href)="(https?:\/\/[^"]+)"/g)].map((m) => m[1]);
  for (const url of fetched) {
    assert.ok(allowed.has(url), `bundle would load ${url}, which is not a knowledge base citation`);
  }
});
