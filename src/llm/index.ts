import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { z } from 'zod';

export interface LlmRequest {
  system: string;
  user: string;
  maxTokens?: number;
}

export interface LlmResponse {
  text: string;
  tokensIn: number;
  tokensOut: number;
}

export interface LlmClient {
  provider: string;
  /** Reported in the run passport; a CLI provider replaces an alias with the resolved model id. */
  model: string;
  /** Stable part of the cache key (provider + requested model). */
  cacheId: string;
  complete(req: LlmRequest): Promise<LlmResponse>;
}

export interface LlmUsage {
  calls: number;
  cacheHits: number;
  tokensIn: number;
  tokensOut: number;
}

export type ProviderName = 'gemini' | 'openai' | 'anthropic' | 'ollama' | 'claude-cli';

export interface LlmConfig {
  provider?: string;
  model?: string;
}

const TIMEOUT_MS = 240_000;
const RETRY_DELAYS_MS = [3_000, 8_000, 20_000, 45_000];

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

class HttpError extends Error {
  constructor(
    public status: number,
    body: string,
  ) {
    super(`HTTP ${status}: ${body.slice(0, 300)}`);
  }
}

async function postJson(url: string, headers: Record<string, string>, body: unknown): Promise<unknown> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (res.ok) return await res.json();
      const text = await res.text();
      const err = new HttpError(res.status, text);
      // Free tiers answer 429 when the per-minute quota is used up; waiting is the correct reaction.
      if (res.status !== 429 && res.status < 500) throw err;
      lastError = err;
    } catch (e) {
      if (e instanceof HttpError && e.status !== 429 && e.status < 500) throw e;
      lastError = e;
    }
    const delay = RETRY_DELAYS_MS[attempt];
    if (delay === undefined) break;
    await sleep(delay);
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function pick(obj: unknown, ...path: (string | number)[]): unknown {
  let cur: unknown = obj;
  for (const key of path) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string | number, unknown>)[key];
  }
  return cur;
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

function geminiClient(apiKey: string, model: string, baseUrl: string): LlmClient {
  return {
    provider: 'gemini',
    model,
    cacheId: `gemini:${model}`,
    async complete(req) {
      const data = await postJson(
        `${baseUrl.replace(/\/+$/, '')}/v1beta/models/${encodeURIComponent(model)}:generateContent`,
        { 'x-goog-api-key': apiKey },
        {
          system_instruction: { parts: [{ text: req.system }] },
          contents: [{ role: 'user', parts: [{ text: req.user }] }],
          // No maxOutputTokens: models differ in their ceiling, and a value above it is rejected; the default is the model's own maximum.
          generationConfig: { temperature: 0, responseMimeType: 'application/json', ...(req.maxTokens ? { maxOutputTokens: req.maxTokens } : {}) },
        },
      );
      const parts = pick(data, 'candidates', 0, 'content', 'parts');
      const text = Array.isArray(parts) ? parts.map((p) => (typeof pick(p, 'text') === 'string' ? (pick(p, 'text') as string) : '')).join('') : '';
      if (text === '') throw new Error(`Gemini вернул пустой ответ (finishReason: ${String(pick(data, 'candidates', 0, 'finishReason') ?? 'нет')})`);
      return { text, tokensIn: num(pick(data, 'usageMetadata', 'promptTokenCount')), tokensOut: num(pick(data, 'usageMetadata', 'candidatesTokenCount')) };
    },
  };
}

function openAiClient(provider: string, baseUrl: string, apiKey: string | undefined, model: string): LlmClient {
  return {
    provider,
    model,
    cacheId: `${provider}:${model}`,
    async complete(req) {
      const data = await postJson(
        `${baseUrl.replace(/\/+$/, '')}/chat/completions`,
        apiKey ? { authorization: `Bearer ${apiKey}` } : {},
        {
          model,
          temperature: 0,
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: req.system },
            { role: 'user', content: req.user },
          ],
        },
      );
      const text = pick(data, 'choices', 0, 'message', 'content');
      if (typeof text !== 'string' || text === '') throw new Error(`${provider} вернул пустой ответ`);
      return { text, tokensIn: num(pick(data, 'usage', 'prompt_tokens')), tokensOut: num(pick(data, 'usage', 'completion_tokens')) };
    },
  };
}

