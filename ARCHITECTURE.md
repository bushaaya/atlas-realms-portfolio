# Atlas Realms Backend — Full Architecture Reference

*v2 pipeline — ConstantsProvider v9.5, Resolver v4.10, Retriever v2.16, Scorer v5.8*

A user types *"something light and co-op for 4 people, not too long"* into a Framer frontend. Within 2–4 seconds they receive six board game recommendations, ranked and annotated with a plain-English explanation of why each one fits. This document explains every decision the backend makes between those two events.

For the *why* behind the architectural approach, read [`ADR_hybrid_llm_architecture.md`](./ADR_hybrid_llm_architecture.md) first.

---

## High-Level Architecture

```
[User] → [Framer Frontend]
           ↓  POST (raw query string)
[Cloudflare Worker]  ← enforces CORS, routes to Flowise URL
           ↓
[Flowise Pipeline — 7 nodes]
  Node 00  ConstantsProvider     → shared config registry (wired to all nodes)
  Node 01  IntentInterpreter     → LLM (always runs)
  Node 02  TheResolverJS         → JS (always runs)
  Node 03  TheTaxonomist         → LLM (conditional — skips if nothing unresolved)
  Node 04  TheMergerJS           → JS (always runs)
  Node 05  TheRetrieverJSv2      → JS + Airtable fetch (always runs)
  Node 06  TheScorerJSv2         → JS (always runs)
  Node 07  TheFormatterJSv2      → JS (always runs)
           ↓
[Framer Frontend] ← { recommendations: [...], query_summary: {...} }
```

---

## Node 00 — ConstantsProvider

Not a processing node. A pure data node that exposes a large JavaScript object wired as an input to every other node that needs it. Think of it as a shared configuration registry — one source of truth for all taxonomy, all mappings, all ordinal scales.

### What it contains

**DB_ENUMS** — Every valid enum value for every taxonomy field, in precedence order (lightest to heaviest, least to most). The order matters: the Retriever and Scorer both use these arrays for ordinal distance calculations. Having one array serve as both the validity check and the ordinal scale was a deliberate design decision — one source of truth, no drift.

Fields covered: mechanics (~40 options), categories (~70 options), rules_complexity, decision_complexity, interaction, tone, format, luck_factor, family (design archetype), experience_mode, plus playtime, turn_flow, replayability, setup_effort, lang_depend, teachability.

**DIAL_MAPPINGS** — Each of the 5 intent dials maps to specific `ideal_*` preferences in the database. This is the core translation layer from natural language vibe to structured database fields.

**DIAL_PRECEDENCE** — When two dials conflict on the same field, the lower-priority dial is dropped first. Order: friction (highest) → approachability → chaos → social_temperature → strategic_ceiling (lowest).

**STYLE_MACROS** — Five style keywords (euro, party, wargame, 18xx, 4X), each with hard constraints (allowed complexity ranges, allowed interaction levels) and soft inferences (implied mechanics, categories, format). These give you significant filtering power from a single user keyword.

**SYNONYM_MAP** — ~150+ entries mapping natural-language phrases to specific `{ field, value }` pairs in the database. This is the primary deterministic path that avoids the Taxonomist LLM. Examples: "co-op" → `categories: Cooperative`, "brain burner" → `tone: Thinky`, "chill" → `tone: Relaxed`, "fiddly" → `setup_effort: High`.

**AVERAGE_GAME_PROFILE** — A baseline representing a typical medium-weight hobby game. Used when the user says "something heavier" without naming a specific reference game — the comparison is evaluated against this baseline rather than failing.

**CONFLICT_PATTERNS** — When a user invokes a style macro but also uses language contradicting that macro's defaults, a synthetic comparison is created. "Euro game with dice" triggers the euro macro (which implies Low luck) but conflicts with "dice." The system creates a comparison: "higher luck than the euro macro default" and passes it to the Scorer as a directional constraint.

---

## The 5 Intent Dials

