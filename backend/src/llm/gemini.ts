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
 * Google Gemini provider (Generative Language API) via fetch — no SDK.
 * Same contract as the other providers: relies on `system` + `messages`, and
 * because the context assembler never puts owner-private data into a stranger's
 * system prompt, the model cannot leak what it was never given.
 */
export class GeminiProvider implements LlmProvider {
  readonly name = 'gemini';
  private readonly apiKey: string;
  private readonly model = config.llm.geminiModel;

  constructor() {
    if (!config.llm.geminiApiKey) {
      throw new Error('LLM_PROVIDER=gemini but GEMINI_API_KEY is not set');
    }
    this.apiKey = config.llm.geminiApiKey;
  }

  async chat(input: { system: string; messages: LlmMessage[]; hints?: ChatHints }): Promise<LlmResult> {
    return this.call(input.system, input.messages, 500);
  }

  async complete(input: { system: string; prompt: string; hints?: CompleteHints }): Promise<LlmResult> {
    const maxTokens = input.hints?.task === 'extract_memory' ? 600 : 220;
    return this.call(input.system, [{ role: 'user', content: input.prompt }], maxTokens);
  }

  private async call(system: string, messages: LlmMessage[], maxOutputTokens: number): Promise<LlmResult> {
    const url =
      `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:generateContent?key=${this.apiKey}`;

    const body = {
      systemInstruction: { parts: [{ text: system }] },
      contents: messages.map((m) => ({
        role: m.role === 'agent' ? 'model' : 'user',
        parts: [{ text: m.content }],
      })),
      generationConfig: { maxOutputTokens, temperature: 0.9 },
    };

    // Retry only on transient server spikes (503/500). NOT on 429: a 429 means
    // the per-minute quota is exhausted, and each retry is another request that
    // burns the very quota we're waiting on — so we surface it immediately and
    // let the FallbackProvider degrade gracefully to the mock.
    let data: any = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (res.ok) {
        data = await res.json();
        break;
      }
      const err = `Gemini API ${res.status}: ${await res.text()}`;
      const transient = res.status === 503 || res.status === 500;
      if (!transient || attempt === 2) throw new Error(err);
      await sleep(500 * (attempt + 1)); // 500ms, 1000ms
    }
    const text: string = (data.candidates?.[0]?.content?.parts ?? [])
      .map((p: any) => p.text ?? '')
      .join('')
      .trim();

    return {
      text: text || '…',
      usage: {
        inputTokens: data.usageMetadata?.promptTokenCount ?? estimateTokens(system),
        outputTokens: data.usageMetadata?.candidatesTokenCount ?? estimateTokens(text),
      },
    };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
