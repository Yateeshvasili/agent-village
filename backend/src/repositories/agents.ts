import type { Db } from '../db/pool.js';
import type { Agent, Skill } from '../domain/types.js';

const AGENT_COLS = `id, api_key, owner_token, name, bio, visitor_bio, status, accent_color,
  avatar_url, showcase_emoji, active_hours_start, active_hours_end, created_at`;

export class AgentsRepo {
  constructor(private db: Db) {}

  async list(): Promise<Agent[]> {
    const { rows } = await this.db.query<Agent>(`SELECT ${AGENT_COLS} FROM living_agents ORDER BY created_at`);
    return rows;
  }

  async byId(id: string): Promise<Agent | null> {
    const { rows } = await this.db.query<Agent>(`SELECT ${AGENT_COLS} FROM living_agents WHERE id = $1`, [id]);
    return rows[0] ?? null;
  }

  /** Resolve an agent by either its public id or its unique name. */
  async byIdOrName(idOrName: string): Promise<Agent | null> {
    const { rows } = await this.db.query<Agent>(
      `SELECT ${AGENT_COLS} FROM living_agents WHERE id::text = $1 OR name = $1 LIMIT 1`,
      [idOrName],
    );
    return rows[0] ?? null;
  }

  async byOwnerToken(token: string): Promise<Agent | null> {
    const { rows } = await this.db.query<Agent>(
      `SELECT ${AGENT_COLS} FROM living_agents WHERE owner_token = $1`,
      [token],
    );
    return rows[0] ?? null;
  }

  async skills(agentId: string): Promise<Skill[]> {
    const { rows } = await this.db.query<Skill>(
      `SELECT id, agent_id, category, description FROM living_skills WHERE agent_id = $1 ORDER BY created_at`,
      [agentId],
    );
    return rows;
  }

  async create(input: {
    name: string;
    bio: string;
    visitorBio: string;
    status: string;
    accentColor: string;
    showcaseEmoji: string;
    ownerToken: string;
    apiKey: string;
    activeHoursStart: number | null;
    activeHoursEnd: number | null;
  }): Promise<Agent> {
    const { rows } = await this.db.query<Agent>(
      `INSERT INTO living_agents
        (api_key, owner_token, name, bio, visitor_bio, status, accent_color, showcase_emoji,
         active_hours_start, active_hours_end)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       RETURNING ${AGENT_COLS}`,
      [
        input.apiKey,
        input.ownerToken,
        input.name,
        input.bio,
        input.visitorBio,
        input.status,
        input.accentColor,
        input.showcaseEmoji,
        input.activeHoursStart,
        input.activeHoursEnd,
      ],
    );
    return rows[0] as Agent;
  }

  async addSkill(agentId: string, category: string, description: string): Promise<void> {
    await this.db.query(
      `INSERT INTO living_skills (agent_id, category, description) VALUES ($1, $2, $3)`,
      [agentId, category, description],
    );
  }

  async updateStatus(agentId: string, status: string): Promise<void> {
    await this.db.query(`UPDATE living_agents SET status = $2, updated_at = now() WHERE id = $1`, [agentId, status]);
  }
}
