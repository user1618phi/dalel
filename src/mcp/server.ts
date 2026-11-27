#!/usr/bin/env node
import { createInterface } from 'node:readline';
import { createClient } from '../llm/index.js';
import { agentVersion, check } from '../pipeline.js';
import { renderMarkdown } from '../report/markdown.js';

/**
 * Minimal Model Context Protocol server over stdio (JSON-RPC 2.0, one message per line).
 * Lets a coding agent ask «is this spec fit to build from?» before it starts writing code.
 */

interface RpcRequest {
  jsonrpc: '2.0';
  id?: number | string | null;
  method: string;
  params?: Record<string, unknown>;
}

const TOOL = {
  name: 'check_requirements',
  description:
    'Статическая проверка документа требований (ТЗ, спецификации) по ISO/IEC/IEEE 29148 и IEEE 830: дефекты с дословными цитатами, противоречия с контрпримерами, вопросы автору и вердикт «можно ли начинать разработку». Вызывайте до начала реализации по документу.',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Путь к документу: .md, .txt, .pdf, .docx или .html' },
      rules_only: { type: 'boolean', description: 'Только детерминированные правила, без обращения к модели' },
      format: { type: 'string', enum: ['markdown', 'json'], description: 'Формат ответа; по умолчанию markdown' },
    },
    required: ['path'],
  },
};

export async function handle(req: RpcRequest): Promise<unknown> {
  switch (req.method) {
    case 'initialize':
      return {
        protocolVersion: typeof req.params?.protocolVersion === 'string' ? req.params.protocolVersion : '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'dalel', version: agentVersion().version },
      };
    case 'ping':
      return {};
    case 'tools/list':
      return { tools: [TOOL] };
    case 'tools/call': {
      const name = req.params?.name;
      const a = (req.params?.arguments ?? {}) as Record<string, unknown>;
      if (name !== TOOL.name) throw Object.assign(new Error(`Неизвестный инструмент: ${String(name)}`), { code: -32602 });
      if (typeof a.path !== 'string' || a.path === '') throw Object.assign(new Error('Нужен параметр path'), { code: -32602 });
      const client = a.rules_only === true ? null : createClient(process.env);
      const { report } = await check(a.path, { client });
      const text = a.format === 'json' ? JSON.stringify(report) : renderMarkdown(report);
      return { content: [{ type: 'text', text }], isError: report.verdict.code === 'not_checked' };
    }
    default:
      throw Object.assign(new Error(`Метод не поддерживается: ${req.method}`), { code: -32601 });
  }
}

export function serve(input: NodeJS.ReadableStream = process.stdin, output: NodeJS.WritableStream = process.stdout): void {
  const rl = createInterface({ input, crlfDelay: Infinity });
  const send = (msg: unknown) => output.write(`${JSON.stringify(msg)}\n`);
  rl.on('line', (line) => {
    if (line.trim() === '') return;
    let req: RpcRequest;
    try {
      req = JSON.parse(line) as RpcRequest;
    } catch {
      send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
      return;
    }
    // Notifications carry no id and expect no reply.
    if (req.id === undefined || req.id === null) return;
    handle(req).then(
      (result) => send({ jsonrpc: '2.0', id: req.id, result }),
      (e: unknown) => {
        const code = typeof (e as { code?: unknown }).code === 'number' ? (e as { code: number }).code : -32000;
        send({ jsonrpc: '2.0', id: req.id, error: { code, message: e instanceof Error ? e.message : String(e) } });
      },
    );
  });
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop() ?? '')) serve();
