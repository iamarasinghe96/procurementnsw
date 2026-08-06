/* NSW Procurement Navigator — client.
   No framework, no build step. Renders the shell from /api/bootstrap, then
   posts questions to /api/ask and paints the structured answer it gets back. */
(() => {
  'use strict';

  const $ = (sel) => document.querySelector(sel);
  const el = (tag, attrs = {}, ...kids) => {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === 'class') node.className = v;
      else if (k === 'html') node.innerHTML = v;
      else if (k.startsWith('on')) node.addEventListener(k.slice(2).toLowerCase(), v);
      else node.setAttribute(k, v === true ? '' : String(v));
    }
    for (const kid of kids.flat()) {
      if (kid == null || kid === false) continue;
      node.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    }
    return node;
  };

  // SVG lives in its own namespace, so it cannot be built with createElement.
  // Parsing the markup is the least fragile way to get a real SVGElement back.
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const icon = (d, extra = {}) => {
    const svg = document.createElementNS(SVG_NS, 'svg');
    const attrs = {
      viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.9',
      'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true', ...extra,
    };
    for (const [k, v] of Object.entries(attrs)) svg.setAttribute(k, String(v));
    const parsed = new DOMParser().parseFromString(`<svg xmlns="${SVG_NS}">${d}</svg>`, 'image/svg+xml');
    for (const child of Array.from(parsed.documentElement.childNodes)) {
      svg.appendChild(document.importNode(child, true));
    }
    return svg;
  };

  const ICONS = {
    council:  '<path d="M3 21h18M5 21V10l7-5 7 5v11M9 21v-5h6v5"/>',
    agency:   '<path d="M3 21h18M4 21V8l8-4 8 4v13M9 12h1.5M13.5 12H15M9 16h1.5M13.5 16H15"/>',
    supplier: '<path d="M3 8h18l-1.5 12h-15zM8 8V6a4 4 0 0 1 8 0v2"/>',
    corporate:'<path d="M3 21h18M5 21V4h9v17M14 9h5v12M8 8h3M8 12h3M8 16h3"/>',
    nfp:      '<path d="M12 20s-7-4.4-7-9.4A3.9 3.9 0 0 1 12 8a3.9 3.9 0 0 1 7 2.6c0 5-7 9.4-7 9.4z"/>',
    public:   '<circle cx="12" cy="12" r="9"/><path d="M3.2 9h17.6M3.2 15h17.6M12 3a15 15 0 0 1 0 18 15 15 0 0 1 0-18z"/>',
    list:     '<path d="M8 6h13M8 12h13M8 18h13M3.5 6h.01M3.5 12h.01M3.5 18h.01"/>',
    check:    '<path d="M4 12.5 9 17.5 20 6.5"/>',
    coin:     '<circle cx="12" cy="12" r="9"/><path d="M15 9.2A3.4 3.4 0 0 0 12 8c-1.7 0-3 .9-3 2.1 0 2.8 6 1.4 6 4 0 1.2-1.3 2.1-3 2.1a3.4 3.4 0 0 1-3-1.2M12 6.4v11.2"/>',
    doc:      '<path d="M14 3H7a1.8 1.8 0 0 0-1.8 1.8v14.4A1.8 1.8 0 0 0 7 21h10a1.8 1.8 0 0 0 1.8-1.8V8z"/><path d="M14 3v5h5"/>',
    warn:     '<path d="M12 4.5 21 19.5H3z"/><path d="M12 10v4M12 17h.01"/>',
    star:     '<path d="M12 4.5 14.3 9.6l5.5.6-4.1 3.8 1.1 5.5-4.8-2.8-4.8 2.8 1.1-5.5-4.1-3.8 5.5-.6z"/>',
    book:     '<path d="M4 5.2A2 2 0 0 1 6 3.2h13v15.6H6a2 2 0 0 0-2 2z"/><path d="M4 18.8V5.2"/>',
  };

  const state = { boot: null, busy: false, retryTimer: null, lastQuestion: '', lastAudience: '' };

  /* ── Data adapter ───────────────────────────────────────────────
     The same UI runs two ways: against the HTTP API (server mode, with AI
     synthesis), or against a knowledge base embedded in the page (standalone
     single-file build, no server and no AI). Everything below this line is
     identical in both. */
  const DATA = window.__PN_EMBEDDED__ ? embeddedAdapter(window.__PN_EMBEDDED__) : httpAdapter();

  function httpAdapter() {
    return {
      offline: false,
      bootstrap: () => fetch('/api/bootstrap').then(failFast),
      topics: () => fetch('/api/topics').then(failFast),
      async ask(question, audience) {
        const res = await fetch('/api/ask', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ question, audience: audience || null }),
        });
        const data = await res.json().catch(() => ({}));
        return { status: res.status, data };
      },
    };
  }

  function failFast(res) {
    if (!res.ok) throw new Error(String(res.status));
    return res.json();
  }

  function embeddedAdapter({ kb, Answerer, ai }) {
    // Same pipeline the server runs. With a key present it calls Groq straight
    // from the browser; without one it answers from the knowledge base.
    const answerer = new Answerer(kb, { config: ai || null });
    const allowed = new Set(kb.allowed_urls);
    // Advisory only: a key shipped in the page cannot be rate limited, this
    // just stops an accidental burst from one tab.
    let recent = [];
    return {
      offline: true,
      aiEnabled: answerer.aiEnabled,
      async bootstrap() {
        return {
          meta: {
            name: kb.meta.name, version: kb.meta.version, disclaimer: kb.meta.disclaimer,
            training_source: kb.meta.training_source, chunk_count: kb.meta.chunk_count,
            topic_count: kb.meta.topic_count, built_at: kb.meta.built_at,
          },
          audiences: kb.audiences,
          topics: kb.topics.map((t) => ({
            id: t.id, title: t.title, path: t.path, stage: t.stage,
            summary: t.summary, audiences: t.audiences, chunk_count: t.chunk_ids.length,
          })),
          thresholds: kb.thresholds.map((t) => ({
            id: t.id, label: t.label, applies_to: t.applies_to, rule: t.rule, citations: t.citations,
          })),
          glossary: kb.glossary,
          primary_sources: kb.meta.primary_sources,
          ai_enabled: answerer.aiEnabled,
        };
      },
      async topics() {
        return {
          topics: kb.topics.map((topic) => ({
            ...topic,
            chunks: kb.chunks.filter((c) => c.topic_id === topic.id).map((c) => ({
              id: c.id, heading: c.heading, path: c.path, summary: c.summary,
              audiences: c.audiences, jurisdiction: c.jurisdiction, authority: c.authority,
              text: c.text, checklist: c.checklist || [], watch_outs: c.watch_outs || [],
              citations: (c.citations || []).filter((cite) => allowed.has(cite.url)),
            })),
          })),
          templates: kb.templates,
        };
      },
      async ask(question, audience) {
        const now = Date.now();
        recent = recent.filter((t) => t > now - 60000);
        if (answerer.aiEnabled && recent.length >= 12) {
          return { status: 429, data: {
            error: 'high_demand',
            message: 'That is a lot of questions in one minute. Please wait about a minute and try again.',
            retry_after_seconds: Math.max(1, Math.ceil((recent[0] + 60000 - now) / 1000)),
          } };
        }
        recent.push(now);

        try {
          const result = await answerer.ask({ question, audience: audience || null });
          return { status: 200, data: { question, ...result } };
        } catch (err) {
          if (err.kind === 'high_demand') {
            return { status: 429, data: {
              error: 'high_demand',
              message: 'We are getting a lot of questions right now, so this one could not be answered. Please try again in about 1 minute.',
              retry_after_seconds: err.retryAfter || 60,
            } };
          }
          throw err;
        }
      },
    };
  }

  /* ── Theme ──────────────────────────────────────────────────── */
  const applyTheme = (t) => {
    if (t) document.documentElement.setAttribute('data-theme', t);
    else document.documentElement.removeAttribute('data-theme');
  };
  applyTheme(localStorage.getItem('pn-theme'));
  $('#theme-toggle').addEventListener('click', () => {
    const current =
      document.documentElement.getAttribute('data-theme') ||
      (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    const next = current === 'dark' ? 'light' : 'dark';
    applyTheme(next);
    localStorage.setItem('pn-theme', next);
  });

  /* ── Nav ────────────────────────────────────────────────────── */
  document.addEventListener('click', (ev) => {
    const trigger = ev.target.closest('[data-nav]');
    if (!trigger) return;
    ev.preventDefault();
    const target = trigger.dataset.nav;
    if (target === 'home') {
      window.scrollTo({ top: 0, behavior: 'smooth' });
      $('#q').focus();
      return;
    }
    $(`#view-${target}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });

  /* ── Boot ───────────────────────────────────────────────────── */
  async function boot() {
    let data;
    try {
      data = await DATA.bootstrap();
    } catch {
      $('#view-answer').hidden = false;
      $('#view-answer').replaceChildren(
        el('div', { class: 'state' },
          el('h2', {}, 'Could not load the knowledge base'),
          el('p', {}, 'Refresh the page. If it keeps happening the server may not be running.'))
      );
      return;
    }
    state.boot = data;
    renderAudienceSelect();
    renderAudienceCards();
    renderTopics();
    renderThresholds();
    renderGlossary();
    renderFooter();
    renderExamples(null);
    hydrateFromUrl();
  }

  /* ── Audience select ────────────────────────────────────────── */
  function renderAudienceSelect() {
    const sel = $('#audience');
    sel.replaceChildren(
      el('option', { value: '' }, 'Anyone / not sure'),
      ...state.boot.audiences.map((a) => el('option', { value: a.id }, a.label))
    );
    sel.addEventListener('change', () => {
      const a = state.boot.audiences.find((x) => x.id === sel.value);
      $('#audience-hint').textContent = a ? a.blurb : '';
      renderExamples(a);
    });
    $('#audience-hint').textContent = '';
  }

  function renderExamples(audience) {
    const questions = audience
      ? audience.top_questions
      : ['Do we have to go to tender for a $300,000 contract?',
         'How do I register to sell to NSW Government?',
         'What checks should I run on a new supplier?',
         'A supplier offered me event tickets — what do I do?',
         'What procurement information has to be published?'];
    $('#examples').replaceChildren(
      ...questions.slice(0, 5).map((q) =>
        el('button', { type: 'button', onclick: () => { $('#q').value = q; ask(q, $('#audience').value); } }, q))
    );
  }

  function renderAudienceCards() {
    $('#audience-cards').replaceChildren(
      ...state.boot.audiences.map((a) =>
        el('button', {
          class: 'card', type: 'button',
          onclick: () => {
            $('#audience').value = a.id;
            $('#audience').dispatchEvent(new Event('change'));
            $('#q').focus();
            window.scrollTo({ top: 0, behavior: 'smooth' });
          },
        },
          el('span', { class: 'c-ico' }, icon(ICONS[a.icon] || ICONS.public)),
          el('h3', {}, a.label),
          el('p', { class: 'c-short' }, a.short),
          el('p', { class: 'c-blurb' }, a.blurb),
          el('ul', { class: 'c-qs' }, ...a.top_questions.slice(0, 3).map((q) => el('li', {}, q)))
        ))
    );
  }

  /* ── Topics ─────────────────────────────────────────────────── */
  let topicsCache = null;
  async function renderTopics() {
    $('#topics-sub').textContent =
      `${state.boot.meta.chunk_count} sections across ${state.boot.meta.topic_count} topics, ` +
      `drawn from the NSW Comperio Procurement Foundations modules plus researched council and supplier guidance.`;

    $('#topic-list').replaceChildren(
      ...state.boot.topics.map((t) =>
        el('details', { class: 'topic' },
          el('summary', { onclick: () => loadTopicChunks(t.id) },
            el('div', {},
              el('h3', {}, t.title),
              el('p', { class: 't-sum' }, t.summary)),
            el('span', { class: 't-n' }, `${t.chunk_count}`)),
          el('div', { class: 'topic-body', id: `tb-${t.id}` }, el('p', { class: 't-sum' }, 'Loading…'))))
    );
  }

  async function loadTopicChunks(topicId) {
    const host = $(`#tb-${topicId}`);
    if (!host || host.dataset.loaded) return;
    if (!topicsCache) {
      try {
        topicsCache = await DATA.topics();
      } catch {
        host.replaceChildren(el('p', { class: 't-sum' }, 'Could not load this topic.'));
        return;
      }
    }
    const topic = topicsCache.topics.find((t) => t.id === topicId);
    if (!topic) return;
    host.dataset.loaded = '1';
    host.replaceChildren(
      ...topic.chunks.map((c) =>
        el('button', { type: 'button', onclick: () => { $('#q').value = c.heading; ask(c.heading, $('#audience').value); } }, c.heading))
    );
  }

  /* ── Thresholds ─────────────────────────────────────────────── */
  let thresholdFilter = '';
  function renderThresholds() {
    $('#threshold-filter').replaceChildren(
      el('button', { type: 'button', 'aria-pressed': thresholdFilter === '', onclick: () => { thresholdFilter = ''; renderThresholds(); } }, 'Everyone'),
      ...state.boot.audiences.map((a) =>
        el('button', { type: 'button', 'aria-pressed': thresholdFilter === a.id, onclick: () => { thresholdFilter = a.id; renderThresholds(); } }, a.label))
    );

    const rows = state.boot.thresholds.filter((t) => !thresholdFilter || t.applies_to.includes(thresholdFilter));
    const labelFor = (id) => state.boot.audiences.find((a) => a.id === id)?.label || id;

    $('#threshold-list').replaceChildren(
      ...rows.map((t) =>
        el('article', { class: 'rule' },
          el('h3', {}, t.label),
          el('p', {}, t.rule),
          el('div', { class: 'who-for' }, ...t.applies_to.map((id) => el('span', {}, labelFor(id)))),
          t.citations?.length
            ? el('div', { class: 'links' }, ...t.citations.map((c) =>
                el('a', { href: c.url, target: '_blank', rel: 'noopener noreferrer' }, c.label)))
            : null))
    );
  }

  function renderGlossary() {
    $('#glossary-list').replaceChildren(
      ...state.boot.glossary.map((g) =>
        el('article', { class: 'term' }, el('b', {}, g.term), el('p', {}, g.definition)))
    );
  }

  function renderFooter() {
    $('#foot-disclaimer').textContent = state.boot.meta.disclaimer;
    $('#foot-training').textContent = state.boot.meta.training_source;
    $('#foot-sources').replaceChildren(
      ...state.boot.primary_sources.map((s) =>
        el('li', {}, el('a', { href: s.url, target: '_blank', rel: 'noopener noreferrer' }, s.label)))
    );
    $('#foot-status').textContent =
      `${state.boot.meta.chunk_count} sections · ${state.boot.meta.topic_count} topics · ` +
      `AI answering ${state.boot.ai_enabled ? 'enabled' : 'disabled (knowledge base answers only)'} · ` +
      `built ${new Date(state.boot.meta.built_at).toLocaleDateString('en-AU')}`;
  }

  /* ── Ask ────────────────────────────────────────────────────── */
  $('#search-form').addEventListener('submit', (ev) => {
    ev.preventDefault();
    ask($('#q').value, $('#audience').value);
  });

  function hydrateFromUrl() {
    const params = new URLSearchParams(location.search);
    const q = params.get('q');
    const a = params.get('as');
    if (a && state.boot.audiences.some((x) => x.id === a)) {
      $('#audience').value = a;
      $('#audience').dispatchEvent(new Event('change'));
    }
    if (q) { $('#q').value = q; ask(q, a || ''); }
  }

  async function ask(question, audience) {
    question = String(question || '').trim();
    if (!question || state.busy) return;

    state.busy = true;
    state.lastQuestion = question;
    state.lastAudience = audience || '';
    clearInterval(state.retryTimer);

    const go = $('.search-go');
    go.disabled = true;
    showLoading(question);

    const url = new URL(location.href);
    url.searchParams.set('q', question);
    if (audience) url.searchParams.set('as', audience); else url.searchParams.delete('as');
    history.replaceState(null, '', url);

    try {
      const { status, data } = await DATA.ask(question, audience);

      if (status === 429) return showBusy(data);
      if (status >= 400) return showError(data.message || 'That did not work. Please try again.');
      renderAnswer(question, data);
    } catch {
      showError(DATA.offline
        ? 'Something went wrong searching the knowledge base. Reload the page and try again.'
        : 'Could not reach the server. Check your connection and try again.');
    } finally {
      state.busy = false;
      go.disabled = false;
    }
  }

  const host = () => $('#view-answer');
  const reveal = () => {
    host().hidden = false;
    host().scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  function showLoading(question) {
    host().replaceChildren(
      el('div', { class: 'answer' },
        el('div', { class: 'answer-top' },
          el('div', { class: 'asked' },
            el('span', { class: 'label' }, 'You asked'),
            el('p', {}, question)),
          el('span', { class: 'badge' }, 'Searching the knowledge base…')),
        el('div', { class: 'answer-body' },
          el('div', { class: 'loading' },
            el('div', { class: 'sk t' }),
            el('div', { class: 'sk' }), el('div', { class: 'sk w90' }), el('div', { class: 'sk w55' }),
            el('div', { class: 'sk t' }),
            el('div', { class: 'sk w80' }), el('div', { class: 'sk' }))))
    );
    reveal();
  }

  function showBusy(data) {
    let left = Number(data.retry_after_seconds) || 60;
    const countdown = el('span', {}, String(left));
    const retry = el('button', {
      class: 'act retry', type: 'button', disabled: true,
      onclick: () => ask(state.lastQuestion, state.lastAudience),
    }, 'Retry now');

    host().replaceChildren(
      el('div', { class: 'state busy' },
        el('h2', {}, 'High demand right now'),
        el('p', {}, data.message ||
          'We are getting a lot of questions right now, so this one could not be answered. Please try again in about 1 minute.'),
        el('p', { class: 'tiny', style: 'margin-top:10px;color:var(--ink-3);font-size:13px' },
          'You can try again in ', countdown, ' seconds. Nothing you typed has been lost.'),
        retry)
    );
    reveal();

    clearInterval(state.retryTimer);
    state.retryTimer = setInterval(() => {
      left -= 1;
      countdown.textContent = String(Math.max(0, left));
      if (left <= 0) {
        clearInterval(state.retryTimer);
        retry.disabled = false;
        retry.textContent = 'Try again';
      }
    }, 1000);
  }

  function showError(message) {
    host().replaceChildren(
      el('div', { class: 'state' },
        el('h2', {}, 'That did not work'),
        el('p', {}, message),
        el('button', { class: 'act retry', type: 'button', onclick: () => ask(state.lastQuestion, state.lastAudience) }, 'Try again'))
    );
    reveal();
  }

  /* ── Answer rendering ───────────────────────────────────────── */
  function renderAnswer(question, payload) {
    const a = payload.answer || {};
    const meta = payload.meta || {};
    const audience = state.boot.audiences.find((x) => x.id === meta.audience);

    const MODE_LABEL = {
      ai: 'AI answer, source-checked',
      'ai-general': 'AI general knowledge',
      'retrieval-only': 'Knowledge base answer',
    };

    const badges = [];
    if (audience) badges.push(el('span', { class: 'badge accent' }, audience.label));
    if (a.unverified) badges.push(el('span', { class: 'badge rose' }, 'Unverified'));
    else if (a.out_of_scope) badges.push(el('span', { class: 'badge amber' }, 'Not covered here'));
    else badges.push(el('span', { class: 'badge teal' }, `${a.confidence || 'medium'} confidence`));
    badges.push(el('span', { class: 'badge' }, MODE_LABEL[meta.mode] || 'Knowledge base answer'));

    const body = [];

    // The question named a different party to the one selected. Silently
    // answering under the other rulebook would be the worst failure this tool
    // has, so the switch is stated.
    const notice = meta.audience_notice;
    if (notice) {
      const to = state.boot.audiences.find((x) => x.id === notice.to);
      const from = notice.from ? state.boot.audiences.find((x) => x.id === notice.from) : null;
      const noun = (a) => a?.noun || a?.label || '';
      const plural = (a) => a?.plural || `${noun(a)}s`;
      const article = (word) => (/^[aeiou]/i.test(word) ? 'an' : 'a');
      body.push(
        el('div', { class: 'switched' },
          icon(ICONS.warn),
          el('div', {},
            el('strong', {}, from
              ? `Answered for ${article(noun(to))} ${noun(to)}, not ${article(noun(from))} ${noun(from)}`
              : `Answered for ${article(noun(to))} ${noun(to)}`),
            el('p', {},
              `Your question says "${notice.evidence}"`,
              from ? `, and ${plural(from)} and ${plural(to)} work under different rules. ` : '. ',
              'Change the selector above if that is not what you meant.')))
      );
    }

    // AI was configured but did not run. The likeliest cause is the browser
    // being unable to reach the API, which looks identical to an outage from
    // here - so say what happened rather than quietly serving a lesser answer.
    if (state.boot?.ai_enabled && meta.mode === 'retrieval-only' && meta.note) {
      body.push(
        el('div', { class: 'degraded' },
          icon(ICONS.warn),
          el('div', {},
            el('strong', {}, 'Answered without AI'),
            el('p', {}, meta.note)))
      );
    }

    if (a.unverified) {
      body.push(
        el('div', { class: 'unverified' },
          icon(ICONS.warn),
          el('div', {},
            el('strong', {}, 'Not from the NSW procurement knowledge base'),
            el('p', {}, 'Your question is outside the material this tool is built on, so this is a general AI answer. ' +
              'Specific dollar thresholds, section numbers and deadlines have been removed because they could not be verified. ' +
              'Check it against your own organisation\u2019s policy and the current NSW guidance before you act on it.')))
      );
    }

    body.push(el('div', { class: 'direct' }, a.direct_answer));

    if (a.applies_to_you) {
      body.push(el('div', { class: 'applies' }, el('strong', {}, 'What this means for you'), a.applies_to_you));
    }

    if (a.key_points?.length) {
      body.push(section('Key points', ICONS.star,
        el('ul', { class: 'points' }, ...a.key_points.map((p) => el('li', {}, p)))));
    }

    if (a.checklist?.length) {
      const items = a.checklist.map((text, i) => {
        const id = `ck-${Date.now()}-${i}`;
        return el('li', {}, el('input', { type: 'checkbox', id }), el('label', { for: id }, text));
      });
      body.push(section('Checklist', ICONS.check, el('ul', { class: 'checks' }, ...items), a.checklist.length));
    }

    if (a.thresholds?.length) {
      body.push(section('Thresholds and rules that apply', ICONS.coin,
        el('div', { class: 'rule-cards' }, ...a.thresholds.map((t) =>
          el('div', { class: 'rule-card' }, el('b', {}, t.label), t.detail ? el('span', {}, t.detail) : null)))));
    }

    if (a.templates?.length) {
      body.push(section('Templates and documents', ICONS.doc,
        el('ul', { class: 'tpl-list' }, ...a.templates.map((t) =>
          el('li', {},
            el('a', { class: 'tpl', href: t.url, target: '_blank', rel: 'noopener noreferrer' },
              icon(ICONS.doc),
              el('span', {},
                el('span', { class: 't-name' }, t.name),
                t.why ? el('span', { class: 't-why' }, t.why) : null,
                t.source ? el('span', { class: 't-src' }, t.source) : null)))))));
    }

    if (a.watch_outs?.length) {
      body.push(section('Watch out for', ICONS.warn,
        el('ul', { class: 'warns' }, ...a.watch_outs.map((w) =>
          el('li', {}, icon(ICONS.warn), el('span', {}, w))))));
    }

    if (a.where_to_check?.length) {
      body.push(section('Check this against', ICONS.book,
        el('ul', { class: 'points' }, ...a.where_to_check.map((w) => el('li', {}, w)))));
    }

    if (a.summary) {
      body.push(section('In short', ICONS.book, el('div', { class: 'summary-box' }, a.summary)));
    }

    if (a.suggestions?.length) {
      body.push(section('Try one of these instead', ICONS.list,
        el('div', { class: 'examples' }, ...a.suggestions.map((s) =>
          el('button', { type: 'button', onclick: () => { $('#q').value = s; ask(s, meta.audience || ''); } }, s)))));
    }

    const sources = a.sources?.length
      ? el('details', { class: 'sources' },
          el('summary', {}, icon(ICONS.list, { style: 'width:15px;height:15px' }),
            `Where this came from (${a.sources.length} ${a.sources.length === 1 ? 'source' : 'sources'})`),
          el('div', { class: 'src-list' }, ...a.sources.map((s) =>
            el('article', { class: 'src' },
              el('div', { class: 'src-head' },
                el('b', {}, s.heading),
                el('span', { class: 'tag' }, s.authority),
                el('span', { class: 'tag' },
                  s.jurisdiction === 'local-government' ? 'councils'
                  : s.jurisdiction === 'nsw-government' ? 'NSW agencies' : 'all')),
              el('p', {}, s.excerpt),
              el('p', { class: 'path' }, s.path),
              s.source_document && s.source_document.endsWith('.docx')
                ? el('p', { class: 'path' }, `from training module: ${s.source_document}`) : null,
              s.links?.length
                ? el('div', { class: 'links' }, ...s.links.map((l) =>
                    el('a', { href: l.url, target: '_blank', rel: 'noopener noreferrer' }, l.label)))
                : null))))
      : null;

    const actions = el('div', { class: 'answer-actions' },
      el('button', { class: 'act', type: 'button', onclick: (ev) => copyAnswer(question, a, ev.currentTarget) }, 'Copy answer'),
      el('button', { class: 'act', type: 'button', onclick: (ev) => copyLink(ev.currentTarget) }, 'Copy link'),
      el('button', { class: 'act', type: 'button', onclick: () => { $('#q').select(); $('#q').focus(); window.scrollTo({ top: 0, behavior: 'smooth' }); } }, 'Ask something else')
    );

    const note = meta.note ? el('p', { class: 'path', style: 'padding:0 22px 14px;color:var(--ink-3);font-size:12.5px' }, meta.note) : null;

    host().replaceChildren(
      el('div', { class: 'answer' },
        el('div', { class: 'answer-top' },
          el('div', { class: 'asked' }, el('span', { class: 'label' }, 'You asked'), el('p', {}, question)),
          el('div', { class: 'badges' }, ...badges)),
        el('div', { class: 'answer-body' }, ...body),
        sources, note, actions)
    );
    reveal();
  }

  function section(title, iconPath, content, count) {
    return el('section', { class: 'sec' },
      el('h3', {}, icon(iconPath), title, count ? el('span', { class: 'count' }, `${count}`) : null),
      content);
  }

  function copyAnswer(question, a, button) {
    const lines = [`Q: ${question}`, ''];
    if (a.unverified) {
      lines.push('[UNVERIFIED - general AI answer, not from the NSW procurement knowledge base.', 
        'Figures and section references were removed because they could not be verified.]', '');
    }
    lines.push(a.direct_answer);
    if (a.applies_to_you) lines.push('', `What this means for you: ${a.applies_to_you}`);
    if (a.key_points?.length) lines.push('', 'Key points:', ...a.key_points.map((p) => `- ${p}`));
    if (a.checklist?.length) lines.push('', 'Checklist:', ...a.checklist.map((c) => `[ ] ${c}`));
    if (a.thresholds?.length) lines.push('', 'Thresholds:', ...a.thresholds.map((t) => `- ${t.label}${t.detail ? `: ${t.detail}` : ''}`));
    if (a.templates?.length) lines.push('', 'Templates:', ...a.templates.map((t) => `- ${t.name} — ${t.url}`));
    if (a.watch_outs?.length) lines.push('', 'Watch out for:', ...a.watch_outs.map((w) => `- ${w}`));
    if (a.where_to_check?.length) lines.push('', 'Check this against:', ...a.where_to_check.map((w) => `- ${w}`));
    if (a.summary) lines.push('', `In short: ${a.summary}`);
    if (a.sources?.length) lines.push('', 'Sources:', ...a.sources.map((s) => `- ${s.heading} (${s.path})`));
    lines.push('', 'General information only, from the NSW Procurement Navigator. Confirm against your own organisation\'s policy.');
    flash(button, lines.join('\n'));
  }

  function copyLink(button) { flash(button, location.href); }

  function flash(button, text) {
    const original = button.textContent;
    navigator.clipboard?.writeText(text).then(
      () => { button.textContent = 'Copied'; setTimeout(() => (button.textContent = original), 1600); },
      () => { button.textContent = 'Copy failed'; setTimeout(() => (button.textContent = original), 1600); }
    );
  }

  boot();
})();