function anthropicClient(apiKey: string, model: string, baseUrl: string): LlmClient {
  return {
    provider: 'anthropic',
    model,
    cacheId: `anthropic:${model}`,
    async complete(req) {
      const data = await postJson(
        `${baseUrl.replace(/\/+$/, '')}/v1/messages`,
        { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
        { model, max_tokens: req.maxTokens ?? 16000, system: req.system, messages: [{ role: 'user', content: req.user }] },
      );
      const content = pick(data, 'content');
      const text = Array.isArray(content) ? content.map((c) => (pick(c, 'type') === 'text' ? String(pick(c, 'text') ?? '') : '')).join('') : '';
      if (text === '') throw new Error('Anthropic вернул пустой ответ');
      return { text, tokensIn: num(pick(data, 'usage', 'input_tokens')), tokensOut: num(pick(data, 'usage', 'output_tokens')) };
    },
  };
}

/** Uses a locally installed Claude Code CLI as the model; needs no API key, only a logged-in CLI. */
function claudeCliClient(model: string): LlmClient {
  const client: LlmClient = {
    provider: 'claude-cli',
    model,
    cacheId: `claude-cli:${model}`,
    complete(req) {
      return new Promise<LlmResponse>((resolve, reject) => {
        const child = spawn('claude', ['-p', '--output-format', 'json', '--max-turns', '1', '--model', model, '--system-prompt', req.system], {
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        let out = '';
        let err = '';
        const timer = setTimeout(() => {
          child.kill('SIGKILL');
          reject(new Error('claude CLI не ответил за отведённое время'));
        }, TIMEOUT_MS * 2);
        child.stdout.on('data', (d: Buffer) => (out += d.toString('utf8')));
        child.stderr.on('data', (d: Buffer) => (err += d.toString('utf8')));
        child.on('error', (e) => {
          clearTimeout(timer);
          reject(new Error(`Не удалось запустить claude CLI: ${e.message}`));
        });
        child.on('close', (code) => {
          clearTimeout(timer);
          if (code !== 0) return reject(new Error(`claude CLI завершился с кодом ${code}: ${(err || out).slice(0, 300)}`));
          try {
            const data: unknown = JSON.parse(out);
            const text = pick(data, 'result');
            if (typeof text !== 'string' || text === '') return reject(new Error('claude CLI вернул пустой результат'));
            const used = Object.keys((pick(data, 'modelUsage') as Record<string, unknown> | undefined) ?? {})[0];
            if (used) client.model = used;
            resolve({
              text,
              tokensIn:
                num(pick(data, 'usage', 'input_tokens')) + num(pick(data, 'usage', 'cache_read_input_tokens')) + num(pick(data, 'usage', 'cache_creation_input_tokens')),
              tokensOut: num(pick(data, 'usage', 'output_tokens')),
            });
          } catch {
            reject(new Error(`claude CLI вернул не JSON: ${out.slice(0, 200)}`));
          }
        });
        child.stdin.end(req.user);
      });
    },
  };
  return client;
}

export const PROVIDER_HELP = `Провайдер выбирается переменной DALEL_PROVIDER или по первому найденному ключу:
  GEMINI_API_KEY (+ GEMINI_MODEL)            — Google AI Studio, бесплатный тариф
  OPENAI_API_KEY (+ OPENAI_MODEL, OPENAI_BASE_URL) — OpenAI и совместимые (OpenRouter, DeepSeek, vLLM)
  ANTHROPIC_API_KEY (+ ANTHROPIC_MODEL)
  OLLAMA_BASE_URL (+ OLLAMA_MODEL)           — локальная модель, документ не покидает контур
  DALEL_PROVIDER=claude-cli                  — установленный Claude Code CLI, ключ не нужен`;

/** Returns null when no provider is configured; the caller then runs the deterministic layer only. */
export function createClient(env: NodeJS.ProcessEnv, cfg: LlmConfig = {}): LlmClient | null {
  const explicit = (cfg.provider ?? env.DALEL_PROVIDER ?? '').trim().toLowerCase();
  const order: ProviderName[] = explicit ? [explicit as ProviderName] : ['gemini', 'openai', 'anthropic', 'ollama'];
  for (const p of order) {
    if (p === 'gemini' && env.GEMINI_API_KEY) return geminiClient(env.GEMINI_API_KEY, cfg.model ?? env.GEMINI_MODEL ?? 'gemini-flash-latest', env.GEMINI_BASE_URL ?? 'https://generativelanguage.googleapis.com');
    if (p === 'openai' && env.OPENAI_API_KEY)
      return openAiClient('openai', env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1', env.OPENAI_API_KEY, cfg.model ?? env.OPENAI_MODEL ?? 'gpt-4o-mini');
    if (p === 'anthropic' && env.ANTHROPIC_API_KEY)
      return anthropicClient(env.ANTHROPIC_API_KEY, cfg.model ?? env.ANTHROPIC_MODEL ?? 'claude-sonnet-5-5', env.ANTHROPIC_API_URL ?? 'https://api.anthropic.com');
    if (p === 'ollama' && (env.OLLAMA_BASE_URL || explicit === 'ollama'))
      return openAiClient('ollama', `${(env.OLLAMA_BASE_URL ?? 'http://localhost:11434').replace(/\/+$/, '')}/v1`, undefined, cfg.model ?? env.OLLAMA_MODEL ?? 'qwen2.5-coder:7b');
    if (p === 'claude-cli') return claudeCliClient(cfg.model ?? env.DALEL_CLAUDE_MODEL ?? 'sonnet');
  }
  if (explicit) throw new Error(`Провайдер «${explicit}» выбран, но для него нет ключа или он не поддерживается.\n${PROVIDER_HELP}`);
  return null;
}

export class LlmCache {
  constructor(
    private dir: string | null,
    private enabled = true,
  ) {
    if (this.dir && this.enabled) mkdirSync(this.dir, { recursive: true });
  }
  private file(key: string): string {
    return join(this.dir ?? '.', `${key}.json`);
  }
  get(key: string): LlmResponse | null {
    if (!this.dir || !this.enabled) return null;
    const f = this.file(key);
    if (!existsSync(f)) return null;
    try {
      return JSON.parse(readFileSync(f, 'utf8')) as LlmResponse;
    } catch {
      return null;
    }
  }
  set(key: string, value: LlmResponse): void {
    if (!this.dir || !this.enabled) return;
    try {
      mkdirSync(this.dir, { recursive: true });
      writeFileSync(this.file(key), JSON.stringify(value));
    } catch {
      // The cache is an optimisation: failing to write it must never cost the user a model answer.
    }
  }
}

export function extractJson(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const candidate = (fenced?.[1] ?? text).trim();
  try {
    return JSON.parse(candidate);
  } catch {
    const start = candidate.indexOf('{');
    const end = candidate.lastIndexOf('}');
    if (start >= 0 && end > start) return JSON.parse(candidate.slice(start, end + 1));
    throw new Error('в ответе модели нет JSON-объекта');
  }
}

export interface JsonCall<T> {
  stage: string;
  system: string;
  user: string;
  schema: z.ZodType<T>;
  maxTokens?: number;
}

/** One model call with a cache, schema validation and a single repair attempt. */
export async function completeJson<T>(client: LlmClient, cache: LlmCache, usage: LlmUsage, call: JsonCall<T>): Promise<T> {
  let user = call.user;
  let lastProblem = '';
  for (let attempt = 0; attempt < 2; attempt++) {
    const key = createHash('sha256').update([client.cacheId, call.system, user].join('\u0000')).digest('hex').slice(0, 40);
    let res = cache.get(key);
    if (res) {
      usage.cacheHits++;
    } else {
      res = await client.complete({ system: call.system, user, ...(call.maxTokens ? { maxTokens: call.maxTokens } : {}) });
      usage.calls++;
      usage.tokensIn += res.tokensIn;
      usage.tokensOut += res.tokensOut;
    }
    try {
      const parsed = call.schema.safeParse(extractJson(res.text));
      if (parsed.success) {
        cache.set(key, res);
        return parsed.data;
      }
      lastProblem = parsed.error.issues
        .slice(0, 6)
        .map((i) => `${i.path.join('.')}: ${i.message}`)
        .join('; ');
    } catch (e) {
      lastProblem = e instanceof Error ? e.message : String(e);
    }
    user = `${call.user}\n\nПредыдущий ответ не прошёл проверку схемы (${lastProblem}). Верни один корректный JSON-объект строго по схеме, без пояснений.`;
  }
  throw new Error(`Этап «${call.stage}»: ответ модели не соответствует схеме (${lastProblem})`);
}

export async function mapLimit<A, B>(items: A[], limit: number, fn: (item: A, index: number) => Promise<B>): Promise<B[]> {
  const out: B[] = new Array<B>(items.length);
  let next = 0;
  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i] as A, i);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return out;
}
