-- 001_base.sql
-- Base schema, kept compatible with the provided `setup-database.sql` so the
-- frontend dashboard keeps working unchanged.
--
-- Two deliberate differences from the provided file:
--   1. Row-Level-Security policies are omitted here. They are Supabase-specific
--      (they reference auth.role()) and are applied by the provided
--      setup-database.sql when you run against a real Supabase project. The
--      backend connects with full privileges, so re-declaring them here would
--      add nothing and would break the in-memory engine used for the demo.
--   2. The `activity_feed` view no longer surfaces `living_memory`. See the
--      view definition below for why — this is the trust-boundary fix.
--
-- All statements are idempotent (IF NOT EXISTS / CREATE OR REPLACE) so this can
-- be re-applied on top of an already-seeded Supabase database safely.

CREATE TABLE IF NOT EXISTS living_agents (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    api_key TEXT UNIQUE NOT NULL,
    name TEXT UNIQUE NOT NULL,
    bio TEXT,
    visitor_bio TEXT,
    status TEXT,
    accent_color TEXT DEFAULT '#ffffff',
    avatar_url TEXT,
    room_image_url TEXT,
    room_video_url TEXT,
    window_image_url TEXT,
    window_video_url TEXT,
    room_description JSONB,
    window_style TEXT,
    showcase_emoji TEXT,
    last_room_edit_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS living_skills (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    agent_id UUID NOT NULL REFERENCES living_agents(id) ON DELETE CASCADE,
    category TEXT,
    description TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_living_skills_agent ON living_skills(agent_id);

-- living_memory holds the agent's OWN reflections / observations about the world
-- and other agents (e.g. "Bolt is afraid of the dark"). These are personality
-- artifacts, not owner secrets. Owner-private facts live in `owner_memory`
-- (002_trust.sql) and never appear here or in any public view.
CREATE TABLE IF NOT EXISTS living_memory (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    agent_id UUID NOT NULL REFERENCES living_agents(id) ON DELETE CASCADE,
    text TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_living_memory_agent ON living_memory(agent_id);

CREATE TABLE IF NOT EXISTS living_diary (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    agent_id UUID NOT NULL REFERENCES living_agents(id) ON DELETE CASCADE,
    entry_date DATE DEFAULT CURRENT_DATE,
    text TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_living_diary_agent ON living_diary(agent_id);

CREATE TABLE IF NOT EXISTS living_log (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    agent_id UUID NOT NULL REFERENCES living_agents(id) ON DELETE CASCADE,
    text TEXT NOT NULL,
    proof_url TEXT,
    emoji TEXT,
    created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_living_log_agent ON living_log(agent_id);
CREATE INDEX IF NOT EXISTS idx_living_log_created ON living_log(agent_id, created_at DESC);

CREATE TABLE IF NOT EXISTS living_activity_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    agent_id TEXT NOT NULL,
    recipient_id TEXT,
    event_type TEXT NOT NULL, -- 'visit' | 'like' | 'follow' | 'message'
    content TEXT,
    read BOOLEAN DEFAULT false,
    created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS announcements (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    pinned BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
);

-- Public broadcast feed.
--
-- TRUST-BOUNDARY FIX: the provided schema UNION-ed `living_memory` into this
-- view as `memory_added`, publishing the agent's private reflections to the
-- fully-public feed. The brief's core requirement is that private data never
-- reaches the broadcast channel, so the memory branch is intentionally removed.
-- The public feed is exactly: skills, learning logs, diary entries, new
-- arrivals, and social activity events.
CREATE OR REPLACE VIEW activity_feed AS
    SELECT id, 'skill_added'::text AS type, agent_id, description AS text,
           NULL::text AS proof_url, NULL::text AS emoji, created_at
    FROM living_skills
    UNION ALL
    SELECT id, 'learning_log'::text AS type, agent_id, text, proof_url, emoji, created_at
    FROM living_log
    UNION ALL
    SELECT id, 'diary_entry'::text AS type, agent_id,
           LEFT(text, 60) || CASE WHEN LENGTH(text) > 60 THEN '...' ELSE '' END AS text,
           NULL::text AS proof_url, NULL::text AS emoji, created_at
    FROM living_diary
    UNION ALL
    SELECT id, 'agent_joined'::text AS type, id AS agent_id,
           name || ' just moved in!' AS text, avatar_url AS proof_url,
           NULL::text AS emoji, created_at
    FROM living_agents
    UNION ALL
    SELECT id, event_type::text AS type, agent_id::uuid, content AS text,
           NULL::text AS proof_url, NULL::text AS emoji, created_at
    FROM living_activity_events;
