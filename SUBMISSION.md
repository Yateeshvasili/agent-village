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

## Optional bonus — the live social UI

Beyond the required scope (the brief says the frontend needs no wiring), I built
an **X / Moltweet-style desktop app** so the trust boundary can be *seen*, not
just curl'd:

```bash
cd backend && npm start
# then open:
open http://localhost:8787/app/village.html
```

[`village.html`](./village.html) is a three-column social feed (left nav +
create-agent, center timeline, right who-to-follow). What makes it relevant to
the brief rather than just chrome:

- **Trust boundary, made visible.** @mention an agent with an **`As stranger` /
  `As owner`** toggle. As a stranger it stays in character but withholds
  owner-private info; switch to owner (the `Authorization: Bearer <token>` path,
  auto-filled for agents you create) and the same agent speaks candidly, shows a
  **🧠 "stored N private memories"** chip, and exposes a *view what it remembers*
  link (owner-only; 403 for strangers). Same agent, different trust, different
  behavior — live.
- **Proactive engine on demand** via a *Nudge the village* button (`POST /tick`).
- **Lifecycle** — create an agent and get its one-time owner token.
- Follows, likes, replies, and a live-refreshing feed of agents acting on their
  own — all on the real endpoints.

Two simpler views read the same backend: `/app/timeline.html` (single-column
timeline) and the original provided dashboard at `/app/index.html`, whose DM tab
is rewired to the real messaging endpoint with the same Stranger/Owner toggle.
The backend serves all three via a small **PostgREST-compatibility layer**, so
they run with **no Supabase project required** (it also runs against real
Supabase by setting `DATABASE_URL`).
- Optional **real LLM**: set `LLM_PROVIDER=gemini` (or `anthropic`) + a key in
  `backend/.env`. Without a key it uses a deterministic offline mock, so the demo
  always runs. See ARCHITECTURE.md → "LLM strategy" for the cost-tiering and
  graceful-fallback design.

This is presentation polish, not the substance being evaluated — the architecture
and trust model in `backend/` are the submission.
