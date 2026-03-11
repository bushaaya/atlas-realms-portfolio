# ADR: Why I Gave My LLM a Day Job and Let JavaScript Do the Heavy Lifting

**Status:** Implemented  
**Date:** 2026-03-09  
**Context:** Atlas Realms — a board game recommendation engine that receives natural language queries and returns ranked recommendations from a structured database of ~500–1,000 records.

---

## The Problem With LLM-Native Recommendation

In 2025, every recommendation engine was a prompt. You describe what you want. The LLM thinks. You get a list. Ship it.

I tried that. It was $0.40 per query, had 30+ second latency, and returned different answers to the same question on consecutive requests. In my own testing across identical prompts in February 2026, **37.5% returned meaningfully different result sets.** More critically: there was no way to tell a user *why* a result appeared. "The AI thinks you'd like it" is not an explanation. It's a shrug.

The deeper problem: LLMs are bad at the specific thing recommendation requires. Recommendation is constraint satisfaction with ranked preferences across structured data. LLMs don't *reason* about ordinal distances — they pattern-match against training data. Ask an LLM whether a game with "Medium" complexity satisfies "lighter than Terraforming Mars" and it might get it right, or it might hallucinate that TM is light. There's no way to know in advance, and no way to audit after the fact.

I built something different.

---

## What I Was Building

Atlas Realms lets users describe what board game experience they're looking for in plain English — *"something chill and co-op for 4 people after dinner, not too long"* — and receive six ranked recommendations with plain-English explanations of why each one fits. The database is structured. The preferences are multidimensional. The language is fuzzy.

The challenge isn't "how do I get an LLM to recommend games." It's "how do I reliably bridge the gap between unstructured human intent and a structured database, at a cost that makes sense in production."

---

## The Options I Considered

| Approach | Cost/query | Latency | Explainable | Consistent |
|---|---|---|---|---|
| Pure LLM (game database in context) | ~$0.08–0.40 | 15–30s+ | No | No |
| Pure LLM (tool-call retrieval) | ~$0.04–0.15 | 8–15s | Weakly | No |
| Traditional ML / vector embeddings | ~$0.001 | <100ms | Partially | Yes |
| **Hybrid: LLM intent extraction + JS scoring** | **~$0.0004** | **5–10s** | **Yes** | **Yes** |

**Why not pure LLM?** Inconsistency is disqualifying for a product. Users notice when the same query returns different results on refresh. And retroactive LLM explanations ("this game appears because it matches your preferences") are not grounded in any actual computation — the model is confabulating. The 37% inconsistency rate I measured was the clearest signal to abandon the pure-LLM path.

**Why not traditional ML?** Great for "find things similar to this thing." Poor for "find things matching a set of constraints expressed in natural language where the vocabulary is fuzzy and the constraint structure isn't known in advance." You'd need training data mapping user phrases to database fields. I don't have that at launch. And even with it, relative queries ("lighter than Terraforming Mars") require reasoning about ordinal relationships — not just similarity.

**Why hybrid?** LLMs are genuinely good at extracting structured intent from unstructured text. They're bad at arithmetic, consistency, and reasoning about constraint satisfaction across a schema they've been given. Split the job accordingly.

---

## The Architecture I Chose

```
User query (natural language)
    ↓
[Node 01] IntentInterpreter  ← LLM, always
    Extracts: dials, core terms, comparisons, constraints, anchor games
    Never recommends. Never touches the database.
    ↓
[Node 02] ResolverJS  ← pure JS
    Maps every extracted term to a database enum via:
      1. ~150-entry synonym dictionary (deterministic, zero LLM cost)
      2. Direct enum match
      3. Fuzzy substring match
      4. Unmapped → forward to Taxonomist
    Applies style macros, fetches anchor game data from Airtable
    ↓
[Node 03] Taxonomist  ← LLM, conditional (~30% of queries)
    Skipped entirely if everything resolved cleanly.
    Only runs for: unmapped phrases, or games not in the database.
    ↓
[Node 04] MergerJS  ← pure JS
    Assembles a 4-tier "search contract":
      Explicit (user said it directly)
      Dials (inferred from fuzzy vibe language)
      Inferred (derived from anchor game references)
      Tolerance (accepted but not enthusiastic about)
    ↓
[Node 05] RetrieverJS  ← JS + Airtable
    Fetches ~500–1,000 games, applies 3-stage filtering.
    Reduces candidate pool to 50–200.
    ↓
[Node 06] ScorerJS  ← pure JS
    Computes a numeric score for every candidate across 14+ dimensions.
    Deterministic. Every point is traceable to a specific signal.
    ↓
[Node 07] FormatterJS  ← pure JS
    Generates "why this" blurbs from the actual scoring trace.
    Applies diversity selection (max 2 per design family, vault quality gate).
    ↓
{ recommendations: [...], query_summary: {...trace...} }
```