Understanding the dial system is prerequisite to understanding everything else. The IntentInterpreter maps the user's query into five orthogonal dimensions. Each has three levels (low / medium / high) or null.

| Dial | What it measures | Low | High |
|------|-----------------|-----|------|
| `approachability` | How hard the **rules** are to learn and teach | User wants complex, heavy rules | User wants light, easy rules |
| `strategic_ceiling` | How deep the **decisions** are during play | User wants light, fast decisions | User wants deep, analytical play |
| `friction` | How much **session length** the user wants | User wants a long, epic session | User wants a quick, short session |
| `social_temperature` | How much **player-vs-player conflict** is desired | User wants peaceful play | User wants aggressive direct conflict |
| `chaos` | How much **randomness** is acceptable | User wants deterministic play | User wants luck-heavy play |

**Critical nuances:**

`friction` measures session length, not difficulty. "Casual" does NOT set friction — it sets approachability. A casual game can take 3 hours. Only actual time references fire friction.

`strategic_ceiling` measures decision depth during turns, not session length. "Low downtime between turns" sets strategic_ceiling:low, not friction.

When a user makes a comparison to a named game ("lighter than Brass"), that dimension is encoded as a comparison anchor only — the corresponding dial is NOT also set. Double-extraction is explicitly forbidden.

When the user uses extreme negative language ("I absolutely hate dice", "dealbreaker"), that dial is added to `strong_signal_dials`. The Scorer later applies 2× penalty weight for that dimension.

---

## Node 01 — IntentInterpreter (LLM)

**Runs:** Every query  
**Input:** Raw user query string  
**Output:** Strict JSON intent object

The IntentInterpreter is a carefully engineered system prompt. The LLM's only job is to parse natural language into a structured JSON object. It does not know about the game database. It does not recommend anything. It is purely an intent extractor.

The LLM is required to write out its `reasoning` field first, covering: the user's core goal, player context, every game mentioned and why, and any contrast language. The extractions must be consistent with the reasoning. This prevents hallucination by forcing structured thinking before commitment.

### What it extracts

**`core_terms`** — Mappable keywords, stripped of fluff modifiers. These go to the Resolver for database mapping. "interesting battles" → `core_terms: ["battles"]`.

**`full_phrases`** — Original phrasing with modifiers preserved, for text matching against game descriptions. "epic fantasy battles" → `full_phrases: ["epic fantasy battles"]`.

**`dials`** — The 5 intent dials. Only set when the user clearly signals that dimension. Never defaults to medium. Does not infer dials from referenced games.

**`strong_signal_dials`** — Dials where extreme negative language appeared ("hate", "dealbreaker", "absolutely refuse"). "Prefer not" and "not a fan" do not qualify.

**`mentioned_games`** — Every game named, each with a role:
- `anchor_include` — "something like Brass" — liked, exclude from results, use attributes as positive signals
- `anchor_exclude_owned` — "I already own Catan" — exclude from results, use as reference
- `anchor_exclude_disliked` — "I hated Root" — exclude from results, use attributes as negative signals
- `comparison_anchor` — "lighter than Terraforming Mars" — purely a scale reference

**`comparisons`** — Relative language as structured objects: `{ anchor_type, anchor_game, dimension, direction, strength }`. For superlatives ("the heaviest game possible"), `anchor_type: "average"` with direction scored against the AVERAGE_GAME_PROFILE baseline.

**`playtime`** — Three sub-fields: `max_minutes` (hard ceiling), `min_minutes` (hard floor), `preference_minutes` (soft target). "We have three hours" sets BOTH max=180 AND min=120 — the user wants to fill that window, not just not exceed it.

**`tolerance_terms`** — Phrases said with acceptance-but-not-enthusiasm language ("area control is okay", "I don't mind dice"). These flow into a separate low-weight scoring tier.

**`must_avoid_phrases`** — Explicit avoidances. Also used to suppress style macros — "more strategic than party games" puts "party" in must_avoid_phrases, which suppresses the party macro entirely.

