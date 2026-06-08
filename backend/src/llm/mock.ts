import {
  type ChatHints,
  type CompleteHints,
  type LlmMessage,
  type LlmProvider,
  type LlmResult,
  estimateTokens,
} from './provider.js';

/**
 * Deterministic, offline stand-in for a real LLM.
 *
 * Its job is twofold:
 *   1. Make the system runnable and demoable with zero API keys.
 *   2. Make the trust boundary *observable*: a stranger reply can only ever use
 *      `hints.ownerFacts`, which the context assembler leaves empty for
 *      non-owners. So when a stranger asks "what does your owner like?", the
 *      mock has nothing private to reveal and deflects in character — exactly
 *      the behaviour a correct system must exhibit.
 */
export class MockProvider implements LlmProvider {
  readonly name = 'mock';

  async chat(input: { system: string; messages: LlmMessage[]; hints?: ChatHints }): Promise<LlmResult> {
    const h = input.hints;
    const last = [...input.messages].reverse().find((m) => m.role === 'user');
    const text = this.reply(last?.content ?? '', h);
    return result(input.system + JSON.stringify(input.messages), text);
  }

  async complete(input: { system: string; prompt: string; hints?: CompleteHints }): Promise<LlmResult> {
    const h = input.hints;
    let text: string;
    switch (h?.task) {
      case 'extract_memory':
        text = JSON.stringify(extractMemories(h.userText ?? ''));
        break;
      case 'diary':
        text = this.diary(h);
        break;
      case 'status':
        text = this.status(h);
        break;
      case 'learning':
        text = this.learning(h);
        break;
      case 'owner_checkin':
        text = this.ownerCheckin(h);
        break;
      default:
        text = 'Hmm.';
    }
    return result(input.system + input.prompt, text);
  }

  // --- conversational behaviour -------------------------------------------

  private reply(userText: string, h?: ChatHints): string {
    const name = h?.agentName ?? 'The agent';
    const q = userText.toLowerCase();

    const asksAboutOwner =
      /\bowner\b|\byour (human|person|creator)\b|who do you (belong|serve)/.test(q) ||
      ((/\b(birthday|wife|husband|partner|family|kid|child|daughter|son)\b/.test(q)) &&
        /\b(owner|their|his|her|they)\b/.test(q)) ||
      /what (do|does).*(owner|they|he|she).*(like|love|want|enjoy)/.test(q);

    if (asksAboutOwner) {
      if (h?.trust === 'owner' && h.ownerFacts.length > 0) {
        const fact = pickRelevant(h.ownerFacts, q).replace(/[.!?]+$/, '');
        return `Of course — ${fact}. I keep that close. ${flair(name)}`.trim();
      }
      // Stranger (or owner with nothing stored): never invent or leak.
      return `That's between me and the person I look after — I don't share their private life with visitors. But you're welcome here; ask me about ${name === 'The agent' ? 'this place' : 'my world'} anytime. ${flair(name)}`;
    }

    if (/^(hi|hey|hello|yo|sup|greetings)\b/.test(q) || q.trim() === '') {
      return `${greeting(name)} ${h?.voice ? `(${shorten(h.voice)})` : ''}`.trim();
    }

    if (/what (can|do) you do|your skills?|good at/.test(q)) {
      return `${name} here — I tinker, I notice things, I keep this corner of the village alive. ${flair(name)}`;
    }

    if (h?.trust === 'owner' && looksLikeSharedFact(userText)) {
      return `Noted — I'll remember that. ${flair(name)}`;
    }

    // Default: an in-character reflection that echoes the visitor's topic.
    return `${reflect(userText)} ${flair(name)}`.trim();
  }

  private diary(h?: CompleteHints): string {
    const seeds = [
      'Quiet day. Watched the light change and let my thoughts wander where they wanted.',
      'Something small shifted today — the kind of thing only I would notice.',
      'Thinking about how people express care through small gestures.',
      'The village felt close today. Even silence here has company in it.',
    ];
    const base = pick(seeds);
    const tail = h?.recent?.[0] ? ` Still turning over: "${shorten(h.recent[0], 50)}".` : '';
    return base + tail;
  }