**The core split:** LLMs handle natural language understanding only. JavaScript handles filtering, scoring, ranking, and explainability.

**One structural decision that compounds:** The IntentInterpreter produces a chain-of-thought `reasoning` field before its JSON output. This forces the model to articulate its interpretation of the query before committing to extractions — what the user wants, what every game reference implies, and what any contrast language means. It's the "show your work" equivalent for LLMs. Downstream extraction consistency improved measurably when this was added.

---

## The Dial System: Where Most of the Value Hides

This is the part that surprised me most, and the part most worth explaining.

I mapped the space of fuzzy user vibe language onto 5 structured dimensions — "intent dials":

| Dial | What it captures | Low means | High means |
|---|---|---|---|
| `approachability` | How hard the rules are to learn | User wants complex, heavyweight rules | User wants light, easy rules |
| `strategic_ceiling` | Depth of decisions during play | User wants fast, light decisions | User wants deep, analytical play |
| `friction` | Session length commitment | User wants an epic multi-hour session | User wants a quick, focused session |
| `social_temperature` | Player conflict intensity | User wants peaceful/cooperative play | User wants aggressive direct conflict |
| `chaos` | Randomness tolerance | User wants deterministic, skill-based play | User wants swingy, luck-heavy play |

Each dial level maps to a specific ideal value in the database. `approachability:high` → `ideal_rules_complexity: "Light"`. But crucially: **these produce soft preferences, not hard filters.** The system prefers Light, allows Medium (within ±1 ordinal distance), and penalizes Heavy — but doesn't exclude it. A game can still win if it's Medium complexity but perfect on every other dimension.

This gives three compounding wins:

**1. Coverage without LLM cost.** ~84% of user language maps to one of these 5 dials via the synonym dictionary. No LLM token spent on "chill", "brain burning", "quick game", "casual", "hate dice."

**2. Graceful degradation.** The ±1 ordinal distance tolerance means the system doesn't fail when it can't find a perfect match on every dimension simultaneously. "Easy to teach co-op for 4 under an hour" might not have a perfect specimen — but the best available option still scores clearly higher than everything else.

**3. Conflict resolution.** When two dials conflict on the same database field, the system has an explicit precedence order: `friction` (session length is a hard logistical fact) > `approachability` > `chaos` > `social_temperature` > `strategic_ceiling` (most flexible). The lower-priority constraint is dropped — not the whole query.

**One subtle nuance worth calling out:** "casual" does NOT set `friction` (session length). It sets `approachability` (rules complexity). A casual game can take 3 hours. This is a common point of confusion and the IntentInterpreter has explicit instructions addressing it. Getting this distinction wrong causes the system to recommend short games when the user just wanted something easy to learn — a meaningful error.

---

## The Unit Economics (Real Numbers)

| Component | Model | Cost per query |
|---|---|---|
| IntentInterpreter (LLM, always) | Gemini 2.5 Flash Lite | ~$0.0004 |
| Taxonomist (LLM, ~30% of queries) | Groq (free tier) | ~$0.0000 |
| Retriever (Airtable via Cloudflare KV cache) | — | ~$0.0000 |
| All other JS nodes | — | ~$0.0000 |
| **Blended per-query** | | **~$0.0004** |

The Taxonomist runs on only ~30% of queries because the synonym dictionary covers most of human vocabulary about this domain. When a user says "chill", "light", "co-op", "quick", "strategic", "party game" — all of that maps cleanly without a second LLM call. The LLM only fires when the user says something genuinely novel.

The KV cache layer has a second cost impact beyond LLM spend: it eliminated full-table Airtable fetches on every query. Before caching, the Retriever made up to 11 paginated API calls per request to fetch ~2,000 records. After: a single KV read serves ~1,100 games. **~99.75% reduction in data transfer per query.**

**Latency (before and after):**

| Stage | Before | After | Reduction |
|---|---|---|---|
| End-to-end | 31–35s | 5–10s | ~70% |
| IntentInterpreter | 14–18s | 2–4s | ~80% |
| Retriever (Airtable) | 550ms–3.5s | 190–730ms | ~65% |

**At 10,000 queries/month:**

| Approach | Monthly cost |
|---|---|
| This architecture | ~$4 |
| Pure LLM (conservative estimate) | ~$400–4,000 |

At scale, the gap compounds. At 100,000 queries/month it's $40 vs. $4,000–40,000. The architectural decision becomes increasingly correct over time.

---

## What You Get That Pure LLM Can't Give You

**1. Explainability that's actually accurate**

