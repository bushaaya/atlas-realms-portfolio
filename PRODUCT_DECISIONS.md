# Product Decisions: Atlas Realms

**Author:** Asher "Ashi" Atlas  
**Type:** Product Case Study  
**Status:** Live in Open Beta (March 2026)

---

## What This Document Is

This is a record of how Atlas Realms was shaped by real decisions — what I assumed, how I tested those assumptions, what broke, what I learned, and how each learning changed the product. It's not a technical deep-dive (that lives elsewhere). It's the story of the product thinking.

---

## Why This Project Existed

In late 2025, I made a deliberate decision to build a real AI product rather than study how to build one. The goal was explicit: learn how to make real product decisions around AI — when to use LLM vs. deterministic code, how consistency behaves in production, how to calibrate trust between the user and the system — by actually shipping something.

I didn't set out to build a venture-scale business. I set out to build something real and sustainable, at learning-stage scale, where the decisions had actual consequences.

Two things made that bet rational rather than naive:

**The domain was already validated.** I had five years of running a board game resale business — 800+ confirmed sales, hundreds of customer conversations, 3,000+ titles catalogued. I wasn't guessing that people struggle to choose the right game. I had been solving that problem manually, personally, for years. The question wasn't "does demand exist?" It was "can a well-designed AI-powered product serve it at scale without me in the loop?"

**The economics were designed to be sustainable from the start.** My success criterion wasn't growth — it was break-even at small scale. One affiliate commission should cover many searches. One Vault sale should cover a month of infrastructure. These constraints were designed deliberately, because a project meant to generate learning shouldn't also require a betting mentality about revenue. If it never scales beyond a few hundred users, the unit economics still work and the learning is real.

This context shapes how I think about the open questions in this document. I'm not waiting on revenue validation to know whether the project succeeded. I already know what I've learned. The remaining uncertainty is about whether Atlas Realms works well enough, and for enough people, to become something larger than a sophisticated learning project.

---

## The Problem I Was Actually Solving

### Five Years of Domain Expertise Before the First Line of Code

I've been running a board game resale side business for five years. Over that time I've catalogued 3,000+ titles, made thousands of pricing decisions, and handled hundreds of customer conversations. The pattern I kept seeing: people don't struggle to find games. They struggle to decide which game is right for a specific situation.

The question is almost never "is this a good game?" It's almost always: "will this work for us, tonight, with this group?"

That framing turns out to matter a lot.

### Why Filters and Browse Experiences Fail

Most board game discovery tools assume the user knows what they want and just needs help narrowing it down. They give you sliders for player count, dropdowns for complexity, lists of mechanics. These work for people who already have the vocabulary. They fail for the majority, who think in experiences, not categories.

Someone who wants a game for "my two reluctant in-laws, one competitive nephew, and my partner who hates conflict" doesn't know what mechanics to filter for. They know how the evening is supposed to feel.

### The Insight I Kept Circling Until Users Forced Me to Name It

When I started building Atlas Realms, I framed it as a recommendation engine that lets you talk like a human. I thought that was the insight. I was wrong — or at least, I was only half right.

The deeper insight came from watching real people use it.

The results were often technically correct and still felt wrong. People got recommendations that matched their stated constraints but would clearly have created a bad night. And when I dug into why, I kept running into the same thing: I was solving a personal preference problem. The real problem is social negotiation.

**Board games are not consumed privately. They're consumed as a group.**

You're not asking "what will I like?" You're asking "what won't ruin game night for this group?" The constraints are social — group patience, mixed experience levels, the one person who can't handle confrontational games, the two players who secretly want to compete. Classic recommendation systems predict taste. They struggle with language, trade-offs, and social context.

Once I reframed the product as a social situation matcher rather than a recommendation engine, everything I'd been seeing in testing suddenly made sense: why one socially wrong result eroded trust even when the other five were fine, why structured prompts felt incomplete, why users described their group more than their preferences.

This reframe didn't just name the product correctly. It made the V2 architecture *necessary*.

