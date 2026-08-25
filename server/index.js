/**
 * NSW Procurement Navigator - HTTP server.
 *
 * Dependency-free: node:http for routing, node:fs for static files. The Groq key
 * stays server-side and never reaches the browser.
 */
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname, extname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Answerer } from './answer.js';
import { RateLimiter, HIGH_DEMAND_MESSAGE, PER_CLIENT_MESSAGE } from './rateLimit.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const publicDir = join(root, 'public');
const kbPath = join(root, 'data', 'knowledge-base.json');

loadDotEnv(join(root, '.env'));

if (!existsSync(kbPath)) {
  console.error('data/knowledge-base.json is missing. Run: npm run build:kb');
  process.exit(1);
}

const kb = JSON.parse(readFileSync(kbPath, 'utf8'));
const answerer = new Answerer(kb);
const limiter = new RateLimiter();

const PORT = Number(process.env.PORT || 3000);
const MAX_QUESTION_LENGTH = 600;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  try {
    if (url.pathname === '/api/bootstrap' && req.method === 'GET') return sendJSON(res, 200, bootstrap());
    if (url.pathname === '/api/topics' && req.method === 'GET') return sendJSON(res, 200, topicsPayload());
    if (url.pathname === '/api/health' && req.method === 'GET') {
      return sendJSON(res, 200, {
        ok: true,
        chunks: kb.chunks.length,
        ai: Boolean((process.env.GROQ_API_KEY || '').trim()),
      });
    }
    if (url.pathname === '/api/ask' && req.method === 'POST') return await handleAsk(req, res);

    return await serveStatic(url.pathname, res);
  } catch (err) {
    console.error('Unhandled error:', err);
    return sendJSON(res, 500, {
      error: 'server_error',
      message: 'Something went wrong at our end. Please try again in a moment.',
    });
  }
});

async function handleAsk(req, res) {
  const clientKey = clientIp(req);
  const gate = limiter.take(clientKey);

  if (!gate.allowed) {
    res.setHeader('Retry-After', String(gate.retryAfter));
    return sendJSON(res, 429, {
      error: 'high_demand',
      message: gate.reason === 'per_client' ? PER_CLIENT_MESSAGE : HIGH_DEMAND_MESSAGE,
      retry_after_seconds: gate.retryAfter,
    });
  }

  let body;
  try {
    body = await readJSONBody(req);
  } catch (err) {
    return sendJSON(res, 400, { error: 'bad_request', message: err.message });
  }

  const question = String(body.question || '').trim();
  const audience = body.audience ? String(body.audience).trim() : null;

  if (!question) {
    return sendJSON(res, 400, { error: 'bad_request', message: 'Please enter a question or a topic to search for.' });
  }
  if (question.length > MAX_QUESTION_LENGTH) {
    return sendJSON(res, 400, {
      error: 'bad_request',
      message: `Please shorten your question to ${MAX_QUESTION_LENGTH} characters or fewer.`,
    });
  }
  if (audience && !kb.audiences.some((a) => a.id === audience)) {
    return sendJSON(res, 400, { error: 'bad_request', message: 'Unknown audience.' });
  }

  limiter.enter();
  try {
    const result = await answerer.ask({ question, audience });
    return sendJSON(res, 200, { question, ...result });
  } catch (err) {
    if (err.kind === 'high_demand') {
      const retryAfter = err.retryAfter || 60;
      res.setHeader('Retry-After', String(retryAfter));
      return sendJSON(res, 429, {
        error: 'high_demand',
        message: HIGH_DEMAND_MESSAGE,
        retry_after_seconds: retryAfter,
      });
    }
    console.error('Ask failed:', err);
    return sendJSON(res, 500, {
      error: 'server_error',
      message: 'Something went wrong answering that. Please try again in a moment.',
    });
  } finally {
    limiter.leave();
  }
}

