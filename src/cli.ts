#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { PROVIDER_HELP, createClient } from './llm/index.js';
import { type AnswerEntry, type CheckOptions, agentVersion, check, parseAnswerFile } from './pipeline.js';
import { renderMarkdown, renderQuestionsFile } from './report/markdown.js';
import { renderFeature } from './stages/testcases.js';
import type { Report, SourceDoc } from './types.js';

type Format = 'md' | 'json' | 'html' | 'pdf' | 'sarif' | 'csv';
const FORMATS: Format[] = ['md', 'json', 'html', 'pdf', 'sarif', 'csv'];

/** Findings as a table for import into a tracker (Jira, YouTrack) or a spreadsheet. */
function renderCsv(report: Report): string {
  const esc = (v: string) => `"${v.replace(/"/g, '""').replace(/\r?\n/g, ' ')}"`;
  const rows = [['id', 'severity', 'status', 'criterion', 'rule', 'requirements', 'line', 'title', 'quote', 'explanation', 'recommendation']];
  for (const f of report.findings) {
    rows.push([f.id, f.severity, f.status, f.criterion, f.ruleId ?? 'model', f.requirementIds.join(' '), String(f.evidence[0]?.lineStart ?? ''), f.title, f.evidence[0]?.quote ?? '', f.explanation, f.recommendation]);
  }
  // BOM: Excel otherwise reads UTF-8 Cyrillic as a legacy code page.
  return `\uFEFF${rows.map((r) => r.map(esc).join(';')).join('\r\n')}\r\n`;
}

const HELP = `Dalel — агент статической проверки документа требований.

Запуск:
  dalel <файл требований> <файл отчёта> [параметры]

Формат отчёта определяется расширением файла отчёта: .md, .json, .html, .pdf, .sarif, .csv

Параметры:
  --formats md,json,html,pdf,sarif,csv  дополнительно записать отчёт в этих форматах рядом с основным
  --all                 записать все форматы, файл вопросов автору и тест-кейсы
  --questions <файл>    записать вопросы автору в отдельный файл для заполнения
  --tests <файл>        записать черновик тест-кейсов в формате Gherkin (.feature)
  --answers <файл>      учесть ответы автора из заполненного файла вопросов
  --interactive         задать вопросы в терминале и сразу пересчитать отчёт
  --provider <имя>      gemini | openai | anthropic | ollama | claude-cli
  --model <имя>         модель выбранного провайдера
  --no-llm              только детерминированные правила, без модели
  --no-cache            не использовать кэш ответов модели (.dalel-cache)
  --no-redact           не маскировать номера карт, ИИН, телефоны и почту в тексте для модели
  --packs a,b           ограничить пакеты правил (по умолчанию все из каталога packs)
  --fail-on <уровень>   critical | major | never — код возврата 3, если есть замечания этого уровня (по умолчанию never)
  --quiet               не печатать ход выполнения
  -h, --help            эта справка
  -v, --version         версия

Другие команды:
  dalel eval [--llm]    замер качества на эталонных документах с внесёнными дефектами
  dalel coverage [отчёт.json] [каталог.yaml]  сверка отчёта с каталогом дефектов документа
  dalel compare <было.json> <стало.json>     что изменилось между двумя редакциями документа
  dalel baseline <документ> <ответ.md>       контрольный опыт: один запрос к модели без конвейера
  dalel stability <a.json> <b.json> …        насколько совпадают замечания между прогонами
  dalel audit <отчёт.json> <документ>        точность отчёта: каждое замечание судит другая модель
  dalel recall <отчёт.md> [имя=файл …]       полнота по каталогу: судит другая модель, годится для любого текстового отчёта
  dalel serve [--port 4173]                  веб-интерфейс на этой машине: загрузка документа, отчёт, ответы на вопросы

${PROVIDER_HELP}

Коды возврата: 0 — отчёт записан; 1 — ошибка запуска; 2 — документ не прочитан (диагностический отчёт записан); 3 — сработал --fail-on.`;

interface Args {
  positional: string[];
  flags: Map<string, string | true>;
}

const VALUE_FLAGS = new Set(['formats', 'questions', 'answers', 'provider', 'model', 'packs', 'fail-on', 'out', 'tests', 'baseline', 'port', 'gold']);

