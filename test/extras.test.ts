import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { runBaseline } from '../src/eval/baseline.js';
import { runAudit } from '../src/eval/audit.js';
import { ablation, coverageText, runCoverage } from '../src/eval/coverage.js';
import { renderStability } from '../src/eval/stability.js';
import type { LlmClient } from '../src/llm/index.js';
import { check } from '../src/pipeline.js';
import { createApp } from '../src/serve/index.js';
import type { Report } from '../src/types.js';

const ROOT = join(__dirname, '..');
const CASE = join(ROOT, 'docs', 'requirements.md');
const GOLD = join(ROOT, 'eval', 'case', 'gold.yaml');
const gold = (parse(readFileSync(GOLD, 'utf8')) as { defects: Parameters<typeof coverageText>[1] }).defects;

describe('строгая сверка и контрольный опыт', () => {
  it('пустой текст ничего не покрывает, сам каталог покрывает себя', () => {
    expect(coverageText('', gold).every((r) => r.covered === 0)).toBe(true);
    const selfText = gold.map((g) => `## ${g.id}\n${(g.keywords ?? []).join(' ')}`).join('\n');
    const self = coverageText(selfText, gold);
    expect(self.every((r) => r.covered === r.total)).toBe(true);
    expect(self.map((r) => r.total)).toEqual([5, 32, 38]);
  });

  it('baseline шлёт один запрос в текстовом режиме с замаскированным документом', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dalel-'));
    const doc = join(dir, 'spec.md');
    writeFileSync(doc, '# ТЗ\n\nКлиент с картой 4111 1111 1111 1111 получает уведомление быстро.\n');
    const seen: { user: string; json?: boolean }[] = [];
    const client: LlmClient = {
      provider: 'fake',
      model: 'fake-1',
      cacheId: 'fake',
      async complete(req) {
        seen.push({ user: req.user, ...(req.json === undefined ? {} : { json: req.json }) });
        return { text: 'Дефект: слово «быстро» неизмеримо.', tokensIn: 1, tokensOut: 1 };
      },
    };
    const out = join(dir, 'baseline.md');
    expect(await runBaseline(client, doc, out, () => undefined)).toBe(0);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.json).toBe(false);
    expect(seen[0]?.user).not.toContain('4111 1111 1111 1111');
    expect(readFileSync(out, 'utf8')).toContain('слово «быстро» неизмеримо');
  });

  it('coverage пишет обе сверки и сравнение с одним запросом', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dalel-'));
    const { report } = await check(CASE, { client: null, cacheDir: null });
    const reportPath = join(dir, 'r.json');
    writeFileSync(reportPath, JSON.stringify(report));
    const baseline = join(dir, 'b.md');
    writeFileSync(baseline, 'Метод GET изменяет состояние: сохранение порога.');
    const out = join(dir, 'case.md');
    expect(runCoverage(reportPath, GOLD, out, () => undefined, baseline)).toBe(0);
    const md = readFileSync(out, 'utf8');
    expect(md).toContain('## Строгая сверка: только ключевые слова');
    expect(md).toContain('Один запрос к той же модели');
  });
});

describe('вклад агентов и проверка точности', () => {
  it('таблица вклада растёт по шагам и заканчивается интервьюером', async () => {
    const { report } = await check(CASE, { client: null, cacheDir: null });
    const withModel: Report = {
      ...report,
      findings: [
        ...report.findings,
        { ...report.findings[0]!, id: 'D-900', source: 'llm', stage: 'consistency', ruleId: undefined, title: 'Критерий приёмки противоречит правилу месяца: январь и февраль', explanation: 'приемка противоречит месяц январь февраль', evidence: [{ quote: 'x', lineStart: 64, lineEnd: 64 }] } as Report['findings'][number],
      ],
    };
    const steps = ablation(withModel, gold);
    expect(steps[0]?.label).toBe('Линтер (правила без модели)');
    expect(steps.map((x) => x.label)).toContain('+ Ревизор согласованности');
    expect(steps.at(-1)?.label).toBe('+ Интервьюер (вопросы автору)');
    const major = (i: number) => steps[i]?.rows.find((r) => r.severity === 'major')?.covered ?? 0;
    for (let i = 1; i < steps.length; i++) expect(major(i)).toBeGreaterThanOrEqual(major(i - 1));
  });

  it('audit считает строгую и мягкую точность по решениям судьи', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dalel-'));
    const { report } = await check(CASE, { client: null, cacheDir: null });
    const reportPath = join(dir, 'r.json');
    writeFileSync(reportPath, JSON.stringify(report));
    const judge: LlmClient = {
      provider: 'fake',
      model: 'judge-1',
      cacheId: 'judge',
      async complete(req) {
        const ids = [...req.user.matchAll(/^(D-\d+) \[/gm)].map((m) => m[1] ?? '');
        return { text: JSON.stringify({ verdicts: ids.map((id, i) => ({ id, verdict: i % 4 === 0 ? 'invalid' : i % 4 === 1 ? 'partial' : 'valid', reason: 'Проверено по тексту.' })) }), tokensIn: 1, tokensOut: 1 };
      },
    };
    const out = join(dir, 'precision.md');
    expect(await runAudit(judge, reportPath, CASE, out, () => undefined)).toBe(0);
    const md = readFileSync(out, 'utf8');
    expect(md).toContain('| Все | ' + report.findings.length + ' |');
    expect(md).toContain('## Замечания, которые судья счёл неверными');
    expect(md).toMatch(/\| Все \| \d+ \| \d+ \| \d+ \| \d+ \| \d+ % \| \d+ % \|/);
  });
});