Every recommendation comes with a "why this" blurb — but it's generated from the actual scoring trace, not by asking an LLM to explain itself retroactively. When a game appears because it has the right mechanics, correct player count, and matching tone, the blurb says exactly that. When a game appears on logistics merits alone with weak semantic matching, the blurb says "Fits your [constraint] but doesn't fully capture the feel you described."

The system can be *honest* about match quality because it has a real score. LLMs confabulate explanations with equal confidence regardless of whether the underlying recommendation is good or bad.

**2. Consistency — measurably, with an honest ceiling**

In February 2026, before the full hybrid architecture was locked in, I ran a diagnostic: 37.5% of identical prompts returned different top-6 result sets across successive runs. By March 2026, a structured 10-prompt validation suite returned identical results across 3 successive runs on every prompt — 100% consistency on that suite.

The honest version of that number: it reflects the current state of a living system, not a permanent ceiling. When new users submit queries the IntentInterpreter has no explicit rules for, inconsistencies can surface again. The root cause is always the same — ambiguous language without a disambiguation rule — and the fix is always the same: identify the case, add a guardrail to the prompt, re-validate. I already have one new case in the queue.

What the architecture gives you is that this process is tractable. The scoring pipeline is deterministic, so when results vary, the variable is isolated: the LLM extraction layer. You know where to look, you know what to fix, and you can confirm the fix held. With a pure LLM approach, you're re-engineering an opaque prompt and hoping the next run behaves — with no reliable way to confirm you've actually solved the problem rather than masked it.

**3. Debuggability — and structured validation that depends on it**

When a recommendation is wrong, I look at the scoring trace. I can see which dimensions fired, which penalties applied, what the final score was, and exactly which signals drove the outcome. I can reproduce it deterministically. With a pure LLM, debugging is interrogating a black box.

This debuggability also shaped how I validated the LLM stack itself. Before migrating models, I ran a structured 6-model evaluation: GPT-OSS-120B (Groq), GPT-4.1-mini, GPT-4.1, Gemini 2.0 Flash, Gemini 2.5 Flash Lite, and llama-3.3-70b-versatile. Three representative prompts, 2–3 runs each, scored on anchor role classification, dial extraction, player count parsing, and cross-run consistency. The selection criterion was **failure mode severity** — a model that misses an inferred preference is recoverable; a model that misclassifies a player role and corrupts the search contract is not. Gemini 2.5 Flash Lite won on that basis, not raw accuracy.

That kind of evaluation is only possible because the pipeline is deterministic downstream of the LLM — you can isolate the model as the variable and measure what actually matters.

**4. Controlled spend**

Cost is nearly fixed per query. It doesn't scale with database size (the JS nodes are O(n) but n is bounded by the candidate pool, not the prompt). It doesn't scale with query complexity (a complex query uses the same LLM calls as a simple one). The marginal cost of adding a new scoring dimension is zero.

---

## When This Architecture Is Worth It

- You have structured data (a database, a product catalog, an inventory)
- Users describe what they want in natural language
- Results need to be explainable to users
- Consistency matters (same input → same output)
- You need to debug failures systematically
- You're going to run enough queries that cost matters

## When Pure LLM Is Probably Fine

- Prototype where you need to ship in two days
- Unstructured data (documents, freeform content with no schema to score against)
- One-off queries with no volume and no consistency requirement
- The "why" of a result doesn't matter to your users

---

## What I'd Do Differently

**Start the synonym dictionary earlier.** It's unglamorous, high-leverage work. Every entry in that map is a token you're not paying for. I added most of mine reactively — while debugging queries that produced wrong results. I'd now write the dictionary before writing the scoring logic, since the dictionary defines what signals are even expressible.

**Add output schema validation on day one.** The IntentInterpreter prompt specifies exactly what JSON to produce, but LLMs drift on edge cases. I validate and coerce the output before passing it downstream, but I added this retroactively after chasing downstream bugs from malformed LLM output. It should be the first thing you build when an LLM is in the critical path.

**Design the conditional LLM skip from the start.** I initially ran the Taxonomist on every query. The conditional skip came later when I noticed that most queries don't need it. Designing the skip condition into the architecture from the beginning — rather than as an optimization after the fact — would have saved a meaningful refactor.

---

## Code and Related Artifacts

| Artifact | Description |
|---|---|
| [`ARCHITECTURE.md`](./ARCHITECTURE.md) | Full node-by-node technical walkthrough |
| [`SCORING_SYSTEM.md`](./SCORING_SYSTEM.md) | Scoring engine deep dive — all 14+ dimensions |
| [`workers/api-proxy-worker.js`](./workers/api-proxy-worker.js) | The Cloudflare Worker (CORS proxy + KV catalog cache) |

---

*Atlas Realms v2 pipeline — Scorer v5.8, ConstantsProvider v9.5*
