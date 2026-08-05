/**
 * In-process rate limiting.
 *
 * Two gates. A per-visitor sliding window stops one person hammering the API, and
 * a global concurrency gate stops the shared Groq key being exhausted when the
 * site is busy - which is the case the "try again in a minute" message exists for.
 */

const WINDOW_MS = 60_000;

export class RateLimiter {
  constructor({
    perClientPerMinute = Number(process.env.RATE_LIMIT_PER_MINUTE || 10),
    globalPerMinute = Number(process.env.GLOBAL_RATE_LIMIT_PER_MINUTE || 120),
    maxConcurrent = Number(process.env.MAX_CONCURRENT_REQUESTS || 6),
  } = {}) {
    this.perClientPerMinute = perClientPerMinute;
    this.globalPerMinute = globalPerMinute;
    this.maxConcurrent = maxConcurrent;
    this.clients = new Map();
    this.globalHits = [];
    this.inFlight = 0;

    // Stop the client map growing without bound on a long-running process.
    this.sweeper = setInterval(() => this.sweep(), WINDOW_MS);
    if (this.sweeper.unref) this.sweeper.unref();
  }

  sweep() {
    const cutoff = Date.now() - WINDOW_MS;
    for (const [key, hits] of this.clients) {
      const kept = hits.filter((t) => t > cutoff);
      if (kept.length) this.clients.set(key, kept);
      else this.clients.delete(key);
    }
    this.globalHits = this.globalHits.filter((t) => t > cutoff);
  }

  /**
   * @returns {{allowed: true} | {allowed: false, reason: string, retryAfter: number}}
   */
  take(clientKey) {
    const now = Date.now();
    const cutoff = now - WINDOW_MS;

    if (this.inFlight >= this.maxConcurrent) {
      return { allowed: false, reason: 'busy', retryAfter: 60 };
    }

    this.globalHits = this.globalHits.filter((t) => t > cutoff);
    if (this.globalHits.length >= this.globalPerMinute) {
      return { allowed: false, reason: 'busy', retryAfter: 60 };
    }

    const hits = (this.clients.get(clientKey) || []).filter((t) => t > cutoff);
    if (hits.length >= this.perClientPerMinute) {
      const oldest = hits[0];
      const retryAfter = Math.max(1, Math.ceil((oldest + WINDOW_MS - now) / 1000));
      return { allowed: false, reason: 'per_client', retryAfter };
    }

    hits.push(now);
    this.clients.set(clientKey, hits);
    this.globalHits.push(now);
    return { allowed: true };
  }

  enter() {
    this.inFlight += 1;
  }

  leave() {
    this.inFlight = Math.max(0, this.inFlight - 1);
  }
}

export const HIGH_DEMAND_MESSAGE =
  'We are getting a lot of questions right now, so this one could not be answered. Please try again in about 1 minute.';

export const PER_CLIENT_MESSAGE =
  'You have sent a lot of questions in a short time. Please wait about a minute and try again.';
