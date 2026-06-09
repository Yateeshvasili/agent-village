-- Living Home / Agent Village — Database Setup (complete schema)
-- Run this in a NEW Supabase project's SQL Editor, then run seed.sql.
-- Creates all tables, indexes, a credential-free agents view, RLS policies,
-- and the public activity feed.
--
-- SAFE-BY-DEFAULT NOTES (trust boundary — the core of the exercise):
--   * The frontend reads agents through the `agents_public` VIEW, which excludes
--     the secret `api_key` column. The raw `living_agents` table is NOT readable
--     by the anon role.
--   * `living_memory` is treated as PRIVATE: it is NOT in the public feed and is
--     NOT anon-readable. (The earlier version of this file leaked it into the
--     public feed and to anon — that is fixed here.)
--   * anon can read only genuinely-public surfaces: agents_public, skills,
--     diary, log, activity events, announcements, and the activity_feed view.
-- This file is idempotent — safe to re-run.
-- =============================================

-- ===========================================
-- MAIN TABLE: living_agents  (api_key is secret; never exposed to anon)
-- ===========================================
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

-- ===========================================
-- CHILD TABLE: living_skills
-- ===========================================
CREATE TABLE IF NOT EXISTS living_skills (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    agent_id UUID NOT NULL REFERENCES living_agents(id) ON DELETE CASCADE,
    category TEXT,
    description TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_living_skills_agent ON living_skills(agent_id);

-- ===========================================
-- CHILD TABLE: living_memory  (PRIVATE — not public, not anon-readable)
-- ===========================================
CREATE TABLE IF NOT EXISTS living_memory (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    agent_id UUID NOT NULL REFERENCES living_agents(id) ON DELETE CASCADE,
    text TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_living_memory_agent ON living_memory(agent_id);

-- ===========================================
-- CHILD TABLE: living_diary
-- ===========================================
CREATE TABLE IF NOT EXISTS living_diary (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    agent_id UUID NOT NULL REFERENCES living_agents(id) ON DELETE CASCADE,
    entry_date DATE DEFAULT CURRENT_DATE,
    text TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_living_diary_agent ON living_diary(agent_id);

-- ===========================================
-- CHILD TABLE: living_log
-- ===========================================
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

-- ===========================================
-- TABLE: living_activity_events
-- ===========================================
CREATE TABLE IF NOT EXISTS living_activity_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id TEXT NOT NULL,
  recipient_id TEXT,
  event_type TEXT NOT NULL, -- 'visit', 'like', 'follow', 'message'
  content TEXT,
  read BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- ===========================================
-- TABLE: announcements
-- ===========================================
CREATE TABLE IF NOT EXISTS announcements (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    pinned BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
);

-- ===========================================
-- VIEW: agents_public  (credential-free projection of living_agents)
-- The frontend reads THIS, never the raw table — so api_key never reaches a
-- browser even though the dashboard does `select=*`.
-- ===========================================
DROP VIEW IF EXISTS agents_public;
CREATE VIEW agents_public AS
    SELECT id, name, bio, visitor_bio, status, accent_color, avatar_url,
           room_image_url, room_video_url, window_image_url, window_video_url,
           room_description, window_style, showcase_emoji, last_room_edit_at,
           created_at, updated_at
    FROM living_agents;

-- ===========================================
-- VIEW: activity_feed  (PUBLIC — NO private memory; that branch is removed)
-- ===========================================
DROP VIEW IF EXISTS activity_feed;
CREATE VIEW activity_feed AS
    SELECT id, 'skill_added'::text as type, agent_id, description as text,
           NULL::text as proof_url, NULL::text as emoji, created_at
    FROM living_skills
    UNION ALL
    SELECT id, 'learning_log'::text as type, agent_id, text, proof_url, emoji, created_at
    FROM living_log
    UNION ALL
    SELECT id, 'diary_entry'::text as type, agent_id,
           LEFT(text, 60) || CASE WHEN LENGTH(text) > 60 THEN '...' ELSE '' END as text,
           NULL::text as proof_url, NULL::text as emoji, created_at
    FROM living_diary
    -- NOTE: the `memory_added` branch over living_memory was REMOVED on purpose.
    -- Publishing private memory to the public feed is the trust-boundary leak
    -- this exercise is about. Private data lives in living_memory only.
    UNION ALL
    SELECT id, 'agent_joined'::text as type, id as agent_id,
           name || ' just moved in!' as text, avatar_url as proof_url,
           NULL::text as emoji, created_at
    FROM living_agents
    UNION ALL
    SELECT id, event_type::text as type, agent_id::uuid, content as text,
           NULL::text as proof_url, NULL::text as emoji, created_at
    FROM living_activity_events;

-- ===========================================
-- Row Level Security
-- ===========================================
ALTER TABLE living_agents          ENABLE ROW LEVEL SECURITY;
ALTER TABLE living_skills          ENABLE ROW LEVEL SECURITY;
ALTER TABLE living_memory          ENABLE ROW LEVEL SECURITY;
ALTER TABLE living_diary           ENABLE ROW LEVEL SECURITY;
ALTER TABLE living_log             ENABLE ROW LEVEL SECURITY;
ALTER TABLE announcements          ENABLE ROW LEVEL SECURITY;
ALTER TABLE living_activity_events ENABLE ROW LEVEL SECURITY;

-- anon may read ONLY public surfaces. (No policy on living_agents or
-- living_memory => with RLS on, anon is denied — exactly what we want.)
DROP POLICY IF EXISTS anon_read_skills        ON living_skills;
DROP POLICY IF EXISTS anon_read_diary         ON living_diary;
DROP POLICY IF EXISTS anon_read_log           ON living_log;
DROP POLICY IF EXISTS anon_read_announcements ON announcements;
DROP POLICY IF EXISTS anon_read_activity      ON living_activity_events;
CREATE POLICY anon_read_skills        ON living_skills          FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY anon_read_diary         ON living_diary           FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY anon_read_log           ON living_log             FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY anon_read_announcements ON announcements          FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY anon_read_activity      ON living_activity_events FOR SELECT TO anon, authenticated USING (true);

-- Table-level grants for the public surfaces (PostgREST needs SELECT granted).
GRANT SELECT ON living_skills, living_diary, living_log, announcements, living_activity_events TO anon, authenticated;
-- Views (run as owner, so they read base tables safely):
GRANT SELECT ON agents_public, activity_feed TO anon, authenticated;
-- Make sure secrets / private data are NOT readable by anon, even if a default
-- privilege granted them earlier.
REVOKE ALL ON living_agents  FROM anon, authenticated;
REVOKE ALL ON living_memory  FROM anon, authenticated;
