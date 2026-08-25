/**
 * Answering pipeline: retrieve -> ground -> generate -> guard.
 *
 * Two modes, and the difference is always visible to the reader.
 *
 * GROUNDED    Retrieval found evidence. The model sees numbered sources and may
 *             use nothing else. This is the normal path.
 * UNVERIFIED  Retrieval found nothing. If general answering is enabled the model
 *             answers from its own knowledge, with NSW-specific figures stripped
 *             on the way out and the answer flagged unverified. Otherwise the
 *             reader is told plainly that the question is not covered.
 *
 * Runs unchanged in Node and in the browser: configuration is passed in rather
 * than read from the environment.
 */
import { Index, relevant, detectAudience } from './retrieval.js';
import {
  buildSystemPrompt,
  buildUserPrompt,
  buildGeneralSystemPrompt,
  buildGeneralUserPrompt,
} from './prompt.js';
import { chatJSON, GroqError, isConfigured, configFromEnv } from './groq.js';
import { validateAnswer, validateGeneralAnswer } from './guardrails.js';
import { composeFromKnowledgeBase, composeNoMatch } from './compose.js';

export class Answerer {
  /**
   * @param {object} kb
   * @param {{config?: object, allowGeneralAnswers?: boolean}} options
   */
  constructor(kb, options = {}) {
    this.kb = kb;
    this.index = new Index(kb);
    this.config = options.config || (typeof process !== 'undefined' ? configFromEnv() : null);
    this.allowGeneralAnswers = options.allowGeneralAnswers !== false;
  }

  get aiEnabled() {
    return isConfigured(this.config);
  }

  async ask({ question, audience = null }) {
    const started = Date.now();

    // The selector is a default, not a declaration. "If an AGENCY wants to
    // purchase..." asked with Local council selected must not be answered under
    // the Local Government Act, so the question itself gets the final say.
    const detected = detectAudience(question);
    let effective = audience;
    let audienceNotice = null;
    if (detected && detected.id !== audience) {
      effective = detected.id;
      audienceNotice = {
        from: audience,
        to: detected.id,
        evidence: detected.evidence,
        reason: audience ? 'contradicts_selection' : 'inferred',
      };
    }

    const audienceMeta = effective ? this.kb.audiences.find((a) => a.id === effective) || null : null;
    const base = { audience: audienceMeta?.id || null, audience_notice: audienceNotice };

    const hits = relevant(this.index.search(question, { audience: audienceMeta?.id || null, limit: 8 }));

    if (!hits.length) {
      return this.answerWithoutSources({ question, audienceMeta, started, base });
    }

    const supporting = this.index.supporting(question, hits, audienceMeta?.id || null);
    const fallback = (note) => ({
      status: 'ok',
      answer: composeFromKnowledgeBase(this.kb, hits, supporting, audienceMeta),
      meta: { ...base, elapsed_ms: Date.now() - started, grounded: true, mode: 'retrieval-only', note },
    });

    if (!this.aiEnabled) {
      return fallback('No AI key is configured, so this answer is assembled directly from the knowledge base.');
    }

    let completion;
    try {
      completion = await chatJSON({
        config: this.config,
        system: buildSystemPrompt(),
        user: buildUserPrompt({ question, audience: audienceMeta, hits, supporting }),
      });
    } catch (err) {
      const handled = this.handleGroqError(err, fallback);
      if (handled) return handled;
      throw err;
    }

    const validated = validateAnswer(completion.content, { hits, supporting, kb: this.kb });
    if (!validated.ok) {
      return fallback(`The AI response was rejected by the safety checks (${validated.reason}).`);
    }

    return {
      status: 'ok',
      answer: validated.answer,
      meta: {
        ...base,
        elapsed_ms: Date.now() - started,
        grounded: true,
        mode: 'ai',
        model: completion.model,
        retrieved: hits.length,
        removed: validated.removals,
      },
    };
  }

  /** Nothing was retrieved: either answer unverified, or decline clearly. */
  async answerWithoutSources({ question, audienceMeta, started, base }) {
    const declined = (note) => ({
      status: 'no_match',
      answer: composeNoMatch(this.kb, audienceMeta, this.index.didYouMean(question)),
      meta: { ...base, elapsed_ms: Date.now() - started, grounded: false, mode: 'retrieval-only', note },
    });

    if (!this.aiEnabled || !this.allowGeneralAnswers) return declined();

    let completion;
    try {
      completion = await chatJSON({
        config: this.config,
        system: buildGeneralSystemPrompt(),
        user: buildGeneralUserPrompt({ question, audience: audienceMeta }),
        temperature: 0.25,
        maxTokens: 1200,
      });
    } catch (err) {
      const handled = this.handleGroqError(err, declined);
      if (handled) return handled;
      throw err;
    }

    const validated = validateGeneralAnswer(completion.content, { kb: this.kb });
    if (!validated.ok) {
      return declined(`The AI response was rejected by the safety checks (${validated.reason}).`);
    }

    return {
      status: 'unverified',
      answer: { ...validated.answer, corrections: this.index.didYouMean(question) },
      meta: {
        ...base,
        elapsed_ms: Date.now() - started,
        grounded: false,
        mode: 'ai-general',
        model: completion.model,
        removed: validated.removals,
      },
    };
  }

  /**
   * Returns a response for errors the tool should absorb. High demand is
   * rethrown, because the UI renders that one specially.
   */
  handleGroqError(err, fallback) {
    if (!(err instanceof GroqError)) return null;
    if (err.kind === 'high_demand' || err.kind === 'network') {
      const e = new Error('high_demand');
      e.kind = 'high_demand';
      e.retryAfter = err.retryAfter || 60;
      throw e;
    }
    if (err.kind === 'auth') {
      return fallback('The AI service rejected the API key, so this answer comes straight from the knowledge base.');
    }
    if (err.kind === 'blocked') {
      return fallback(
        'The browser could not reach the AI service, so this answer comes straight from the knowledge base. A small server-side proxy fixes this.'
      );
    }
    return fallback('The AI service could not be reached, so this answer comes straight from the knowledge base.');
  }

  retrievalOnlyAnswer(hits, supporting, audienceMeta) {
    return composeFromKnowledgeBase(this.kb, hits, supporting, audienceMeta);
  }

  noMatchAnswer(question, audienceMeta) {
    return composeNoMatch(this.kb, audienceMeta, this.index.didYouMean(question));
  }
}