function parseArgs(argv: string[]): Args {
  const positional: string[] = [];
  const flags = new Map<string, string | true>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? '';
    if (a === '-h') flags.set('help', true);
    else if (a === '-v') flags.set('version', true);
    else if (a.startsWith('--')) {
      const [name, inline] = a.slice(2).split('=', 2) as [string, string | undefined];
      if (inline !== undefined) flags.set(name, inline);
      else if (VALUE_FLAGS.has(name)) {
        const next = argv[++i];
        if (next === undefined) throw new Error(`Параметру --${name} нужно значение.`);
        flags.set(name, next);
      } else flags.set(name, true);
    } else positional.push(a);
  }
  return { positional, flags };
}

/** Minimal .env reader: KEY=VALUE lines, optional quotes; existing environment variables win. */
function loadEnvFiles(): void {
  const roots = [...new Set([process.cwd(), join(dirname(fileURLToPath(import.meta.url)), '..')])];
  for (const root of roots) {
    for (const name of ['.env.local', '.env']) {
      const file = join(root, name);
      if (!existsSync(file)) continue;
      for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
        const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
        if (!m?.[1]) continue;
        let value = (m[2] ?? '').trim();
        if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
        else value = value.replace(/\s+#.*$/, '');
        if (value !== '' && process.env[m[1]] === undefined) process.env[m[1]] = value;
      }
    }
  }
}

async function render(format: Format, report: Report, doc: SourceDoc | null): Promise<string | Buffer> {
  switch (format) {
    case 'md':
      return renderMarkdown(report);
    case 'json':
      return `${JSON.stringify(report, null, 2)}\n`;
    case 'html':
      return (await import('./report/html.js')).renderHtml(report, doc);
    case 'pdf':
      return (await import('./report/pdf.js')).renderPdf(report);
    case 'sarif':
      return (await import('./report/sarif.js')).renderSarif(report);
    case 'csv':
      return renderCsv(report);
  }
}

function formatOf(path: string): Format {
  const ext = extname(path).slice(1).toLowerCase();
  if (ext === 'markdown') return 'md';
  if ((FORMATS as string[]).includes(ext)) return ext as Format;
  throw new Error(`Неизвестный формат отчёта «.${ext}». Поддерживаются: ${FORMATS.map((f) => `.${f}`).join(', ')}.`);
}

