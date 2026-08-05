/**
 * Minimal Groq chat-completions client.
 *
 * No SDK: one fetch call, an explicit model fallback chain, and error
 * classification the caller can act on. Anything that means "the service is
 * busy" is surfaced as `high_demand` so the UI can show the retry-in-a-minute
 * message rather than a stack trace.
 */

const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';

export class GroqError extends Error {
  constructor(kind, message, { status = null, retryAfter = null } = {}) {
    super(message);
    this.name = 'GroqError';
    this.kind = kind; // high_demand | auth | bad_request | model_unavailable | network | server
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

function modelChain() {
  const configured = (process.env.GROQ_MODEL || '').trim();
  const fallbacks = (process.env.GROQ_FALLBACK_MODELS || 'llama-3.1-8b-instant')
    .split(',')
    .map((m) => m.trim())
    .filter(Boolean);
  const primary = configured || 'llama-3.3-70b-versatile';
  return [primary, ...fallbacks.filter((m) => m !== primary)];
}

export function isConfigured() {
  return Boolean((process.env.GROQ_API_KEY || '').trim());
}

/**
 * @param {{system: string, user: string, temperature?: number, maxTokens?: number, timeoutMs?: number}} opts
 * @returns {Promise<{content: string, model: string, usage: object|null}>}
 */
export async function chatJSON(opts) {
  const apiKey = (process.env.GROQ_API_KEY || '').trim();
  if (!apiKey) throw new GroqError('auth', 'GROQ_API_KEY is not set');

  const models = modelChain();
  let lastError = null;

  for (const model of models) {
    try {
      return await callOnce(apiKey, model, opts);
    } catch (err) {
      lastError = err;
      // Only walk down the chain for problems the next model could actually fix.
      if (err instanceof GroqError && (err.kind === 'model_unavailable' || err.kind === 'high_demand')) {
        continue;
      }
      throw err;
    }
  }
  throw lastError || new GroqError('server', 'No Groq model succeeded');
}

async function callOnce(apiKey, model, { system, user, temperature = 0.15, maxTokens = 2200, timeoutMs = 30000 }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let response;
  try {
    response = await fetch(GROQ_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        temperature,
        max_tokens: maxTokens,
        top_p: 0.9,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
      }),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    if (err.name === 'AbortError') {
      throw new GroqError('high_demand', `Groq request timed out after ${timeoutMs}ms`);
    }
    throw new GroqError('network', `Could not reach Groq: ${err.message}`);
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    const retryAfter = Number(response.headers.get('retry-after')) || null;
    let detail = '';
    try {
      detail = await response.text();
    } catch {
      /* body already consumed or unreadable */
    }

    if (response.status === 429) {
      throw new GroqError('high_demand', 'Groq rate limit reached', { status: 429, retryAfter });
    }
    if (response.status === 401 || response.status === 403) {
      throw new GroqError('auth', 'Groq rejected the API key', { status: response.status });
    }
    if (response.status === 404 || /model.*(not found|decommissioned|does not exist)/i.test(detail)) {
      throw new GroqError('model_unavailable', `Model ${model} is unavailable`, { status: response.status });
    }
    if (response.status >= 500) {
      throw new GroqError('high_demand', `Groq returned ${response.status}`, { status: response.status, retryAfter });
    }
    throw new GroqError('bad_request', `Groq returned ${response.status}: ${detail.slice(0, 300)}`, {
      status: response.status,
    });
  }

  const payload = await response.json();
  const content = payload?.choices?.[0]?.message?.content;
  if (!content) throw new GroqError('server', 'Groq returned an empty completion');

  return { content, model, usage: payload.usage || null };
}
