-- 002_trust.sql
-- Additive schema for the three things the backend owns that the provided
-- schema does not model: owner-private memory, a per-trust-context message log,
-- and a durable job queue for the scheduler. All idempotent.

-- Owner authentication token. The owner of an agent proves identity by
-- presenting this token; everyone else is a stranger. Defaults to the agent's
-- existing api_key so seeded agents have a usable owner credential out of the box.
ALTER TABLE living_agents ADD COLUMN IF NOT EXISTS owner_token TEXT;
UPDATE living_agents SET owner_token = api_key WHERE owner_token IS NULL;

-- Optional active-hours window (local 0-23) used by the proactive engine to
-- decide *when* an agent is likely to act. NULL => active any time.
ALTER TABLE living_agents ADD COLUMN IF NOT EXISTS active_hours_start INT;
ALTER TABLE living_agents ADD COLUMN IF NOT EXISTS active_hours_end INT;

-- ---------------------------------------------------------------------------
-- OWNER-PRIVATE MEMORY  (full-trust tier)
-- The heart of the trust boundary. Facts/preferences the owner shared in
-- confidence. This table is NEVER exposed through a public view and is only
-- ever read when a request is authenticated as the owner. Strangers' requests
-- never even load these rows (defense in depth — not just a prompt instruction).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS owner_memory (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    agent_id UUID NOT NULL REFERENCES living_agents(id) ON DELETE CASCADE,
    kind TEXT NOT NULL DEFAULT 'fact',     -- 'fact' | 'preference' | 'event' | 'relationship'
    content TEXT NOT NULL,
    source_message_id UUID,                -- provenance: which message produced this
    created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_owner_memory_agent ON owner_memory(agent_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- CONVERSATIONS + MESSAGES  (per trust-context history)
-- Every conversation is tagged with the trust context it happened under. Owner
-- and stranger histories are physically the same table but partitioned by
-- `trust` + `participant_id`, so the context assembler can load "this owner's
-- past messages" without ever co-mingling stranger threads.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS conversations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    agent_id UUID NOT NULL REFERENCES living_agents(id) ON DELETE CASCADE,
    trust TEXT NOT NULL,                   -- 'owner' | 'stranger'
    participant_id TEXT NOT NULL,          -- 'owner' for the owner; visitor id for strangers
    created_at TIMESTAMPTZ DEFAULT now(),
    last_message_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_conversations_lookup
    ON conversations(agent_id, trust, participant_id);

CREATE TABLE IF NOT EXISTS messages (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    agent_id UUID NOT NULL REFERENCES living_agents(id) ON DELETE CASCADE,
    role TEXT NOT NULL,                    -- 'user' | 'agent'
    trust TEXT NOT NULL,                   -- denormalised for cheap filtering/auditing
    content TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_messages_conversation
    ON messages(conversation_id, created_at);

-- ---------------------------------------------------------------------------
-- AGENT JOB QUEUE  (durable scheduling)
-- The scheduler is not a naked setInterval. Work is persisted as rows; workers
-- claim due jobs transactionally (FOR UPDATE SKIP LOCKED on real Postgres), so
-- the system survives restarts and scales to N workers without double-firing.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS agent_jobs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    agent_id UUID NOT NULL REFERENCES living_agents(id) ON DELETE CASCADE,
    job_type TEXT NOT NULL,                -- 'proactive_tick'
    status TEXT NOT NULL DEFAULT 'pending',-- 'pending' | 'running' | 'done' | 'failed'
    run_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    attempts INT NOT NULL DEFAULT 0,
    last_error TEXT,
    locked_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_agent_jobs_due
    ON agent_jobs(status, run_at);

-- ---------------------------------------------------------------------------
-- BEHAVIOR EVENT LOG  (observability)
-- An append-only audit trail of every autonomous decision: what the agent did,
-- why (the signals + score), and how much it cost. This is how you answer
-- "what are my agents doing right now?" in production.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS agent_behavior_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    agent_id UUID NOT NULL REFERENCES living_agents(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,                    -- 'proactive_action' | 'proactive_skip' | 'message_in' | 'message_out'
    action TEXT,                           -- 'diary' | 'status' | 'learning' | 'owner_checkin' | ...
    trust TEXT,                            -- trust context, when relevant
    reason TEXT,                           -- human-readable "why"
    detail JSONB,                          -- signals, scores, token usage
    created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_behavior_events_agent
    ON agent_behavior_events(agent_id, created_at DESC);