A system built to predict personal preferences can work with a single, tightly-constrained LLM that maps user vocabulary to database fields. A system meant to decode social situations cannot. Social context arrives in language that's fuzzy, contextual, and full of implications — "my two reluctant in-laws, a competitive nephew, and my partner who hates conflict" doesn't map to any field in any database. It requires a node that can *reason* about what that situation demands before any mapping happens at all.

That's the architectural consequence of the social context insight. Not "we need a smarter LLM." But "we need to separate understanding from mapping" — because a node that can reason about social dynamics and a node that maps to database fields are doing fundamentally different jobs and need to be built that way. The V2 engine, now at v2.5, exists because of that insight.

---

## Building V1: The Assumptions I Started With

### What I Built

Version 1 had a scoring script and a single LLM node. The LLM's job was to extract intent from user input and map it to the fields my database understood. The scoring script took that output and ranked games against it.

On the UX side, I built "guidance pills" as structured inputs — dropdowns for player count, play time, group type. The idea was to help users structure their prompts and give the system cleaner input.

### How I Tested It

My initial testing was built on prompts I created myself, plus prompts I asked LLMs to generate. Some were simple, some were designed to probe edge cases. The results looked solid. The scoring felt calibrated. I felt confident.

### Why That Confidence Was Wrong

Structured test prompts produce structured responses. Structured responses play to a system's strengths. I had unknowingly designed a testing methodology that hid the problem I was about to discover.

The guidance pills made it worse. When users filled in a player count dropdown and a complexity slider, they produced clean, mappable input. But they also produced input that was stripped of the most important thing: the real, ambiguous, human context that makes board game selection genuinely hard.

I didn't know this until I put the product in front of real people.

---

## What Real Users Showed Me

### The LLM Wasn't Reasoning — It Was Only Mapping

My single LLM node (what I now call The Taxonomist) had a very specific job: take user input and map it to my database enumerations. I had constrained it tightly to stay within my schema. Those constraints were exactly right for the mapping job. They were completely wrong for understanding human intent.

When real users gave real prompts — vague, contextual, experience-focused — the node had no mechanism to understand what they actually meant. It could map structured vocabulary. It couldn't reason about fuzzy intent. The result was recommendations that were technically matching some constraint the user had mentioned, but missing the point of the whole query.

One test confirmed this starkly: after a usability test, I explained to a user that my goal was for the system to compete with vanilla LLMs at understanding group context. That reframe completely changed how he interacted with it. He started typing the way he'd actually describe a game night situation — vague, human, unstructured. My engine broke. The results were embarrassing.

That user hadn't done anything wrong. He'd given the system what it should have been able to handle. The system wasn't ready for it.

### The Architecture Consequence

I needed to separate two jobs that I had bundled into one LLM node:

1. **Understand what the user wants** — a reasoning task that requires board game domain knowledge and comfort with fuzzy human language.
2. **Map that understanding to database fields** — a translation task that requires precision and should not involve reasoning.

I added a new node at the top of the pipeline: the IntentInterpreter. This node has no access to my database schema. It doesn't know about my field enumerations. Its only job is to understand the user's intent in human terms — what kind of experience they're looking for, what they want to avoid, how they've described their group — and articulate that clearly enough for the mapping layer to act on. Unlike the Taxonomist, this node is allowed to reason.

The long-term thinking: if this system scales, the IntentInterpreter's behavior becomes a training dataset. I'm already building the output format with that in mind.

### The Decision I Almost Made Too Early

At this point, I had a full V2 pipeline designed on paper: the IntentInterpreter, a deterministic resolver, and a stripped-down Taxonomist, each with a clear and non-overlapping job. I was about to build it.

Then I stopped.

My usability data told me that in 7 formal tests, only 2 users had used prompts my system genuinely couldn't handle — and one of those only happened after I explicitly challenged him. The majority used prompts that, as I kept refining the scoring and enriching the database, my existing system handled reasonably well.

The question was: does this architectural change serve the users I have now, or the users I project having at scale?

