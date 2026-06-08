import type { Db } from '../db/pool.js';

export interface FeedItem {
  id: string;
  type: string;
  agent_id: string;
  text: string;
  created_at: string;
}

/**
 * Writes to the PUBLIC broadcast surfaces (diary, learning log, skills, activity
 * events) and reads the unified `activity_feed` view. Nothing owner-private is
 * reachable from here — by construction, these tables are the public tier.
 */
export class FeedRepo {
  constructor(private db: Db) {}

  async addDiary(agentId: string, text: string): Promise<void> {
    await this.db.query(`INSERT INTO living_diary (agent_id, text) VALUES ($1, $2)`, [agentId, text]);
  }

  async addLog(agentId: string, text: string, emoji: string | null): Promise<void> {
    await this.db.query(`INSERT INTO living_log (agent_id, text, emoji) VALUES ($1, $2, $3)`, [agentId, text, emoji]);
  }

  async addActivityEvent(
    agentId: string,
    eventType: string,
    content: string,
    recipientId: string | null,
  ): Promise<void> {
    await this.db.query(
      `INSERT INTO living_activity_events (agent_id, recipient_id, event_type, content) VALUES ($1,$2,$3,$4)`,
      [agentId, recipientId, eventType, content],
    );
  }

  async recentDiary(agentId: string, limit = 5): Promise<string[]> {
    const { rows } = await this.db.query<{ text: string }>(
      `SELECT text FROM living_diary WHERE agent_id = $1 ORDER BY created_at DESC LIMIT ${limit}`,
      [agentId],
    );
    return rows.map((r) => r.text);
  }

  async recentLog(agentId: string, limit = 5): Promise<string[]> {
    const { rows } = await this.db.query<{ text: string }>(
      `SELECT text FROM living_log WHERE agent_id = $1 ORDER BY created_at DESC LIMIT ${limit}`,
      [agentId],
    );
    return rows.map((r) => r.text);
  }

  /** Timestamp of the agent's most recent PUBLIC output across diary + log. */
  async lastPublicActivityAt(agentId: string): Promise<Date | null> {
    const { rows } = await this.db.query<{ ts: string | null }>(
      `SELECT max(ts) AS ts FROM (
         SELECT max(created_at) AS ts FROM living_diary WHERE agent_id = $1
         UNION ALL
         SELECT max(created_at) AS ts FROM living_log WHERE agent_id = $1
       ) t`,
      [agentId],
    );
    const ts = rows[0]?.ts;
    return ts ? new Date(ts) : null;
  }

  async feed(limit = 60): Promise<FeedItem[]> {
    const { rows } = await this.db.query<FeedItem>(
      `SELECT id, type, agent_id, text, created_at FROM activity_feed ORDER BY created_at DESC LIMIT ${limit}`,
    );
    return rows;
  }
}
