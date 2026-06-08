import 'dotenv/config';

/** Centralised, typed configuration. Read env once; fail loud on bad values. */
function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`Env ${name} must be a number, got "${raw}"`);
  return n;
}

function bool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  return raw === 'true' || raw === '1';
}

export const config = {
  port: num('PORT', 8787),

  /** Unset => in-memory Postgres (pg-mem). Set => real Postgres / Supabase. */
  databaseUrl: process.env.DATABASE_URL || null,

  llm: {
    provider: (process.env.LLM_PROVIDER || 'mock') as 'mock' | 'anthropic' | 'gemini',
    anthropicApiKey: process.env.ANTHROPIC_API_KEY || null,
    anthropicModel: process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6',
    geminiApiKey: process.env.GEMINI_API_KEY || null,
    geminiModel: process.env.GEMINI_MODEL || 'gemini-2.0-flash',
  },

  scheduler: {
    enabled: bool('SCHEDULER_ENABLED', true),
    pollMs: num('SCHEDULER_POLL_MS', 2000),
    proactiveTickMs: num('PROACTIVE_TICK_MS', 20_000),
    maxActionsPerHour: num('PROACTIVE_MAX_ACTIONS_PER_HOUR', 6),
  },
} as const;

export type Config = typeof config;