I chose to delay. I shipped incremental improvements, added analytics to track real prompt patterns, and used the data to decide when V2 was actually necessary. The architecture was designed to accommodate the upgrade cleanly when the time came. I didn't want to build for a problem I hadn't confirmed existed at scale.

This is one of the better product decisions I made. The V2 build ultimately did happen — and it was justified — but doing it on a timeline driven by user data rather than engineering ambition meant I wasn't premature about it.

---

## The Vault: Over-Indexing for Trust

### The Setup

Atlas Realms has two things: a recommendation engine and a curated used game collection (The Vault) from my own inventory. I sell the Vault items. I had a potential conflict of interest to manage.

My first instinct was to emphasize trust above all else, especially for a new platform with no established credibility. So I built the results page to separate general recommendations from Vault items — two distinct sections, different visual treatment, different copy, clearly labeled.

I thought this was the principled choice.

### What Users Actually Did

Six users across two testing rounds. All six scrolled through the first three results and stopped. The Vault section went completely unnoticed. When I asked if they had seen a second set of results, every single one said no — and then, without prompting, explained that they had expected the Vault items to be mixed into the recommendations. Having inventory results separated felt strange. Not unethical, just... unexpected.

The words one user used: "I thought those would just be included. Like sponsored results."

This landed differently than I expected. I had over-indexed for a trust problem that users weren't experiencing. I had created an unusual UX to solve a concern they weren't bringing to the interaction. The separation wasn't protecting trust — it was just making the experience confusing.

### The Fix and What It Revealed

I overhauled the results page to present all results together, ranked by match quality, with clear labels indicating whether a game is a recommendation or available from the Vault. Two more tests in, users weren't troubled by seeing Vault items in the results. They were, if anything, intrigued.

The broader lesson: trust is built through consistent, high-quality results — not through structural separation that users have to interpret. The right signal is "this recommendation is correct and clearly explained," not "this section is labeled differently to show I care about fairness."

There is such a thing as over-engineering for trust. Especially at the expense of normal, expected behavior.

---

## Tag Quality: When Less Is More

### The Assumption

When enriching my game database, my instinct was completeness. I wanted every game to have as many accurate tags as possible — every mechanic, every category, every nuance captured. More data should mean better matching.

### What Users Showed Me

Results were technically correct and still incomplete-feeling. Users would get recommendations that matched their stated constraints but didn't feel like the games really fit. When I traced why, the enrichment approach was part of the problem.

By tagging every facet of every game, I had flattened the signal. A game with 12 relevant mechanics and 8 relevant categories would score points across all of them — but none would score strongly enough to create clear differentiation. Everything looked like a partial match. Nothing looked like a strong match.

The insight: what makes a game what it is isn't the exhaustive list of things it contains. It's a small number of things it does better than anything else. Those are the signals that matter for matching.

I've begun refining the enrichment approach to focus on defining what makes each game shine rather than cataloguing everything it contains. I'm also planning a survey of board game players to understand which dimensions — mechanics, theme, interaction style, luck factor — they actually use when choosing games, so I can make sure my scoring reflects how humans actually think about fit rather than how databases store information.

---

## The Sommelier Insight: Building the Context Engine, Then Forgetting the Context Experience

### The Second Application of the Same Insight

After the social situation matcher reframe, I thought I'd applied the insight. The algorithm understood the room. The results were smarter.

A friend tested the beta. My Kallax was visible behind me — 50 games, colorful covers, eyes wandering before he knew anything about the games. "The results feel flat," he said. "It should feel like you're walking me through your collection. Not like a search engine."

He was right.

The algorithm understood context. The interface still presented results like a ranked list — small thumbnails, text-heavy cards, scores and badges. A search engine wearing a recommendation engine's hat.

I had applied the social context insight to the backend. I hadn't applied it to the frontend.

Choosing a board game is a visual, social experience. You browse. Cover art catches your eye before you read a word. The way a knowledgeable friend recommends a game is not "here are six results ordered by match score." It's "I think you should try this one — here's why — and if that doesn't appeal, here are some alternatives."

### The Redesign Decision