describe('стабильность между прогонами', () => {
  it('два прогона слоя правил совпадают полностью', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dalel-'));
    const paths: string[] = [];
    for (const n of [1, 2]) {
      const { report } = await check(CASE, { client: null, cacheDir: null });
      const p = join(dir, `r${n}.json`);
      writeFileSync(p, JSON.stringify(report));
      paths.push(p);
    }
    const md = renderStability(paths);
    expect(md).toContain('Нарезка требований одинакова во всех прогонах: да');
    expect(md).toContain('Замечания слоя правил одинаковы во всех прогонах: да');
    expect(md).toMatch(/найдено в каждом прогоне: \d+ \(100 %\)/);
  });
});

describe('веб-интерфейс', () => {
  const server = createApp(null);
  let base = '';
  beforeAll(async () => {
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
  });

  it('отдаёт страницу без внешних ресурсов', async () => {
    const res = await fetch(`${base}/`);
    const html = await res.text();
    expect(res.status).toBe(200);
    expect(html).toContain('<html lang="ru">');
    expect(html).not.toMatch(/(?:src|href)="https?:\/\//);
    expect(res.headers.get('content-security-policy')).toContain("default-src 'self'");
  });

  it('проверяет загруженный документ, принимает ответы и отдаёт отчёт для скачивания', async () => {
    const first = await fetch(`${base}/api/check?name=${encodeURIComponent('ТЗ <script>.md')}&rules=1`, { method: 'POST', body: readFileSync(CASE) });
    expect(first.status).toBe(200);
    const data = (await first.json()) as { id: string; verdict: Report['verdict']; summary: Report['summary']; questions: Report['questions'] };
    expect(data.verdict.code).toBe('not_ready');
    expect(data.summary.requirements).toBe(58);
    expect(data.questions.length).toBeGreaterThan(5);
    const full = await fetch(`${base}/api/report/${data.id}.html`);
    const html = await full.text();
    expect(full.headers.get('content-type')).toContain('text/html');
    expect(full.headers.get('content-disposition')).toBeNull();
    expect(html).toContain('Паспорт прогона');
    expect(html).not.toContain('<script>.md');

    const q = data.questions[0];
    const second = await fetch(`${base}/api/answer`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: data.id, answers: { [q?.id ?? '']: q?.options[0]?.label, 'Q-999': 'лишний' } }) });
    const after = (await second.json()) as typeof data;
    expect(after.questions.find((x) => x.id === q?.id)?.answer).toBe(q?.options[0]?.label);
    expect(after.questions.filter((x) => x.answer)).toHaveLength(1);

    const md = await fetch(`${base}/api/report/${data.id}.md`);
    expect(md.headers.get('content-disposition')).toContain('attachment');
    expect(await md.text()).toContain('## 5. Вопросы автору');
    const feature = await (await fetch(`${base}/api/report/${data.id}.feature`)).text();
    expect(feature.startsWith('# language: ru')).toBe(true);
    const pdf = Buffer.from(await (await fetch(`${base}/api/report/${data.id}.pdf`)).arrayBuffer());
    expect(pdf.subarray(0, 4).toString()).toBe('%PDF');
  });

  it('понятно отказывает на неподходящий формат, чужую сессию и путь вне API', async () => {
    const bad = await fetch(`${base}/api/check?name=table.xlsx`, { method: 'POST', body: 'x' });
    expect(bad.status).toBe(415);
    expect(((await bad.json()) as { error: string }).error).toContain('не поддерживается');
    expect((await fetch(`${base}/api/answer`, { method: 'POST', body: JSON.stringify({ id: 'нет', answers: {} }) })).status).toBe(404);
    expect((await fetch(`${base}/api/report/..%2F..%2Fetc%2Fpasswd.md`)).status).toBe(404);
    const broken = await fetch(`${base}/api/check?name=broken.pdf`, { method: 'POST', body: Buffer.from('%PDF-1.7 мусор') });
    expect(((await broken.json()) as { verdict: Report['verdict'] }).verdict.code).toBe('not_checked');
  });
});
