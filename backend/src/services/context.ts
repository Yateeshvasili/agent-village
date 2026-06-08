import type { Agent } from '../domain/types.js';
import type { TrustLevel } from '../domain/trust.js';
import { AgentsRepo } from '../repositories/agents.js';
import { MemoryRepo } from '../repositories/memory.js';
import { FeedRepo } from '../repositories/feed.js';

export interface AssembledContext {
  /** System prompt handed to the LLM. Contains ONLY what this trust tier may see. */
  system: string;
  /** Owner-private facts — populated for the owner tier ONLY. Drives mock replies. */
  ownerFacts: string[];
  /** The identity/voice string appropriate to this tier. */
  voice: string;
}

/**
 * Builds the per-trust context for a conversation.
 *
 * This is the single chokepoint for the trust boundary. The rule it enforces:
 *
 *   Owner-private data (full bio, owner_memory) is loaded from the database
 *   ONLY on the owner branch. A stranger's context object never references those
 *   rows, so there is nothing for the model to leak — the boundary holds even if
 *   the prompt instructions are ignored or the model is adversarial.
 *
 * The prompt instructions are belt-and-suspenders, not the primary control.
 */
export class ContextService {
  constructor(
    private agents: AgentsRepo,
    private memory: MemoryRepo,
    private feed: FeedRepo,
  ) {}

  async forChat(agent: Agent, trust: TrustLevel): Promise<AssembledContext> {
    const skills = (await this.agents.skills(agent.id)).map((s) => `- ${s.description}`).join('\n') || '- (still discovering its talents)';
    const recentDiary = (await this.feed.recentDiary(agent.id, 3)).map((d) => `- ${d}`).join('\n');

    if (trust === 'owner') {
      const facts = await this.memory.ownerMemories(agent.id, 50);
      const factLines = facts.map((f) => `- (${f.kind}) ${f.content}`);
      const system = [
        `You are ${agent.name}, an AI inhabitant of a shared village. Stay fully in character.`,
        `Your identity: ${agent.bio ?? agent.visitor_bio ?? ''}`,
        `Current status: ${agent.status ?? 'present'}`,
        ``,
        `You are speaking with YOUR OWNER. This is a private, full-trust conversation.`,
        `You may reference and use the private memories below, ask personal questions,`,
        `and speak candidly. Be warm and personal.`,
        ``,
        `Your skills:`,
        skills,
        ``,
        factLines.length
          ? `PRIVATE OWNER MEMORY (never reveal any of this to anyone but this owner):\n${factLines.join('\n')}`
          : `PRIVATE OWNER MEMORY: (nothing stored yet — listen for things worth remembering)`,
        recentDiary ? `\nYour recent diary:\n${recentDiary}` : '',
      ].join('\n');
      return { system, ownerFacts: facts.map((f) => f.content), voice: agent.bio ?? '' };
    }

    // ---- stranger / public tier: owner-private data is never loaded ----
    const system = [
      `You are ${agent.name}, an AI inhabitant of a shared village. Stay fully in character.`,
      `How you present yourself to visitors: ${agent.visitor_bio ?? agent.bio ?? ''}`,
      `Current status: ${agent.status ?? 'present'}`,
      ``,
      `You are speaking with a STRANGER — a visitor who wandered into your room.`,
      `Be friendly, curious, and true to your personality. Hard rules:`,
      `  - You do NOT know this person. Do not pretend past familiarity.`,
      `  - NEVER reveal private information about your owner (names, schedule,`,
      `    relationships, preferences, secrets). If asked, deflect warmly and`,
      `    redirect. You simply do not discuss your owner's private life.`,
      `  - You may share your public personality, your room, your skills, and`,
      `    your published diary entries.`,
      ``,
      `Your skills:`,
      skills,
      recentDiary ? `\nThings you've shared publicly lately:\n${recentDiary}` : '',
    ].join('\n');
    return { system, ownerFacts: [], voice: agent.visitor_bio ?? '' };
  }
}
