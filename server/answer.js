/**
 * Answering pipeline: retrieve -> ground -> generate -> guard.
 *
 * Two things never happen here. The model is never asked a question without
 * retrieved evidence attached, and its output is never returned to a user
 * without passing through the guardrails.
 */
import { Index } from './retrieval.js';
import { buildSystemPrompt, buildUserPrompt } from './prompt.js';
import { chatJSON, GroqError, isConfigured } from './groq.js';
import { validateAnswer } from './guardrails.js';
import { composeFromKnowledgeBase, composeNoMatch } from './compose.js';

const MIN_SCORE = 1.2; // below this the retrieval is noise, not evidence

export class Answerer {
  constructor(kb) {
    this.kb = kb;
    this.index = new Index(kb);
  }

  /**
   * @param {{question: string, audience?: string|null}} input
   */
  async ask({ question, audience = null }) {
    const started = Date.now();
    const audienceMeta = audience ? this.kb.audiences.find((a) => a.id === audience) || null : null;

    const hits = this.index
      .search(question, { audience: audienceMeta?.id || null, limit: 8 })
      .filter((h) => h.score >= MIN_SCORE);

    if (!hits.length) {
      return {
        status: 'no_match',
        answer: this.noMatchAnswer(question, audienceMeta),
        meta: { audience: audienceMeta?.id || null, elapsed_ms: Date.now() - started, grounded: false },
      };
    }

    const supporting = this.index.supporting(question, hits, audienceMeta?.id || null);

    if (!isConfigured()) {
      return {
        status: 'ok',
        answer: this.retrievalOnlyAnswer(hits, supporting, audienceMeta),
        meta: {
          audience: audienceMeta?.id || null,
          elapsed_ms: Date.now() - started,
          grounded: true,
          mode: 'retrieval-only',
          note: 'GROQ_API_KEY is not set, so this answer is assembled directly from the knowledge base without AI synthesis.',
        },
      };
    }

    const system = buildSystemPrompt();
    const user = buildUserPrompt({ question, audience: audienceMeta, hits, supporting });

    let completion;
    try {
      completion = await chatJSON({ system, user });
    } catch (err) {
      if (err instanceof GroqError && (err.kind === 'high_demand' || err.kind === 'network')) {
        const e = new Error('high_demand');
        e.kind = 'high_demand';
        e.retryAfter = err.retryAfter || 60;
        throw e;
      }
      if (err instanceof GroqError && err.kind === 'auth') {
        // A misconfigured key should not take the whole tool down.
        return {
          status: 'ok',
          answer: this.retrievalOnlyAnswer(hits, supporting, audienceMeta),
          meta: {
            audience: audienceMeta?.id || null,
            elapsed_ms: Date.now() - started,
            grounded: true,
            mode: 'retrieval-only',
            note: 'The AI service rejected the configured API key, so this answer comes straight from the knowledge base.',
          },
        };
      }
      throw err;
    }

    const validated = validateAnswer(completion.content, { hits, supporting, kb: this.kb });
    if (!validated.ok) {
      return {
        status: 'ok',
        answer: this.retrievalOnlyAnswer(hits, supporting, audienceMeta),
        meta: {
          audience: audienceMeta?.id || null,
          elapsed_ms: Date.now() - started,
          grounded: true,
          mode: 'retrieval-only',
          note: `The AI response was rejected by the safety checks (${validated.reason}), so this answer comes straight from the knowledge base.`,
        },
      };
    }

    return {
      status: 'ok',
      answer: validated.answer,
      meta: {
        audience: audienceMeta?.id || null,
        elapsed_ms: Date.now() - started,
        grounded: true,
        mode: 'ai',
        model: completion.model,
        retrieved: hits.length,
        removed: validated.removals,
      },
    };
  }

  /** Assembled straight from the knowledge base - no model involved. */
  retrievalOnlyAnswer(hits, supporting, audienceMeta) {
    return composeFromKnowledgeBase(this.kb, hits, supporting, audienceMeta);
  }

  noMatchAnswer(question, audienceMeta) {
    return composeNoMatch(this.kb, audienceMeta, this.index.didYouMean(question));
  }
}
