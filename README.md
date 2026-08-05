# NSW Procurement Navigator

A search-and-answer tool that turns NSW procurement rules into plain-English
answers. Ask a question the way you'd ask a colleague and get back a direct
answer, a checklist, the thresholds that apply, links to the real templates, the
things that commonly go wrong, and the sources it all came from.

Built for the people who actually have to do procurement: council staff, NSW
Government agency buyers, suppliers and SMEs, large contractors, social
enterprises and Aboriginal businesses, and members of the public who just want
to know how their money is being spent.

```
npm start                       # http://localhost:3000
```

---

## Why it exists

NSW procurement guidance is spread across the Procurement Policy Framework,
Board Directions, buy.nsw guidance, ICAC publications, the Local Government Act
and Regulation, and Office of Local Government circulars. Working out which of
those applies to you is most of the work.

The single most consequential distinction — and the one this tool is built
around — is that **NSW councils and NSW Government agencies run under different
rulebooks.**

| | NSW Government agency | NSW local council |
|---|---|---|
| Governing law | Public Works and Procurement Act 1912 | Local Government Act 1993, ss 55 & 55A |
| Rules | Procurement Policy Framework, Board Directions | LG (General) Regulation 2021 Part 7, OLG guidelines |
| Tender trigger | Accreditation level and approved arrangements | $250,000 (s 55(3)(n)) |
| Buying capacity | Set by agency accreditation level | Not applicable |

The source training material covers agencies only. Serving a council officer an
agency threshold would be worse than useless, so audience is a first-class
concept throughout: it steers retrieval, filters the thresholds that can be
shown, and is enforced by tests.

---

## How answering works

```
question + audience
      │
      ▼
┌─────────────────┐   BM25 over weighted fields, procurement synonym expansion,
│   retrieval     │   audience boost, hard jurisdiction steering
└────────┬────────┘
         │  top 8 chunks above the noise floor
         ▼
┌─────────────────┐   numbered [S1..Sn] source blocks + thresholds + templates
│   grounding     │   filtered to the reader's audience
└────────┬────────┘
         │
         ▼
┌─────────────────┐   Groq chat completion, JSON mode, model fallback chain
│   generation    │
└────────┬────────┘
         │
         ▼
┌─────────────────┐   strip URLs, drop invented templates, reject citations to
│   guardrails    │   sources never supplied, cap list lengths
└────────┬────────┘
         │
         ▼
   structured answer + provenance
```

**Nothing is answered from the model's own knowledge.** If retrieval finds
nothing above the noise floor, the model is never called at all — the tool says
it doesn't cover that and suggests questions it does cover.

### The anti-hallucination measures

| Risk | Control |
|---|---|
| Invented URLs | The model is told not to emit URLs. Any that appear are stripped from every text field. All links come from the knowledge base's `allowed_urls`. |
| Invented templates | Template names are matched against the registry. Unknown names are dropped; matched ones get the registry's URL, not the model's. |
| Fake citations | Only `S1..Sn` ids that were actually supplied survive. An answer citing nothing valid is downgraded to medium confidence. |
| Wrong-jurisdiction advice | Retrieval penalises cross-rulebook chunks; `supporting()` filters thresholds and templates by audience unconditionally. |
| Model returning prose | JSON is extracted from a fence or wrapper; if it still won't parse, the request degrades to a knowledge-base answer rather than erroring. |
| Padded output | Every list is length-capped. |

Whatever the guardrails remove is reported in `meta.removed` so drift is
visible rather than silent.

### Graceful degradation

The tool never hard-fails on the AI layer. If the key is missing or rejected,
or the model returns something unusable, it falls back to a **retrieval-only
answer** assembled straight from the knowledge base — direct answer, checklist,
thresholds, templates, watch-outs and sources, just without AI synthesis. The
response is labelled so it's obvious which mode produced it.

### High demand

Because the Groq key is shared across every visitor, three gates protect it: a
per-visitor sliding window, a global per-minute cap, and a concurrency limit.
Any of them tripping — or a 429 / 5xx from Groq — produces:

```json
{
  "error": "high_demand",
  "message": "We are getting a lot of questions right now, so this one could not be answered. Please try again in about 1 minute.",
  "retry_after_seconds": 60
}
```

The UI renders this as a countdown with a retry button that enables itself, and
keeps what the user typed.

---

## The knowledge base

`data/knowledge-base.json` is built from the parts in `data/kb/` and is the
single source of truth for every answer.

```
data/kb/00-registry.json      audiences, thresholds, templates, glossary
data/kb/10-objectives.json    ┐
data/kb/20-legislation.json   │
data/kb/30-governance.json    │  from the eight Comperio
data/kb/40-planning.json      ├─ "Procurement Foundations"
data/kb/50-sourcing.json      │  modules in source-documents/
data/kb/60-managing.json      │
data/kb/70-probity.json       │
data/kb/80-corruption.json    ┘
data/kb/90-councils.json      ┐
data/kb/95-suppliers.json     ├─ researched additions filling gaps
data/kb/97-due-diligence.json ┘  the course does not cover
```

**73 sections across 11 topics**, plus 15 thresholds, 24 templates and a 17-term
glossary.

