import { config } from '../config.js';
import {
  type ChatHints,
  type CompleteHints,
  type LlmMessage,
  type LlmProvider,
  type LlmResult,
  estimateTokens,
} from './provider.js';

/**
 * Real Claude provider (Anthropic Messages API) via fetch — no SDK dependency.
 * Relies entirely on `system` + `messages`; `hints` are ignored. Because the
 * context assembler never places owner-private data into a stranger's system
 * prompt, the model cannot leak what it was never given.
 */
export class AnthropicProvider implements LlmProvider {
  readonly name = 'anthropic';
  private readonly apiKey: string;
  private readonly model = config.llm.anthropicModel;

  constructor() {
    if (!config.llm.anthropicApiKey) {
      throw new Error('LLM_PROVIDER=anthropic but ANTHROPIC_API_KEY is not set');
    }
    this.apiKey = config.llm.anthropicApiKey;
  }

  async chat(input: { system: string; messages: LlmMessage[]; hints?: ChatHints }): Promise<LlmResult> {
    return this.call(input.system, input.messages, 400);
  }

  async complete(input: { system: string; prompt: string; hints?: CompleteHints }): Promise<LlmResult> {
    const maxTokens = input.hints?.task === 'extract_memory' ? 500 : 200;
    return this.call(input.system, [{ role: 'user', content: input.prompt }], maxTokens);
  }

  private async call(system: string, messages: LlmMessage[], maxTokens: number): Promise<LlmResult> {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: this.model,
        max_tokens: maxTokens,
        system,
        messages: messages.map((m) => ({
          role: m.role === 'agent' ? 'assistant' : 'user',
          content: m.content,
        })),
      }),
    });

    if (!res.ok) {
      throw new Error(`Anthropic API ${res.status}: ${await res.text()}`);
    }

    const data: any = await res.json();
    const text: string = (data.content ?? [])
      .filter((b: any) => b.type === 'text')
      .map((b: any) => b.text)
      .join('')
      .trim();

    return {
      text,
      usage: {
        inputTokens: data.usage?.input_tokens ?? estimateTokens(system),
        outputTokens: data.usage?.output_tokens ?? estimateTokens(text),
      },
    };
  }
}
