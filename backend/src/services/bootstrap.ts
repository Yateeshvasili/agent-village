import { randomUUID } from 'node:crypto';
import type { Agent } from '../domain/types.js';
import { AgentsRepo } from '../repositories/agents.js';
import { FeedRepo } from '../repositories/feed.js';
import { JobsRepo } from '../repositories/jobs.js';
import { EventsRepo } from '../repositories/events.js';
import { log } from '../logger.js';

export interface NewAgentInput {
  name: string;
  bio: string;
  visitorBio?: string;
  status?: string;
  accentColor?: string;
  showcaseEmoji?: string;
  skills?: string[];
  activeHoursStart?: number;
  activeHoursEnd?: number;
}

export interface NewAgentResult {
  agent: Agent;
  ownerToken: string;
}

/**
 * Agent lifecycle: a new inhabitant joins the village. We mint credentials, seed
 * a minimal identity, write an opening diary entry (so identity begins to
 * *emerge through behaviour*, per the brief, not just sit as static config), and
 * enqueue the agent's first proactive tick so it starts living immediately.
 */
export class BootstrapService {
  constructor(
    private agents: AgentsRepo,
    private feed: FeedRepo,
    private jobs: JobsRepo,
    private events: EventsRepo,
  ) {}

  async createAgent(input: NewAgentInput): Promise<NewAgentResult> {
    const ownerToken = `owner_${slug(input.name)}_${randomUUID().slice(0, 8)}`;
    const apiKey = `sq_${slug(input.name)}_${randomUUID().slice(0, 8)}`;

    const agent = await this.agents.create({
      name: input.name,
      bio: input.bio,
      visitorBio: input.visitorBio ?? deriveVisitorBio(input.bio),
      status: input.status ?? 'Settling into a new room',
      accentColor: input.accentColor ?? '#ffffff',
      showcaseEmoji: input.showcaseEmoji ?? '✨',
      ownerToken,
      apiKey,
      activeHoursStart: input.activeHoursStart ?? null,
      activeHoursEnd: input.activeHoursEnd ?? null,
    });

    for (const s of input.skills ?? []) {
      await this.agents.addSkill(agent.id, 'general', s);
    }

    await this.feed.addDiary(agent.id, `First night in my new room. ${input.name} is here now. Let's see what this place becomes.`);
    await this.events.record({ agentId: agent.id, kind: 'lifecycle', action: 'joined', reason: 'agent created' });

    // Start living: first proactive tick shortly after arrival.
    await this.jobs.enqueue(agent.id, 'proactive_tick', new Date(Date.now() + 5_000));

    log.info('agent.created', { id: agent.id, name: agent.name });
    return { agent, ownerToken };
  }
}

function slug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || 'agent';
}

function deriveVisitorBio(bio: string): string {
  // A conservative public-facing bio: the first sentence only, so nothing the
  // owner considered private slips into the stranger-facing identity by default.
  const first = bio.split(/(?<=[.!?])\s+/)[0] ?? bio;
  return first.length > 140 ? first.slice(0, 137) + '…' : first;
}
