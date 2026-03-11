# Multi-Model AI Enrichment Pipeline

**The problem:** You have a catalog of 1,100+ items. Each needs 15+ structured fields populated — some objective (does this game support 5 players?), some subjective (what mood does this game create?). No single model is best at all of them. And you can't afford to be wrong on the objective ones.

**The solution:** Run three models in parallel, apply field-type-weighted consensus, write only what passed.

---

## Why Three Models

Every model has distinct failure modes:

| Model | Strength | Failure Mode |
|---|---|---|
| Gemini 2.0 Flash | Native Google Search grounding — finds current data from live sources | Occasionally verbose, less conservative on edge cases |
| GPT-4o-mini | Follows structured output instructions precisely | Can be confidently wrong on obscure items, occasionally injects jargon |
| Claude Haiku | Most conservative — least likely to hallucinate a field value | Can be overly cautious, sometimes refuses ambiguous classifications |

A field that all three agree on is almost certainly correct. A field where they split is ambiguous and worth flagging rather than committing.

---

## Architecture

```
                    ┌──────────────────┐
                    │  Item Catalog    │
                    │  (Airtable)      │
                    └────────┬─────────┘
                             │  fetch unenriched batch
                             ▼
              ┌──────────────────────────────┐
              │  Web Context Acquisition     │
              │                              │
              │  Gemini: Google Search       │
              │  grounding (native)          │
              │  GPT + Claude: Serper API    │
              │  results injected as context │
              └──────────────┬───────────────┘
                             │ one Serper call shared
                             │ between GPT and Claude
                    ┌────────▼─────────┐
                    │  Parallel Calls  │
                    │  (3 models)      │
                    └────────┬─────────┘
                             │
              ┌──────────────▼───────────────┐
              │  Consensus Layer             │
              │                              │
              │  Objective fields:           │
              │  2/3 majority vote required  │
              │                              │
              │  Subjective fields:          │
              │  Single model (best fit)     │
              └──────────────┬───────────────┘
                             │
                    ┌────────▼─────────┐
                    │  Airtable Write  │
                    │  (only on pass)  │
                    └──────────────────┘
```

---

## Field-Type Weighting

Not all fields are equally objective. The consensus rule differs by field type:

**Objective fields** (binary classification, structured facts):
- Require **2/3 majority vote**
- Example: "Does this game have asymmetric factions?" — yes or no, objectively verifiable from the rulebook
- All three models provide a vote; 2/3 required to write `true`

```python
def apply_consensus(gemini_res, gpt_res, claude_res):
    """2/3 majority vote for binary fields."""
    asym_votes = [
        bool(gemini_res.get('asymmetric_factions', False)),
        bool(gpt_res.get('asymmetric_factions', False)),
        bool(claude_res.get('asymmetric_factions', False)),
    ]
    return {
        'asymmetric_factions': sum(asym_votes) >= 2,
        'asym_votes': asym_votes,
        'asym_reasoning': {
            'gemini': gemini_res.get('asymmetric_factions_reasoning', ''),
            'gpt':    gpt_res.get('asymmetric_factions_reasoning', ''),
            'claude': claude_res.get('asymmetric_factions_reasoning', ''),
        }
    }
```

**Subjective fields** (mood, atmosphere, descriptive copy):
- Assigned to the **single model best suited** to the task
- Example: "mood tags" (emotional register, atmosphere, aesthetic) → Gemini only
- Rationale: mood is a creative judgment call, not a verifiable fact. Averaging three models' creative outputs produces mediocre prose. The model with Google Search grounding can base mood on actual player reviews.

---

## Why Each Model Gets Its Role

**Gemini with Google Search grounding → mood/atmosphere fields**

Grounding connects the model to actual player language from reviews, forums, and community discussions. When asked "what does playing this game feel like?", Gemini can ground its answer in how real players actually described the experience — not just its training data. Mood tags generated this way capture authentic community vocabulary.

```python
# Gemini payload includes Google Search as a tool
payload = {
    "contents": [{"parts": [{"text": prompt}]}],
    "tools": [{"google_search": {}}],
    "generationConfig": {"temperature": 0.15, "maxOutputTokens": 600}
}
```

**GPT-4o-mini + Claude Haiku → binary classification votes**

For yes/no factual fields, raw accuracy on the definition matters more than creative language. Both models receive the same web context (one Serper API call shared between them — one less API call per item), the same precise definition of the mechanic, and produce a vote with reasoning.

