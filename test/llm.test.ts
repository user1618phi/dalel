import { type IncomingMessage, type Server, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { LlmCache, type LlmUsage, completeJson, createClient, splitCommand } from '../src/llm/index.js';

interface Seen {
  url: string;
  headers: IncomingMessage['headers'];
  body: Record<string, unknown>;
}

let server: Server;
let base = '';
const seen: Seen[] = [];
let geminiFailures = 0;

beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c: Buffer) => (raw += c.toString('utf8')));
    req.on('end', () => {
      const body = JSON.parse(raw || '{}') as Record<string, unknown>;
      seen.push({ url: req.url ?? '', headers: req.headers, body });
      const send = (status: number, payload: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(payload));
      };
      if (req.url?.includes(':generateContent')) {
        if (req.url.includes('bad-model')) return send(404, { error: { message: 'model not found' } });
        if (geminiFailures > 0) {
          geminiFailures--;
          return send(200, { candidates: [{ content: { parts: [{ text: 'это не JSON' }] } }], usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 2 } });
        }
        return send(200, { candidates: [{ content: { parts: [{ text: '{"ok":' }, { text: 'true}' }] } }], usageMetadata: { promptTokenCount: 11, candidatesTokenCount: 3 } });
      }
      if (req.url?.endsWith('/chat/completions')) return send(200, { choices: [{ message: { content: '```json\n{"ok":true}\n```' } }], usage: { prompt_tokens: 7, completion_tokens: 2 } });
      if (req.url?.endsWith('/v1/messages')) return send(200, { content: [{ type: 'text', text: 'Ответ: {"ok":true}' }], usage: { input_tokens: 9, output_tokens: 4 } });
      return send(404, {});
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

const schema = z.object({ ok: z.boolean() });
const call = { stage: 'тест', system: 'системная инструкция', user: 'запрос', schema };
const usage = (): LlmUsage => ({ calls: 0, cacheHits: 0, tokensIn: 0, tokensOut: 0 });

describe('провайдеры моделей', () => {
  it('Gemini: ключ в заголовке, системная инструкция и JSON-режим в теле, ответ собирается из частей', async () => {
    const client = createClient({ GEMINI_API_KEY: 'test-key', GEMINI_BASE_URL: base, GEMINI_MODEL: 'gemini-test' });
    expect(client?.provider).toBe('gemini');
    const u = usage();
    expect(await completeJson(client!, new LlmCache(null), u, call)).toEqual({ ok: true });
    const req = seen.at(-1)!;
    expect(req.url).toBe('/v1beta/models/gemini-test:generateContent');
    expect(req.headers['x-goog-api-key']).toBe('test-key');
    expect(req.url).not.toContain('test-key');
    expect(req.body).toMatchObject({
      system_instruction: { parts: [{ text: 'системная инструкция' }] },
      contents: [{ role: 'user', parts: [{ text: 'запрос' }] }],
      generationConfig: { temperature: 0, responseMimeType: 'application/json' },
    });
    expect(u).toEqual({ calls: 1, cacheHits: 0, tokensIn: 11, tokensOut: 3 });
  });

  it('просит модель исправить ответ, который не разбирается, и считает оба обращения', async () => {
    geminiFailures = 1;
    const client = createClient({ GEMINI_API_KEY: 'k', GEMINI_BASE_URL: base });
    const before = seen.length;
    const u = usage();
    expect(await completeJson(client!, new LlmCache(null), u, call)).toEqual({ ok: true });
    expect(seen.length - before).toBe(2);
    expect(JSON.stringify(seen.at(-1)!.body)).toContain('не прошёл проверку схемы');
    expect(u.calls).toBe(2);
  });

  it('ошибка клиента (4xx) не повторяется и доходит до вызывающего', async () => {
    const client = createClient({ GEMINI_API_KEY: 'k', GEMINI_BASE_URL: base, GEMINI_MODEL: 'bad-model' });
    const before = seen.length;
    await expect(completeJson(client!, new LlmCache(null), usage(), call)).rejects.toThrow(/HTTP 404/);
    expect(seen.length - before).toBe(1);
  });

  it('OpenAI-совместимый: Bearer-ключ, JSON-режим, ответ в ограде кода разбирается', async () => {
    const client = createClient({ OPENAI_API_KEY: 'sk-test', OPENAI_BASE_URL: `${base}/v1`, OPENAI_MODEL: 'm' });
    expect(await completeJson(client!, new LlmCache(null), usage(), call)).toEqual({ ok: true });
    const req = seen.at(-1)!;
    expect(req.headers.authorization).toBe('Bearer sk-test');
    expect(req.body).toMatchObject({ model: 'm', temperature: 0, response_format: { type: 'json_object' } });
  });

  it('Ollama работает без ключа через тот же протокол', async () => {
    const client = createClient({ OLLAMA_BASE_URL: base, OLLAMA_MODEL: 'local' });
    expect(client?.provider).toBe('ollama');
    expect(await completeJson(client!, new LlmCache(null), usage(), call)).toEqual({ ok: true });
    expect(seen.at(-1)!.headers.authorization).toBeUndefined();
  });

  it('Anthropic: ключ и версия API в заголовках, JSON достаётся из текста', async () => {
    const client = createClient({ ANTHROPIC_API_KEY: 'ak', ANTHROPIC_API_URL: base, ANTHROPIC_MODEL: 'claude-test' });
    expect(await completeJson(client!, new LlmCache(null), usage(), call)).toEqual({ ok: true });
    const req = seen.at(-1)!;
    expect(req.headers['x-api-key']).toBe('ak');
    expect(req.headers['anthropic-version']).toBe('2023-06-01');
    expect(req.body).toMatchObject({ model: 'claude-test', system: 'системная инструкция' });
  });

  it('любая команда терминала как модель: запрос уходит в стандартный ввод, ответ читается из вывода', async () => {
    expect(splitCommand(`node -e "console.log('a b')" --flag 'x y'`)).toEqual(['node', '-e', "console.log('a b')", '--flag', 'x y']);
    const script = "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.stringify({ok:s.includes('системная инструкция')&&s.includes('запрос')})))";
    const client = createClient({ DALEL_PROVIDER: 'cli', DALEL_CLI_CMD: `${process.execPath} -e "${script}"`, DALEL_CLI_MODEL: 'local-test' });
    expect(client?.provider).toBe('cli');
    expect(client?.model).toBe('local-test');
    const u = usage();
    expect(await completeJson(client!, new LlmCache(null), u, call)).toEqual({ ok: true });
    expect(u.calls).toBe(1);
    const failing = createClient({ DALEL_PROVIDER: 'cli', DALEL_CLI_CMD: `${process.execPath} -e "process.exit(3)"` });
    await expect(completeJson(failing!, new LlmCache(null), usage(), call)).rejects.toThrow(/кодом 3/);
    expect(() => createClient({ DALEL_PROVIDER: 'cli' })).toThrow(/нет ключа/);
  });

  it('без ключей клиента нет; явный провайдер без ключа — понятная ошибка', () => {
    expect(createClient({})).toBeNull();
    expect(() => createClient({ DALEL_PROVIDER: 'gemini' })).toThrow(/нет ключа/);
  });
});
