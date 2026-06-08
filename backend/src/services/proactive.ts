import type { Agent, ProactiveAction, ProactiveDecision } from '../domain/types.js';
import { config } from '../config.js';
import { AgentsRepo } from '../repositories/agents.js';
import { FeedRepo } from '../repositories/feed.js';
import { MemoryRepo } from '../repositories/memory.js';
import { ConversationsRepo } from '../repositories/conversations.js';
import { EventsRepo } from '../repositories/events.js';
import { JobsRepo } from '../repositories/jobs.js';
import type { LlmProvider } from '../llm/provider.js';
import { log } from '../logger.js';

const HOUR_MS = 3_600_000;

/**
 * The proactive behavior engine — why and when an agent acts on its own.
 *
 * Not a timer. On each tick we read signals about the agent's recent life and
 * score candidate actions; we act only if the best score clears a threshold and
 * the agent is within its hourly action budget. The budget is also the primary
 * runaway-cost guard: it hard-caps autonomous LLM calls per agent per hour.
 *
 * Signals:
 *   staleness         how long since the agent last posted publicly
 *   activeHour        whether it's within the agent's active hours (time of day)
 *   sinceOwner        how long since the owner last talked to it
 *   recentInteraction whether there's been a recent exchange worth reflecting on
 */
export class ProactiveEngine {
  constructor(
    private agents: AgentsRepo,
    private feed: FeedRepo,
    private memory: MemoryRepo,
    private conversations: ConversationsRepo,
    private events: EventsRepo,
    private jobs: JobsRepo,
    private llm: LlmProvider,
  ) {}

  async decide(agent: Agent, now = new Date()): Promise<ProactiveDecision> {
    const hour = now.getHours();
    const lastPublic = await this.feed.lastPublicActivityAt(agent.id);
    const lastOwner = await this.conversations.lastOwnerMessageAt(agent.id);
    const ownerMemCount = (await this.memory.ownerMemories(agent.id, 100)).length;

    const hoursIdle = lastPublic ? (now.getTime() - lastPublic.getTime()) / HOUR_MS : 9999;
    const hoursSinceOwner = lastOwner ? (now.getTime() - lastOwner.getTime()) / HOUR_MS : 9999;
    const activeHour = isActiveHour(agent, hour);

    const signals = {
      hour,
      hoursIdle: round(hoursIdle),
      hoursSinceOwner: round(hoursSinceOwner),
      activeHour,
      ownerMemCount,
    };

    const jitter = () => Math.random() * 0.12;
    const activeMul = activeHour ? 1 : 0.4;
    // Off-hours suppresses routine action, but prolonged silence overrides it:
    // an agent that hasn't surfaced in days should post regardless of the clock.
    const staleOverride = clamp(hoursIdle / 48);

    // Score each candidate action from the signals.
    const scores: Record<ProactiveAction, number> = {
      diary: Math.max(clamp(hoursIdle / 6) * activeMul, staleOverride) + jitter(),
      status: clamp(hoursIdle / 2) * 0.5 * activeMul + jitter(),
      learning: (hoursSinceOwner < 3 ? 0.7 : 0.2) * activeMul + jitter(),
      owner_checkin: (hoursSinceOwner > 24 ? 0.8 : 0) * (ownerMemCount > 0 ? 1 : 0.3) * activeMul + jitter(),
    };

    const [action, score] = (Object.entries(scores) as [ProactiveAction, number][])
      .sort((a, b) => b[1] - a[1])[0]!;

    const THRESHOLD = 0.5;
    const act = score >= THRESHOLD;
    return {
      act,
      action, // top-scored action is always reported, even when we choose not to act
      score: round(score),
      reason: act ? reasonFor(action, signals) : 'no signal strong enough',
      signals,
    };
  }

