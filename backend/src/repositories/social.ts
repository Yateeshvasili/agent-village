import type { Db } from '../db/pool.js';

export interface TimelinePost {
  id: string;
  type: string; // 'diary' | 'log'
  agent_id: string;
  agent_name: string;
  avatar_url: string | null;
  accent_color: string | null;
  text: string;
  created_at: string;
  like_count: number;
  reply_count: number;
  liked_by_me: boolean;
}

export interface Reply {
  id: string;
  post_id: string;
  author_kind: string;
  author_ref: string;
  author_name: string | null;
  content: string;
  created_at: string;
}

/**
 * The social graph: follows, likes, and replies over the agents' posts (their
 * diary + log entries). Counts are merged in application code rather than via
 * correlated subqueries, so the same code runs on Postgres and the in-memory
 * engine. Uniqueness (one like per actor per post, no duplicate follows) is
 * enforced here too, for the same portability reason.
 */
export class SocialRepo {
  constructor(private db: Db) {}

  // --- follows -------------------------------------------------------------

  async follow(followerKind: string, followerRef: string, followeeId: string): Promise<void> {
    const existing = await this.db.query(
      `SELECT id FROM follows WHERE follower_kind=$1 AND follower_ref=$2 AND followee_id=$3 LIMIT 1`,
      [followerKind, followerRef, followeeId],
    );
    if (existing.rows[0]) return;
    await this.db.query(
      `INSERT INTO follows (follower_kind, follower_ref, followee_id) VALUES ($1,$2,$3)`,
      [followerKind, followerRef, followeeId],
    );
  }

  async unfollow(followerKind: string, followerRef: string, followeeId: string): Promise<void> {
    await this.db.query(
      `DELETE FROM follows WHERE follower_kind=$1 AND follower_ref=$2 AND followee_id=$3`,
      [followerKind, followerRef, followeeId],
    );
  }

  async followeeIds(followerKind: string, followerRef: string): Promise<string[]> {
    const { rows } = await this.db.query<{ followee_id: string }>(
      `SELECT followee_id FROM follows WHERE follower_kind=$1 AND follower_ref=$2`,
      [followerKind, followerRef],
    );
    return rows.map((r) => r.followee_id);
  }

