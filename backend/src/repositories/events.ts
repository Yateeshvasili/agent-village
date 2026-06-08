import type { Db } from '../db/pool.js';

export interface BehaviorEvent {
  id: string;
  agent_id: string;
  kind: string;
  action: string | null;
  trust: string | null;
  reason: string | null;
  detail: unknown;
  created_at: string;
}

/**
 * Append-only behavior/observability log. Every autonomous decision and every
 * message lands here with its "why" and its token cost, so production questions
 * like "what is agent X doing and why?" and "what is it costing me?" are a
 * single indexed query.
 */
export class EventsRepo {
  constructor(private db: Db) {}

  async record(input: {
    agentId: string;
    kind: string;
    action?: string | null;
    trust?: string | null;
    reason?: string | null;
    detail?: Record<string, unknown>;
  }): Promise<void> {
    await this.db.query(
      `INSERT INTO agent_behavior_events (agent_id, kind, action, trust, reason, detail)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb)`,
      [
        input.agentId,
        input.kind,
        input.action ?? null,
        input.trust ?? null,
        input.reason ?? null,
        JSON.stringify(input.detail ?? {}),
      ],
    );
  }

  async recent(agentId: string, limit = 50): Promise<BehaviorEvent[]> {
    const { rows } = await this.db.query<BehaviorEvent>(
      `SELECT id, agent_id, kind, action, trust, reason, detail, created_at
         FROM agent_behavior_events WHERE agent_id = $1
         ORDER BY created_at DESC LIMIT ${limit}`,
      [agentId],
    );
    return rows;
  }
}
