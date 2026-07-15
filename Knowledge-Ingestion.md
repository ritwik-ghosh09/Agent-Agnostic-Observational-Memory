# Knowledge-Ingestion — OpenTelemetry ↔ Observational Memory Verification Plan

> Scope: verify that the memory Copilot CLI actually receives (observed via OpenTelemetry)
> is the **same** Observational / Long-term memory that the Live-Context retrieval pipeline
> aggregates, and determine the **session scope** of that data. Read-only investigation plan;
> no code changes proposed here.

---

## 0. Key terminology disambiguation (must read first)

There are **two distinct "caches"**, and conflating them is the main risk in this task:

| Term | What it actually is | Where it lives | Scope |
|------|--------------------|----------------|-------|
| **Provider prompt cache** — OTel `gen_ai.usage.cache_read.input_tokens` / `cache_creation.input_tokens` | The LLM **provider's** (Anthropic/OpenAI) prompt-prefix cache. A raw token count of how much of the request prefix was served from the provider cache vs. freshly billed. | Emitted by Copilot CLI's OTel exporter per `chat` / `invoke_agent` span. | **Ephemeral, single-session.** Keyed by `gen_ai.conversation.id` (= Copilot session id). Not persisted, not tier-labeled. |
| **Observational / Long-term Memory** | The 3-tier obs-memory store (Observations → Digests → Insights) + Working Memory, injected into the prompt as `additionalContext`. | `.observations/observations.db` (host obs-api :12436) + Qdrant. | **Cross-session, persisted.** Re-retrieved and re-injected **per prompt** by the injection hook. |

**Consequence:** OTel's `cache_read.input_tokens` is **NOT** a semantic measure of Observational Memory.
It is a provider-side byte/token accounting number with **no tier breakdown**. The Observational
Memory *content* rides inside `input_tokens` and is only recoverable from **content capture**
(`gen_ai.input.messages`) — not from the cache counters. Any aggregation "by Observational Memory"
must be reconstructed from the captured message content, then cross-checked against the retrieval
pipeline's own output, **not** read directly off the OTel cache attributes.

---

## Task 1 — Can OTel-returned cached memory be aggregated on the basis of Observational / Long-term Memory (as Live-Context aggregates it), and is it one-session or cross-session?

### 1.1 What Live-Context aggregation produces (the ground truth to compare against)

Single shared code path for BOTH the real `UserPromptSubmit` injection and the dashboard
Live-Context preview (verified earlier):

- Entry: `src/hooks/knowledge-injection-hook.js` → `callRetrieval()` → `POST /api/retrieve`
  (obs-api :12436) → `RetrievalService.retrieve(query, options)` in
  `src/retrieval/retrieval-service.js`.
- `retrieve()` returns:
  - `markdown` = `## Working Memory …` + `\n\n` + `## Observational Memory …`
    (the `## Observational Memory` heading is emitted by `assembleBudgetedMarkdown()` in
    `src/retrieval/token-budget.js`).
  - `meta.tokens_used`, `meta.working_memory_tokens` (⇒ Observational tokens = `tokens_used − working_memory_tokens`).
  - `rankedResults[]` each with `tier` (`insights|digests|kg_entities|observations`) and
    `usedInObservational` (true only for items that survived token budgeting and were emitted).
  - `includedKeys` = `${tier}:${id}` of every emitted item.
- The injection hook wraps `markdown` as `hookSpecificOutput.additionalContext`; Copilot CLI
  injects it into the turn as a **`system-reminder`** block.

**So Live-Context already gives us a tier-aggregated, token-counted, per-item manifest of the
Observational Memory for a query.** This is the reference the OTel data must be reconciled against.

### 1.2 What OTel actually exposes (per CLI command reference → OpenTelemetry monitoring)

- Enable locally: `COPILOT_OTEL_FILE_EXPORTER_PATH=~/.copilot/otel.jsonl`
  and `OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT=true` (content capture; sensitive — trusted env only).
- `invoke_agent` span (one per user message, aggregated across all turns of that message):
  `gen_ai.usage.input_tokens`, `output_tokens`, **`gen_ai.usage.cache_read.input_tokens`**,
  `gen_ai.usage.cache_creation.input_tokens`, `github.copilot.turn_count`, `gen_ai.conversation.id`.
