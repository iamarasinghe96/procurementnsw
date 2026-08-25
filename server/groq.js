/**
 * Minimal Groq chat-completions client.
 *
 * Runs in Node and in the browser: it takes its configuration as an argument
 * rather than reading process.env directly, so the same file can be bundled
 * into the standalone build. Anything meaning "the service is busy" is
 * surfaced as `high_demand` so the UI can show the retry-in-a-minute message.
 */

export const GROQ_ENDPOINT = 'https://api.groq.com/openai/v1/chat/completions';

/**
 * Tried in order when the configured model is unavailable.
 *
 * Groq retires models on its own schedule, and a key baked into a static page
 * cannot be redeployed the moment one goes. A chain that spans several families
 * means a retirement degrades the answer rather than stopping it.
 */
export const DEFAULT_FALLBACKS = [
  'llama-3.3-70b-versatile',
  'llama-3.1-8b-instant',
  'openai/gpt-oss-120b',
  'openai/gpt-oss-20b',
  'meta-llama/llama-4-scout-17b-16e-instruct',
  'qwen/qwen3-32b',
];

export class GroqError extends Error {
  constructor(kind, message, { status = null, retryAfter = null, detail = null, model = null } = {}) {
    super(message);
    this.name = 'GroqError';
    // high_demand | auth | bad_request | model_unavailable | blocked | network | server
    this.kind = kind;
    this.status = status;
    this.retryAfter = retryAfter;
    // Carried so the UI can say what actually went wrong instead of "could not
    // be reached", which sends people looking for a network fault that is not there.
    this.detail = detail;
    this.model = model;
  }
}

/** Pull the useful sentence out of an API error body. */
function summarise(body) {
  if (!body) return '';
  try {
    const parsed = JSON.parse(body);
    const message = parsed?.error?.message || parsed?.message;
    if (message) return String(message).slice(0, 220);
  } catch {
    /* not JSON */
  }
  return String(body).replace(/\s+/g, ' ').trim().slice(0, 220);
}

const env = (name, fallback = '') => {
  if (typeof process === 'undefined' || !process?.env) return fallback;
  return (process.env[name] || fallback).trim();
};

/** Server-side configuration, read from the environment. */
export function configFromEnv() {
  return {
    apiKey: env('GROQ_API_KEY'),
    model: env('GROQ_MODEL', 'llama-3.3-70b-versatile'),
    fallbackModels: env('GROQ_FALLBACK_MODELS', DEFAULT_FALLBACKS.join(','))
      .split(',')
      .map((m) => m.trim())
      .filter(Boolean),
    endpoint: env('GROQ_ENDPOINT', GROQ_ENDPOINT),
  };
}

export function isConfigured(config = configFromEnv()) {
  return Boolean(config?.apiKey);
}

function modelChain(config) {
  const primary = config.model || 'llama-3.3-70b-versatile';
  const fallbacks = (config.fallbackModels || []).filter((m) => m && m !== primary);
  return [primary, ...fallbacks];
}

/**
 * @param {{system: string, user: string, config?: object, temperature?: number,
 *          maxTokens?: number, timeoutMs?: number}} opts
 * @returns {Promise<{content: string, model: string, usage: object|null}>}
 */
export async function chatJSON(opts) {
  const config = opts.config || configFromEnv();
  if (!config.apiKey) throw new GroqError('auth', 'No Groq API key is configured');

  let lastError = null;
  for (const model of modelChain(config)) {
    try {
      return await callOnce(config, model, opts);
    } catch (err) {
      lastError = err;
      // Only walk the chain for problems the next model could actually fix.
      if (err instanceof GroqError && (err.kind === 'model_unavailable' || err.kind === 'high_demand')) {
        continue;
      }
      throw err;
    }
  }
  throw lastError || new GroqError('server', 'No Groq model succeeded');
}

async function callOnce(config, model, { system, user, temperature = 0.15, maxTokens = 2200, timeoutMs = 30000 }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let response;
  try {
    response = await fetch(config.endpoint || GROQ_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey}`,
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
    if (err.name === 'AbortError') {
      throw new GroqError('high_demand', `Groq request timed out after ${timeoutMs}ms`);
    }
    // In a browser a blocked cross-origin request is indistinguishable from an
    // offline network: both surface as an opaque TypeError. Callers need to be
    // able to tell the user which fix applies.
    if (typeof window !== 'undefined') {
      throw new GroqError(
        'blocked',
        'The browser could not reach Groq. This is usually a CORS restriction, which needs a small server-side proxy to fix.'
      );
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
      /* body unreadable */
    }

    if (response.status === 429) {
      throw new GroqError('high_demand', 'Groq rate limit reached', { status: 429, retryAfter });
    }
    if (response.status === 401 || response.status === 403) {
      throw new GroqError('auth', 'Groq rejected the API key', { status: response.status });
    }
    // A retired or unknown model comes back as a 404, and sometimes as a 400
    // whose body names the model. Both must fall through to the next model
    // rather than ending the request.
    if (
      response.status === 404 ||
      /model/i.test(detail) &&
        /(not found|decommissioned|does not exist|not supported|invalid|deprecat)/i.test(detail)
    ) {
      throw new GroqError('model_unavailable', `Model ${model} is unavailable: ${summarise(detail)}`, {
        status: response.status,
        detail: summarise(detail),
        model,
      });
    }
    if (response.status >= 500) {
      throw new GroqError('high_demand', `Groq returned ${response.status}`, { status: response.status, retryAfter });
    }
    throw new GroqError('bad_request', `Groq returned ${response.status}: ${summarise(detail)}`, {
      status: response.status,
      detail: summarise(detail),
      model,
    });
  }

  const payload = await response.json();
  const content = payload?.choices?.[0]?.message?.content;
  if (!content) throw new GroqError('server', 'Groq returned an empty completion');

  return { content, model, usage: payload.usage || null };
}
