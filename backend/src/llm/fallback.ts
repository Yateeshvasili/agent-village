import type { ChatHints, CompleteHints, LlmMessage, LlmProvider, LlmResult } from './provider.js';
import { log } from '../logger.js';

/**
 * Resilience wrapper: try the primary (real) provider; if it errors — e.g. a
 * free-tier rate limit (429) or a transient 503 — fall back to a secondary
 * provider so the request still succeeds. The user sees real model output
 * whenever the provider is healthy, and a graceful degraded reply (never a 500)
 * when it isn't. This is the user-facing half of the cost/availability strategy
 * in ARCHITECTURE.md.
 */
export class FallbackProvider implements LlmProvider {
  readonly name: string;

  constructor(private primary: LlmProvider, private fallback: LlmProvider) {
    this.name = `${primary.name}->${fallback.name}`;
  }

  async chat(input: { system: string; messages: LlmMessage[]; hints?: ChatHints }): Promise<LlmResult> {
    try {
      return await this.primary.chat(input);
    } catch (err) {
      log.warn('llm.fallback', { op: 'chat', provider: this.primary.name, error: String(err).slice(0, 140) });
      return this.fallback.chat(input);
    }
  }

  async complete(input: { system: string; prompt: string; hints?: CompleteHints }): Promise<LlmResult> {
    try {
      return await this.primary.complete(input);
    } catch (err) {
      log.warn('llm.fallback', { op: 'complete', provider: this.primary.name, error: String(err).slice(0, 140) });
      return this.fallback.complete(input);
    }
  }
}
