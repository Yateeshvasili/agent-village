import { config } from '../config.js';
import { JobsRepo } from '../repositories/jobs.js';
import { AgentsRepo } from '../repositories/agents.js';
import { ProactiveEngine } from '../services/proactive.js';
import { log } from '../logger.js';

/**
 * Background worker loop. Drains due jobs from the durable queue, dispatches
 * them, and reschedules the next proactive tick per agent with jitter so agents
 * don't act in lockstep.
 *
 * This is intentionally a thin loop over a persistent queue rather than a bag of
 * setInterval timers: the *state* lives in Postgres, so any number of worker
 * processes can run this same loop and (via SKIP LOCKED) split the work without
 * coordination. Scaling the scheduler is "run more workers."
 */
export class Scheduler {
  private running = false;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private jobs: JobsRepo,
    private agents: AgentsRepo,
    private proactive: ProactiveEngine,
  ) {}

  async start(): Promise<void> {
    if (!config.scheduler.enabled) {
      log.info('scheduler.disabled');
      return;
    }
    this.running = true;
    // Make sure every existing agent has a tick queued (e.g. after a restart).
    await this.jobs.ensurePendingForAll('proactive_tick', new Date(Date.now() + 2_000));
    log.info('scheduler.started', { pollMs: config.scheduler.pollMs, tickMs: config.scheduler.proactiveTickMs });
    void this.loop();
  }

  stop(): void {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
  }

  private loop(): void {
    if (!this.running) return;
    void this.drain()
      .catch((err) => log.error('scheduler.drain_error', { error: String(err) }))
      .finally(() => {
        if (this.running) this.timer = setTimeout(() => this.loop(), config.scheduler.pollMs);
      });
  }

  /** Process all jobs that are currently due, then return. */
  private async drain(): Promise<void> {
    for (;;) {
      const job = await this.jobs.claimDue();
      if (!job) return;
      try {
        await this.process(job.agent_id, job.job_type);
        await this.jobs.complete(job.id);
      } catch (err) {
        log.error('scheduler.job_failed', { jobId: job.id, error: String(err) });
        await this.jobs.fail(job.id, String(err));
      } finally {
        // Keep the agent alive regardless of this tick's outcome.
        if (job.job_type === 'proactive_tick') {
          await this.jobs.enqueue(job.agent_id, 'proactive_tick', nextTickAt());
        }
      }
    }
  }

  private async process(agentId: string, jobType: string): Promise<void> {
    if (jobType !== 'proactive_tick') {
      log.warn('scheduler.unknown_job', { jobType });
      return;
    }
    const agent = await this.agents.byId(agentId);
    if (!agent) return;
    await this.proactive.tick(agent);
  }
}

function nextTickAt(): Date {
  const base = config.scheduler.proactiveTickMs;
  const jitter = base * (0.5 + Math.random()); // 0.5x–1.5x base
  return new Date(Date.now() + jitter);
}