- `chat` span (one per LLM request / turn): same usage fields, per-turn.
- **Content capture** attributes (only with the env flag):
  `gen_ai.input.messages` (full prompt messages as JSON — **this is where the injected obs-memory
  block lives**), `gen_ai.system_instructions`, `gen_ai.tool.definitions`.
- Span events for context churn: `github.copilot.session.truncation`
  (`pre_tokens/post_tokens/tokens_removed`), `github.copilot.session.compaction_complete`.

### 1.3 Findings to record (the actual answers)

- **Can it be aggregated "by Observational Memory"?**
  - **Not from the cache counters directly** — `cache_read`/`cache_creation` are untyped token
    totals with no tier or provenance labels.
  - **Yes, indirectly**, by parsing `gen_ai.input.messages`, isolating the injected
    `## Observational Memory` section (the `system-reminder` `additionalContext`), then re-deriving
    the tier aggregation by matching that content back to the retrieval pipeline's `rankedResults` /
    `includedKeys`. The tier breakdown is reconstructed from obs-memory, **not** provided by OTel.
- **One session or across sessions?**
  - **The OTel view is single-session.** Spans are scoped to one `gen_ai.conversation.id`
    (= one Copilot CLI session); the provider prompt cache (`cache_read`) is ephemeral and
    session-local — it reflects prefix reuse **within** the current session's turns, not memory
    recalled from prior sessions.
  - **The Observational Memory itself is cross-session** (persisted store, re-retrieved per prompt).
    The *same* long-term item can be injected into many different sessions; each injection shows up
    as fresh `input_tokens` in that session's OTel span (and may then become `cache_read` on the
    *next turn of the same session* once the provider caches the prefix).
  - **Therefore:** to study Observational Memory *across* sessions you must aggregate across multiple
    `invoke_agent` spans grouped by `gen_ai.conversation.id`, and correlate each against its own
    obs-memory retrieval snapshot — OTel alone cannot attribute a cached token back to a long-term
    memory item or to a prior session.

### 1.4 Steps for Task 1

1. Turn on OTel file export + content capture; run one substantive Copilot CLI prompt (tmux-wrapped
   so the injection hook + live-query monitor both fire).
2. From `otel.jsonl`, pull the `invoke_agent` span: record `input_tokens`, `cache_read.input_tokens`,
   `cache_creation.input_tokens`, `turn_count`, `conversation.id`.
3. From the **same** span's `gen_ai.input.messages`, locate the `system-reminder` message whose text
   contains `## Working Memory` / `## Observational Memory`. Extract just the `## Observational Memory`
   subsection.
4. Tokenize that subsection (same `gpt-tokenizer` the pipeline uses) → `otel_obs_tokens`.
5. Pull the matching Live-Context entry (`GET :3033/api/live-context?limit=5`) OR replay the hook
   (`echo '{"prompt":"…","transcript_path":"…"}' | node src/hooks/knowledge-injection-hook.js`) →
   record `meta.tokens_used − meta.working_memory_tokens` = `pipeline_obs_tokens`, plus the
   `rankedResults[]` where `usedInObservational === true`.
6. Compare `otel_obs_tokens` ≈ `pipeline_obs_tokens` (small delta expected from tokenizer/wrapping).
7. Note the session-scope conclusions from §1.3 in the results.

---

## Task 2 — Verify the aggregated long-term memory from OTel contains the Observational Memory Results for a specific *similar* query

Goal: prove that for a query similar to a previously-seen one, the memory Copilot actually received
(OTel content capture) **contains the same Observational Memory items** the retrieval pipeline says
it injected — including any items promoted by the Human-in-the-Loop learned rerank for *similar*
queries.

### 2.1 Method — content-match, not counter-match

Because the tier/provenance is not in OTel, verification = **set intersection of item identities**
between (a) the captured injected block and (b) the pipeline's `rankedResults[usedInObservational]`.

Item identity keys available:
- Pipeline side: `rankedResults[].{tier,id,title,snippet}` and `includedKeys` = `${tier}:${id}`.
- OTel side: the injected `## Observational Memory` markdown — each emitted item carries a stable,
  human-readable **title/heading** and body snippet (the same text `token-budget.js` wrote). Match on
  normalized title + first-N-chars of snippet (id is not embedded in the markdown, so match by text).