async function askInteractively(report: Report): Promise<Record<string, string>> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  const answers: Record<string, string> = {};
  process.stderr.write(`\nВопросов к автору: ${report.questions.length}. Введите номер варианта или свой ответ; пустая строка — пропустить.\n`);
  for (const q of report.questions) {
    process.stderr.write(`\n${q.id}${q.blocking ? ' [блокирует]' : ''} — кому: ${q.addressee}\n${q.text}\n`);
    q.options.forEach((o, i) => process.stderr.write(`  ${i + 1}) ${o.label} → ${o.consequence}\n`));
    const raw = (await rl.question('Ответ: ')).trim();
    if (raw === '') continue;
    const n = Number(raw);
    const option = Number.isInteger(n) ? q.options[n - 1] : undefined;
    answers[q.id] = option ? option.label : raw;
  }
  rl.close();
  return answers;
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  if (args.flags.has('version')) {
    const v = agentVersion();
    process.stdout.write(`dalel ${v.version} (${v.commit})\n`);
    return 0;
  }
  if (args.positional[0] === 'check') args.positional.shift();
  if (args.flags.has('help') || args.positional.length === 0) {
    process.stdout.write(`${HELP}\n`);
    return args.flags.has('help') ? 0 : 1;
  }
  loadEnvFiles();
  const quiet = args.flags.has('quiet');
  const log = (m: string) => {
    if (!quiet) process.stderr.write(`dalel: ${m}\n`);
  };
  const str = (name: string): string | undefined => {
    const v = args.flags.get(name);
    return typeof v === 'string' ? v : undefined;
  };

  if (args.positional[0] === 'eval') {
    const { runEval } = await import('./eval/run.js');
    const provider = str('provider');
    const model = str('model');
    const client = args.flags.has('llm') ? createClient(process.env, { ...(provider ? { provider } : {}), ...(model ? { model } : {}) }) : null;
    return runEval({ client, log, out: str('out') ?? 'docs/EVAL.md', useCache: !args.flags.has('no-cache') });
  }

  if (args.positional[0] === 'coverage') {
    const { runCoverage } = await import('./eval/coverage.js');
    return runCoverage(args.positional[1] ?? 'reports/requirements.report.json', args.positional[2] ?? 'eval/case/gold.yaml', str('out') ?? 'docs/EVAL-case.md', log, str('baseline'));
  }
  if (args.positional[0] === 'baseline') {
    const [, doc, target] = args.positional;
    if (!doc || !target) throw new Error('Нужны два пути: dalel baseline <документ> <файл ответа>');
    const provider = str('provider');
    const model = str('model');
    const client = createClient(process.env, { ...(provider ? { provider } : {}), ...(model ? { model } : {}) });
    if (!client) throw new Error('Для baseline нужна модель: задайте ключ провайдера.');
    return (await import('./eval/baseline.js')).runBaseline(client, doc, target, log);
  }
  if (args.positional[0] === 'serve') {
    const provider = str('provider');
    const model = str('model');
    const client = args.flags.has('no-llm') ? null : createClient(process.env, { ...(provider ? { provider } : {}), ...(model ? { model } : {}) });
    const port = Number(str('port') ?? '4173');
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Порт должен быть числом от 1 до 65535.');
    return (await import('./serve/index.js')).serve(client, port, log);
  }
  if (args.positional[0] === 'audit') {
    const [, reportPath, doc] = args.positional;
    if (!reportPath || !doc) throw new Error('Нужны два пути: dalel audit <отчёт.json> <документ>');
    const provider = str('provider');
    const model = str('model');
    const client = createClient(process.env, { ...(provider ? { provider } : {}), ...(model ? { model } : {}) });
    if (!client) throw new Error('Для audit нужна модель: задайте ключ провайдера.');
    return (await import('./eval/audit.js')).runAudit(client, reportPath, doc, str('out') ?? 'docs/EVAL-precision.md', log);
  }
  if (args.positional[0] === 'recall') {
    const files = args.positional.slice(1);
    if (files.length === 0) throw new Error('Нужен хотя бы один текстовый отчёт: dalel recall <отчёт.md> [имя=другой.md …]');
    const provider = str('provider');
    const model = str('model');
    const client = createClient(process.env, { ...(provider ? { provider } : {}), ...(model ? { model } : {}) });
    if (!client) throw new Error('Для recall нужна модель: задайте ключ провайдера.');
    return (await import('./eval/recall.js')).runRecall(client, files, str('gold') ?? 'eval/case/gold.yaml', str('out') ?? 'docs/EVAL-recall.md', log);
  }
  if (args.positional[0] === 'stability') {
    const files = args.positional.slice(1);
    if (files.length < 2) throw new Error('Нужны хотя бы два отчёта в формате JSON: dalel stability <a.json> <b.json> …');
    const text = (await import('./eval/stability.js')).renderStability(files);
    const target = str('out');
    if (target) {
      mkdirSync(dirname(resolve(target)), { recursive: true });
      writeFileSync(target, text);
      log(`стабильность записана: ${target}`);
    } else process.stdout.write(text);
    return 0;
  }

  if (args.positional[0] === 'compare') {
    const [, before, after] = args.positional;
    if (!before || !after) throw new Error('Нужны два отчёта в формате JSON: dalel compare <было.json> <стало.json>');
    const { compareReports, renderComparison } = await import('./report/compare.js');
    const text = renderComparison(compareReports(JSON.parse(readFileSync(before, 'utf8')) as Report, JSON.parse(readFileSync(after, 'utf8')) as Report));
    const target = str('out');
    if (target) {
      mkdirSync(dirname(resolve(target)), { recursive: true });
      writeFileSync(target, text);
      log(`сравнение записано: ${target}`);
    } else process.stdout.write(text);
    return 0;
  }

  const [input, output] = args.positional;
  if (!input || !output) {
    process.stderr.write('Нужны два пути: файл требований и файл отчёта.\n\n');
    process.stderr.write(`${HELP}\n`);
    return 1;
  }
  const mainFormat = formatOf(output);
  const provider = str('provider');
  const model = str('model');
  const client = args.flags.has('no-llm') ? null : createClient(process.env, { ...(provider ? { provider } : {}), ...(model ? { model } : {}) });
  if (!client && !args.flags.has('no-llm')) log('ключ модели не найден — выполняю только детерминированные правила (см. --help)');
  else if (client) log(`модель: ${client.model} (${client.provider})`);

  const answers: Record<string, string> = {};
  let answerEntries: AnswerEntry[] = [];
  const answersFile = str('answers');
  if (answersFile) {
    if (!existsSync(answersFile)) throw new Error(`Файл ответов не найден: ${answersFile}`);
    answerEntries = parseAnswerFile(readFileSync(answersFile, 'utf8'));
    log(`ответов автора: ${answerEntries.length}`);
  }
  const packs = str('packs');
  const options: CheckOptions = {
    client,
    useCache: !args.flags.has('no-cache'),
    redact: !args.flags.has('no-redact'),
    answers,
    answerEntries,
    ...(answersFile ? { answersFile } : {}),
    ...(packs ? { packs: packs.split(',').map((s) => s.trim()) } : {}),
    onProgress: log,
  };

  let { report, doc } = await check(input, options);
  if (args.flags.has('interactive') && report.questions.length > 0 && process.stdin.isTTY) {
    const given = await askInteractively(report);
    if (Object.keys(given).length > 0) ({ report, doc } = await check(input, { ...options, answers: { ...answers, ...given } }));
  }

  const formats = new Set<Format>([mainFormat]);
  if (args.flags.has('all')) for (const f of FORMATS) formats.add(f);
  for (const f of (str('formats') ?? '').split(',').map((s) => s.trim().toLowerCase())) {
    if (f === '') continue;
    if (!(FORMATS as string[]).includes(f)) throw new Error(`Неизвестный формат «${f}» в --formats.`);
    formats.add(f as Format);
  }
  const outPath = resolve(output);
  const base = outPath.slice(0, outPath.length - extname(outPath).length);
  mkdirSync(dirname(outPath), { recursive: true });
  for (const f of formats) {
    const target = f === mainFormat ? outPath : `${base}.${f}`;
    try {
      writeFileSync(target, await render(f, report, doc));
      log(`отчёт записан: ${target}`);
    } catch (e) {
      // A secondary format must never cost the user the main report.
      if (f === mainFormat) throw e;
      log(`формат ${f} не записан: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  const questionsPath = str('questions') ?? (args.flags.has('all') ? `${base}.questions.md` : undefined);
  if (questionsPath && report.questions.length > 0) {
    mkdirSync(dirname(resolve(questionsPath)), { recursive: true });
    writeFileSync(questionsPath, renderQuestionsFile(report));
    log(`вопросы автору записаны: ${questionsPath}`);
  }

  const testsPath = str('tests') ?? (args.flags.has('all') ? `${base}.feature` : undefined);
  if (testsPath && (report.testCases?.length ?? 0) > 0) {
    mkdirSync(dirname(resolve(testsPath)), { recursive: true });
    writeFileSync(testsPath, renderFeature(report.passport.documentName, report.testCases ?? []));
    log(`тест-кейсы записаны: ${testsPath}`);
  }

  const s = report.summary;
  log(`итог: ${report.verdict.headline}. Требований ${s.requirements}, замечаний ${s.findings} (критичных ${s.bySeverity.critical}, существенных ${s.bySeverity.major}), вопросов ${s.questions}`);
  if (report.verdict.code === 'not_checked') {
    for (const d of report.diagnostics) process.stderr.write(`dalel: ${d.message}${d.hint ? ` ${d.hint}` : ''}\n`);
    return 2;
  }
  const failOn = str('fail-on') ?? 'never';
  if (failOn === 'critical' && s.bySeverity.critical > 0) return 3;
  if (failOn === 'major' && s.bySeverity.critical + s.bySeverity.major > 0) return 3;
  return 0;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (e: unknown) => {
    process.stderr.write(`dalel: ошибка — ${e instanceof Error ? e.message : String(e)}\n`);
    process.exitCode = 1;
  },
);
