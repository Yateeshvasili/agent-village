import type { Db } from '../db/pool.js';
import type { ChatMessage } from '../domain/types.js';
import type { TrustLevel } from '../domain/trust.js';

/**
 * Conversation + message log, partitioned by (agent, trust, participant).
 * The owner's thread and each stranger's thread are isolated: loading "this
 * requester's history" can never pull another participant's messages, so a
 * stranger can never see what the owner said.
 */
export class ConversationsRepo {
  constructor(private db: Db) {}

  /** Find or create the conversation for a (agent, trust, participant) triple. */
  async ensureConversation(agentId: string, trust: TrustLevel, participantId: string): Promise<string> {
    const found = await this.db.query<{ id: string }>(
      `SELECT id FROM conversations WHERE agent_id=$1 AND trust=$2 AND participant_id=$3 LIMIT 1`,
      [agentId, trust, participantId],
    );
    if (found.rows[0]) return found.rows[0].id;

    const created = await this.db.query<{ id: string }>(
      `INSERT INTO conversations (agent_id, trust, participant_id) VALUES ($1,$2,$3) RETURNING id`,
      [agentId, trust, participantId],
    );
    return created.rows[0]!.id;
  }

  async addMessage(
    conversationId: string,
    agentId: string,
    role: 'user' | 'agent',
    trust: TrustLevel,
    content: string,
  ): Promise<string> {
    const { rows } = await this.db.query<{ id: string }>(
      `INSERT INTO messages (conversation_id, agent_id, role, trust, content)
       VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [conversationId, agentId, role, trust, content],
    );
    await this.db.query(`UPDATE conversations SET last_message_at = now() WHERE id = $1`, [conversationId]);
    return rows[0]!.id;
  }

  /** Most recent turns of a single conversation, oldest-first for the LLM. */
  async history(conversationId: string, limit = 12): Promise<ChatMessage[]> {
    const { rows } = await this.db.query<ChatMessage>(
      `SELECT role, content FROM (
         SELECT role, content, created_at FROM messages
         WHERE conversation_id = $1 ORDER BY created_at DESC LIMIT ${limit}
       ) t ORDER BY created_at ASC`,
      [conversationId],
    );
    return rows;
  }

  /**
   * Full message history for a specific (agent, trust, participant) thread,
   * oldest-first, for display. Returns [] if the thread doesn't exist yet.
   * Because the caller passes the *resolved* trust + participant, an owner's
   * thread and a stranger's thread are never returned to the wrong requester.
   */
  async messagesFor(
    agentId: string,
    trust: TrustLevel,
    participantId: string,
    limit = 100,
  ): Promise<Array<{ role: string; content: string; created_at: string }>> {
    const conv = await this.db.query<{ id: string }>(
      `SELECT id FROM conversations WHERE agent_id=$1 AND trust=$2 AND participant_id=$3 LIMIT 1`,
      [agentId, trust, participantId],
    );
    const id = conv.rows[0]?.id;
    if (!id) return [];
    const { rows } = await this.db.query<{ role: string; content: string; created_at: string }>(
      `SELECT role, content, created_at FROM (
         SELECT role, content, created_at FROM messages
         WHERE conversation_id = $1 ORDER BY created_at DESC LIMIT ${limit}
       ) t ORDER BY created_at ASC`,
      [id],
    );
    return rows;
  }

  async lastOwnerMessageAt(agentId: string): Promise<Date | null> {
    const { rows } = await this.db.query<{ created_at: string }>(
      `SELECT created_at FROM messages
        WHERE agent_id = $1 AND trust = 'owner' AND role = 'user'
        ORDER BY created_at DESC LIMIT 1`,
      [agentId],
    );
    return rows[0] ? new Date(rows[0].created_at) : null;
  }
}
