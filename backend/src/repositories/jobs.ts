import type { Db } from '../db/pool.js';

export interface Job {
  id: string;
  agent_id: string;
  job_type: string;
  status: string;
  run_at: string;
  attempts: number;
}

/**
 * Durable job queue backing the scheduler. Jobs are rows, not in-memory timers,
 * so work survives restarts and can be processed by N concurrent workers.
 *
 * Claiming is the interesting part: on real Postgres we use
 * `FOR UPDATE SKIP LOCKED`, which lets many workers pull disjoint jobs without
 * blocking each other — the standard pattern for a horizontally scalable queue.
 * The in-memory engine is single-process, so a plain select-then-mark is safe
 * and equivalent there.
 */
export class JobsRepo {
  constructor(private db: Db) {}

  async enqueue(agentId: string, jobType: string, runAt: Date): Promise<void> {
    await this.db.query(
      `INSERT INTO agent_jobs (agent_id, job_type, run_at) VALUES ($1, $2, $3)`,
      [agentId, jobType, runAt.toISOString()],
    );
  }

  /** Ensure every agent has at least one pending job, without duplicating. */
  async ensurePendingForAll(jobType: string, runAt: Date): Promise<void> {
    const agents = await this.db.query<{ id: string }>(`SELECT id FROM living_agents`);
    const pending = await this.db.query<{ agent_id: string }>(
      `SELECT DISTINCT agent_id FROM agent_jobs WHERE job_type = $1 AND status = 'pending'`,
      [jobType],
    );
    const have = new Set(pending.rows.map((r) => r.agent_id));
    for (const a of agents.rows) {
      if (!have.has(a.id)) await this.enqueue(a.id, jobType, runAt);
    }
  }

  /** Atomically claim one due job, or return null if none are ready. */
  async claimDue(): Promise<Job | null> {
    if (this.db.supportsSkipLocked) {
      const { rows } = await this.db.query<Job>(
        `UPDATE agent_jobs SET status = 'running', locked_at = now(), attempts = attempts + 1
           WHERE id = (
             SELECT id FROM agent_jobs
              WHERE status = 'pending' AND run_at <= now()
              ORDER BY run_at
              FOR UPDATE SKIP LOCKED
              LIMIT 1
           )
         RETURNING id, agent_id, job_type, status, run_at, attempts`,
      );
      return rows[0] ?? null;
    }

    // Single-process engine: select then claim by id inside a transaction.
    return this.db.tx(async (tx) => {
      const found = await tx.query<{ id: string }>(
        `SELECT id FROM agent_jobs WHERE status = 'pending' AND run_at <= now() ORDER BY run_at LIMIT 1`,
      );
      const id = found.rows[0]?.id;
      if (!id) return null;
      const { rows } = await tx.query<Job>(
        `UPDATE agent_jobs SET status = 'running', locked_at = now(), attempts = attempts + 1
           WHERE id = $1
         RETURNING id, agent_id, job_type, status, run_at, attempts`,
        [id],
      );
      return rows[0] ?? null;
    });
  }

  async complete(id: string): Promise<void> {
    await this.db.query(`UPDATE agent_jobs SET status = 'done' WHERE id = $1`, [id]);
  }

  async fail(id: string, error: string): Promise<void> {
    await this.db.query(`UPDATE agent_jobs SET status = 'failed', last_error = $2 WHERE id = $1`, [id, error]);
  }

  async countActionsSince(agentId: string, since: Date): Promise<number> {
    const { rows } = await this.db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM agent_behavior_events
        WHERE agent_id = $1 AND kind = 'proactive_action' AND created_at >= $2`,
      [agentId, since.toISOString()],
    );
    return rows[0]?.n ?? 0;
  }
}
