import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { type LlmClient, LlmCache, type LlmUsage, completeJson, mapLimit } from '../llm/index.js';
import { loadDocument } from '../load/index.js';
import { AUDIT_SYSTEM, AuditSchema, numberedDocument } from '../stages/prompts.js';
import { redact } from '../stages/redact.js';
import { type Finding, type Report, SEVERITY_LABEL } from '../types.js';

/**
 * Precision check by an independent judge: another model reads the document and rules on every finding of the report.
 * A model judging a model is not ground truth — it is a second opinion that makes over-flagging visible.
 */
export async function runAudit(client: LlmClient, reportPath: string, docPath: string, out: string, log: (m: string) => void): Promise<number> {
  const report = JSON.parse(readFileSync(reportPath, 'utf8')) as Report;
  const doc = await loadDocument(docPath);
  const masked = redact(doc.text).text;
  const docText = numberedDocument(doc, masked.split('\n'));
  const findings = report.findings.filter((f) => f.status !== 'resolved');
  const batches: Finding[][] = [];
  for (let i = 0; i < findings.length; i += 24) batches.push(findings.slice(i, i + 24));
  const usage: LlmUsage = { calls: 0, cacheHits: 0, tokensIn: 0, tokensOut: 0 };
  const verdicts = new Map<string, { verdict: 'valid' | 'partial' | 'invalid'; reason: string }>();
  await mapLimit(batches, 3, async (batch, i) => {
    const listing = batch
      .map((f) => `${f.id} [${f.severity}, ${f.criterion}] ${f.title}\n  ${f.explanation}\n  Цитаты: ${f.evidence.map((e) => `стр. ${e.lineStart}: «${e.quote}»`).join(' | ')}`)
      .join('\n\n');
    const res = await completeJson(client, new LlmCache(null), usage, {
      stage: `проверка точности ${i + 1}/${batches.length}`,
      system: AUDIT_SYSTEM,
      user: redact(`${docText}\n\nЗамечания отчёта:\n${listing}`).text,
      schema: AuditSchema,
    });
    for (const v of res.verdicts) {
      const verdict = v.verdict.toLowerCase().startsWith('inv') ? 'invalid' : v.verdict.toLowerCase().startsWith('part') ? 'partial' : 'valid';
      if (batch.some((f) => f.id === v.id)) verdicts.set(v.id, { verdict, reason: v.reason });
    }
  });

  const judged = findings.filter((f) => verdicts.has(f.id));
  const count = (list: Finding[], v: string) => list.filter((f) => verdicts.get(f.id)?.verdict === v).length;
  const pct = (a: number, b: number) => (b === 0 ? '—' : `${Math.round((100 * a) / b)} %`);
  const md: string[] = [];
  md.push('# Проверка точности отчёта независимой моделью');
  md.push('');
  md.push(`Файл сформирован командой \`dalel audit\`. Отчёт: \`${reportPath}\` (сформирован моделью ${report.passport.model}). Судья: ${client.model} (${client.provider}) — он читает документ и выносит решение по каждому замечанию: верно, верно частично или неверно.`);
  md.push('');
  md.push('Судья — тоже модель, а не эталон: это второе мнение, которое делает видимым завышение. Строгая точность считает верными только замечания «верно», мягкая — «верно» и «частично».');
  md.push('');
  md.push('| Замечания | Проверено | Верно | Частично | Неверно | Точность строгая | Точность мягкая |');
  md.push('| :--- | :---: | :---: | :---: | :---: | :---: | :---: |');
  for (const [name, list] of [
    ['Все', judged],
    ['Критичные', judged.filter((f) => f.severity === 'critical')],
    ['Существенные', judged.filter((f) => f.severity === 'major')],
    ['Незначительные', judged.filter((f) => f.severity === 'minor')],
    ['От правил', judged.filter((f) => f.source === 'rule')],
    ['От модели', judged.filter((f) => f.source === 'llm')],
  ] as const) {
    const v = count(list, 'valid');
    const p = count(list, 'partial');
    md.push(`| ${name} | ${list.length} | ${v} | ${p} | ${count(list, 'invalid')} | ${pct(v, list.length)} | ${pct(v + p, list.length)} |`);
  }
  md.push('');
  md.push('## Замечания, которые судья счёл неверными');
  md.push('');
  const invalid = judged.filter((f) => verdicts.get(f.id)?.verdict === 'invalid');
  if (invalid.length === 0) md.push('Нет.');
  for (const f of invalid) md.push(`- ${f.id} (${SEVERITY_LABEL[f.severity]}, ${f.source === 'rule' ? `правило ${f.ruleId}` : 'модель'}): ${f.title} — ${verdicts.get(f.id)?.reason ?? ''}`);
  md.push('');
  md.push('## Замечания, верные частично');
  md.push('');
  const partial = judged.filter((f) => verdicts.get(f.id)?.verdict === 'partial');
  if (partial.length === 0) md.push('Нет.');
  for (const f of partial) md.push(`- ${f.id} (${SEVERITY_LABEL[f.severity]}): ${f.title} — ${verdicts.get(f.id)?.reason ?? ''}`);
  md.push('');
  if (judged.length < findings.length) md.push(`Судья не вынес решения по ${findings.length - judged.length} замечаниям; они в расчёт не вошли.\n`);
  const outPath = resolve(out);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, md.join('\n'));
  log(`audit: проверено ${judged.length} из ${findings.length}; верно ${count(judged, 'valid')}, частично ${count(judged, 'partial')}, неверно ${invalid.length}; отчёт: ${outPath}`);
  return 0;
}
