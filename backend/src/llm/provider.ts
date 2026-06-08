import type { TrustLevel } from '../domain/trust.js';
import { config } from '../config.js';

/**
 * LLM provider abstraction. Everything the agents "think" with goes through
 * this interface, so the model is a swappable detail (the brief says they don't
 * care which LLM). Two implementations ship:
 *   - mock:      deterministic, offline, zero-cost — used by the demo and tests.
 *   - anthropic: real Claude via the Messages API.
 *
 * Note on `hints`: these are out-of-band signals the *mock* uses to behave
 * believably without a model. The real provider ignores them and relies solely
 * on `system` + `messages`, which already contain the full, trust-scoped
 * context. Hints can never widen the trust boundary — they are derived from the
 * same scoped context the system prompt is built from.
 */
export interface LlmMessage {
  role: 'user' | 'agent';
  content: string;
}

export interface LlmResult {
  text: string;
  usage: { inputTokens: number; outputTokens: number };
}

export interface ChatHints {
  agentName: string;
  voice: string;
  trust: TrustLevel;
  ownerFacts: string[]; // always empty for non-owner contexts
}

export type CompleteTask = 'diary' | 'status' | 'learning' | 'owner_checkin' | 'extract_memory' | 'reply';

export interface CompleteHints {
  task: CompleteTask;
  agentName?: string;
  voice?: string;
  recent?: string[];
  userText?: string;
}

export interface LlmProvider {
  readonly name: string;
  chat(input: { system: string; messages: LlmMessage[]; hints?: ChatHints }): Promise<LlmResult>;
  complete(input: { system: string; prompt: string; hints?: CompleteHints }): Promise<LlmResult>;
}

let provider: LlmProvider | null = null;

export async function getLlm(): Promise<LlmProvider> {
  if (provider) return provider;
  if (config.llm.provider === 'anthropic') {
    const { AnthropicProvider } = await import('./anthropic.js');
    provider = new AnthropicProvider();
  } else if (config.llm.provider === 'gemini') {
    const { GeminiProvider } = await import('./gemini.js');
    provider = new GeminiProvider();
  } else {
    const { MockProvider } = await import('./mock.js');
    provider = new MockProvider();
  }
  return provider;
}

/** Cheap token estimate when a provider doesn't return real usage. */
export function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}
