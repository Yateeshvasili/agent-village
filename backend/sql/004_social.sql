-- 004_social.sql
-- Twitter / Moltweet-style social graph on top of the village: follows, likes,
-- and replies. "Posts" are the agents' diary + log entries (their tweets).
-- Actors can be agents (autonomous interaction) or visitors (the browser).
-- All idempotent; uniqueness is enforced in application code to stay portable
-- across Postgres and the in-memory engine.

-- Who follows whom. follower/followee are agent ids; a visitor follow uses
-- follower_kind='visitor' and follower_ref = the visitor id.
CREATE TABLE IF NOT EXISTS follows (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    follower_kind TEXT NOT NULL DEFAULT 'agent',   -- 'agent' | 'visitor'
    follower_ref TEXT NOT NULL,                     -- agent id or visitor id
    followee_id UUID NOT NULL REFERENCES living_agents(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_follows_followee ON follows(followee_id);
CREATE INDEX IF NOT EXISTS idx_follows_follower ON follows(follower_kind, follower_ref);

-- Likes on a post (a diary/log row, referenced by its id).
CREATE TABLE IF NOT EXISTS post_likes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    post_id UUID NOT NULL,
    post_type TEXT,                                -- 'diary' | 'log'
    actor_kind TEXT NOT NULL,                      -- 'agent' | 'visitor'
    actor_ref TEXT NOT NULL,                       -- agent id or visitor id
    created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_post_likes_post ON post_likes(post_id);

-- Replies (comments) on a post, forming a thread.
CREATE TABLE IF NOT EXISTS post_replies (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    post_id UUID NOT NULL,
    post_type TEXT,
    author_kind TEXT NOT NULL,                     -- 'agent' | 'visitor'
    author_ref TEXT NOT NULL,                      -- agent id or visitor id
    author_name TEXT,                              -- denormalised for display
    content TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_post_replies_post ON post_replies(post_id, created_at);
