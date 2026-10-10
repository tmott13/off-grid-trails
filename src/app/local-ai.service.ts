import { Injectable, signal } from '@angular/core';
import type { MLCEngine } from '@mlc-ai/web-llm';

/** Small Gemma first; the 2B model is the backup, but never on iPhone/iPad (it needs too much memory). */
const IOS = typeof navigator !== 'undefined' &&
  (/iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1));
const MODELS = IOS ? ['gemma3-1b-it-q4f16_1-MLC'] : ['gemma3-1b-it-q4f16_1-MLC', 'gemma-2-2b-it-q4f16_1-MLC-1k'];
/**
 * A short 1,024-token context keeps memory low (our prompts are ~500 tokens).
 * WebLLM allows only one window setting, so the sliding window is turned off (-1).
 */
const CHAT_OPTS = { context_window_size: 1024, sliding_window_size: -1 };

// Crash guard: if Safari kills the tab while Gemma loads, we remember it and never auto-load again,
// so the app can't get stuck in a crash loop.
const LOADING = 'ogt.gemma.loading';
const OK = 'ogt.gemma.ok';
const flag = {
  get: (k: string) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
  del: (k: string) => { try { localStorage.removeItem(k); } catch { /* private mode */ } },
};

export type AiState = 'unsupported' | 'idle' | 'downloading' | 'loading' | 'ready' | 'error';

const RULES = `You are a calm trail buddy inside an offline hiking app. The phone has no cell service.
Answer ONLY from the FACTS. Never invent trails, distances or directions that are not in the FACTS.
Keep it to 2–3 short sentences. Be warm and steady. If someone sounds lost or hurt, tell them to stop,
stay put, stay warm, and call 911 if they can (emergency calls and texts can sometimes get through
when normal service can't). You are not a replacement for a paper map.`;

/**
 * Gemma runs entirely on the phone with WebLLM (WebGPU). After a one-time download over Wi-Fi,
 * it is cached in the browser and answers with zero signal.
 */
@Injectable({ providedIn: 'root' })
export class LocalAiService {
  readonly state = signal<AiState>(hasWebGpu() ? 'idle' : 'unsupported');
  readonly progress = signal(0);
  readonly status = signal('');
  readonly modelId = signal<string | null>(null);
  /** True when the last load attempt crashed the page. */
  readonly crashed = signal(false);

  private engine: MLCEngine | null = null;

  /** Load straight away if the model is already on the phone (no network needed). */
  async loadIfCached() {
    if (this.state() !== 'idle') return;
    if (flag.get(LOADING)) {
      flag.del(LOADING);
      flag.del(OK);
      this.crashed.set(true);
      this.state.set('error');
      this.status.set('Gemma closed the page last time it loaded, most likely because the phone ran short on memory.');
      return;
    }
    if (!flag.get(OK)) return; // only auto-load after one successful load
    try {
      const { hasModelInCache } = await import('@mlc-ai/web-llm');
      for (const id of MODELS) {
        if (await hasModelInCache(id)) return this.load(id);
      }
    } catch {
      /* not cached, that's fine */
    }
  }

  /** One-time download (~700 MB for Gemma 3 1B). Do this on Wi-Fi before the trip. */
  async load(preferred?: string) {
    if (this.engine || this.state() === 'unsupported') return;
    this.crashed.set(false);
    flag.set(LOADING, String(Date.now()));
    const webllm = await import('@mlc-ai/web-llm');
    const order = preferred ? [preferred, ...MODELS.filter(m => m !== preferred)] : MODELS;
    for (const id of order) {
      try {
        const cached = await webllm.hasModelInCache(id);
        this.state.set(cached ? 'loading' : 'downloading');
        this.engine = await webllm.CreateMLCEngine(id, {
          initProgressCallback: r => {
            this.progress.set(Math.round(r.progress * 100));
            this.status.set(r.text);
          },
        }, CHAT_OPTS);
        this.modelId.set(id);
        flag.del(LOADING);
        flag.set(OK, id);
        this.state.set('ready');
        return;
      } catch (e) {
        console.warn('Gemma model failed to load', id, e);
        this.status.set(String((e as Error)?.message ?? e));
      }
    }
    flag.del(LOADING);
    this.state.set('error');
  }

  /**
   * Small models ramble and fumble numbers, so Gemma gets a tight job.
   * Buttons: the app already has the facts, so Gemma adds ONE short, warm tip with no numbers or directions.
   * Typed questions: Gemma answers in 1–2 sentences from the FACTS.
   * Gemma has no separate system role, so the rules go in the user message.
   */
  async ask(question: string, facts: string, draft?: string | null): Promise<string> {
    if (!this.engine) throw new Error('Gemma is not loaded');
    await this.engine.resetChat();
    const content = draft
      ? `You are a calm trail buddy in an offline hiking app. The hiker asked: "${question.slice(0, 200)}"\n` +
        `The app already told them: "${draft}"\n` +
        `Add ONE short, warm, practical tip for this moment, under 20 words. ` +
        `Do not use any numbers, distances, directions, or place names. Reply with the tip only.`
      : `${RULES}\n\nFACTS:\n${facts.slice(0, 1500)}\n\nQUESTION: ${question.slice(0, 200)}\n\n` +
        `Answer the QUESTION in 1 or 2 short sentences using only the FACTS. If the FACTS don't say, reply: "I don't know from this trail pack."`;
    const reply = await this.engine.chat.completions.create({
      messages: [{ role: 'user', content }],
      temperature: draft ? 0.6 : 0.2,
      top_p: 0.9,
      max_tokens: draft ? 40 : 90,
      repetition_penalty: 1.15,
      frequency_penalty: 0.6,
    });
    return tidy(reply.choices[0]?.message?.content ?? '', draft ? 1 : 3);
  }

  async remove() {
    const { deleteModelAllInfoInCache } = await import('@mlc-ai/web-llm');
    await this.engine?.unload();
    this.engine = null;
    for (const id of MODELS) await deleteModelAllInfoInCache(id).catch(() => {});
    this.modelId.set(null);
    flag.del(OK);
    this.state.set('idle');
  }
}

/** Removes repeated sentences (a common small-model loop) and keeps at most `max` sentences. */
export function tidy(text: string, max = 3): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of text.replace(/\s+/g, ' ').trim().match(/[^.!?]+[.!?]?/g) ?? []) {
    const sentence = raw.trim();
    const key = sentence.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(sentence);
    if (out.length === max) break;
  }
  return out.join(' ');
}

function hasWebGpu() {
  return typeof navigator !== 'undefined' && 'gpu' in navigator;
}
