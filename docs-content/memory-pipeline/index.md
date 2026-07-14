# Memory Pipeline — Overview

!!! abstract "An extension of the Coding Documentation"
    This section is a focused deep-dive built **on top of** the base
    [Coding Documentation :material-book-open-variant:](https://fwornle.github.io/coding/).
    It documents the **Observational Memory + Working Memory ingestion** pipeline and the
    **Live Context Retrieval** pipeline (with its full ranking machinery) as implemented in the
    [`Agent-Agnostic-Observational-Memory`](https://bmw.ghe.com/Ritwik-GA-Ghosh/Agent-Agnostic-Observational-Memory)
    repository. For the surrounding platform (LSL, UKB/VKB, constraints, health monitoring) refer back to the
    [base project](https://fwornle.github.io/coding/).

## The two pipelines in one picture

The system has two complementary halves that share a single store:

- **Ingestion (write path)** — every completed agent exchange is summarized, deduplicated, and
  persisted; later consolidated into daily **digests** and durable **insights**.
- **Live Context Retrieval (read path)** — on each new prompt, the most relevant memory is
  retrieved, fused, re-ranked, budgeted, and injected back into the agent's context.

```mermaid
flowchart LR
    subgraph WRITE["Ingestion — write path"]
        direction TB
        EX[Agent exchange] --> SUM[LLM summarize + dedup]
        SUM --> OBS[(Observations)]
        OBS --> DIG[(Digests)]
        DIG --> INS[(Insights)]
    end

    subgraph STORE["Single-owner store"]
        DB[(SQLite WAL + FTS5)]
        QD[(Qdrant vectors)]
    end

    subgraph READ["Live Context Retrieval — read path"]
        direction TB
        Q[New prompt] --> RET[Embed + parallel search]
        RET --> RRF[RRF fusion + rerank]
        RRF --> BUD[Token budget + assembly]
        BUD --> CTX[Injected context]
    end

    OBS --> DB
    DIG --> DB
    INS --> DB
    INS -.embeddings.-> QD
    DB --> RET
    QD --> RET
    CTX -. human feedback .-> QD

    classDef w fill:#e3f2fd,stroke:#4051b5,color:#0d1b2a;
    classDef r fill:#e8f5e9,stroke:#2e7d32,color:#0d1b2a;
    classDef s fill:#fff8e1,stroke:#f9a825,color:#0d1b2a;
    class EX,SUM,OBS,DIG,INS w;
    class Q,RET,RRF,BUD,CTX r;
    class DB,QD s;
```

## Three-tier memory hierarchy

Inspired by Mastra's Observer/Reflector hierarchy, adapted for cross-agent project knowledge:

| Tier | What | Trigger | Volume |
|------|------|---------|--------|
| **Observations** | Per-exchange structured summaries (Intent / Approach / Artifacts / Result) | Real-time, per prompt-set | ~30/day |
| **Digests** | Daily thematic work-session summaries | End of day (cron or manual) | ~7/day |
| **Insights** | Persistent, self-verifying project knowledge | Weekly or ≥ 5 new digests | ~10 total |

```mermaid
flowchart TB
    subgraph HOST["Host process — Observations API server (localhost:12436)"]
        OW["ObservationWriter"]
        OC["ObservationConsolidator"]
        RS["RetrievalService"]
        EXP["ObservationExporter"]
    end
    ETM["Enhanced Transcript Monitor"] -->|per exchange| OAC["ObservationApiClient (HTTP shim)"]
    OAC -->|POST /api/observations/messages| OW
    OW --> DB[("observations.db\nobservations | digests | insights")]
    OC --> DB
    RS --> DB
    OW -. debounced 10s .-> EXP
    OC -. exportAll .-> EXP
    EXP --> JSON[[".data/observation-export/*.json (git-tracked)"]]
    DASH["Dashboard (container :3033/:3032)"] -->|host.docker.internal:12436| HOST

    classDef api fill:#e3f2fd,stroke:#4051b5,color:#0d1b2a;
    classDef store fill:#fff8e1,stroke:#f9a825,color:#0d1b2a;
    class OW,OC,RS,EXP,OAC,DASH api;
    class DB,JSON store;
```

## Single-owner architecture

The runtime DB has exactly **one owner**: a host process — the **Observations API server**
([`scripts/observations-api-server.mjs`](https://bmw.ghe.com/Ritwik-GA-Ghosh/Agent-Agnostic-Observational-Memory/blob/main/scripts/observations-api-server.mjs), port `12436`).
Every other consumer (transcript monitor, dashboard, consolidator, retrieval) reaches
`observations.db` **only** through this HTTP service. The `.observations` directory is **not**
bind-mounted into the container.

This eliminates the classic SQLite-on-Docker-Desktop WAL/SHM corruption pattern where a host
writer and a container reader lose coherence across the bind-mount boundary. The pattern mirrors
the UKB/VKB "one writer, everyone else over HTTP" approach.

## Where to go next

<div class="grid cards" markdown>

- :material-database-import: **[Ingestion](ingestion.md)** — capture, summarize, dedup, consolidate, verify.
- :material-lightning-bolt: **[Working Memory](working-memory.md)** — the always-on ≤300-token context prefix.
- :material-magnify-scan: **[Live Context Retrieval](retrieval.md)** — the 8-stage read pipeline.
- :material-sort-variant: **[Ranking & Nuances](ranking.md)** — RRF, tier weights, reranking, learned feedback.
- :material-view-dashboard: **[Live Context Preview](live-context.md)** — the dashboard tuning surface.

</div>

---

*Part of the [Agent-Agnostic Observational Memory](https://bmw.ghe.com/Ritwik-GA-Ghosh/Agent-Agnostic-Observational-Memory) project — an extension of the [Coding Documentation](https://fwornle.github.io/coding/).*