**`negative_text_phrases`** — Themes the user dislikes that can't be hard-filtered by database field ("I hate demonic themes"). These get penalized in the Scorer by searching the game's description text.

---

## Node 02 — TheResolverJS

**Runs:** Every query  
**Input:** IntentInterpreter JSON + ConstantsProvider + Airtable credentials  
**Output:** `{ resolver_payload, taxonomist_payload, llm2_payload, merge_seed }`

This is the bridge between natural language and the database. It runs 10 phases.

### Phase 1 — Keyword Resolution (4-step chain)

For every term in `core_terms`, the Resolver tries to map it to a specific `{ field, value }` pair using four steps in order:

**Step 1 — SYNONYM_MAP (exact match).** The normalized phrase is looked up in the ~150-entry synonym dictionary. Always fires first — this is critical for terms like "light", "medium", "heavy", which must map to `rules_complexity`, not some other field. If matched here, steps 2–4 are skipped.

**Step 2 — Direct DB_ENUM match.** Checks if the phrase is an exact value in any DB enum array (case-insensitive). Field priority order matters: `rules_complexity` and `decision_complexity` are checked before the legacy `complexity` field to avoid mis-routing.

**Step 3 — Fuzzy enum match.** Only for multi-word phrases (single words are too ambiguous — "game" would match "Eurogame"). Checks if the phrase contains or is contained by any enum value. Only applied to mechanics, categories, tone, and format — fields where substring matching is semantically valid.

**Step 4 — Unmapped.** Nothing matched. The phrase is added to `unmapped_phrases` and forwarded to the Taxonomist.

The same 4-step chain runs on `tolerance_terms` separately, outputting to `tolerant_soft_preferences` — a lower-weight scoring tier.

### Phase 2 — Must-Avoid Processing

`must_avoid_phrases` are resolved to `banned_mechanics` and `banned_categories` using the same chain, with one addition: each step also tries a suffix-stripped version ("area control games" → tries "area control"). This prevents false misses on common phrasing patterns.

Phrases from `must_avoid_phrases` are also filtered out of `text_match_phrases` before text scoring. Without this, "no trading games" would appear in the text match input and the Scorer's token fallback would extract "trading" as a positive signal — directly against the user's stated preference.

### Phase 3–5 — Style Macro System

The Resolver checks if any core term matches a style macro trigger keyword.

**Critical suppression rule:** If the triggering keyword also appears in `must_avoid_phrases`, the macro is suppressed. "More strategic than party games" — "party" is in must_avoid, so the party macro never fires.

**Conflict as comparison:** If user language contradicts a macro's defaults (using CONFLICT_PATTERNS), a synthetic comparison is created and merged with the user's real comparisons. "Euro game with dice" → synthetic: "higher luck than the euro macro default (Low)." These are scored exactly like user-stated comparisons.

### Phase 7 — Dial-to-Database Mapping

Each dial value is looked up in DIAL_MAPPINGS to produce `ideal_*` preferences. When multiple dials constrain the same field with non-intersecting ranges, the DIAL_PRECEDENCE list is applied — the lowest-priority dial is dropped until intersection is non-empty.

Special cases:
- `friction:high` without explicit minutes → a short-session target value derived from DIAL_MAPPINGS
- `social_temperature` → maps to both `ideal_interaction` (enum string) AND `ideal_interaction_intensity` (numeric range on a 1–5 scale)

### Airtable Fetch for Anchor Games

If there are mentioned games, the Resolver does a server-side filtered Airtable fetch using `filterByFormula` to retrieve only those specific games' data. Much faster than fetching all records. The filter uses `LEFT({Title_Normalized}, N) = "..."` which handles subtitle and edition variants — "Talisman" matches "Talisman: The Magical Quest Game 5th Edition." When multiple candidates match, exact title wins; otherwise shortest title (base game heuristic) wins.

### Output

The Resolver outputs:
- `resolver_payload` — all the structured preference signals (hard_filters, explicit_soft, dials_soft, inferred_soft, tolerant_soft, comparisons, text_match_phrases, negative_text_phrases)
- `taxonomist_payload` — unmapped phrases for the Taxonomist
- `llm2_payload` — mentioned games not found in the database
- `should_run_taxonomist` — true if either of the above is non-empty

