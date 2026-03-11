# Atlas Realms — Backend Architecture Portfolio

> **"I build AI products designed to survive unit economics."**

A board game recommendation engine that takes natural language queries and returns ranked, explainable results from a structured database. This folder contains the architecture documentation and code artifacts for the backend pipeline.

Live product: [atlasrealms.com](https://www.atlasrealms.com)

---

## Why This Repo Exists

This repository is not the production codebase. It exists to document the architecture, scoring logic, and product decisions behind Atlas Realms without exposing proprietary data or infrastructure.

---

## What Makes This Interesting

Many early AI recommendation systems are built primarily around prompt reasoning — you describe what you want, the LLM thinks, you get a list. That approach costs $0.40/query, returns different results for the same input, and can't explain why anything appeared.

This system is different: **LLMs handle only natural language understanding. JavaScript handles filtering, scoring, ranking, and explainability.** The result is a deterministic, traceable, ~$0.0014/query pipeline.

---

## Architecture at a Glance

```
[User query: "something chill and co-op for 4 people, not too long"]
         ↓
[Cloudflare Worker]  ← CORS enforcement, routes to pipeline
         ↓
[Flowise Pipeline — 7 nodes]
  ┌─────────────────────────────────────────────────────────┐
  │  Node 00  ConstantsProvider     Config registry         │
  │  Node 01  IntentInterpreter ←── LLM (always)           │
  │  Node 02  TheResolverJS     ←── JS (always)            │
  │  Node 03  TheTaxonomist     ←── LLM (conditional ~30%) │
  │  Node 04  TheMergerJS       ←── JS (always)            │
  │  Node 05  TheRetrieverJS    ←── JS + Airtable          │
  │  Node 06  TheScorerJS       ←── JS (always)            │
  │  Node 07  TheFormatterJS    ←── JS (always)            │
  └─────────────────────────────────────────────────────────┘
         ↓
[{ recommendations: [...], query_summary: {...} }]
```

---

## Contents

| File | What it is |
|---|---|
| [`ADR_hybrid_llm_architecture.md`](./ADR_hybrid_llm_architecture.md) | Architecture Decision Record — *why* the hybrid approach, with real unit economics |
| [`ARCHITECTURE.md`](./ARCHITECTURE.md) | Full system walkthrough — every node, every design decision, every edge case |
| [`SCORING_SYSTEM.md`](./SCORING_SYSTEM.md) | Deep dive into the scoring engine — 15 dimensions, 4 signal tiers, all weights |
| [`workers/api-proxy-worker.js`](./workers/api-proxy-worker.js) | Cloudflare Worker — CORS proxy, KV-backed catalog cache, cron refresh |

**Start with the ADR** if you want to understand the philosophy.  
**Read ARCHITECTURE.md** if you want the full technical depth.  
**Read SCORING.md** if you want to understand the ranking engine specifically.

---

## Key Design Decisions

**Two LLM calls maximum per query.** The IntentInterpreter always runs (~2,000 tokens). The Taxonomist — a fallback for unresolvable language — runs on ~30% of queries (~1,400 tokens). When the synonym dictionary covers the full query, only one LLM call fires.

**5 Intent Dials convert fuzzy language to structured signals deterministically.** "Chill" → `social_temperature:low` → `ideal_interaction: Indirect`. Zero LLM tokens spent on this mapping. ~84% of user vocabulary maps through this dictionary without an LLM.

**4-tier scoring signal hierarchy.** Explicit (user said it) > Dials (inferred from vibe language) > Inferred (derived from anchor games) > Tolerance (user said it's acceptable). Each tier has calibrated point weights — a game can't win on tolerance signals alone.

**Fail-open vs fail-closed filtering.** Player count is fail-closed (a game with no player data is excluded — recommending an unplayable game is worse than missing a good one). All other hard filters are fail-open (missing data passes through rather than eliminating real candidates).

**Semantic floor cap.** If the user asked for "a fantasy dungeon crawler" and a game has zero semantic match, it's capped near zero even if it fits the logistics (player count, playtime). Logistical fit alone doesn't make a recommendation.

**Comparison anchors are excluded from inferred ordinals.** If you ask for "something lighter than Terraforming Mars", TM's heavy complexity is used only for the directional comparison calculation — not placed in the inferred soft preferences. If it were, it would create distance penalties that fight against the comparison directional bonus you're trying to satisfy.

---

## Real Numbers

| Metric | Value |
|---|---|
| End-to-end latency | 5–10s (down from 31–35s, ~70% reduction) |
| Average cost per query (blended) | ~$0.0004 |
| IntentInterpreter | Gemini 2.5 Flash Lite (~$0.0004) |
| Taxonomist | Groq free tier (~$0.0000) |
| Equivalent pure-LLM approach | ~$0.08–0.40/query |
| Cost at 10k queries/month | ~$4 vs ~$400–4,000 |
| Consistency rate (10-prompt validation suite) | 100% on current suite (up from 62.5% in Feb 2026) |
| Airtable data transfer reduction | ~99.75% per query (KV cache vs. 11 paginated calls) |
| Game catalog | 1,094 titles, 15 taxonomy dimensions each |
| Scoring dimensions | 14+ |
| Hard filter stages | 3 (explicit → dial → inferred ±1) |
| Typical candidate pool after filtering | 50–200 from ~1,100 total |
| Max results returned | 6 |

---

## Stack

| Layer | Technology |
|---|---|
| Pipeline orchestration | [Flowise](https://flowiseai.com) (self-hosted) |
| LLM | Gemini 2.5 Flash Lite (IntentInterpreter), Groq GPT-OSS-120B (Taxonomist) |
| Database | Airtable (Inventory + External Seed tables) |
| Catalog cache | Cloudflare KV (12h TTL, stale-while-revalidate) |
| Proxy / CORS | Cloudflare Workers |
| Frontend | Framer |
| Analytics | PostHog + GA4 |

---

## What This Demonstrates

- Designing a hybrid system that minimizes LLM usage without sacrificing quality
- Engineering a multi-tier scoring engine with explainable, traceable results
- Handling the messy gap between natural language and structured data (synonym maps, fuzzy matching, ordinal distance logic)
- Thinking carefully about failure modes (fail-open vs fail-closed, semantic floor caps, vault quality gates)
- Building for unit economics from day one, not retrofitting them later

---

## License

**Code** (all `.js` and `.ts` files, including the Cloudflare Worker and analytics helpers): released under the [MIT License](./LICENSE). Use them freely in your own projects.

**Written content** (all `.md` files — architecture documents, ADRs, case studies, and product decision records): © Asher Atlas. All Rights Reserved. You are welcome to link to them, reference them, and discuss them, but you may not copy, modify, or republish the text without explicit permission.