The three researched files exist because the course is written for NSW
Government agency buyers. It has nothing on council tendering, nothing on the
supplier's side of the transaction, and it references the ICAC supplier due
diligence guide repeatedly without reproducing it. Those additions are sourced
from the Local Government Act and Regulation, OLG circulars, the IPC, the
Anti-slavery Commissioner, ICAC and buy.nsw — every claim carries a citation.

### Chunk shape

Paths are hierarchical and stable, so a section can be linked and cited:

```json
{
  "id": "councils.tender-threshold",
  "path": "councils/tendering-threshold",
  "heading": "When a council must go to tender: the $250,000 threshold",
  "audiences": ["council", "supplier", "corporate", "public"],
  "jurisdiction": "local-government",
  "authority": "legislation",
  "summary": "...",
  "text": "...",
  "keywords": ["250000", "must we tender", "section 55", ...],
  "checklist": ["Estimate the full contract value including all options...", ...],
  "watch_outs": ["Splitting a requirement into parts to stay under $250,000...", ...],
  "thresholds": ["thr-council-tender-250k"],
  "templates": ["tpl-olg-tendering-guidelines"],
  "citations": [{ "label": "...", "url": "..." }]
}
```

`authority` records what a statement rests on — `legislation`, `policy`,
`guidance`, `training` or `practice` — and is shown to the user, so operational
advice is never mistaken for a statutory requirement.

### Editing it

Edit the relevant file in `data/kb/`, then:

```bash
npm run build:kb    # merges, validates, writes data/knowledge-base.json
npm test
```

The build fails on duplicate ids, unknown audience/threshold/template
references, missing required fields, and citations without a label or URL. Any
URL you add is automatically added to `allowed_urls`, which is what makes it
renderable — a link that isn't in the knowledge base can never reach a user.

---

## Setup

```bash
git clone https://github.com/iamarasinghe96/procurementnsw.git
cd procurementnsw
cp .env.example .env      # add your GROQ_API_KEY
npm start
```

Node 18+. **No runtime dependencies** — the server is `node:http`, the frontend
is plain HTML/CSS/JS, retrieval is hand-rolled BM25. `playwright-core` is a dev
dependency used only for UI checks.

Without a `GROQ_API_KEY` the tool runs in retrieval-only mode, which is useful
for working on the knowledge base offline.

### Configuration

See `.env.example`. Key settings: `GROQ_MODEL`, `GROQ_FALLBACK_MODELS`,
`RATE_LIMIT_PER_MINUTE`, `GLOBAL_RATE_LIMIT_PER_MINUTE`,
`MAX_CONCURRENT_REQUESTS`.

The API key is read server-side and never sent to the browser.

---

## API

### `POST /api/ask`

```json
{ "question": "Do we have to tender for a $300,000 waste contract?", "audience": "council" }
```

`audience` is optional and one of `council`, `agency`, `supplier`, `corporate`,
`nfp`, `public`.

```json
{
  "question": "...",
  "status": "ok",
  "answer": {
    "direct_answer": "...",
    "applies_to_you": "...",
    "key_points": [],
    "checklist": [],
    "thresholds": [{ "label": "...", "detail": "..." }],
    "templates": [{ "name": "...", "url": "...", "why": "..." }],
    "watch_outs": [],
    "summary": "...",
    "sources": [{ "heading": "...", "path": "...", "authority": "...", "links": [] }],
    "confidence": "high",
    "out_of_scope": false
  },
  "meta": { "mode": "ai", "model": "...", "retrieved": 8, "removed": [] }
}
```

`status` is `ok` or `no_match`. `429` carries the high-demand payload above.

### Other endpoints

| Endpoint | Purpose |
|---|---|
| `GET /api/bootstrap` | Audiences, topics, thresholds, glossary, disclaimer |
| `GET /api/topics` | Full topic tree with section text for browsing |
| `GET /api/health` | Liveness, chunk count, whether AI answering is on |

---

## Tests

```bash
npm test    # 35 tests
```

Covers knowledge base integrity (no dangling references, no URL outside
`allowed_urls`, council rules never offered to agencies), retrieval behaviour
(the kerbside contract question, council vs agency divergence on an identical
question, synonym expansion, noise floor), the guardrails (URL stripping,
invented template rejection, fake citation rejection, fenced JSON recovery), and
the full pipeline against a stubbed Groq endpoint (prompt grounding, model
fallback, 429 handling, degradation paths, rate limiter).

---

## Project layout

```
data/kb/           knowledge base parts (edit these)
data/              knowledge-base.json (generated)
scripts/           build + validation
server/            retrieval, prompt, groq client, guardrails, rate limit, http
public/            frontend
test/              node:test suites
source-documents/  the original Comperio .docx modules
```

---

## Limitations

- **General information, not advice.** Confirm against your own agency or
  council policy and the current legislation before acting.
- **Thresholds move.** The Procurement Policy Framework is reissued quarterly
  and the Local Government Regulation is amended periodically. Figures here were
  correct against the sources cited at build time; the tool shows its sources
  precisely so they can be re-checked.
- **Goods and services focus.** Construction procurement has its own regime that
  is only touched on.
- **Not an official source.** This is an independent reference tool, not
  affiliated with or endorsed by the NSW Government, the NSW Procurement Board
  or the Office of Local Government.