### 2.2 Steps for Task 2

1. **Seed a learned signal (optional but recommended):** in the dashboard Live-Context, run query Q1,
   drag-reorder results, **Save ranking** (writes one event to `human_rerank_feedback` in Qdrant).
2. **Fire the similar query Q2** (cosine-similar to Q1, e.g. reword it) through Copilot CLI with OTel
   content capture ON.
3. **Capture the injected block:** from the Q2 `invoke_agent` span, extract `gen_ai.input.messages` →
   the `system-reminder` → the `## Observational Memory` subsection → parse into an ordered list of
   `{title, snippet}` items = `otel_items`.
4. **Get the pipeline manifest for Q2:** replay the hook (or read the Live-Context entry) for the same
   enriched Q2 query → `rankedResults[usedInObservational===true]` = `pipeline_items`
   (with `tier`, `id`, `learnedRerank` metadata if the boost applied).
5. **Assert containment / equality:**
   - Every `pipeline_items[i]` appears in `otel_items` (title+snippet match) ⇒ OTel truly received the
     aggregated Observational Memory. Report any items in `pipeline_items` **missing** from `otel_items`
     (would indicate truncation by Copilot's own context management — cross-check the
     `session.truncation` span event) and any **extra** items in `otel_items` not in `pipeline_items`
     (would indicate a query-enrichment mismatch between the hook path and the monitor path).
   - Confirm ordering/promotion: if Q2 triggered `learnedRerank` (from Q1's feedback), the promoted
     item should rank at/near the top of both lists — evidence the Human-in-the-Loop boost for the
     *similar* query propagated all the way into what Copilot received.
6. **Token cross-check (secondary):** `otel_obs_tokens ≈ pipeline_obs_tokens` (from Task 1) as a
   coarse corroboration that nothing large was silently dropped.

### 2.3 Caveats / expected sources of mismatch (record these)

- **Enriched-query divergence:** the hook enriches the prompt from the **transcript**; the tmux
  live-query monitor enriches from **pane context**. Same typed prompt → possibly different enriched
  query → possibly different retrieved set. Compare the **exact enriched query string** on both sides
  before declaring a mismatch a bug.
- **Copilot-side truncation/compaction:** if the conversation is near the context limit, Copilot may
  truncate the injected block *after* the hook produced it. The `github.copilot.session.truncation` /
  `compaction_complete` span events (`pre_tokens/post_tokens/tokens_removed`) explain any shortfall.
- **Provider cache masking:** on turn ≥ 2 of a session, part of the obs-memory block may show up as
  `cache_read.input_tokens` rather than fresh `input_tokens`; this does **not** mean the memory is
  absent — the content is still present in `gen_ai.input.messages`. Verify on **content**, not counters.
- **Sensitivity:** `OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT=true` writes full prompts,
  file contents, and code to disk. Run only in a trusted local environment and delete
  `~/.copilot/otel.jsonl` afterward.

---

## Reference map (files / endpoints)

| Purpose | Location |
|---------|----------|
| Injection hook (UserPromptSubmit) | `src/hooks/knowledge-injection-hook.js` → `retrieval-client.js` |
| Shared retrieval impl | `src/retrieval/retrieval-service.js` (`retrieve()`), `token-budget.js` (`## Observational Memory`, `includedKeys`, `usedInObservational`), `working-memory.js` (`## Working Memory`) |
| obs-api endpoint | `POST http://localhost:12436/api/retrieve` (`scripts/observations-api-server.mjs`) |
| Live-Context (dashboard) | `POST /api/live-context/query`, `GET /api/live-context` (`integrations/system-health-dashboard/server.js`); retrieval forwarded to obs-api |
| Human-in-the-Loop store | Qdrant `human_rerank_feedback`; applied in `retrieve()` step 4.8 |
| OTel enable | `COPILOT_OTEL_FILE_EXPORTER_PATH`, `OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT=true` |
| OTel fields | `invoke_agent`/`chat` spans: `gen_ai.usage.input_tokens`, `cache_read.input_tokens`, `cache_creation.input_tokens`, `gen_ai.input.messages`, `gen_ai.conversation.id`; events: `session.truncation`, `session.compaction_complete` |

---

*Author: Ritwik Ghosh · Intern · EF 412*