---

## Node 021 — TheTrimmer

A thin utility node. If `should_run_taxonomist` is false, it emits `{ skip_taxonomist: true }` instead of forwarding the Resolver output. This prevents the Taxonomist LLM from running (and billing) on queries where everything resolved cleanly.

---

## Node 03 — TheTaxonomist (LLM, conditional)

**Runs:** ~30% of queries, only when Resolver has unresolved items  
**Input:** Resolver's taxonomist_payload + llm2_payload + constants  
**Output:** Strict JSON with enrichment data

The first thing the Taxonomist does is check for `"skip_taxonomist": true`. If present, it returns an empty response without processing.

When it does run, it has three tasks:

**Task A — Unknown Game Enrichment:** For each game not found in the database, the Taxonomist uses its LLM knowledge to provide taxonomy data (complexity, luck, interaction, tone, format, experience_mode, mechanics, categories, play time ranges). Only provides data if it can recall at least 2 concrete facts. Explicitly instructed not to hallucinate for unknown games.

**Task B — Unmapped Phrase Resolution:** For phrases that went through the Resolver's 4-step chain without mapping, the Taxonomist uses semantic understanding to find the right database enum. It applies the same Compound Modifier Rule: "economic puzzles" should not map to the "Economic" category — the modifier "puzzles" shifts the meaning to `format: "Puzzle / Optimization"`.

**Task C — Tolerance Phrase Mapping:** Same resolution as Task B, but results go into a separate output (`tolerance_keyword_mapping`), keeping the tolerance tier isolated from the explicit tier.

---

## Node 04 — TheMergerJS

**Runs:** Every query  
**Input:** Resolver output + Taxonomist output + ConstantsProvider  
**Output:** A single clean `search_contract` object

The Merger combines everything from the Resolver and Taxonomist into a clean, four-tiered `search_contract` that downstream nodes can query uniformly.

### Tier 1 — Explicit

What the user directly said. Highest scoring weight.

**Hard filters:** player_count, play_max_minutes, play_min_minutes, age_min, banned_mechanics, banned_categories, exclude_ids (all mentioned games), lang_depend.

**play_min_minutes inference:** If only a `play_max_minutes` was given and it's above a threshold, a proportional minimum floor is inferred. This prevents a "max 2 hours" request from returning 10-minute filler games. Below the threshold, no floor is added — the user genuinely wants short games.

**Adult age floor:** If no age context was stated and no children's vocabulary appears, an adult age floor is injected. Games explicitly tagged below that age are excluded from adult queries. This prevents genuinely children's games from appearing in adult recommendations.

**Soft preferences:** Everything the user directly named — preferred mechanics, categories, complexity tiers, interaction, tone, format, experience_mode, family.

The Merger merges the Resolver's explicit tier with the Taxonomist's `keyword_enum_mapping` results. Both sources are treated as explicit tier — the Taxonomist's mappings came from the user's words, just via the LLM fallback path.

### Tier 2 — Dials

What the user meant (vibe). Lower scoring weight than explicit.

Macro-based hard filters (`allowed_rules_complexity`, `allowed_interaction`, etc.) sit here — these are actual hard filters, not soft preferences. The Retriever will exclude games outside these ranges.

Dial-derived soft preferences (`ideal_rules_complexity`, `ideal_decision_complexity`, `ideal_interaction`, `ideal_luck_factor`, `ideal_tone`, `ideal_preference_minutes`, `ideal_setup_effort`, `ideal_interaction_intensity`) are the signals the Scorer uses for bonus/penalty scoring.

### Tier 3 — Inferred

What the user referenced indirectly, via anchor games or macro inferences. Lower scoring weight than dials.

