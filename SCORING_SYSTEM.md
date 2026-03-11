# Atlas Realms — Scoring Engine: Deep Dive

> **Is this system complex?**
> Yes. Objectively. This is a multi-tier, multi-dimension, ordinal-distance scoring engine with 15 active scoring dimensions, 3 signal tiers per dimension, distance-graduated penalties, a conditional score multiplier, a semantic floor cap, a strong-signal amplifier, and a 5-criteria deterministic tiebreaker. Most commercial recommenders use simple tag overlap or collaborative filtering. This engine computes a structured compatibility score by reasoning about *what the user meant*, not just *what they said*.

This document is the technical reference for the Scorer — Node 06 in the 7-node pipeline. For the overall architecture, see [`ARCHITECTURE.md`](./ARCHITECTURE.md). For the reasoning behind the hybrid LLM + deterministic approach, see [`ADR_hybrid_llm_architecture.md`](./ADR_hybrid_llm_architecture.md).

---

## Table of Contents

1. [How Scoring Works: The Big Picture](#1-how-scoring-works-the-big-picture)
2. [Signal Tiers: Where Points Come From](#2-signal-tiers-where-points-come-from)
3. [Scoring Dimensions (A–M)](#3-scoring-dimensions)
4. [Global Modifiers](#4-global-modifiers)
5. [Tiebreaker Logic](#5-tiebreaker-logic)
6. [Result Selection (Vault vs External)](#6-result-selection)
7. [End-to-End Example](#7-end-to-end-example)

---

## 1. How Scoring Works: The Big Picture

Every candidate game starts at a base score. The Scorer then evaluates up to **15 dimensions** of compatibility between what the user asked for and what the game offers. Points are added for matches and subtracted for mismatches.

The pipeline that feeds the Scorer has already done the hard work:

```
User query (natural language)
    ↓
IntentInterpreter  →  extracts dials, phrases, comparisons, constraints
    ↓
Resolver           →  maps phrases to DB enums via synonym map + fuzzy match
    ↓
Taxonomist         →  handles phrases the Resolver couldn't map (LLM fallback)
    ↓
Merger             →  builds the "search contract" (structured scoring instructions)
    ↓
Retriever          →  hard-filters the game database to a candidate pool
    ↓
SCORER             →  ranks every candidate with a numeric score  ← you are here
    ↓
Formatter          →  writes the response
```

The Scorer receives a **search contract** — a structured JSON object containing four tiers of preferences — and scores each candidate game against it.

---

## 2. Signal Tiers: Where Points Come From

Every scoring dimension is split into up to **four tiers** based on how the signal was derived. Higher-confidence signals earn more points.

| Tier | Name | Source | Example |
|---|---|---|---|
| **Tier 1** | **Explicit** | User said it directly | "I want deck building" |
| **Tier 2** | **Dials** | Inferred from fuzzy language signals | "chill game" → `social_temperature:low` → prefers low interaction |
| **Tier 3** | **Inferred** | Derived from anchor games the user mentioned | "something like Wingspan" → Worker Placement, Engine Building inferred |
| **Tier 4** | **Tolerance** | User accepted, not requested | "deck building is fine" → mild nudge, won't drive results |

The tolerance tier exists because acceptance language ("okay with", "fine if", "can handle") is a fundamentally different signal from enthusiasm. A game shouldn't rank top because the user said it's acceptable — but it's still marginally better than a game with no signal at all.

### The 5 Intent Dials

Before scoring, the IntentInterpreter maps the user's natural language onto 5 structured dials. Each dial fires soft preferences into the search contract.

| Dial | What it Captures | Example Phrases |
|---|---|---|
| `friction` | Session length commitment | "quick game", "long campaign", "weeknight game" |
| `approachability` | Rules complexity / teachability | "easy to teach", "gateway game", "veteran players" |
| `strategic_ceiling` | Depth of decisions during play | "brain burning", "deep thinker", "casual play" |
| `social_temperature` | Player conflict / interaction level | "chill", "cutthroat", "aggressive", "peaceful" |
| `chaos` | Luck and randomness tolerance | "hate dice", "luck-based", "strategic control" |

Each dial produces **ideal values** — soft preferences — not hard filters (with one exception: macro keywords like "party game" still apply hard complexity constraints).

### Dial Precedence (Conflict Resolution)

When two dials produce conflicting constraints on the same field, lower-priority dials are dropped. The precedence order runs from the most logistically concrete constraint (session length) to the most flexible preference (decision depth).

---

## 3. Scoring Dimensions

### A. Mechanics (4-Tier Tag Overlap)

Mechanics are multi-select tags on games (e.g. "Deck Building", "Worker Placement"). The Scorer checks whether any of the game's mechanics match what the search contract requested.

| Match Type | Weight | Source |
|---|---|---|
| Explicit mechanic match | **High** | User said "deck building" |
| Dials mechanic match | **Moderate** | Macro: "euro game" → infers Worker Placement, Engine Building |
| Inferred mechanic match | **Low** | Derived from anchor game ("like Wingspan") |
| Tolerance mechanic match | **Minimal** | User said "deck building is okay" |
| Penalty mechanic present | **Mild penalty** | Dial signal flagged this mechanic as unwanted |

**Penalty Mechanics** are a special case: dials can flag mechanics that are *bad fits*. Examples:
- `strategic_ceiling:low` (user wants simple decisions) → penalizes Worker Placement, Engine Building, Auction, Negotiation
- `approachability:high` (easy to teach) → penalizes Variable Player Powers, Market Manipulation, Card Crafting

**Disliked Anchor Penalty:** If the user said "I hated Root", Root's mechanics (Area Control) are extracted and penalized across all candidates — unless the user also explicitly requested that mechanic in the same query.

> *Example:* "I hated Root but love asymmetric games" → Area Control: moderate penalty. Asymmetric Powers: exempt.

---

### B. Categories (4-Tier Tag Overlap)

Categories cover themes and game types (e.g. "Fantasy", "Economic", "Cooperative"). Same structure as mechanics.

| Match Type | Weight |
|---|---|
| Explicit category match | **High** |
| Dials category match | **Moderate** |
| Inferred category match | **Low** |
| Tolerance category match | **Minimal** |

**Banned Categories** (from `must_avoid_phrases`) are applied as hard filters in the Retriever, so they never reach the Scorer. The Resolver maps "no wargames" → `banned_categories: ["Wargame"]` before the Scorer ever runs.

---

### B2. Design Family (Explicit Only)

`family` is a single-select genre archetype label — Euro, Wargame, 4x, Dungeon Crawler, Deckbuilder, Trick-Taking, Roll-and-Write, etc. It's broader than category, so it earns slightly less than an exact category match.

| Match | Weight |
|---|---|
| Explicit family match | **High** |

No dials or inferred tier — family labels are too coarse for dial inference.

> *Example:* "A good dungeon crawler for 4" → family: Dungeon Crawler matches → significant bonus for Gloomhaven, Descent, etc.

---

### C. Complexity (Three Paths)

Complexity is split into **two independent dimensions**, each scored separately:

#### C1. Legacy Path (backward compatibility)
Direct enum phrases ("Light", "Medium", "Heavy") and Taxonomist-mapped complexity terms still score against `game.complexity` with distance-graduated rewards/penalties.

| Distance | Explicit | Inferred |
|---|---|---|
| Exact match | **High** | **Low** |
| Distance 1 (e.g. Light ↔ Medium) | **Mild penalty** | **Mild penalty** |
| Distance 2 (Light ↔ Heavy) | **Moderate penalty** | **Moderate penalty** |

#### C2. Rules Complexity (how hard to learn the rules)
Mapped from SYNONYM_MAP phrases ("easy to teach", "heavyweight", "beginner game") and from the `approachability` dial.

| Match | Weight | Notes |
|---|---|---|
| Explicit rules_complexity match | **High** | User said "easy to learn" |
| Dials rules_complexity match | **Moderate** | `approachability:high` → ideal: Light |
| Distance 1 penalty | **Mild penalty** | On both tiers |
| Distance 2 penalty | **Moderate penalty** | On both tiers |

**Why the relatively gentle penalties?** Complexity is a real constraint but it's also the dimension most likely to be misread from language. A mild penalty keeps it as a useful tiebreaker without letting it override explicit theme or category matches. A user asking for "superheroes" should get the superhero game even if it's slightly more complex than they implied.

**Fallback at reduced weight:** Games not yet re-enriched with split complexity fields fall back to the old `complexity` field, but all bonuses and penalties are reduced to avoid over-penalizing for missing data.

#### C3. Decision Complexity (how deep are the in-game decisions)
Separate from rules complexity. A game can be easy to learn but brutally deep (e.g. Go). Mapped from phrases like "brain burning", "complex decisions" and from the `strategic_ceiling` dial.

| Match | Weight |
|---|---|
| Explicit decision_complexity match | **High** |
| Dials decision_complexity match | **Moderate** |

**No fallback** to old `complexity` field — old complexity field ≠ decision depth.

> *Nuance:* A user saying "something not too complex" fires `approachability:high`, which sets `ideal_rules_complexity: "Light"` but does **not** set `ideal_decision_complexity`. The two are independent. A "light rules, deep decisions" game (like Chess) would score well on the first and neutral on the second.

---

### D. Ordinal Distance Scoring (Interaction, Luck, Tone, Format, Turn Flow, Setup Effort, Replayability)

Seven fields share a common scoring pattern: ordinal-scale fields where the "distance" from the requested value determines whether you get a bonus or a penalty.

**Ordinal scales:**
- Interaction: No Interaction → Indirect → Direct Non-Aggressive → Direct Aggressive
- Luck: None → Low → Medium → High
- Tone: Relaxed → Playful → Thinky → Competitive → Tense → Cutthroat → Epic
- Format: Strategic Build → Puzzle/Optimization → Competitive Scoring → Tactical Conflict → Narrative/Campaign → Hidden Info/Deduction → Social/Negotiation → Party/Performance
- Turn Flow: Interleaved → Sequential → Semi-Simultaneous → Simultaneous
- Setup Effort: Low → Medium → High
- Replayability: Low → Medium → High

Each field is scored at three tiers (Explicit / Dials / Inferred) with distance-graduated penalties. The general pattern for every field:

| Match type | Distance 0 (exact) | Distance 1 | Distance 2 | Distance 3+ |
|---|---|---|---|---|
| **Explicit** | Strong bonus | Moderate penalty | Strong penalty | Max penalty |
| **Dials** | Moderate bonus | Moderate penalty | Strong penalty | Max penalty |
| **Inferred** | Mild bonus | Moderate penalty | Strong penalty | Max penalty |

**Field-specific weight calibration:**

- **Tone and Format** carry the highest bonuses and penalties — they define experiential identity. A Relaxed puzzle game and a Tense wargame feel completely different even if they share mechanics. A mismatch here cascades through the Tone/Format multiplier (see Section I).
- **Luck Factor** carries milder penalties — many players accept Medium luck even if they prefer None. The penalty scales more gradually.
- **Interaction** is heavily penalized at distance because social experience (conflict vs. cooperation) is non-negotiable for most users.
- **Turn Flow, Setup Effort, Replayability** are treated as secondary considerations — useful tiebreakers, not primary filters.

> *Example — Tone:*
> User: "something chill" → SYNONYM_MAP maps "chill" → explicit tone: Relaxed.
> Candidate game: Tone = Tense (distance 4 from Relaxed on the 7-point scale).
> Result: Maximum penalty applied — near-disqualifying for an explicitly requested relaxed mood.

---

### E. Player Count (2-Tier)

| Condition | Weight |
|---|---|
| Game can accommodate the full group | **High** |
| Game is optimized for exactly this count | **Moderate** (stacks with above) |
| Game requires far more players than the group has | **Mild penalty** |

The two bonuses stack. A dedicated 2-player game requested for exactly 2 players earns both — the strongest possible player count score.

> *Nuance:* The penalty only fires when the gap is significant. A 3-player game requested for 2 players passes through the Retriever's range check already; the penalty catches extreme mismatches the Retriever might have allowed through.

---

### F. Playtime (Minutes Proximity)

Playtime is scored by **numeric proximity in minutes**, not bucket matching. This fires when the user has expressed a soft session length preference (via the `friction` dial or explicit minutes).

| Delta from preferred minutes | Weight |
|---|---|
| Very close to preference | **Mild bonus** |
| Moderately close | **Small bonus** |
| Far from preference | No bonus |
| Significantly overruns preference | **Mild penalty** |

The penalty is asymmetric — only fires when a game runs much longer than the preference. A shorter game doesn't get penalized.

---

### G. Age Penalty

When the user specifies children are playing, a penalty is applied per year that the game's minimum age exceeds the child's age.

---

### H. Comparison Scoring

**One of the most sophisticated parts of the system.** Users often express preferences in relative terms: "something lighter than Terraforming Mars", "more interactive than Wingspan", "something different from what we usually play."

The Scorer resolves these by:
1. Finding the anchor game's value on the requested dimension in its known game data
2. Comparing the candidate game's value against that anchor using ordinal distance
3. Awarding a scaled bonus if the candidate satisfies the direction; a flat penalty if it goes the wrong way

The bonus scales with both the **strength** of the expressed preference (low / medium / high) and the **ordinal distance satisfied** — a game that is much lighter than the anchor earns more than one that is barely lighter. A per-anchor cap prevents runaway stacking when multiple dimensions all favor one game.

#### Comparison Types

**Named game comparison:**
> "lighter than Terraforming Mars" → TM has Heavy rules complexity. A Light game fully satisfies the comparison and earns a large scaled bonus. A Heavy game earns a flat penalty.

**Superlative / anchor-free comparison (vs. average baseline):**
> "the lightest game you have" or "something more interactive than usual" → compared against the average game profile (Medium complexity, Indirect Interaction, etc.).

**Synthetic comparison (macro conflict resolution):**
> "a euro game with more combat than usual" → Euro macro defaults to Indirect interaction. User wants more. The system creates a synthetic comparison: "higher interaction than a typical Euro". No named game needed.

#### Inverse-Semantics Dimensions

Some dial names have inverted semantics. `approachability` is one: when a user says "lighter than X", `direction: higher` means "higher approachability", which maps to *lower* index on the complexity scale. The Scorer flips the direction for these cases automatically.

---

### I. Tone/Format Multiplier

When the user mentions anchor games (e.g. "games like Wingspan"), the system infers tone and format from those anchors. If a candidate game has a tone or format that is **far** from the inferred preference, the entire score is multiplied down — not just the tone/format portion.

| Condition | Effect |
|---|---|
| Both tone and format: exact match | No reduction |
| One exact, one close (distance 1) | Small reduction |
| Both close (distance 1) | Moderate reduction |
| One close, one far/missing | Large reduction |
| Both far or missing | Near-elimination |
| No tone/format data at all | Near-elimination |
| Only one dimension tracked, exact | No reduction |
| Only one dimension tracked, close | Small reduction |
| Only one dimension tracked, far | Large reduction |

**Rationale:** Tone and format define the *experiential identity* of a game. A Relaxed puzzle game and a Tense wargame might share mechanics (Area Control) but feel completely different to play. If the candidate's fundamental feel doesn't match, no amount of mechanic or category overlap makes it a good recommendation.

---

### J. Experience Mode (Player Structure)

`experience_mode` is a single-select field describing the structural relationship between players: Free-For-All, Fully Cooperative, Semi-Cooperative, Team-Based, One-vs-Many, Aligned Rivalry.

| Match | Weight |
|---|---|
| Explicit match (user said "cooperative") | **High** |
| Inferred match (from cross-field inference) | **Moderate** |

#### Antipode Penalties

These are the system's strongest penalties — because recommending a competitive game when someone asked for co-op (or vice versa) is a **category error**, not just a suboptimal match:

| Condition | Effect |
|---|---|
| Co-op requested, game has a non-co-op experience_mode | **Near-disqualifying** |
| Co-op requested, game has no experience_mode tagged | **Significant penalty** (unknown, not confirmed wrong) |
| Aggression requested (Cutthroat tone or Direct Aggressive interaction), game is co-op | **Near-disqualifying** |

**Exemption:** If a game has no `experience_mode` tag but has the "Cooperative" category, it bypasses the unknown penalty — it's inferably cooperative.

---

### K. Language Dependence

Language dependence sits on a 3-point scale: None → Low → High.

**Explicit path (K):** Fires when user explicitly requested language independence ("icon-based", "no reading required", "language independent"):

| Distance | Weight |
|---|---|
| Exact (None requested, game has None) | **Mild bonus** |
| Distance 1 (None requested, game has Low) | **Moderate penalty** |
| Distance 2 (None requested, game has High) | **Strong penalty** (safety net — should have been hard-filtered) |

**Inferred path (K2):** Fires when a young child's age is given but no explicit language request was made. Softer weights:

| Distance | Weight |
|---|---|
| Exact match | **Small bonus** |
| Distance 1 | **Mild penalty** |
| Distance 2 | **Moderate penalty** |

---

### L. Interaction Intensity

A 1–5 numeric scale for *how* aggressively players affect each other. More granular than the 4-level `interaction` field. Scored from the `social_temperature` dial.

| Condition | Weight |
|---|---|
| Intensity within preferred range | **Small bonus** |
| Outside range by 1 | **Small penalty** |
| Outside range by 2+ | **Moderate penalty** |

---

### M. Strong Signal Amplifier

When the user expresses **extreme intolerance** ("I absolutely hate dice", "no luck whatsoever"), the IntentInterpreter marks those dials as `strong_signal_dials`. The Scorer then **doubles** any dials-tier penalties for those dimensions.

| Amplifiable Dials |
|---|
| `chaos` (doubles luck distance penalties) |
| `approachability` (doubles rules_complexity distance penalties) |
| `strategic_ceiling` (doubles decision_complexity distance penalties) |
| `social_temperature` (doubles interaction distance penalties) |

Only **dials-tier penalties** are doubled — not explicit-tier (which already have their own weights) and not inferred-tier.

> *Example:* User says "I absolutely hate dice — zero luck." `chaos` is flagged as strong signal. A game with Medium luck factor would normally take the standard dials-tier penalty for that distance. With the amplifier, that penalty doubles.

---

### Text Matching (Cross-Cutting)

The Scorer scans the game's text fields against the user's original phrases. The text corpus searched includes the game's **verdict, summary, pros, cons, and Mood Tags** (a dedicated field of comma-separated mood and visual style phrases, e.g. "dark and gritty, medieval atmosphere, immersive lore"). This means atmospheric or visual-style keywords from the user's prompt — "dark", "gritty", "cozy", "atmospheric" — match against specifically curated mood descriptions, not just whatever happens to appear in the summary.

Keywords are classified into four categories:

#### Logistics Keywords
Practical concerns: "quick setup", "small table", "low downtime", "portable".

| Found in | Weight |
|---|---|
| Pros field | **Moderate bonus** |
| Cons with negative context (e.g. "long setup" in cons) | **Moderate penalty** |

Anchor-based matching: "easy setup" anchors to "setup" — so "minimal setup time", "fast to set up" etc. all match.

#### Group Fit Keywords
Social suitability signals: "family friendly", "gateway", "newcomers", "easy to learn", "casual", "non-gamers".

| Found in | Weight |
|---|---|
| Pros or Summary | **Moderate bonus** |
| Cons | **Moderate penalty** |

#### Aesthetics Keywords
Visual/production quality signals: "beautiful", "artwork", "miniatures", "table presence", "components".

| Found in | Weight |
|---|---|
| Pros or Summary | **Mild bonus** |
| Cons with negative context (e.g. "cheap components") | **Mild penalty** |

#### Experience Keywords (theme, vibe, atmosphere)
Everything else — thematic and experiential phrases: "pirate theme", "horror atmosphere", "political intrigue", "colonial".

| Found in | Weight |
|---|---|
| Summary + Pros (verbatim) | **High bonus** |
| Summary + Pros (longest token fallback for multi-word phrases) | **High bonus** |

**Token fallback:** If "colonial exploration" doesn't match verbatim, the Scorer tries the longest meaningful token ("colonial", 8 chars). Stopwords and quality adjectives ("amazing", "compelling", "engaging") are blocked from this fallback to prevent false positives.

#### Negative Text Penalty (theme avoidance)

When the user expresses **strong aversion to a theme or concept** that isn't a filterable mechanic or category — "I hate demonic themes", "nothing too dark or violent" — the IntentInterpreter extracts these into `negative_text_phrases`. The Scorer penalizes games whose text fields contain those terms.

| Found in | Weight |
|---|---|
| Any game text (verdict, summary, pros, cons) | **Moderate penalty per phrase** |

This is a soft penalty, not a hard filter. A game with "demonic" in its summary still appears if every other signal strongly favors it — but it gets pushed down relative to thematically clean alternatives. Multiple matching phrases stack.

---

## 4. Global Modifiers

### Semantic Floor Cap

If the query contains **semantic signals** (theme, vibe, mechanic, category preferences) but a candidate game matched **none of them**, the game is capped to prevent it from appearing in results on logistics merits alone.

| Condition | Effect |
|---|---|
| Explicit semantic signals present, but no semantic match | **Low cap** — near-elimination |
| Only inferred/dial/unmapped signals, but no semantic match | **Moderate cap** — significant score limit |
| No semantic signals at all (pure logistics query) | **No cap** |

> *Example:* User asks for "a fantasy dungeon crawler for 4 players, under 2 hours." A chess-like abstract game that fits 4 players and runs 90 minutes would otherwise score decently on player count and playtime. The semantic floor cap prevents it from appearing — it has zero semantic relevance to "fantasy dungeon crawler."

---

## 5. Tiebreaker Logic

When two candidates have the same final score, ties are broken by **six criteria in order**:

| Priority | Criterion | Rationale |
|---|---|---|
| 1 | **Score (desc)** | Higher score wins |
| 2 | **Source: inventory first** | Vault games (the seller's physical collection) get display priority on ties — they represent real purchase opportunities |
| 3 | **Weighted scoring breadth (desc)** | More dimensions matched = more holistically relevant. Tone/Format are weighted higher than other dimensions, reflecting their importance to experiential fit |
| 4 | **Data completeness (desc)** | Games with more taxonomy fields populated are more reliably scored — they've had more scoring dimensions available |
| 5 | **Tiebreaker field (desc)** | Composite Airtable score combining popularity + availability. Surfaces better-known and more accessible games before obscure ones at equal relevance |
| 6 | **Alphabetical (asc)** | Stable, deterministic, zero-bias final fallback |

---

## 6. Result Selection

After sorting, the Scorer selects the final display list from the ranked candidates:

- **Maximum 6 results total**
- **Maximum 2 Vault (inventory) results**
- **Vault quality gate:** Vault items must meet a minimum quality threshold relative to the top result's score. A Vault item cannot appear if it's being rescued from a low score by its inventory status alone.
- **Deduplication:** If the same game title appears in both databases, the Vault version wins.

### Diversity Cap

To prevent clustering — e.g. most results being 18xx train games when the user asked for "economic games" — the Scorer applies a **Family diversity cap** during result selection:

| Condition | Cap Applied |
|---|---|
| No explicit Family or Format in query | Cap by **`game.family`** — a per-family limit on result slots |
| Explicit Family requested, no explicit Format | Cap by **`game.format[0]`** — family intentionally requested, introduce format variety instead |
| Both explicit Family AND explicit Format requested | **No cap** — user fully specified both dimensions, honour their intent |

**Binary fallback:** If the active cap reduces the result list below the target, the cap is dropped entirely and the top results are returned uncapped. No partial degradation — either the cap works cleanly or it lifts.

**"Explicit" defined:** Only signals from the explicit tier of the search contract count. Inferred or dial-derived family/format signals do **not** lift the cap.

---

## 7. End-to-End Example

**Query:** *"We're 4 adults, mixed experience. Want something fun and chill tonight — not too long, maybe 90 minutes. No luck-heavy games. We loved Wingspan."*

### What the pipeline extracts

**Dials fired:**
- `social_temperature: low` (chill → ideal: Indirect/No Interaction, low intensity)
- `friction: high` (not too long → short-session preference, max ~120 min)
- `chaos: low` (no luck-heavy → ideal: None luck factor)
- `approachability: medium` (mixed experience → ideal: Medium rules complexity)

**Explicit:** Players = 4. Playtime = max 120 min.

**Anchor game:** Wingspan → role: `anchor_include` → Wingspan's data inferred:
- Mechanics: Card Drafting, Engine Building, Set Collection (Tier 3 inferred)
- Tone: Thinky (Tier 3 inferred)
- Format: Strategic Build (Tier 3 inferred)

**Text match phrases:** "fun", "chill", "tonight" → "chill" maps to explicit tone: Relaxed

---

### Scoring: Azul (candidate)

*Note: The values below are approximations to illustrate the direction and relative magnitude of each signal, not calibrated weights.*

| Section | Signal | Game Value | Outcome |
|---|---|---|---|
| Mechanics | Inferred: Engine Building | Not present | No bonus |
| Mechanics | Inferred: Card Drafting | Not present | No bonus |
| Tone (explicit) | Relaxed | Thinky | Distance 2 → strong penalty |
| Tone (dials) | ideal: Relaxed | Thinky | Distance 2 → strong penalty |
| Tone (inferred) | Thinky (from Wingspan) | Thinky | Exact → moderate bonus |
| Format (inferred) | Strategic Build (from Wingspan) | Puzzle/Optimization | Distance 1 → mild penalty |
| Interaction (dials) | ideal: Indirect | Indirect | Exact → moderate bonus |
| Luck (dials) | ideal: None | None | Exact → moderate bonus |
| Rules Complexity | ideal: Medium | Light | Distance 1 → mild penalty (reduced weight — fallback data) |
| Players | max=4 | max=4, rec=2 | Accommodates → high bonus |
| Playtime | short-session preference | midpoint ~30 min | Very close → small bonus |
| Tone/Format multiplier | Inferred tone exact, inferred format distance 1 | | Small reduction applied |

**Result: Moderate positive score** — logistics and partial feel match overcome tone mismatches.

---

### Scoring: Ticket to Ride (same query)

*Note: Approximations for illustration.*

| Section | Signal | Game Value | Outcome |
|---|---|---|---|
| Tone (explicit) | Relaxed | Competitive | Distance 3 → max penalty |
| Tone (dials) | ideal: Relaxed | Competitive | Distance 3 → max penalty |
| Tone (inferred) | Thinky (Wingspan) | Competitive | Distance 1 → mild penalty |
| Interaction (dials) | ideal: Indirect | Indirect | Exact → moderate bonus |
| Luck (dials) | ideal: None | Low | Distance 1 → small penalty |
| Players | max=4 | supports 4 | Accommodates → high bonus |
| Playtime | short-session preference | midpoint ~45 min | Close → small bonus |
| Tone/Format multiplier | Tone far on all three tiers | | Near-elimination multiplier applied |

**Result: Near-zero score** — the tone mismatch cascades through the multiplier and effectively eliminates the game despite fitting the logistics.

The contrast illustrates the system's core design: tone and format define experiential identity. A game can fit your group size and session length perfectly and still be the wrong recommendation. The multiplier ensures that logistical fit alone doesn't override experiential fit.

---

*Scorer v5.8 / ConstantsProvider v9.5*
