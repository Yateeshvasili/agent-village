import type { Db } from '../db/pool.js';
import type { OwnerMemory } from '../domain/types.js';

/**
 * Two physically separate memory stores, by trust tier:
 *   - owner_memory:  private owner facts. Read ONLY via owner-authenticated paths.
 *   - living_memory: the agent's own public-safe reflections.
 *
 * Keeping them in different tables (rather than one table with a flag) makes the
 * boundary hard to cross by accident: a query against the wrong store returns
 * the wrong tier's data structurally, so the safe default is enforced by which
 * method you call.
 */
export class MemoryRepo {
  constructor(private db: Db) {}

  // --- owner-private -------------------------------------------------------

  async addOwnerMemory(
    agentId: string,
    kind: string,
    content: string,
    sourceMessageId: string | null,
  ): Promise<void> {
    await this.db.query(
      `INSERT INTO owner_memory (agent_id, kind, content, source_message_id) VALUES ($1,$2,$3,$4)`,
      [agentId, kind, content, sourceMessageId],
    );
  }

  async ownerMemories(agentId: string, limit = 50): Promise<OwnerMemory[]> {
    const { rows } = await this.db.query<OwnerMemory>(
      `SELECT id, agent_id, kind, content, created_at
         FROM owner_memory WHERE agent_id = $1
         ORDER BY created_at DESC LIMIT ${limit}`,
      [agentId],
    );
    return rows;
  }

  // --- public reflections --------------------------------------------------

  async addReflection(agentId: string, text: string): Promise<void> {
    await this.db.query(`INSERT INTO living_memory (agent_id, text) VALUES ($1, $2)`, [agentId, text]);
  }

  async reflections(agentId: string, limit = 20): Promise<string[]> {
    const { rows } = await this.db.query<{ text: string }>(
      `SELECT text FROM living_memory WHERE agent_id = $1 ORDER BY created_at DESC LIMIT ${limit}`,
      [agentId],
    );
    return rows.map((r) => r.text);
  }
}