**From anchor games:** For `anchor_include` and `anchor_exclude_owned` roles, the Merger extracts both semantic attributes (mechanics, categories, tone, format) AND ordinal attributes (complexity, luck, interaction, turn_flow, setup_effort, replayability, experience_mode). For `comparison_anchor` roles, only semantic attributes are extracted. **Critical:** comparison anchors' ordinal attributes are intentionally kept out of the inferred tier because the Scorer's comparison system handles them — if they were also in the inferred tier, they would create distance penalties that fight against the comparison directional bonus.

**Multi-anchor consensus (BUG-16):** When 2+ positive anchors are present and they share mechanics or categories, those shared signals are promoted to the Explicit tier. If the user references both Wingspan and Azul as liked games, and both have "Tile Placement," that shared signal is stronger than a single anchor's data.

**Ordinal conflict cancellation (BUG-16):** If multiple anchors disagree on an ordinal dimension (one is Light complexity, another is Heavy), that dimension is cleared entirely. A contradiction is not a preference — better to have no signal than the wrong signal.

**Cross-field inferences:** If the user didn't explicitly state `experience_mode` but requested "Cooperative" as a category, the Merger infers `Fully Cooperative`. "Hidden Traitor" mechanic → `Semi-Cooperative`. "Team Play" mechanic → `Team-Based`. If `age_min ≤ 8`, infer `lang_depend: "None"` (young children need language-independent games).

**Disliked anchors:** For `anchor_exclude_disliked` games, the Merger extracts their mechanics and categories into `disliked_mechanics` and `disliked_categories`. These flow to the Scorer, which applies penalties per match — unless the user also explicitly requested that same mechanic in the same query. "I hated Root but I love asymmetric games" → Area Control penalized; Asymmetric Powers exempt.

### Tier 4 — Tolerance

Mechanics and categories the user said are acceptable but not desired. Very low scoring weight (lowest tier). Specifically lower than inferred to prevent tolerance signals from driving results. Merged from Resolver's `tolerant_soft_preferences` and Taxonomist's `tolerance_keyword_mapping`.

---

## Node 05 — TheRetrieverJSv2

**Runs:** Every query  
**Input:** Merger output (search_contract)  
**Output:** Filtered candidate list + search_contract + trace

The Retriever fetches all games from Airtable and narrows them to a manageable candidate list before scoring runs.

### Airtable Fetch

Fetches all records from two tables concurrently:
- **Inventory table** — games physically owned and offered for sale/rental ("vault" items). Includes: Condition, Asking_price, BGG_listing, Edition_tags.
- **External Seed table** — the main game database. Includes: Players_rec, Affiliate_link, Popularity, Mood_tags, Tiebreaker.

Both tables use a filtered Airtable view (only "ready" games appear). After fetching, records are normalized into a flat structure. Deduplication: if the same game appears in both tables, the inventory version takes priority. The `Tiebreaker` field is a composite popularity + availability score pre-computed in Airtable.

### Three-Stage Filtering

**Stage 1 — Explicit Hard Filters**

- **Player count (Fail-Closed):** If game data is missing player info → REMOVE. The filter also checks that the game "covers the lower end": a 3–7 player game fails a "4 player" query because you couldn't play it at 4 players.
- **Playtime max (Fail-Open):** If no play_max data → KEEP.
- **Playtime min (Fail-Open):** If no data → KEEP.
- **Age min (Fail-Open):** Game's age_min must be ≤ user's stated age + 3-year buffer. If no data → KEEP.
- **Adult age floor (Fail-Open):** Game's age_min must meet the adult age floor threshold. If no age tag → KEEP.
- **Banned mechanics (bidirectional substring match):** If any banned term is a substring of any game mechanic, or vice versa, the game is removed.
- **Banned categories:** Same bidirectional substring logic.
- **Language dependence (Fail-Open):** If lang_depend was hard-filtered, game must match one of the allowed values. If no lang_depend data → KEEP.

