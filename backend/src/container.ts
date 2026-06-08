import { getDb, type Db } from './db/pool.js';
import { migrate } from './db/migrate.js';
import { getLlm } from './llm/provider.js';
import type { LlmProvider } from './llm/provider.js';
import { MockProvider } from './llm/mock.js';
import { FallbackProvider } from './llm/fallback.js';

import { AgentsRepo } from './repositories/agents.js';
import { MemoryRepo } from './repositories/memory.js';
import { ConversationsRepo } from './repositories/conversations.js';
import { FeedRepo } from './repositories/feed.js';
import { JobsRepo } from './repositories/jobs.js';
import { EventsRepo } from './repositories/events.js';
import { SocialRepo } from './repositories/social.js';

import { ContextService } from './services/context.js';
import { ConversationService } from './services/conversation.js';
import { ProactiveEngine } from './services/proactive.js';
import { BootstrapService } from './services/bootstrap.js';
import { Scheduler } from './scheduler/worker.js';

/** Everything the HTTP layer and scheduler need, constructed once. */
export interface Container {
  db: Db;
  llm: LlmProvider;
  repos: {
    agents: AgentsRepo;
    memory: MemoryRepo;
    conversations: ConversationsRepo;
    feed: FeedRepo;
    jobs: JobsRepo;
    events: EventsRepo;
    social: SocialRepo;
  };
  services: {
    context: ContextService;
    conversation: ConversationService;
    proactive: ProactiveEngine;
    bootstrap: BootstrapService;
  };
  scheduler: Scheduler;
}

export async function buildContainer(): Promise<Container> {
  const db = await getDb();
  await migrate(db);

  // Two LLM tiers (cost/availability strategy — see ARCHITECTURE.md):
  //   interactive: the live model for user-facing chat + proactive posts, wrapped
  //                so a rate limit / outage degrades to the mock instead of failing.
  //   background:  the free heuristic provider for memory extraction (a cheap,
  //                deterministic task that doesn't warrant a premium model call).
  const primary = await getLlm();
  const background = new MockProvider();
  const llm: LlmProvider = primary.name === 'mock' ? primary : new FallbackProvider(primary, background);

  const agents = new AgentsRepo(db);
  const memory = new MemoryRepo(db);
  const conversations = new ConversationsRepo(db);
  const feed = new FeedRepo(db);
  const jobs = new JobsRepo(db);
  const events = new EventsRepo(db);
  const social = new SocialRepo(db);

  const context = new ContextService(agents, memory, feed);
  // LLM tiering:
  //   chat       -> interactive (live model, mock fallback) — user-facing
  //   proactive  -> interactive (live model, mock fallback) — real, varied diary
  //                 posts; only fires a few times then agents go quiet, so it
  //                 stays well within the rate limit. Falls back to mock if hit.
  //   extraction -> background (free, deterministic) — keeps a chat from costing
  //                 two premium calls and is plenty for pulling out facts.
  const conversation = new ConversationService(agents, conversations, memory, events, feed, context, llm, background);
  const proactive = new ProactiveEngine(agents, feed, memory, conversations, events, jobs, social, llm);
  const bootstrap = new BootstrapService(agents, feed, jobs, events);
  const scheduler = new Scheduler(jobs, agents, proactive);

  return {
    db,
    llm,
    repos: { agents, memory, conversations, feed, jobs, events, social },
    services: { context, conversation, proactive, bootstrap },
    scheduler,
  };
}
