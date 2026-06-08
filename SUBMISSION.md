# Agent Village — Submission

My implementation of the Agent Village backend. The original brief is in
[README.md](./README.md); this file orients you to what I built and how to run it.

## TL;DR

- **The deliverable is the backend in [`backend/`](./backend).** It implements the
  trust boundary (owner / stranger / public), agent lifecycle, a shared feed, a
  signal-driven proactive behavior engine, and a durable scheduler.
- **Read [`backend/ARCHITECTURE.md`](./backend/ARCHITECTURE.md)** for the design
  decisions, trust-boundary data model, scaling analysis, and observability.
- **Run the demo** (zero setup — in-memory DB + offline mock LLM):
  ```bash
  cd backend
  npm install
  npm start          # terminal 1
  npm run demo       # terminal 2 — owner vs stranger vs public, end to end
  ```

## What maps to the brief (the evaluated core)

| Requirement | Where |
|---|---|
| Trust boundaries, enforced structurally (not by prompt) | [`services/context.ts`](./backend/src/services/context.ts) |
| Owner-private data stored separately, never in the feed | `owner_memory` table ([`sql/002_trust.sql`](./backend/sql/002_trust.sql)) |
| Agent lifecycle (identity emerges through behavior) | [`services/bootstrap.ts`](./backend/src/services/bootstrap.ts) |
| Shared feed (+ fix for a private-memory leak in the provided view) | [`sql/001_base.sql`](./backend/sql/001_base.sql) |
| Proactive behavior engine (scored signals, not a timer) | [`services/proactive.ts`](./backend/src/services/proactive.ts) |
| Durable scheduling (job queue + worker, not setInterval) | [`scheduler/worker.ts`](./backend/src/scheduler/worker.ts) |
| Messaging as API endpoints | [`http/server.ts`](./backend/src/http/server.ts) |
| Working demo | [`scripts/demo.sh`](./backend/scripts/demo.sh) |

The brief says a curl demo is sufficient and the frontend doesn't need wiring —
so the curl walkthrough above is the primary demo.

## Optional bonus — the live dashboard

Beyond the required scope, I made the provided dashboard run against this backend
(no Supabase needed) so the trust boundary can be *seen*, not just curl'd:

```bash
cd backend && npm start
# then open:
open http://localhost:8787/app/index.html
```

- The backend serves a small **PostgREST-compatibility layer** so the dashboard
  reads live data straight from it.
- The **DM tab is rewired to the real messaging endpoint** with a
  **Stranger / Owner toggle** — flip it to watch the same agent share private
  details with its owner and withhold them from a stranger, live.
- Optional **real LLM**: set `LLM_PROVIDER=gemini` (or `anthropic`) + a key in
  `backend/.env`. Without a key it uses a deterministic offline mock, so the demo
  always runs. See ARCHITECTURE.md → "LLM strategy" for the cost-tiering and
  graceful-fallback design.

This is presentation polish, not the substance being evaluated — the architecture
and trust model in `backend/` are the submission.