Sharing the Serper call is a small but meaningful optimization: at 1,100 items, it eliminates 1,100 redundant web requests.

```python
# One Serper call, injected as context for both GPT and Claude
web_context = serper_web_search(game_title)
gpt_result   = gpt_binary_vote(game_title, existing_mechanics, existing_categories, web_context)
claude_result = claude_binary_vote(game_title, existing_mechanics, existing_categories, web_context)
```

---

## The Reasoning Log

Every consensus decision logs all three models' reasoning, not just the outcome:

```json
{
  "asymmetric_factions": true,
  "asym_votes": [true, true, false],
  "asym_reasoning": {
    "gemini": "Each faction in Root operates under fundamentally different rules — the Marquise de Cat, Eyrie Dynasties, and Woodland Alliance have entirely different action systems.",
    "gpt": "Root has asymmetric factions with different rules for each player faction, not just stat differences.",
    "claude": "The game has player powers but I'm uncertain whether the underlying action structure is sufficiently different to qualify."
  }
}
```

Claude's dissent — logged alongside the majority decision — is itself useful data. Cases where two models vote yes and one votes no are worth auditing for calibration: the dissenting reasoning sometimes reveals a genuine edge case that the definition should address.

---

## Prompt Design: Defining the Target

The most important engineering in this pipeline isn't the consensus logic — it's the mechanic definitions. Vague definitions produce disagreement at the boundary cases, which defeats the purpose of multi-model consensus.

The key design principle: **explicit counter-examples in the definition**.

```
Asymmetric Factions: Each faction has fundamentally DIFFERENT actions, win conditions,
or resource systems — not just different stats or starting positions.

Good examples: Root, Hegemony, Vast, Oath, Uprising.

NOT this mechanic: games with variable player powers where all players still use the
same underlying action system (e.g. Scythe has asymmetric starting stats but same action
structure). Asymmetric starting resources alone does not qualify.
```

The counter-example for Scythe directly addressed a case where model agreement was low in pilot runs. Adding it reduced split votes on similar games from ~30% to under 5%.

---

## Resilience Design

**Auto-resume:** The script skips items where the target field is already populated. A batch that fails halfway through can be restarted without re-processing already-completed records.

**Dry run mode:** `--dry-run` verifies API connectivity and field schema without writing anything. Required before any production run.

**Field validation before writes:** A preflight check confirms the target Airtable field exists before the first batch starts. Failing fast on a missing field prevents a run that writes nothing while appearing to succeed.

**Retry logic on API failures:** Each model call retries up to 3 times on transient errors before logging the failure and continuing to the next item. One bad API response doesn't kill the batch.

---

## Cost

| Component | Per item | 1,100 items |
|---|---|---|
| Gemini 2.0 Flash (grounding call) | ~$0.0003 | ~$0.33 |
| GPT-4o-mini (binary vote) | ~$0.0001 | ~$0.11 |
| Claude Haiku (binary vote) | ~$0.0002 | ~$0.22 |
| Serper web search (shared) | ~$0.001 | ~$1.10 |
| **Total** | **~$0.0016** | **~$1.76** |

Under $2 to enrich 1,100 records with three-model consensus across multiple fields. The Serper cost dominates — the model costs are negligible at this scale, which is a direct consequence of using smaller, optimized models (GPT-4o-mini, Claude Haiku) for the binary classification tasks rather than defaulting to flagship models. The binary vote doesn't require GPT-4o or Claude Sonnet — it requires a precise definition and a well-structured prompt. Using the right-sized model for the task is how the model costs stay negligible.

---

## Results

- **1,094 records enriched**, 2 failures (99.8% success rate)
- **Consensus rate on binary fields:** ~87% unanimous (all 3 agree), ~11% majority (2/3), ~2% logged as uncertain and reviewed manually
- **Mood tags:** Generated for all records; reviewed sample of 50 for quality — rated 8.3/10 on specificity and authenticity vs. generic alternatives

---

## What Transfers to Other Domains

This pattern applies to any catalog enrichment problem where:

1. You have structured fields that are objectively verifiable (2/3 vote)
2. You have subjective fields where creative quality matters (single best model)
3. You need an audit trail of reasoning, not just outputs
4. Cost and reliability matter more than using the most expensive model for everything

The specific models and definitions are domain-specific. The architecture — parallel calls, field-type weighting, reasoning logs, auto-resume — is not.