We're redesigning around a sommelier metaphor: one featured recommendation with a large cover image and a clear explanation, followed by five supporting options. No score badges. No fit tier labels. The position in the layout implies rank without making it explicit. A game detail modal for deep exploration. The experience should feel like someone who knows the collection is walking you through it.

The same insight — social context matters — applied twice, with two different implementations.

---

## How Inputs Became a Product Problem

### Pills as Dropdowns

My original guidance pills were structured inputs: a player count dropdown, a play time selector, a group description field. The assumption was that helping users fill in the fields would produce better input, and better input would produce better results.

The assumption was technically correct and experientially wrong. Users who used the pills produced clean, mappable prompts — and sterile ones. The richest signals — tone, group dynamics, social context — didn't fit anywhere in the dropdown structure. The pills were capturing logistics while users were trying to communicate situations.

### A Different Philosophy

The redesign started from a different principle: people don't struggle with typing. They struggle with knowing what to think about.

The new guidance pills are thinking prompts, not input collectors. A pill shows a question ("Which games have been a hit with your group? What did you like about them?") that sparks reflection. The user responds in their own words. The question disappears once they start typing. There's no second input field. The pill's job is to get people out of "I don't know how to start" and into natural language — which is exactly what the IntentInterpreter is built to handle.

I'm currently A/B testing three variants of this approach — pure muse questions, vibe cards that generate a baseline prompt to edit, and a guided step-by-step flow — to understand which works best for different user types.

---

## The Affiliate Link Problem

A less glamorous product decision that real usage forced.

Game availability is volatile. Even the most popular games go out of stock regularly. Linking directly to specific product pages results in 404 errors — a dead CTA at the moment users are most likely to act.

I moved affiliate links to search results pages rather than specific listings. For out-of-print or hard-to-find games, I added eBay as an alternative. It's not ideal — a search results page creates more friction than a direct product page — but a live link that works is better than a precise link that doesn't.

This is a genuinely unsolved problem. The right solution depends on having reliable stock signal for ~1,100 games across multiple retailers in near-real time. That's infrastructure I don't have. The workaround is functional. I've accepted it as a known limitation.

---

## Who the Users Actually Are

Beta testing clarified something I had hypothesized but not confirmed.

**Mid-tier board game enthusiasts** are the natural Ask Atlas users. They own 20-100 games, have an established group, and know enough about board games to care about fit — but aren't so deep in the hobby that they have strong independent opinions about every title. They want help deciding.

**Heavy hobbyists** — the kind of people who know the BGG top 100 and have opinions about COIN games and 18xx — are more interested in The Vault. They come with specific games in mind. They want access to trusted used-game inventory from someone who knows the hobby, not recommendations they could have formed themselves.

This split was the hypothesis. Beta confirmed it. The implications are real: the two user types have different trust signals, different content needs, and different success metrics. As the product matures, the UX for each will likely diverge.

---

## Who I Was Actually Building For

### The Original Assumption

My original user model had three personas: the Considered Buyer (20–100 games, researches before buying), the Collector (200+ games, hunting rare titles), and the Newcomer (1–10 games, just discovering the hobby). I positioned Collectors as secondary Ask Atlas users — they know the most about games, but they still face the matching problem for their groups.

That assumption was wrong.

### What Beta Revealed

During beta testing, a clear pattern emerged. Mid-tier enthusiasts — people who take board games seriously but don't deep-dive on every title — were the natural Ask Atlas users. They have opinions, they know some games by name, they care about fit for their group. But they don't have strong independent views on every recommendation, which means they're open to being guided.

Heavy hobbyists and collectors are different. They come to Atlas Realms with specific games in mind. They've done the research. They aren't looking for recommendations they couldn't have formed themselves. What they want is access to trusted used inventory — which is exactly what The Vault is. A collector browsing the Vault is there to acquire, not to discover.

The error in my original model: I assumed collectors still have the matching problem. They don't. They solved it themselves. The matching problem belongs to the people who care enough about games to want the right one but not enough to have researched it already.

### Why This Mattered

