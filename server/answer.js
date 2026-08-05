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
    const top = hits[0].chunk;
    const checklist = [];
    const watchOuts = [];
    const keyPoints = [];

    for (const hit of hits.slice(0, 4)) {
      for (const item of hit.chunk.checklist || []) {
        if (checklist.length < 10 && !checklist.includes(item)) checklist.push(item);
      }
      for (const item of hit.chunk.watch_outs || []) {
        if (watchOuts.length < 5 && !watchOuts.includes(item)) watchOuts.push(item);
      }
      if (hit.chunk.id !== top.id && keyPoints.length < 5) keyPoints.push(`${hit.chunk.heading}: ${hit.chunk.summary}`);
    }

    return {
      direct_answer: top.summary,
      applies_to_you: audienceMeta ? audienceMeta.blurb : null,
      key_points: keyPoints,
      checklist,
      thresholds: supporting.thresholds.map((t) => ({ label: t.label, detail: t.rule })),
      templates: supporting.templates.slice(0, 5).map((t) => ({
        id: t.id,
        name: t.name,
        url: t.url,
        source: t.source,
        why: t.description,
      })),
      watch_outs: watchOuts,
      summary: top.text.length > 700 ? `${top.text.slice(0, 700).trim()}...` : top.text,
      sources: hits.slice(0, 5).map((hit) => ({
        id: hit.chunk.id,
        heading: hit.chunk.heading,
        topic: hit.chunk.topic_title,
        path: hit.chunk.path,
        authority: hit.chunk.authority,
        jurisdiction: hit.chunk.jurisdiction,
        excerpt: hit.chunk.summary,
        source_document: hit.chunk.source_document,
        links: (hit.chunk.citations || []).filter((c) => this.kb.allowed_urls.includes(c.url)),
      })),
      confidence: 'medium',
      out_of_scope: false,
    };
  }

  noMatchAnswer(question, audienceMeta) {
    const suggestions = audienceMeta
      ? audienceMeta.top_questions
      : this.kb.audiences.flatMap((a) => a.top_questions.slice(0, 1));
    return {
      direct_answer:
        'This knowledge base does not cover that question, so there is nothing here that can be answered without guessing.',
      applies_to_you: null,
      key_points: [
        'The knowledge base covers NSW procurement objectives, legislation and policy, governance, planning, sourcing, contract management, probity, corruption prevention, council procurement and supplier guidance.',
      ],
      checklist: [],
      thresholds: [],
      templates: [],
      watch_outs: [],
      summary: `Try rephrasing, or start from one of these: ${suggestions.slice(0, 4).join(' / ')}`,
      sources: [],
      confidence: 'low',
      out_of_scope: true,
      suggestions: suggestions.slice(0, 5),
    };
  }
}
