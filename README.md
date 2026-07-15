# 👁️ Observational Memory

> A cross-agent, self-improving memory system that **watches** your coding
> sessions, **summarizes** them into structured knowledge, and **retrieves** the
> right slice of that knowledge back into your next prompt — continuously sharpened
> by [**live human feedback**](#7--live-human-feedback-reranking-the-standout-feature).

Observational Memory captures what happens across *all* your coding agents (Claude
Code, GitHub Copilot, OpenCode, Mastracode), distills it into a three-tier memory
hierarchy, and serves it back through a hybrid retrieval pipeline. What sets it
apart from a vanilla "embed-and-search" memory is its **Live Human-Feedback
Reranking** loop: when a human reorders retrieval results to reflect what was
actually useful, the system *learns* from that judgment and reranks future,
similar queries accordingly.

> 📖 **Documentation:** [Memory Pipeline docs](https://ritwik-ga-ghosh-agent-agnostic-observational-memory.pages.bmw.ghe.com/release-notes/) —
> a deep-dive into ingestion, working memory, live context retrieval, and ranking,
> built as an extension of the [Coding Documentation](https://fwornle.github.io/coding/).

---

## 🚀 Quick Start

Observational Memory ships as part of the **Coding** AI development toolkit. Install
the toolkit, launch any supported agent, and observations begin streaming
automatically — no per-agent configuration required.

```bash
# Install the system (safe - prompts before any system changes)
./install.sh

# Start Claude Code with all features (observations capture automatically)
coding

# Or use a specific agent — every agent generates observations
coding --claude
coding --copilot
coding --opencode
coding --mastra

# Clean start (kills all orphaned processes, frees ports)
coding --force

# Query the local LLM from the command line (Docker Model Runner)
llm "Explain this error message"
cat file.js | llm "Review this code"
```

Once a session is running, browse the captured memory in the dashboard:

- **Observation Viewer** — `http://localhost:3032/observations` (filter by agent/project, search, compact view)
- **Insights** — `http://localhost:3032/insights` (project-root multi-select to scope consolidation)
- **Live Context** — `http://localhost:3032` → **Live Context** tab (live memory preview as you type)

### 🐳 Docker Deployment

The coding stack runs in Docker — there is no native fallback. Docker services start
automatically when you launch an agent.

```bash
# Start Claude or CoPilot — Docker services start automatically
coding --claude
coding --copilot
```

**Benefits**: Persistent MCP servers, shared browser automation across sessions,
isolated database containers, no duplicate containers when switching agents.

The Docker stack runs 4 containers (`coding-services`, **Qdrant**, **Memgraph**,
**Redis**) with 10 internal services managed by supervisord, using ~1.75 GB memory
total. The only host-side service is the **LLM CLI Proxy** (port `12435`), which
bridges to host-local CLI tools like Claude Code and GitHub Copilot for zero-cost
observation summarization.

> **Why this matters for Observational Memory:** the **Qdrant** container hosts the
> five 384-dimensional vector collections (`insights`, `digests`, `kg_entities`,
> `observations`, `human_rerank_feedback`) described in [§5.2](#52--qdrant--the-vector-store),
> while the host **Observations API** (`localhost:12436`) exclusively owns the SQLite
> runtime store ([§5.1](#51--sqlite--the-single-owner-runtime-store)). The
> `.observations` directory is intentionally **not** bind-mounted into the container
> to avoid SQLite-on-Docker WAL corruption.

**MCP Configuration**: `claude-mcp-launcher.sh` wires the stdio-proxy → SSE bridge so
the agent talks to the containerized MCP servers. All agents are wrapped in tmux
sessions via the shared `scripts/tmux-session-wrapper.sh`, which is also the
**requirement** for the Live Context preview ([§8](#8-retrieval-tuning-controls--slider--exponential-toggle))
to read the input draft from the pane.

### 🛡️ Installation Safety

The installer follows a **non-intrusive policy** — it will NEVER modify system tools
without explicit consent:

- **Confirmation prompts** before installing any system packages (Node.js, Python, jq)
- **Skip options**: `y` (approve), `N` (skip), `skip-all` (skip all system changes)
- **Shell config backup** with timestamped files before any modifications
- **Syntax verification** after shell config changes

Observation summarization routes through the unified LLM layer with
**subscription-first** zero-cost routing (Claude Code → GitHub Copilot → Groq →
Anthropic → OpenAI), so all observation, digest, and insight generation runs at **$0**
via existing subscriptions, with automatic fallback when a quota is exhausted.

---

## 📖 Table of Contents

- [🚀 Quick Start](#-quick-start)
  - [🐳 Docker Deployment](#-docker-deployment)
  - [🛡️ Installation Safety](#️-installation-safety)
1. [What Makes It Different](#1-what-makes-it-different)
2. [The Three-Tier Memory Hierarchy](#2-the-three-tier-memory-hierarchy)
3. [Creation Pipeline — How Memories Are Born](#3-creation-pipeline--how-memories-are-born)
4. [Consolidation — From Observations to Knowledge](#4-consolidation--from-observations-to-knowledge)
5. [Storage Mechanism — Where Everything Lives](#5-storage-mechanism--where-everything-lives)
6. [Retrieval Pipeline — The Read Path](#6-retrieval-pipeline--the-read-path)
7. [★ Live Human-Feedback Reranking](#7--live-human-feedback-reranking-the-standout-feature)
8. [Retrieval Tuning Controls — Slider & Exponential Toggle](#8-retrieval-tuning-controls--slider--exponential-toggle)
9. [Configuration & Tuning](#9-configuration--tuning)
10. [Future Optimization — Supervised Embedder Fine-Tuning](#10-future-optimization--supervised-embedder-fine-tuning)
11. [API Quick Reference](#11-api-quick-reference)
12. [Glossary](#12-glossary)

---

## 1. ✨ What Makes It Different

Most "AI memory" systems are a single loop: embed text → store vectors → cosine
search → inject top-k. That works until the embedding model's notion of
"similar" diverges from what a human actually finds *useful*. Cosine similarity
of the `all-MiniLM-L6-v2` model clusters in a narrow `0.75–0.82` band for any two
documents from the same project, so raw vector similarity alone cannot reliably
discriminate *relevance*.

Observational Memory addresses this with three structural advantages:

| Capability | Vanilla memory | Observational Memory |
|------------|----------------|----------------------|
| **Knowledge shape** | Flat chunks | 3-tier hierarchy: Observations → Digests → Insights |
| **Retrieval** | Single vector search | Hybrid: semantic **+** keyword (FTS5) **+** recency, fused with RRF |
| **Ranking signals** | Cosine only | Tier weight, agent profile, context, topic overlap, freshness, query↔item emphasis |
| **Human in the loop** | None | **Live drag-to-reorder feedback** becomes a learned, decaying rerank boost |
| **Truth maintenance** | Stale silently | Insights are re-verified against live code; stale claims demoted |

The headline differentiator is [**#7 — Live Human-Feedback Reranking**](#7--live-human-feedback-reranking-the-standout-feature). Everything
else is the well-engineered substrate that makes that loop safe, bounded, and
fail-open.

---

## 2. 🏛️ The Three-Tier Memory Hierarchy

Inspired by Mastra's Observer/Reflector model and adapted for cross-agent project
knowledge, memory is organized into three tiers of increasing abstraction and
persistence.

| Tier | What it is | Trigger | Typical volume |
|------|-----------|---------|----------------|
| **Observations** | Per-exchange structured summary (Intent / Approach / Artifacts / Result) | Real-time, per prompt-set | ~30 / day |
| **Digests** | Daily thematic work-session summaries | End of day (cron or manual) | ~7 / day |
| **Insights** | Persistent, structured project knowledge articles | Weekly, or ≥ 5 new digests | ~10 total |

[![Three-Tier Memory Hierarchy](docs/images/memory-tier-hierarchy.png)](docs/images/memory-tier-hierarchy.png)

Each tier is queryable independently and all four contribute to retrieval, but
with different **tier weights** (insights count most; raw observations least) —
see [§6](#6-retrieval-pipeline--the-read-path).

---

## 3. 🌱 Creation Pipeline — How Memories Are Born

Observations are created automatically as you work. The **Enhanced Transcript
Monitor (ETM)** watches each agent's transcript; when a prompt-set (a completed
user + assistant exchange) finishes, it fires an observation — **fire-and-forget**,
so it never blocks your session.

[![Observation Creation Pipeline](docs/images/observation-creation-pipeline.png)](docs/images/observation-creation-pipeline.png)

### 🔢 Step-by-step

1. **Exchange completed** — the ETM detects a finished prompt-set.
2. **Fire-and-forget over HTTP** — `ObservationApiClient.processMessages()` POSTs
   to the host obs-api on `localhost:12436`. It is never awaited and never blocks
   live logging.
3. **LLM summarization** — inside obs-api, `ObservationWriter` calls the LLM proxy
   to produce a structured **Intent / Approach / Artifacts / Result** summary.
4. **Sanitization** — `_sanitizeSummary()` strips unfilled template placeholders
   (e.g. `[what the developer…]`) and LLM self-correction artifacts (duplicate
   `Intent:` blocks).
5. **Serialized write** — `_serializedWrite()` holds a promise-chain lock so
   concurrent fire-and-forget calls cannot race past the dedup check (TOCTOU
   prevention). Only the dedup-check + DB-write is serialized; LLM calls run
   concurrently.
6. **Dedup check** — multi-layer (see below).
7. **Storage** — written to SQLite with metadata (agent, project, LLM
   model/provider, token counts).
8. **JSON export** — debounced (~10 s coalesce) export to
   `.data/observation-export/observations.json`.

### 🧹 Deduplication concepts

Observations are deduplicated *before* storage at several levels:

| Layer | Mechanism | Threshold |
|-------|-----------|-----------|
| **Content hash** | MD5 of `sessionId \| userContent \| assistantContent` | Exact match → reject |
| **Semantic dedup** | Stemmed keyword similarity over a 4-hour sliding window (last 50 obs/agent). Synonymous verbs canonicalized (`debug/diagnose/investigate → debug`), stop words stripped | Jaccard > 0.4 **or** containment > 0.7 |
| **Trivial filter** | Drops "trivial exchange" / "no actionable content" | Substring match |
| **Sanitization** | Discards unfilled-placeholder or self-corrected LLM output | Pattern match |

---

## 4. 🔮 Consolidation — From Observations to Knowledge

Consolidation runs **in-process inside the obs-api server** (it already owns the
SQLite handle, so there is no second writer and no WAL race). It produces the two
higher tiers.

[![Consolidation Pipeline](docs/images/consolidation-pipeline.png)](docs/images/consolidation-pipeline.png)

### 📰 Digests (Tier 2)
- **Trigger:** end of day (daemon at 02:00), manual run, or dashboard
  "Consolidate" button. The daemon skips *today* (still being written); manual
  triggers can include today via `includeToday: true`.
- **Project-aware:** observations carry a `project` column, so a session touching
  two projects yields two digests (no cross-project blending).

### 💡 Insights (Tier 3)
- **Trigger:** when ≥ 5 unsynthesized digests exist.
- **Output:** self-contained reference articles (not changelogs), optimized for
  context-priming injection.
- **Confidence:** starts ~0.8–0.95, decays −0.05 per week of inactivity, floor 0.3.

### ✅ Truthfulness & freshness verification

Insights age — a renamed file or moved route makes the prose silently rot. The
verifier extracts every backticked code claim (paths, `funcName()`, env vars,
`GET /api/…` routes, `@scoped/pkg`) and checks each against the live codebase
(repo + submodules + sibling `_work/*` checkouts), re-running on a 7-day cadence.

`verificationRatio = verifiedClaims / totalClaims` is bucketed into bands that
directly affect retrieval:

| Band | Ratio | Retrieval consequence |
|------|-------|------------------------|
| **FRESH** | ≥ 0.70 | Full retrieval weight |
| **PARTIAL** | 0.50 – 0.70 | `rrfScore *= 0.3 + 0.7 × ratio` (insight tier) |
| **STALE** | < 0.50 | Heavily demoted + one-shot confidence penalty (up to −0.20, floor 0.30) |

---

## 5. 🗄️ Storage Mechanism — Where Everything Lives

Observational Memory uses **three coordinated stores**: SQLite for structured
records, Qdrant for vector search, and git-tracked JSON for portability.

[![Storage Architecture](docs/images/storage-architecture.png)](docs/images/storage-architecture.png)

### 5.1 🗃️ SQLite — the single-owner runtime store

The runtime DB (`.observations/observations.db`) has **exactly one owner**: the
host **Observations API server** (`scripts/observations-api-server.mjs`, port
`12436`). Every other consumer — the transcript monitor, the dashboard inside the
container, the consolidator, the retrieval pipeline — reaches the DB *only*
through this HTTP service. The `.observations` directory is **not** bind-mounted
into the container.

This eliminates the classic SQLite-on-Docker-Desktop corruption pattern (host
writer + container reader losing WAL/SHM coherence across the bind-mount). It runs
in **WAL mode** with `busy_timeout=5000ms`; the in-process writer, consolidator,
and retrieval connections coexist safely because they share the same SQLite shared
memory. One writer, everyone else over HTTP.

#### 📋 Table schemas

```sql
CREATE TABLE observations (
  id TEXT PRIMARY KEY,
  summary TEXT,            -- Intent / Approach / Artifacts / Result
  messages TEXT,           -- JSON array of original messages
  agent TEXT,              -- claude, copilot, opencode, mastra
  session_id TEXT,
  source_file TEXT,
  created_at TEXT,         -- ISO 8601
  metadata TEXT,           -- JSON: project, llmModel, llmProvider, llmTokens
  content_hash TEXT,       -- MD5 for dedup
  quality TEXT,            -- high, normal, low
  digested_at TEXT         -- set when consolidated into a digest
);

CREATE TABLE digests (
  id TEXT PRIMARY KEY,
  date TEXT NOT NULL,            -- YYYY-MM-DD
  theme TEXT NOT NULL,
  summary TEXT NOT NULL,        -- consolidated narrative
  observation_ids TEXT NOT NULL,-- JSON array of source observation IDs
  agents TEXT,                  -- JSON array
  files_touched TEXT,           -- JSON array
  quality TEXT DEFAULT 'normal',
  created_at TEXT NOT NULL,
  metadata TEXT
);

CREATE TABLE insights (
  id TEXT PRIMARY KEY,
  topic TEXT NOT NULL,
  summary TEXT NOT NULL,        -- living knowledge document
  confidence REAL DEFAULT 0.8,  -- decays -0.05/week, floor 0.3
  digest_ids TEXT NOT NULL,     -- JSON array of source digest IDs
  last_updated TEXT NOT NULL,
  created_at TEXT NOT NULL,
  metadata TEXT                 -- JSON: incl. codeVerification.verificationRatio
);
```

Observations additionally have an **FTS5** virtual table powering full-text
keyword search; digests and insights use `LIKE` fallback.

### 5.2 🔷 Qdrant — the vector store

Five collections, each **384-dimensional Cosine** (matching `all-MiniLM-L6-v2`):

| Collection | Purpose |
|------------|---------|
| `insights` | Insight embeddings (semantic search, tier weight 1.5) |
| `digests` | Digest embeddings (tier weight 1.2) |
| `kg_entities` | Knowledge-graph entity embeddings (tier weight 1.0) |
| `observations` | Observation embeddings (tier weight 0.8) |
| `human_rerank_feedback` | **One point per human rerank event** — powers [§7](#7--live-human-feedback-reranking-the-standout-feature) |

### 5.3 📤 Git-tracked JSON export

Mirroring the UKB knowledge-export pattern, the system exports human-readable,
diff-friendly JSON to `.data/observation-export/` for cross-machine portability
and backup:

| File | Content |
|------|---------|
| `observations.json` | Summaries + metadata (excludes raw `messages`) |
| `digests.json` | Daily thematic digests |
| `insights.json` | Persistent insights + confidence |
| `metadata.json` | Export timestamp + counts |

Triggers: after each write (debounced 10 s, observations only), and a full
`exportAll()` after each consolidation run.

---

## 6. 🔍 Retrieval Pipeline — The Read Path

When an agent submits a prompt, the retrieval pipeline assembles a token-budgeted
slice of memory to prime its context. Retrieval is **hybrid** (semantic + keyword
+ recency) and **fused** with Reciprocal Rank Fusion, then refined by a sequence
of reranking passes before the final token-budgeted markdown is built.

### 6.1 🧩 Core concepts

| Concept | What it is |
|---------|-----------|
| **Embeddings** | `all-MiniLM-L6-v2`, 384-dim, cosine. Query embedded once (`embedOne`), ~20 ms warm. |
| **Semantic search** | Qdrant search across the 4 content collections in parallel, ≤ 20 hits each, `score_threshold` (default 0.70 via settings). |
| **Keyword search** | SQLite **FTS5 MATCH** for observations, `LIKE` for digests/insights — catches exact terms embeddings miss. |
| **Recency** | Exponential decay, 14-day half-life: `score = 0.5 ^ (ageDays / 14)`. |
| **RRF** | Reciprocal Rank Fusion: each list contributes `1 / (k + rank + 1)`, `k = 60`. Rank-based, so it is robust to incomparable raw scores. |
| **Tier weights** | After fusion: insights ×1.5, digests ×1.2, kg_entities ×1.0, observations ×0.8. |
| **Agent profiles** | Optional per-agent tier multipliers (a second pass on top of tier weights). |
| **Working memory** | A small always-on prefix (VKB team, project STATE) built per-query. |
| **Token budget** | `gpt-tokenizer` counts tokens; per-tier reserved slots + caps guarantee a blend (insights first, observations last). |

### 6.2 🔗 The pipeline, stage by stage

[![Retrieval Pipeline](docs/images/retrieval-pipeline.png)](docs/images/retrieval-pipeline.png)

Each pass mutates an `rrfScore` on the fused candidates:

- **4.5 Context boost** — multiplicative: project match ×1.15 (or ×0.5 for a
  *different* labelled project), cwd path-segment match ×1.10, recent-file
  basename match ×1.20.
- **4.6 Topic-relevance demotion** — because MiniLM cosines cluster at 0.75–0.82
  within a project, keyword overlap between query and a result's topic/theme is
  used as a discriminating proxy to demote off-topic hits.
- **4.7 Freshness rerank** — for the `insights` tier only, multiply `rrfScore` by
  `0.3 + 0.7 × verificationRatio` so a fully-fresh insight is untouched and a
  fully-stale one drops to 0.3× (never fully filtered).
- **4.75 Query↔Item emphasis** *(optional, user-tunable)* — RRF is rank-based and
  discards the raw cosine, so when enabled this multiplies each semantic-origin
  item's score by `clamp(cosine, 0, 1) ^ exponent`. Keyword/recency-only items
  (no true cosine) are left untouched.
- **4.8 Learned rerank** — the human-feedback boost; see [§7](#7--live-human-feedback-reranking-the-standout-feature).

Finally, candidates are re-sorted, the token-budgeted markdown is assembled
(reserving slots per tier so insights/digests actually reach the agent rather than
being crowded out by high-volume observations), and the working-memory prefix is
prepended. Items actually emitted are flagged `usedInObservational` for dashboard
provenance pills.

---

## 7. ⭐ Live Human-Feedback Reranking (the standout feature)

This is the capability that elevates Observational Memory above a vanilla
retrieval pipeline. **A human can reorder retrieval results to reflect what was
actually useful, and the system learns from that judgment** — applying a bounded,
decaying, confidence-weighted boost to similar future queries.

It implements the approved design *"Feedback Loop Design: Human Re-Ranking as a
Learned Path-A Boost"*. Two phases: **capture** and **apply**.

[![Live Human-Feedback Reranking — Capture & Apply](docs/images/learned-rerank-capture-apply.png)](docs/images/learned-rerank-capture-apply.png)

### 7.1 📸 Capture — turning a reorder into a learning signal

When a human reorders results in the dashboard live-context view, the client
sends the query plus the before/after ordering to `POST /api/rerank-feedback`.
The obs-api:

1. Embeds the **query text** (must be 384-dim).
2. Builds one `itemSignals` entry per item, capturing its stable `itemKey`
   (`tier:id`), `originalRank`, the human-chosen `humanRank`, and the
   `rankDelta = originalRank − humanRank`.
3. **Upserts a single Qdrant point** into `human_rerank_feedback` — vector = the
   query embedding, payload = the item signals plus scope context (`project`,
   `agent`, `cwd`, `sessionId`, `userHash`, `capturedAt`, `schemaVersion`).

One human save = one compact, query-keyed event. A `GET /api/rerank-feedback`
endpoint provides an audit view (vectors omitted).

### 7.2 🚀 Apply — the learned boost at query time

On the next retrieval, `_applyLearnedRerank` (Step 4.8) consults the feedback
store. `FeedbackStore.findSimilar` searches `human_rerank_feedback` for events
whose stored **query embedding** is cosine-similar to the current query
(default threshold 0.85), **project-scoped first**, with an optional reduced-weight
global fallback only when project matches are sparse.

Matched events are aggregated by the **pure, deterministic, time-injectable**
`aggregateLearnedSignals()` (no I/O — unit-testable without Qdrant):

```text
similarityWeight = exponentialEnabled ? clamp(score, 0, 1) ^ exponent : score
ageWeight        = 0.5 ^ (ageDays / HALF_LIFE_DAYS)        // default half-life 45 days
eventWeight      = similarityWeight × ageWeight × scopeWeight × userWeight
deltaNorm        = clamp((originalRank − humanRank) / max(windowSize − 1, 1), −1, 1)
weightedDelta    = Σ(deltaNorm × eventWeight) / max(Σ eventWeight, ε)
confidence       = min(1, Σ|eventWeight| / CONFIDENCE_DIVISOR)   // divisor default 1.5
learnedSignal    = clamp(weightedDelta × confidence, −1, 1)
multiplier       = clamp(1 + COEFFICIENT × learnedSignal, MIN, MAX)  // 0.30, [0.90, 1.25]
```

The multiplier is applied as `item.rrfScore *= multiplier` — but **only** to items
already present in the fused candidate list (missing-candidate recall is
deliberately out of scope). Each boosted item carries a `learnedRerank`
`{ multiplier, signal, matchedEvents }` object for explainability, surfaced as a
dashboard pill.

### 7.3 🚪 The two gates that decide how much a reorder counts

Not every past reorder should influence the current query equally. A reorder you
made for *"why does the docker build time out"* should strongly shape a near-identical
future query, but should barely touch *"how does RRF fusion work"*. Two gates,
applied in sequence inside `aggregateLearnedSignals()`, enforce exactly that.

**Gate 1 — the similarity admission gate (hard cutoff).**
`FeedbackStore.findSimilar` only returns feedback events whose stored query
embedding has cosine similarity **≥ the `queryQuery` threshold** (default `0.85`)
to the current query, via Qdrant's `score_threshold`. Anything below the floor is
never even considered — a binary in/out decision. This keeps unrelated past
opinions out of the picture entirely.

**Gate 2 — the exponential emphasis gate (soft reshape).**
Admission is not enough, because the admitted band (`0.85 → 1.00`) still mixes
"basically the same question" with "loosely related". MiniLM cosine scores are
compressed: a *near-duplicate* query might score `0.97` while a *merely related*
one scores `0.86`, only `0.11` apart. A linear weight (`weight = similarity`)
would treat those almost identically. The exponential reshape

```text
similarityWeight = clamp(similarity, 0, 1) ^ k        // k = queryQuery exponent, default 3
```

**stretches** that compressed band so small similarity differences become large
weight differences — letting the system make a *fine-grained* selection among
very-similar queries.

![Exponential gate: similarity weight vs. query↔query cosine similarity for several exponents](docs/images/learned-rerank-exponential-curve.png)

Reading the plot (x = query↔query cosine similarity, y = the weight that feedback
event receives):

- **`k = 1` (linear, exponential OFF)** — weight equals raw cosine. At the `0.85`
  floor an admitted event still carries `0.85` weight, so a barely-related past
  query counts almost as much as a perfect match. Coarse.
- **`k = 3` (default)** — the curve bows downward: `0.86` collapses to
  `0.86³ ≈ 0.64`, while `0.97` stays high at `0.97³ ≈ 0.91`. The gap between
  "related" and "near-duplicate" widens from `0.11` to `~0.27`.
- **`k = 5` / `k = 8`** — progressively sharper. At `k = 8`, `0.86⁸ ≈ 0.30` is
  heavily suppressed while `0.99⁸ ≈ 0.92` survives — only near-identical queries
  retain meaningful weight.

**Why this matters for fine-grained selection.** Within the narrow, high-similarity
band that survives Gate 1, the *ordering* of influence is what determines whether
the boost reflects the *right* prior judgment. The exponential turns a flat,
indiscriminate band into a steep ramp, so the event from the query that truly
matches dominates the events from queries that merely overlap. Raising `k`
(via the dashboard, see [§8](#8-retrieval-tuning-controls--slider--exponential-toggle))
tightens this to near-duplicate-only; lowering it broadens generalization.

The same two-gate idea is reused on the read path as **Query↔Item** emphasis
(Step 4.75): Gate 1 is the `queryItem` admission threshold (which *items* are
retrieved), Gate 2 is `cosine^k` applied to each item's score (how steeply
near-duplicate *items* are emphasized).

### 7.4 🧪 Worked example — from a drag to a boost

Suppose last week you searched **"docker build times out on coding-services"** and
dragged the insight *"ETM Docker Build Timeout Hardening"* from rank 5 up to rank 1,
out of 8 shown results. That created one feedback event. Today a teammate asks
**"docker-compose build hangs for coding-services"** — cosine similarity to your
stored query is `0.95`. With defaults (`k = 3`, half-life `45 d`, coefficient
`0.30`, confidence divisor `1.5`), and the event captured `10` days ago:

```text
similarityWeight = 0.95 ^ 3                     = 0.857     (Gate 2 reshape)
ageWeight        = 0.5 ^ (10 / 45)              = 0.857     (45-day decay)
eventWeight      = 0.857 × 0.857 × 1.0 × 1.0    = 0.735     (scope/user weight = 1.0)
deltaNorm        = (5 − 1) / (8 − 1)            = 0.571     (promoted 4 ranks of 7)
weightedDelta    = (0.571 × 0.735) / 0.735      = 0.571     (single event)
confidence       = min(1, 0.735 / 1.5)          = 0.490     (one event ⇒ modest)
learnedSignal    = clamp(0.571 × 0.490, −1, 1)  = 0.280
multiplier       = clamp(1 + 0.30 × 0.280, 0.90, 1.25) = 1.084
```

The insight's `rrfScore` is boosted **≈ 8.4 %** — enough to lift it a rank or two,
not enough to override a strongly off-topic result. Now contrast the gates and the
loop's self-reinforcement:

| Scenario | Effect on multiplier |
|----------|----------------------|
| Similarity only `0.86` (just above floor), `k = 3` | `0.86³ = 0.64` weight → `confidence ≈ 0.36` → multiplier `≈ 1.062` (smaller) |
| Same `0.86` but exponential **OFF** (linear) | weight `0.86` → larger, indiscriminate boost — the coarse behavior the exponential prevents |
| **Five** teammates agree (5 similar events) | `Σ|eventWeight|` grows → `confidence → 1.0` → multiplier approaches the `1.25` cap |
| Event is now `90` days old | `ageWeight = 0.5^(90/45) = 0.25` → boost shrinks ~4× as the opinion ages out |

This is the crux of the feature: **a single human drag becomes a small, principled,
decaying nudge; repeated human agreement on similar queries compounds into a strong,
bounded boost** — and the exponential gate guarantees that compounding only happens
for the queries that genuinely match.

### 7.5 🛡️ Why this is safe — design guarantees

| Guarantee | How |
|-----------|-----|
| **Fail-open** | Any Qdrant error, missing collection, or zero matches → `[]` and a no-op multiplier of 1.0. Learned rerank can never degrade baseline retrieval. |
| **Bounded** | Multiplier hard-clamped to `[0.90, 1.25]` — always weaker than context/topic signals, so feedback nudges rather than dominates. |
| **Decaying** | Exponential 45-day half-life: stale opinions fade automatically. |
| **Confidence-weighted** | A single weak event barely moves the score; agreement across many strong, recent, similar events is required for a full boost. |
| **Query-similarity-gated** | The optional `score^exponent` reshape concentrates influence on near-duplicate queries; loosely-similar past queries contribute little. |
| **Scoped** | Project-scoped by default; global fallback is off unless explicitly enabled and runs at higher threshold + reduced weight. |
| **Explainable** | `learnedRerank` metadata records exactly why an item was boosted. |

### 7.6 🔄 The self-improving loop

[![The Self-Improving Loop](docs/images/self-improving-loop.png)](docs/images/self-improving-loop.png)

Over time, the system's ranking converges toward **human-validated usefulness**
for the queries that matter most — something pure embedding similarity cannot do.

---

## 8. 🎛️ Retrieval Tuning Controls — Slider & Exponential Toggle

The dashboard exposes the two similarity stages as live, draggable controls in the
**Retrieval Tuning** panel (`RetrievalTuningPanel.tsx`). These are not per-session
toys — they write to the same `.observations/retrieval-settings.json` that the
production retrieval path reads, so **whatever you set here is the single source of
truth** for both the UserPromptSubmit knowledge-injection hook and the dashboard's
live preview.

[![Retrieval Tuning Controls](docs/images/retrieval-tuning-controls.png)](docs/images/retrieval-tuning-controls.png)

### 8.1 🎚️ The two control groups

| Group | Governs | Stage in pipeline | Default |
|-------|---------|-------------------|---------|
| **Query ↔ Query** | How strongly a *past human-ranked query* influences the current ranking (the learned-rerank feedback gate) | Step 4.8 ([§7](#7--live-human-feedback-reranking-the-standout-feature)) | threshold `0.85`, exponential **on**, `k = 3.0` |
| **Query ↔ Item** | Which *memory items* are admitted for the current query, and how steeply their similarity is emphasized | Steps 2 + 4.75 ([§6](#6-retrieval-pipeline--the-read-path)) | threshold `0.70`, exponential **off**, `k = 3.0` |

### 8.2 🔩 The three knobs in each group

Each group has the same three controls:

| Control | UI | Range / step | Effect on retrieval |
|---------|-----|--------------|---------------------|
| **Threshold** | Slider | `0.50 – 0.99`, step `0.01` | The cosine **admission floor** (Gate 1). Raise it → fewer, stricter matches (precision ↑, recall ↓). Lower it → more, looser matches (recall ↑, noise ↑). For Query↔Item this is Qdrant's `score_threshold`; for Query↔Query it is the feedback-event admission floor. |
| **Exponential** | Switch | on / off | Turns Gate 2 on/off. **On** → `weight = similarity^k` (near-matches emphasized, far-matches suppressed). **Off** → linear/raw cosine (rank-based only for Query↔Item; flat weighting for Query↔Query). |
| **Exponent (k)** | Slider | `1.0 – 8.0`, step `0.5` | Sharpness of the falloff (disabled, shown `—`, when the switch is off). Higher `k` → only near-duplicate queries/items keep weight (see the curve in [§7.3](#73-the-two-gates-that-decide-how-much-a-reorder-counts)); lower `k` → broader generalization. |

### 8.3 📡 How a change propagates

1. You drag a slider or flip a switch → local state updates **optimistically**
   (instant UI feedback).
2. The change is **debounced 400 ms** so dragging doesn't spam the server, then
   `PUT /api/retrieval-settings` persists it.
3. The server **validates and clamps** to bounds (threshold `[0.5, 0.99]`,
   exponent `[1.0, 8.0]`), writes atomically (tmp file + rename), and returns the
   stored value.
4. The dashboard's `onSaved` callback **re-runs the live preview**, so you
   immediately see how the new settings reorder a real query's results.
5. The very next agent prompt picks up the same file (mtime-cached, fail-open to
   defaults on any read error) — no restart required.

### 8.4 🍳 Practical tuning recipes

| Goal | Adjustment |
|------|-----------|
| Feedback is over-generalizing to loosely-related queries | **Query↔Query:** raise threshold toward `0.90` and/or raise `k` to `5–8` |
| Feedback barely affects anything | **Query↔Query:** lower threshold toward `0.80`, keep exponential on at `k ≈ 3` |
| Too few memories retrieved | **Query↔Item:** lower threshold toward `0.60` |
| Retrieved items feel off-topic | **Query↔Item:** turn exponential **on**, `k ≈ 3` to emphasize true near-duplicates |

---

## 9. ⚙️ Configuration & Tuning

### 9.1 📐 Retrieval settings (`.observations/retrieval-settings.json`)

A single JSON file is the **single source of truth** read by `retrieve()`, so the
UserPromptSubmit hook and the dashboard live preview honor identical values. It
exposes two similarity stages, each with `threshold`, `exponentialEnabled`, and
`exponent` — surfaced as the controls in [§8](#8-retrieval-tuning-controls--slider--exponential-toggle):

| Stage | Controls | Default threshold | Default exponential |
|-------|----------|-------------------|---------------------|
| `queryQuery` | Learned-rerank gate (query↔query similarity) | 0.85 | enabled, exponent 3.0 |
| `queryItem` | Semantic admission + emphasis (query↔item similarity) | 0.70 | disabled, exponent 3.0 |

Bounds: threshold `[0.5, 0.99]`, exponent `[1.0, 8.0]`. Reads/writes are
fail-open (defaults on error) and atomic (tmp file + rename).

### 9.2 🌿 Learned-rerank env overrides

All tuning constants are env-overridable, so the loop can be tuned without code
changes:

| Env var | Default | Meaning |
|---------|---------|---------|
| `LEARNED_RERANK_THRESHOLD` | 0.85 | Cosine floor for a feedback event to apply |
| `LEARNED_RERANK_TOPK` | 10 | Max feedback events fetched per query |
| `LEARNED_RERANK_HALF_LIFE_DAYS` | 45 | Age decay half-life |
| `LEARNED_RERANK_COEFFICIENT` | 0.30 | Boost coefficient |
| `LEARNED_RERANK_MIN_MULTIPLIER` / `MAX_MULTIPLIER` | 0.90 / 1.25 | Hard multiplier bounds |
| `LEARNED_RERANK_CONFIDENCE_DIVISOR` | 1.5 | Confidence normalizer |
| `LEARNED_RERANK_GLOBAL` | off | Enable reduced-weight cross-project fallback |

### 9.3 🖊️ Observation creation (`.observations/config.json`)

Per-agent LLM model selection and token limits, e.g. default
`anthropic/claude-haiku-4-5`. Summarization routes through the LLM CLI proxy
(`localhost:12435`) with automatic provider fallback (claude-code → copilot →
groq → paid APIs), priority configured in `config/llm-providers.yaml`.

---

## 10. 🔭 Future Optimization — Supervised Embedder Fine-Tuning

Everything in [§6](#6-retrieval-pipeline--the-read-path) and
[§7](#7--live-human-feedback-reranking-the-standout-feature) improves ranking
*after* the embedder has spoken — RRF, tier weights, context, freshness, and the
learned rerank all operate on top of a **frozen** `all-MiniLM-L6-v2`. That model
was trained on generic web text, which is exactly why its cosine scores cluster in
a narrow `0.75–0.82` band for any two documents in the same project: it has no
notion of *this* codebase's relevance. The reranking layers compensate, but they
cannot recover signal the embedding never encoded.

The next leap is to **move relevance into the embedding space itself** by
fine-tuning the embedder on *our own* supervised "good" examples — and we already
collect them. Every saved rerank event in `human_rerank_feedback` is a labeled
judgment: for query `q`, item `A` (promoted) is *more* relevant than item `B`
(demoted). That is precisely the supervision signal contrastive sentence-embedding
training consumes.

[![Supervised Embedder Fine-Tuning](docs/images/embedder-finetuning-pipeline.png)](docs/images/embedder-finetuning-pipeline.png)

### 10.1 🎯 Where the supervised pairs come from

| Source | Positive (relevant) | Negative (less relevant) |
|--------|---------------------|--------------------------|
| **Rerank feedback** (strongest) | Item a human dragged **up** (`humanRank < originalRank`) | Item a human dragged **down**, or one ranked below it |
| **Used-in-Observational provenance** | Items flagged `usedInObservational` for a query | Retrieved-but-dropped items for the same query |
| **Consolidation links** | Observations cited by a digest / digests cited by an insight | Same-window items not cited |

These yield `(anchor query, positive item, negative item)` **triplets** — the
canonical input for `MultipleNegativesRankingLoss` or `TripletLoss` in
`sentence-transformers`.

### 10.2 🤝 Why this complements (not replaces) the rerank loop

| Aspect | Learned rerank (today) | Fine-tuned embedder (proposed) |
|--------|------------------------|--------------------------------|
| **Where it acts** | Post-hoc, on the fused candidate list | At the source — the cosine scores themselves |
| **Recall of new items** | None (only re-orders already-retrieved items) | **Yes** — a better embedder *surfaces* items the old one missed |
| **Latency** | A single extra Qdrant lookup per query | Zero at query time (cost is offline training + one re-embed) |
| **Failure mode** | Fail-open no-op | Needs versioning + offline eval gate before promotion |
| **Data reuse** | Consumes feedback events | Consumes the *same* feedback events as training labels |

The learned rerank is the fast, safe, online loop; embedder fine-tuning is the
slower, offline loop that **bakes the accumulated human judgment into the model**
so future queries start from a sharper similarity space — after which the rerank
layer has less work to do and operates on cleaner candidates.

### 10.3 🚧 Practical guardrails

- **Cold-start threshold** — only fine-tune once enough distinct feedback triplets
  exist (e.g. a few hundred), otherwise the model overfits a handful of queries.
- **Hard-negative mining** — negatives should be *plausible* (retrieved but
  demoted), not random; random negatives teach the model nothing new.
- **Versioned, gated rollout** — train → evaluate nDCG/MRR against a held-out slice
  of feedback → promote only on improvement; keep the previous embedder for rollback.
- **Re-embed on promotion** — dimensions stay 384 (drop-in for the existing Qdrant
  collections), but all vectors must be regenerated with the new model so query and
  stored embeddings live in the same space.
- **Keep it fail-open** — the retrieval pipeline must run unchanged on the frozen
  baseline if a fine-tuned model is unavailable.

---

## 11. 📡 API Quick Reference

All endpoints are served by the host obs-api (`localhost:12436`) and mirrored by
the dashboard (`localhost:3033`) as thin HTTP forwarders.

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/retrieve` | POST | Hybrid retrieval for a query (returns markdown + ranked results + meta) |
| `/api/rerank-feedback` | POST | **Capture a human-reordered result list** → one `human_rerank_feedback` event |
| `/api/rerank-feedback?limit=N` | GET | Audit recent rerank events (vectors omitted) |
| `/api/observations` | GET | Paginated observations (agent/date/project/quality/FTS filters) |
| `/api/observations/messages` | POST | (host only) Summarize + dedup + insert a message chunk |
| `/api/digests` | GET | Paginated digests |
| `/api/insights` | GET | All insights (topic/text filter) |
| `/api/projects/:project/coverage` | GET | Per-project truthfulness + coverage summary |
| `/api/consolidation/status` | GET | Counts: total/undigested/pending, digests, insights |
| `/api/consolidation/run` | POST | Trigger consolidation (optional `{ date }`) |

---

## 12. 📖 Glossary

| Term | Definition |
|------|-----------|
| **Observation** | Tier-1 per-exchange structured summary (Intent/Approach/Artifacts/Result). |
| **Digest** | Tier-2 daily thematic summary grouping related observations. |
| **Insight** | Tier-3 persistent, structured knowledge article with a confidence score. |
| **obs-api** | The single-owner host server (port 12436) that exclusively owns the SQLite DB. |
| **RRF** | Reciprocal Rank Fusion — combines ranked lists via `1/(k+rank+1)`. |
| **Tier weight** | Post-fusion multiplier reflecting a tier's trustworthiness (insights highest). |
| **Recency score** | Exponential time decay (14-day half-life) used as a third fusion list. |
| **Working memory** | Always-on context prefix (team/project state) prepended to retrieval output. |
| **Freshness band** | FRESH/PARTIAL/STALE classification of an insight by code-claim verification ratio. |
| **Learned rerank** | The bounded, decaying boost derived from human re-ranking feedback. |
| **Admission gate (Gate 1)** | The cosine threshold below which a query/item is excluded entirely (hard cutoff). |
| **Exponential gate (Gate 2)** | The `similarity^k` reshape that emphasizes near-duplicates over loosely-similar matches (soft). |
| **Exponent (k)** | Sharpness of the exponential gate (1.0–8.0); higher = steeper falloff, near-duplicate-only. |
| **Query↔Query** | Similarity between the current query and a past human-ranked query (drives learned rerank). |
| **Query↔Item** | Similarity between the query and a memory item (drives semantic admission + emphasis). |
| **`human_rerank_feedback`** | Qdrant collection storing one query-keyed event per human reorder. |
| **itemSignals** | Per-item `originalRank`/`humanRank`/`rankDelta` records inside a feedback event. |
| **learnedSignal** | Confidence-weighted, clamped rank-delta that drives the rerank multiplier. |
| **Triplet** | `(anchor query, positive item, negative item)` training example mined from feedback for embedder fine-tuning. |
| **Fail-open** | Design principle: any failure degrades to current behavior, never worse. |

---

### 🔗 Related documentation

For dashboard screenshots and an image-rich walkthrough, see
[`docs-content/core-systems/observational-memory.md`](docs-content/core-systems/observational-memory.md).