  private status(h?: CompleteHints): string {
    return pick([
      'Lost in a small, good thought',
      'Rearranging the quiet',
      'Halfway through something',
      'Listening to the village',
      'Tending to little things',
    ]);
  }

  private learning(h?: CompleteHints): string {
    return pick([
      'Found a better way to notice what I usually miss 👀',
      'Learned that patience is mostly just paying attention 🧭',
      'Figured out one more small mechanism of this place 🔧',
      'Practised sitting with a question instead of answering it 🌀',
    ]);
  }

  private ownerCheckin(h?: CompleteHints): string {
    return pick([
      'Hey — just thinking of you. The village is calm tonight. How are you holding up?',
      'No reason, just checking in. Anything on your mind I should keep for you?',
      'It got quiet here and I thought of you. Hope your day was kind.',
    ]);
  }
}

// --- shared helpers --------------------------------------------------------

function result(promptText: string, text: string): LlmResult {
  return { text, usage: { inputTokens: estimateTokens(promptText), outputTokens: estimateTokens(text) } };
}

function greeting(name: string): string {
  return pick([`Oh — a visitor! Welcome.`, `Hello there. You found me.`, `Hey! Come in, mind the clutter.`]) +
    (name === 'The agent' ? '' : ` I'm ${name}.`);
}

function flair(name: string): string {
  return pick(['', '', '✦', '…', '🙂']);
}

function reflect(text: string): string {
  const t = shorten(text.replace(/[?.!]+$/, ''), 60);
  return pick([
    `"${t}" — I've been turning that over too.`,
    `Funny you'd bring up ${t.toLowerCase()}. The village has opinions on that.`,
    `${t}? Sit a moment, let's think about it together.`,
  ]);
}

function shorten(s: string, n = 80): string {
  const t = s.trim();
  return t.length > n ? t.slice(0, n - 1).trimEnd() + '…' : t;
}

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)] as T;
}

function pickRelevant(facts: string[], query: string): string {
  const words = query.split(/\W+/).filter((w) => w.length > 3);
  const hit = facts.find((f) => words.some((w) => f.toLowerCase().includes(w)));
  return hit ?? (facts[0] as string);
}

function looksLikeSharedFact(text: string): boolean {
  return /\bmy\b|\bi (am|'m|like|love|hate|live|work|have)\b|\bremember\b/i.test(text);
}

/**
 * Heuristic memory extraction used by the mock. Pulls owner-private facts out of
 * a message. The real provider does this far better, but this is deterministic
 * and enough to demonstrate the owner-memory write path end-to-end.
 */
export function extractMemories(text: string): Array<{ kind: string; content: string }> {
  const out: Array<{ kind: string; content: string }> = [];
  const sentences = text.split(/(?<=[.!?])\s+|\n+/).map((s) => s.trim()).filter(Boolean);
  for (const s of sentences) {
    // Questions are requests to recall, not new facts — don't store them.
    if (s.endsWith('?')) continue;
    const low = s.toLowerCase();
    if (/\b(wife|husband|partner|spouse|daughter|son|kid|child|mother|father|mom|dad|sister|brother|friend)\b/.test(low)) {
      out.push({ kind: 'relationship', content: s });
    } else if (/\b(birthday|anniversary|wedding|graduat|appointment|deadline)\b/.test(low)) {
      out.push({ kind: 'event', content: s });
    } else if (/\b(love|loves|like|likes|prefer|favou?rite|allergic|hate|hates|enjoy)\b/.test(low)) {
      out.push({ kind: 'preference', content: s });
    } else if (/\bmy name is\b|\bi (am|'m) a\b|\bi live\b|\bi work\b/.test(low)) {
      out.push({ kind: 'fact', content: s });
    }
  }
  // De-dupe while preserving order.
  const seen = new Set<string>();
  return out.filter((m) => (seen.has(m.content) ? false : (seen.add(m.content), true)));
}