Clarifying the real target user changed the GTM sequencing and the product priorities. The engine I was building — social situation matching, group context, fuzzy language understanding — is most valuable to someone who knows enough to describe what they want but needs help mapping that to the right game. That's not the collector. That's exactly the mid-tier enthusiast.

It also anchored the RICE prioritization session that followed. Every Reach estimate in the backlog was made against this explicit GTM audience: "casual gamers, families, mid-tier players." Not the heavy hobbyists who would self-serve, and not the newcomers who might need a different product entirely.

---

## Structured Prioritization: RICE in Practice

### Why Formal Prioritization Became Necessary

Once the V2 architecture was live, the GTM audience was clear, and beta testing had surfaced a long list of engine gaps, I had a real prioritization problem. Dozens of bugs and improvements, all legitimate, all competing for attention. Without a framework, the tendency is to fix whatever feels most painful — which usually means the most recent complaint, not the highest-leverage fix.

I ran a formal RICE scoring session across the backlog.

### The Collaborative Model

RICE has four components: Reach, Impact, Confidence, Effort. Two of them are product judgment calls. Two are technical estimation calls.

I handled Reach and Impact. These require knowing the user, knowing the query patterns I was seeing in testing, and knowing which failure modes actually break trust vs. which ones users work around naturally. Claude Code handled the initial Confidence and Effort estimates, drawing on its knowledge of the codebase — how many files a change touches, what regression risk exists, where existing infrastructure handles part of the problem. Then I pushed back, challenged the estimates, and we landed on final scores together.

The division of responsibility was deliberate. Reach and Impact are not things an engineering partner can estimate without knowing the user. Confidence and Effort are not things I can estimate accurately without deep knowledge of the codebase. The collaboration respected that split.

### What the Scoring Revealed

A few specific decisions that came out of the RICE session illustrate the discipline:

**E-04 (Semantic Floor Cap) scored 199 — the second-highest priority.** When a user asks for a "cooperative game for a relaxed evening" and gets results that rank highly on player count and playtime alone — zero mechanic or theme match — the damage is immediate and visible. Reach 85 (affects most searches), Impact 9 (the most trust-damaging failure mode), Confidence 78, Effort 3. The score was high enough that it was implemented with an extension (BUG-V2) bundled in.

**R7 (Playtime Floor) scored 160 despite Reach of only 25.** This was the case where a user's "3-hour session" allowed 30-minute filler games to surface. The Reach is genuinely low — most long-session queries also include experience or complexity signals that implicitly narrow the short end. But Effort was 1 (trivial, a few lines in the Merger), which made the RICE score competitive. When a small fix solves a trust-breaking problem for the cases it covers, it earns its place even if those cases aren't frequent. That's the framework working correctly.

**E-05 (Blurb Overhaul) scored 117 with Reach 100 and Impact 9 — but Confidence only 65.** Every result card across every search. The primary trust signal for users who don't already know the games. On raw potential it's the highest-priority item in the backlog. But Creative work is harder to estimate than deterministic fixes, and the blurbs' full impact is gated behind a UI redesign that will surface them more prominently. The honest Confidence score — acknowledging that getting tone right requires iteration — kept the score realistic. And the note in the backlog made the dependency explicit: don't implement until the UI can surface what the improved blurbs deliver.

**E-08 (Age → Language Dependence inference) scored only 108 despite Confidence 90.** The problem is real: specifying young children's ages doesn't automatically infer a language independence preference. But Impact scored 4 because a workaround exists — users who see a text-heavy result for their 6-year-old can revise their prompt to add "language independent." The problem feels painful, but there's a natural recovery path. Inflating Impact because the problem seems important would have mis-prioritized it against fixes with no workaround.

**D005-T3 (Knizia unlock, Rules/Decision complexity split) scored 33 — low, but correctly low.** It's blocked by enrichment work that needs to happen first, and it touches six pipeline files with meaningful regression risk. The score reflects the real state of the dependency and the implementation complexity. It didn't get scored up because the outcome would be meaningful. It scored what it scored.