function bootstrap() {
  return {
    meta: {
      name: kb.meta.name,
      version: kb.meta.version,
      disclaimer: kb.meta.disclaimer,
      training_source: kb.meta.training_source,
      chunk_count: kb.meta.chunk_count,
      topic_count: kb.meta.topic_count,
      built_at: kb.meta.built_at,
    },
    audiences: kb.audiences,
    topics: kb.topics.map((t) => ({
      id: t.id,
      title: t.title,
      path: t.path,
      stage: t.stage,
      summary: t.summary,
      audiences: t.audiences,
      chunk_count: t.chunk_ids.length,
    })),
    thresholds: kb.thresholds.map((t) => ({
      id: t.id,
      label: t.label,
      applies_to: t.applies_to,
      rule: t.rule,
      citations: t.citations,
    })),
    glossary: kb.glossary,
    primary_sources: kb.meta.primary_sources,
    ai_enabled: Boolean((process.env.GROQ_API_KEY || '').trim()),
  };
}

function topicsPayload() {
  return {
    topics: kb.topics.map((topic) => ({
      ...topic,
      chunks: kb.chunks
        .filter((c) => c.topic_id === topic.id)
        .map((c) => ({
          id: c.id,
          heading: c.heading,
          path: c.path,
          summary: c.summary,
          audiences: c.audiences,
          jurisdiction: c.jurisdiction,
          authority: c.authority,
          text: c.text,
          checklist: c.checklist || [],
          watch_outs: c.watch_outs || [],
          citations: (c.citations || []).filter((cite) => kb.allowed_urls.includes(cite.url)),
          templates: (c.templates || [])
            .map((id) => kb.templates.find((t) => t.id === id))
            .filter(Boolean)
            .map((t) => ({ id: t.id, name: t.name, url: t.url })),
        })),
    })),
    templates: kb.templates,
  };
}

async function serveStatic(pathname, res) {
  const relative = pathname === '/' ? 'index.html' : normalize(pathname).replace(/^(\.\.[/\\])+/, '').replace(/^\//, '');
  const filePath = join(publicDir, relative);

  if (!filePath.startsWith(publicDir)) {
    return sendText(res, 403, 'Forbidden');
  }

  try {
    const info = await stat(filePath);
    if (!info.isFile()) throw new Error('not a file');
    const body = await readFile(filePath);
    res.writeHead(200, {
      'Content-Type': MIME[extname(filePath)] || 'application/octet-stream',
      'Cache-Control': extname(filePath) === '.html' ? 'no-cache' : 'public, max-age=300',
      'X-Content-Type-Options': 'nosniff',
    });
    return res.end(body);
  } catch {
    // Unknown path: fall back to the app shell so client-side routing works.
    try {
      const shell = await readFile(join(publicDir, 'index.html'));
      res.writeHead(200, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-cache' });
      return res.end(shell);
    } catch {
      return sendText(res, 404, 'Not found');
    }
  }
}

function readJSONBody(req, limit = 16 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('Request body is too large.'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new Error('Request body was not valid JSON.'));
      }
    });
    req.on('error', () => reject(new Error('Could not read the request.')));
  });
}

function clientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.length) return forwarded.split(',')[0].trim();
  return req.socket.remoteAddress || 'unknown';
}

function sendJSON(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(body);
}

function sendText(res, status, text) {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(text);
}

/** Tiny .env reader so there is no dotenv dependency. */
function loadDotEnv(path) {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

server.listen(PORT, () => {
  const ai = (process.env.GROQ_API_KEY || '').trim();
  console.log(`NSW Procurement Navigator listening on http://localhost:${PORT}`);
  console.log(`  knowledge base: ${kb.chunks.length} chunks across ${kb.topics.length} topics`);
  console.log(`  AI answering:   ${ai ? `enabled (${process.env.GROQ_MODEL || 'llama-3.3-70b-versatile'})` : 'disabled - set GROQ_API_KEY to enable'}`);
});

export { server, answerer, kb };
