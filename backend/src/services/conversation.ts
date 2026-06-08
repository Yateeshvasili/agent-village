import type { Agent, ResolvedRequester } from '../domain/types.js';
import { AgentsRepo } from '../repositories/agents.js';
import { ConversationsRepo } from '../repositories/conversations.js';
import { MemoryRepo } from '../repositories/memory.js';
import { EventsRepo } from '../repositories/events.js';
import { FeedRepo } from '../repositories/feed.js';
import { ContextService } from './context.js';
import type { LlmProvider } from '../llm/provider.js';
import { log } from '../logger.js';

export interface ChatResult {
  reply: string;
  conversationId: string;
  memoriesLearned: number;
}

/**
 * Orchestrates a single inbound message under a resolved trust context:
 * assemble trust-scoped context → generate a reply → persist the turn → and,
 * for the OWNER only, extract and store any new private memories.
 */
export class ConversationService {
  constructor(
    private agents: AgentsRepo,
    private conversations: ConversationsRepo,
    private memory: MemoryRepo,
    private events: EventsRepo,
    private feed: FeedRepo,
    private context: ContextService,
    private llm: LlmProvider,
    /** Cheap/free provider for memory extraction — keeps premium quota for chat. */
    private extractor: LlmProvider = llm,
  ) {}

  async handleMessage(agent: Agent, requester: ResolvedRequester, userText: string): Promise<ChatResult> {
    const { trust, participantId } = requester;
    const convId = await this.conversations.ensureConversation(agent.id, trust, participantId);

    const userMsgId = await this.conversations.addMessage(convId, agent.id, 'user', trust, userText);
    await this.events.record({
      agentId: agent.id,
      kind: 'message_in',
      trust,
      reason: `inbound message from ${participantId}`,
    });

    // Trust-scoped context. Strangers never get owner-private data loaded here.
    const ctx = await this.context.forChat(agent, trust);
    const history = await this.conversations.history(convId, 12);

    const completion = await this.llm.chat({
      system: ctx.system,
      messages: [...history, { role: 'user', content: userText }],
      hints: { agentName: agent.name, voice: ctx.voice, trust, ownerFacts: ctx.ownerFacts },
    });

    await this.conversations.addMessage(convId, agent.id, 'agent', trust, completion.text);
    await this.events.record({
      agentId: agent.id,
      kind: 'message_out',
      trust,
      reason: 'agent reply',
      detail: { tokens: completion.usage },
    });

    let memoriesLearned = 0;
    if (trust === 'owner') {
      memoriesLearned = await this.learnFromOwner(agent, userText, userMsgId);
    }

    log.info('conversation.handled', {
      agent: agent.name,
      trust,
      memoriesLearned,
      tokens: completion.usage.inputTokens + completion.usage.outputTokens,
    });

    return { reply: completion.text, conversationId: convId, memoriesLearned };
  }

  /** Owner-only: pull durable private facts out of the message into owner_memory. */
  private async learnFromOwner(agent: Agent, userText: string, sourceMessageId: string): Promise<number> {
    const out = await this.extractor.complete({
      system:
        'Extract durable, owner-private facts worth remembering from the user message. ' +
        'Return ONLY a JSON array of objects {"kind","content"} where kind is one of ' +
        'fact|preference|event|relationship. Empty array if nothing is worth storing.',
      prompt: userText,
      hints: { task: 'extract_memory', userText },
    });

    let items: Array<{ kind: string; content: string }> = [];
    try {
      const parsed = JSON.parse(extractJsonArray(out.text));
      if (Array.isArray(parsed)) items = parsed.filter((m) => m && typeof m.content === 'string');
    } catch {
      items = [];
    }

    for (const m of items) {
      const kind = ['fact', 'preference', 'event', 'relationship'].includes(m.kind) ? m.kind : 'fact';
      await this.memory.addOwnerMemory(agent.id, kind, m.content, sourceMessageId);
    }
    if (items.length) {
      await this.events.record({
        agentId: agent.id,
        kind: 'memory_learned',
        trust: 'owner',
        reason: `stored ${items.length} private memory item(s)`,
        detail: { kinds: items.map((i) => i.kind) },
      });
    }
    return items.length;
  }
}

/** Tolerantly pull the first JSON array out of a model response. */
function extractJsonArray(text: string): string {
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  return start >= 0 && end > start ? text.slice(start, end + 1) : '[]';
}