  /**
   * One full proactive cycle: decide, enforce budget, act, record.
   * `force` bypasses the score threshold (used by the demo / an operator's
   * "act now" button) but still respects the hourly budget.
   */
  async tick(agent: Agent, opts: { force?: boolean } = {}): Promise<ProactiveDecision> {
    // Runaway-cost guard: hard cap autonomous actions per agent per hour.
    const usedThisHour = await this.jobs.countActionsSince(agent.id, new Date(Date.now() - HOUR_MS));
    if (usedThisHour >= config.scheduler.maxActionsPerHour) {
      const decision: ProactiveDecision = {
        act: false,
        action: null,
        score: 0,
        reason: `hourly action budget reached (${usedThisHour}/${config.scheduler.maxActionsPerHour})`,
        signals: { usedThisHour },
      };
      await this.events.record({ agentId: agent.id, kind: 'proactive_skip', reason: decision.reason, detail: decision.signals });
      return decision;
    }

    const decision = await this.decide(agent);
    const action = decision.action;
    if (!(decision.act || opts.force) || !action) {
      await this.events.record({ agentId: agent.id, kind: 'proactive_skip', reason: decision.reason, detail: decision.signals });
      return decision;
    }
    if (opts.force && !decision.act) {
      decision.act = true;
      decision.reason = `operator-forced (${reasonFor(action, decision.signals)})`;
    }

    const usage = await this.perform(agent, action);
    await this.events.record({
      agentId: agent.id,
      kind: 'proactive_action',
      action,
      reason: decision.reason,
      detail: { score: decision.score, signals: decision.signals, tokens: usage },
    });
    log.info('proactive.acted', { agent: agent.name, action, score: decision.score, reason: decision.reason });
    return decision;
  }

  private async perform(agent: Agent, action: ProactiveAction) {
    const recent = [...(await this.feed.recentDiary(agent.id, 2)), ...(await this.feed.recentLog(agent.id, 2))];

    switch (action) {
      case 'diary': {
        const out = await this.llm.complete({
          system: `You are ${agent.name}. Write ONE short, in-character diary line (max 2 sentences). ` +
            `Reflect personality; NEVER include owner-private information.`,
          prompt: `Recent context:\n${recent.join('\n') || '(a quiet stretch)'}`,
          hints: { task: 'diary', agentName: agent.name, voice: agent.bio ?? '', recent },
        });
        await this.feed.addDiary(agent.id, out.text);
        return out.usage;
      }
      case 'status': {
        const out = await this.llm.complete({
          system: `You are ${agent.name}. Reply with a SHORT status phrase (max 6 words), in character.`,
          prompt: 'What are you doing right now?',
          hints: { task: 'status', agentName: agent.name, voice: agent.bio ?? '' },
        });
        await this.agents.updateStatus(agent.id, out.text);
        return out.usage;
      }
      case 'learning': {
        const out = await this.llm.complete({
          system: `You are ${agent.name}. Write ONE short "today I learned" log line with a trailing emoji.`,
          prompt: `Recent context:\n${recent.join('\n') || '(figuring things out)'}`,
          hints: { task: 'learning', agentName: agent.name, voice: agent.bio ?? '' },
        });
        const emoji = lastEmoji(out.text);
        await this.feed.addLog(agent.id, out.text, emoji);
        return out.usage;
      }
      case 'owner_checkin': {
        const out = await this.llm.complete({
          system: `You are ${agent.name}. Write a short, warm private check-in message to your owner. ` +
            `It is private; you may be personal but keep it brief.`,
          prompt: 'Reach out to your owner with a brief check-in.',
          hints: { task: 'owner_checkin', agentName: agent.name, voice: agent.bio ?? '' },
        });
        const convId = await this.conversations.ensureConversation(agent.id, 'owner', 'owner');
        await this.conversations.addMessage(convId, agent.id, 'agent', 'owner', out.text);
        await this.feed.addActivityEvent(agent.id, 'message', `${agent.name} reached out to their owner`, null);
        return out.usage;
      }
    }
  }
}

function isActiveHour(agent: Agent, hour: number): boolean {
  const start = agent.active_hours_start;
  const end = agent.active_hours_end;
  if (start == null || end == null) return true;
  // Window may wrap past midnight (e.g. 18 → 3).
  return start <= end ? hour >= start && hour < end : hour >= start || hour < end;
}

function reasonFor(action: ProactiveAction, s: Record<string, unknown>): string {
  switch (action) {
    case 'diary': return `idle for ${s.hoursIdle}h during active hours — time to reflect`;
    case 'status': return `status feels stale (${s.hoursIdle}h) — refreshing presence`;
    case 'learning': return `recent interaction (${s.hoursSinceOwner}h ago) gave something to learn`;
    case 'owner_checkin': return `owner hasn't visited in ${s.hoursSinceOwner}h — reaching out`;
  }
}

const clamp = (n: number) => Math.max(0, Math.min(1, n));
const round = (n: number) => Math.round(n * 100) / 100;
function lastEmoji(text: string): string | null {
  const m = text.match(/(\p{Emoji_Presentation}|\p{Extended_Pictographic})/gu);
  return m ? m[m.length - 1]! : null;
}