### What the Process Enforced

Committing estimates to writing changed how each number was arrived at. Reach requires a real estimate, not a vibe — which means naming the specific user behavior being counted and being honest about how common it actually is. Impact requires admitting when a workaround exists, even when the problem feels important. Confidence requires naming the specific source of uncertainty rather than assuming things will work out.

One item — E-07 (comparison anchor silent failure) — scored 22 as a standalone fix. That score meant it didn't earn its own implementation slot. It got bundled into E-01 as a one-line addition within existing scope. A RICE score of 22 is the framework telling you that something is real but not worth the cost of its own context switch.

The discipline that makes RICE honest rather than theatrical: not working backward from a priority to justify a score. Every item scored what it scored based on what I actually knew about the users and the codebase. When the score was surprising — when something with Reach 25 beat something with Reach 65 — that was the framework working, not an error to correct.

---

## What I'm Still Testing

### The Input Problem

The pills A/B test is running. I don't know yet which variant produces the richest prompts, whether prompt quality correlates with result satisfaction, or whether users who use the pills at all produce meaningfully different output than users who type freely. These are live experiments.

### The North Star

I have a defined north star metric — Qualified Searches: sessions where the user submits a meaningful query, receives results, and engages with at least one result (expands a card, clicks a CTA, or gives feedback). This is a leading indicator for both revenue streams and a measure of the core value proposition: discovery that produces consideration.

I have analytics in place to measure it. I'm in open beta and not yet driving meaningful traffic, so the metric is defined and tracked but not yet representative. The goal of the current phase is to get enough volume to make it meaningful.

### The Biggest Open Question

The one I'm least confident in: whether the recommendation quality creates enough pull that users follow through to a purchase action — or whether they use Ask Atlas as a research step and buy elsewhere.

The economics were designed to break even at small scale, not to grow at scale. One Vault sale covers a month of infrastructure. One affiliate commission covers many searches. At low volume, this works. The open question is whether the product creates purchase intent, or only informs it.

I believe the social context angle is the differentiator here: a recommendation you trust because it accounted for your specific group, not just your preferences, should convert better than a generic recommendation. But that belief is still a hypothesis. Confirming it requires traffic, and building that traffic is the current focus.

It shapes where I invest attention: result quality and explainability (makes the recommendation trustworthy enough to act on) ahead of conversion rate optimization (which only matters if the trust is already there).

---

## What I Would Do Differently

**Test with real human prompts from day one.** I built a testing suite out of structured prompts and LLM-generated scenarios. They gave me false confidence. I should have recruited real users for prompt input before I had anything to show them. The way people actually describe game night situations is the product's core input — I should have been studying it from the start.

**Separate "does this work mechanically?" from "does this feel right socially?" as distinct tests.** My early testing evaluated whether the correct games surfaced. It didn't evaluate whether the results would feel right to the person who asked. Those are different questions and they require different testing methods. Mechanical correctness is measurable against a ground truth. Social fit requires watching real people react.

**Treat the UX and the algorithm as the same problem.** The sommelier redesign came from a friend pointing at my Kallax. That insight should have been obvious earlier: the algorithm understands context, the interface must convey context. The design language needs to match the product philosophy at every layer, not just the backend. I applied the social context insight to the algorithm first and the experience second, and the gap was visible in testing.

---

## The Thread That Connects Everything

The decisions that held up were the ones where I asked: am I solving the right problem for the right people, with the right level of evidence?

The decisions that needed reversing were usually the ones where I solved a problem I had assumed existed — either too early (architectural complexity before data confirmed its need), too simply (single LLM for both reasoning and mapping), or too carefully (separating Vault results to signal trust that users weren't questioning).

Every major revision came from watching real users. Not from analytics alone, not from reasoning about what users should do — from watching specific people in specific situations do unexpected things and asking why.

That's still the methodology. The product will be shaped by the next hundred users the same way it was shaped by the first seven.

---

*This document is part of the Atlas Realms public portfolio. Internal implementation details, scoring weights, and exact system parameters are documented separately.*