Why fail-open everywhere except player count: player count is the one filter where a wrong recommendation is completely unusable (you literally can't play the game). Everything else is a preference mismatch, not a structural impossibility. Fail-open preserves candidates for the Scorer to evaluate.

**Stage 2 — Dial Hard Filters (Fail-Open)**

Macro-based hard filters from the Dials tier — e.g., the party macro forces `allowed_rules_complexity: ["Light"]`. Games with no data for that field pass through. Only actual macro constraints appear here — regular dial-derived signals produce soft preferences, not hard filters.

**Stage 3 — Inferred Soft Filters (Fail-Open, ±1 distance)**

For each dimension where an ideal value exists, games more than 1 step away on the ordinal scale are removed. "More than 1 step" means: tone:Relaxed ideal → Relaxed (distance 0) passes, Playful (distance 1) passes, Thinky (distance 2) fails.

Applied to: tone, format, rules_complexity, decision_complexity, interaction, luck_factor, and playtime (approximately one session-length bucket around the game midpoint).

All fail-open: games with no data always pass.

---

## Node 06 — TheScorerJSv2

**Runs:** Every query  
**Input:** Retriever output (candidates + search_contract)  
**Output:** Top 6 scored and ranked candidates

The most complex node. Every candidate game starts at a base score. The Scorer evaluates it across 14+ sections (A through M), then applies diversity-aware selection.

For exact scoring weights, see [`SCORING_SYSTEM.md`](./SCORING_SYSTEM.md). This section covers the architecture and logic.

### Mechanics and Categories (Sections A, B)

Both use a 4-tier structure — explicit (user said it directly), dials (macro-inferred), inferred (from anchor games), tolerance (accepted but not desired). The explicit tier earns the most; tolerance earns the least and can never make a game rank above one with real signal matches. Matching uses bidirectional substring: "Deck Building" matches "Deck Builder" and vice versa.

The **disliked anchor penalty** applies here: if the user said "I hated Root", Root's mechanics (Area Control) are extracted and penalized across all candidates — unless the user also explicitly requested that mechanic in the same query.

### Family Label (Section B2)

The design archetype (Euro, Wargame, Dungeon Crawler, etc.) scores in the explicit tier only. No dial-derived tier (no dial maps to family label). No inferred tier (family is too coarse to reliably infer from a specific anchor game).

### Complexity (Sections C, C2, C3)

Split into three independent paths:

**Legacy path:** For backward compatibility with games not yet re-enriched with split complexity fields — scores against the old unified `complexity` field at half weight.

**Rules complexity:** How hard to learn and teach the game. Derived from explicit user phrases ("easy to learn") and from the `approachability` dial. Distance-graduated penalties: a game that is one step away from ideal on the rules complexity scale receives a small penalty; two or more steps away receives a larger penalty.

**Decision complexity:** How deep the in-game decisions are. Separate from rules complexity — a game can be easy to learn but brutally deep (e.g., Go). Derived from explicit phrases ("brain burning") and the `strategic_ceiling` dial. No fallback to the old complexity field because old complexity ≠ decision depth.

### Ordinal Distance Fields (Section D)

Seven fields share a common scoring pattern: interaction, luck_factor, tone, format, turn_flow, setup_effort, replayability. Each is scored at three tiers (Explicit / Dials / Inferred) with distance-graduated penalties.

The distance is calculated as index distance in the ordered DB_ENUM array. For multi-value game fields (tone and format can have multiple values), the closest distance to any of the game's values is used.

Tone and format carry the highest penalty weights because they define experiential identity — a Relaxed puzzle game and a Tense wargame might share mechanics but feel completely different to play. Luck carries milder penalties because luck tolerance is more flexible — many players accept Medium luck even if they prefer None.

### Player Count (Section E)

Two bonuses that stack: one for the game being able to accommodate the full group at all, and a higher bonus if the game is specifically optimized for exactly that count. A dedicated 2-player game played at 2 players earns both. There's a penalty when the game's minimum player count exceeds the requested count by more than 3 — a safety net for games the Retriever might not have fully filtered.

### Playtime Proximity (Section F)

Scored by numeric proximity in minutes, not bucket matching. Only fires if the user expressed a soft session length preference. Asymmetric: only penalizes games that significantly overrun the preference. A game that runs shorter doesn't get penalized.

### Comparison Scoring (Section H)

**One of the most sophisticated parts of the system.** Users often express preferences in relative terms: "something lighter than Terraforming Mars", "more interactive than Wingspan."

The Scorer:
1. Finds the anchor game's value on the requested dimension in its known data
2. Compares the candidate game's value against that anchor using ordinal distance
3. Awards a bonus scaled by strength multiplier × distance if the candidate satisfies the direction
4. Applies a flat penalty if the candidate goes the wrong direction

Strength multipliers scale linearly across low/medium/high levels, and there's a per-anchor cap to prevent runaway stacking when multiple dimensions all favor one game.

**Inversion handling:** `approachability` and `friction` have inverted semantics — "higher approachability" means simpler rules (lower complexity index). The Scorer flips the direction for these dimensions automatically.

**Superlative comparisons ("the lightest game possible"):** `anchor_type: "average"` — the comparison is evaluated against the AVERAGE_GAME_PROFILE baseline.

**Synthetic comparisons (macro conflicts):** "A euro game with more combat than usual" creates a synthetic comparison: "higher interaction than a typical Euro." Scored identically to user-stated comparisons.

### Text Matching

The Scorer scans game text (summary, verdict, pros, cons, Mood Tags) against the user's original phrases. Four keyword categories:

- **Logistics** ("easy setup", "low downtime", "portable") — matched against Pros, penalized if they appear in Cons with negative context
- **Group Fit** ("family friendly", "gateway", "easy to learn") — matched against Pros + Summary
- **Aesthetics** ("beautiful", "miniatures", "table presence") — matched against Pros + Summary
- **Experience/Vibe** (thematic phrases, "pirate theme", "horror atmosphere") — matched against Summary + Verdict + Pros

**Token fallback:** If a multi-word phrase doesn't match verbatim, the Scorer tries the longest meaningful token (≥6 chars). Stopwords and quality adjectives ("amazing", "compelling") are blocked from this fallback to prevent false positives. A given token can contribute at most 2 hits total across all phrases (deduplication).

**Negative text penalty:** Each phrase in `negative_text_phrases` that appears in a game's text fields applies a soft penalty. Multiple phrases stack. It's soft — a game with "demonic" in its summary still appears if every other signal strongly favors it, but it's pushed below thematically clean alternatives.

### Experience Mode (Section J)

Non-ordinal: exact match only, two tiers. Explicit (user said "cooperative") earns the most; inferred (Merger derived from cross-field inference) earns less.

**Antipode penalties (the system's strongest):** Recommending a competitive game when someone asked for co-op — or vice versa — is a category error, not a preference mismatch. The system applies near-disqualifying penalties for these cases. Co-op requested + non-co-op game → maximum penalty. Aggression requested + co-op game → maximum penalty. A small "unknown" penalty applies when the game has no experience_mode tag and isn't tagged with "Cooperative" — not confirmed wrong, but uncertain.

### Strong Signal Amplifier (Section M)

For each dial in `strong_signal_dials`, every dials-tier penalty already applied for that dimension is doubled. Only dials-tier penalties are amplified — explicit-tier and inferred-tier penalties have their own calibrated weights. The amplification is additive, not multiplicative.

Example: User says "I absolutely hate dice — zero luck." `chaos` becomes a strong signal. A candidate game with Medium luck factor normally takes a dials-tier penalty. With the amplifier, that penalty doubles.

### Semantic Floor Cap

After all scoring, a final cap is applied to games with zero semantic matches despite the query containing semantic intent:

- Query had explicit semantic signals, game matched none → a low cap is applied. The user named something specific; this game has none of it.
- Query had only inferred/dial semantic signals, game matched none → a moderate cap is applied. Softer — the signal was indirect.
- Query had no semantic signals (pure logistics: "4 players, 90 minutes") → no cap.
- Game matched at least one semantic signal → no cap.

This prevents a game from appearing solely on logistical fit when the user expressed content preferences. A chess-like abstract game shouldn't appear in response to "fantasy dungeon crawler" just because it fits 4 players.

### Tone/Format Multiplier

After individual dimension scoring, if there are inferred tone/format preferences (from anchor games), a global multiplier is applied based on how well the game's feel aligns. This multiplier can significantly reduce the score of a game with perfect mechanics but completely wrong experiential feel. It only fires when anchor games were mentioned — otherwise there's no inferred feel signal to check against.

### Result Selection

After sorting (score → inventory-first → scoring breadth → data completeness → tiebreaker → alphabetical), diversity-aware selection picks up to 6 games:

- Max 2 vault (inventory) items, and only if they meet a minimum quality threshold relative to the top result. This prevents low-quality vault items from displacing strong external recommendations.
- Default: a per-family cap applies (to avoid results clustering around a single design archetype — e.g. all 18xx train games when the user asked for "economic games").
- If user explicitly requested a specific family → cap by Format instead (diversify within the family they requested).
- If user specified both family AND format → no cap (fully constrained intent).
- If the diversity cap would yield fewer than 6 results → drop the cap entirely and take top 6. No partial degradation.

---

## Node 07 — TheFormatterJSv2

**Runs:** Every query  
**Input:** Scorer output (top 6 + search_contract)  
**Output:** `{ recommendations: [...], query_summary: {...} }`

Maps internal Airtable field names to frontend-friendly names. Formats playtime as "30–60 min" from minute-range fields. Applies category rotation across the 6 results to avoid showing the same label repeatedly.

### Why-This Blurbs

The score is compared against a reference to determine match quality: excellent, strong, partial, or limited.

For **limited and partial matches**: the blurb is honest — it acknowledges what didn't match before stating what did. "Fits your player count. Different mechanics than requested, but meets the basics." Building trust matters more than appearing confident about a weak match.

For **strong and excellent matches**: if there are tradeoffs (penalties applied during scoring), the blurb leads with the tradeoff ("Caps at 4 instead of your 6, but plays tight and stays engaging"). If there are comparison anchors, it references them. Otherwise it highlights the strongest matching dimension.

All blurbs use a deterministic hash of the game name to select among template variants — the same game always gets the same variant, preventing flickering on re-renders.

### query_summary

The full search_contract, resolver trace, merger trace, and unmapped_terms are passed through as `query_summary`. Used by the analytics pipeline to understand query structure and identify vocabulary gaps (unmapped_terms are candidates for SYNONYM_MAP additions — the dictionary grows from real usage).

---

## Key Architectural Decisions

**Fail-open vs fail-closed:** Player count is fail-closed because including an unplayable game is worse than missing a good one. All other filters are fail-open because missing data is common and over-exclusion would be too aggressive.

**Two LLM calls maximum:** IntentInterpreter runs every time. Taxonomist only when something couldn't be resolved. Average: 2,500–3,400 tokens per query.

**Ordinal arrays as precedence-ordered truth:** The DB_ENUM arrays in ConstantsProvider double as the ordinal scale for distance calculations. One source of truth for both enum validity and ordinal ordering — no drift between them.

**Comparison anchors excluded from inferred ordinals:** A game used as `comparison_anchor` contributes its mechanics/categories/tone/format to the inferred tier (so you get games that feel similar), but its ordinal attributes are kept out. If they were included, they would create distance penalties that fight against the comparison directional bonus. The comparison system handles ordinal scaling exclusively for these games.

**The Tone/Format multiplier fires only when anchors are present:** If no anchor games were mentioned, there are no inferred tone/format preferences, so the multiplier never fires. It only applies when the user referenced specific games and the system has a strong "feel" signal to check against.

**Why the party macro hard-filters but most dials don't:** `approachability` produces a soft preference because a user might say "easy to learn" while asking for a genre that tends toward medium complexity. The party macro is a categorical style statement — "party game" implies light rules by definition. Heavy-rules party games don't exist as a coherent category.