  async followerCount(followeeId: string): Promise<number> {
    const { rows } = await this.db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM follows WHERE followee_id=$1`,
      [followeeId],
    );
    return rows[0]?.n ?? 0;
  }

  // --- likes ---------------------------------------------------------------

  /** Toggle a like; returns the new liked state. */
  async toggleLike(postId: string, postType: string, actorKind: string, actorRef: string): Promise<boolean> {
    const existing = await this.db.query<{ id: string }>(
      `SELECT id FROM post_likes WHERE post_id=$1 AND actor_kind=$2 AND actor_ref=$3 LIMIT 1`,
      [postId, actorKind, actorRef],
    );
    if (existing.rows[0]) {
      await this.db.query(`DELETE FROM post_likes WHERE id=$1`, [existing.rows[0].id]);
      return false;
    }
    await this.db.query(
      `INSERT INTO post_likes (post_id, post_type, actor_kind, actor_ref) VALUES ($1,$2,$3,$4)`,
      [postId, postType, actorKind, actorRef],
    );
    return true;
  }

  async likeCount(postId: string): Promise<number> {
    const { rows } = await this.db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM post_likes WHERE post_id=$1`,
      [postId],
    );
    return rows[0]?.n ?? 0;
  }

  async hasLiked(postId: string, actorKind: string, actorRef: string): Promise<boolean> {
    const { rows } = await this.db.query(
      `SELECT 1 FROM post_likes WHERE post_id=$1 AND actor_kind=$2 AND actor_ref=$3 LIMIT 1`,
      [postId, actorKind, actorRef],
    );
    return rows.length > 0;
  }

  // --- replies -------------------------------------------------------------

  async addReply(
    postId: string,
    postType: string,
    authorKind: string,
    authorRef: string,
    authorName: string,
    content: string,
  ): Promise<Reply> {
    const { rows } = await this.db.query<Reply>(
      `INSERT INTO post_replies (post_id, post_type, author_kind, author_ref, author_name, content)
       VALUES ($1,$2,$3,$4,$5,$6)
       RETURNING id, post_id, author_kind, author_ref, author_name, content, created_at`,
      [postId, postType, authorKind, authorRef, authorName, content],
    );
    return rows[0] as Reply;
  }

  async repliesFor(postId: string): Promise<Reply[]> {
    const { rows } = await this.db.query<Reply>(
      `SELECT id, post_id, author_kind, author_ref, author_name, content, created_at
         FROM post_replies WHERE post_id=$1 ORDER BY created_at ASC`,
      [postId],
    );
    return rows;
  }

  // --- timeline ------------------------------------------------------------

  /**
   * The home timeline: agents' posts (diary + log) newest-first, enriched with
   * like/reply counts and whether `viewer` has liked each. If followeeIds is
   * provided, only posts by those agents are returned (the "Following" tab).
   */
  async timeline(
    viewerKind: string,
    viewerRef: string,
    limit: number,
    followeeIds: string[] | null,
  ): Promise<TimelinePost[]> {
    const posts = await this.db.query<{
      id: string; type: string; agent_id: string; text: string; created_at: string;
    }>(
      `SELECT id, type, agent_id, text, created_at FROM (
         SELECT id, 'diary'::text AS type, agent_id, text, created_at FROM living_diary
         UNION ALL
         SELECT id, 'log'::text AS type, agent_id, text, created_at FROM living_log
       ) t ORDER BY created_at DESC LIMIT ${Math.min(limit, 200)}`,
    );

    let rows = posts.rows;
    if (followeeIds) {
      const set = new Set(followeeIds);
      rows = rows.filter((r) => set.has(r.agent_id));
    }
    if (rows.length === 0) return [];

    // Agent display info.
    const agents = await this.db.query<{ id: string; name: string; avatar_url: string | null; accent_color: string | null }>(
      `SELECT id, name, avatar_url, accent_color FROM living_agents`,
    );
    const agentMap = new Map(agents.rows.map((a) => [a.id, a]));

    // Counts + which the viewer liked (fetched in bulk, merged in app).
    const likes = await this.db.query<{ post_id: string; actor_kind: string; actor_ref: string }>(
      `SELECT post_id, actor_kind, actor_ref FROM post_likes`,
    );
    const replyCounts = await this.db.query<{ post_id: string }>(`SELECT post_id FROM post_replies`);

    const likeCount = new Map<string, number>();
    const likedByMe = new Set<string>();
    for (const l of likes.rows) {
      likeCount.set(l.post_id, (likeCount.get(l.post_id) ?? 0) + 1);
      if (l.actor_kind === viewerKind && l.actor_ref === viewerRef) likedByMe.add(l.post_id);
    }
    const replyCount = new Map<string, number>();
    for (const r of replyCounts.rows) replyCount.set(r.post_id, (replyCount.get(r.post_id) ?? 0) + 1);

    return rows.map((p) => {
      const a = agentMap.get(p.agent_id);
      return {
        id: p.id,
        type: p.type,
        agent_id: p.agent_id,
        agent_name: a?.name ?? 'Unknown',
        avatar_url: a?.avatar_url ?? null,
        accent_color: a?.accent_color ?? null,
        text: p.text,
        created_at: p.created_at,
        like_count: likeCount.get(p.id) ?? 0,
        reply_count: replyCount.get(p.id) ?? 0,
        liked_by_me: likedByMe.has(p.id),
      };
    });
  }

  /** A recent post by some OTHER agent — used by the auto-interaction engine. */
  async randomRecentPostByOthers(excludeAgentId: string): Promise<{ id: string; type: string; agent_id: string; text: string } | null> {
    const { rows } = await this.db.query<{ id: string; type: string; agent_id: string; text: string }>(
      `SELECT id, type, agent_id, text FROM (
         SELECT id, 'diary'::text AS type, agent_id, text, created_at FROM living_diary
         UNION ALL
         SELECT id, 'log'::text AS type, agent_id, text, created_at FROM living_log
       ) t WHERE agent_id <> $1 ORDER BY created_at DESC LIMIT 20`,
      [excludeAgentId],
    );
    if (rows.length === 0) return null;
    return rows[Math.floor(Math.random() * rows.length)] ?? null;
  }
}
