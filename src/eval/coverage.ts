import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { parse } from 'yaml';
import type { Report } from '../types.js';

interface GoldDefect {
  id: string;
  statement: string;
  quotes?: { text: string; line: number }[];
  severity: string;
  found_by?: number;
  verdict: string;
  keywords?: string[];
}

export interface CoverageRow {
  severity: string;
  total: number;
  covered: number;
}

export interface Coverage {
  rows: CoverageRow[];
  missed: GoldDefect[];
  falseHits: { gold: GoldDefect; by: string }[];
}

/**
 * Heuristic match of a report against a hand-made catalogue: a catalogue entry counts as covered when one
 * finding or question shares most of its keyword stems, with a bonus when the finding quotes the same line.
 */
export function coverage(report: Report, gold: GoldDefect[]): Coverage {
  const items = [
    ...report.findings.map((f) => ({
      id: f.id,
      lines: f.evidence.flatMap((e) => [e.lineStart, e.lineEnd]),
      text: `${f.title} ${f.explanation} ${f.recommendation} ${f.counterexample ? JSON.stringify(f.counterexample) : ''}`.toLowerCase(),
    })),
    ...report.questions.map((q) => ({ id: q.id, lines: [] as number[], text: `${q.text} ${q.why} ${q.options.map((o) => `${o.label} ${o.consequence}`).join(' ')}`.toLowerCase() })),
  ];
  const score = (g: GoldDefect): { best: number; by: string } => {
    const stems = (g.keywords ?? []).map((k) => k.toLowerCase());
    const lines = new Set((g.quotes ?? []).map((q) => q.line));
    let best = 0;
    let by = '';
    for (const it of items) {
      const share = stems.filter((k) => it.text.includes(k)).length / Math.max(1, stems.length);
      const s = share + (it.lines.some((l) => lines.has(l)) ? 0.34 : 0);
      if (s > best) {
        best = s;
        by = it.id;
      }
    }
    return { best, by };
  };
  const rows = new Map<string, CoverageRow>();
  const missed: GoldDefect[] = [];
  const falseHits: Coverage['falseHits'] = [];
  for (const g of gold) {
    const { best, by } = score(g);
    if (/FALSE/i.test(g.verdict)) {
      if (best >= 0.9) falseHits.push({ gold: g, by });
      continue;
    }
    if (!/REAL/i.test(g.verdict)) continue;
    const row = rows.get(g.severity) ?? { severity: g.severity, total: 0, covered: 0 };
    row.total++;
    if (best >= 0.67) row.covered++;
    else missed.push(g);
    rows.set(g.severity, row);
  }
  const order = ['critical', 'major', 'minor'];
  return { rows: [...rows.values()].sort((a, b) => order.indexOf(a.severity) - order.indexOf(b.severity)), missed, falseHits };
}

const LABEL: Record<string, string> = { critical: 'Критичные', major: 'Существенные', minor: 'Незначительные' };

export function runCoverage(reportPath: string, goldPath: string, out: string, log: (m: string) => void): number {
  const report = JSON.parse(readFileSync(reportPath, 'utf8')) as Report;
  const gold = (parse(readFileSync(goldPath, 'utf8')) as { defects: GoldDefect[] }).defects;
  const c = coverage(report, gold);
  const md: string[] = [];
  md.push('# Сверка отчёта с каталогом дефектов кейса');
  md.push('');
  md.push(`Файл сформирован командой \`npm run coverage\`. Отчёт: \`${reportPath}\` (модель ${report.passport.model}, агент ${report.passport.agentVersion}). Каталог: \`${goldPath}\` — ${gold.length} записей, собранных вручную по десяти открытым отчётам участников и собственному разбору документа.`);
  md.push('');
  md.push('Запись каталога считается найденной, когда одно замечание или вопрос отчёта содержит не менее двух третей её ключевых слов; совпадение строки цитаты добавляет к оценке треть. Сверка эвристическая: она может не узнать замечание, сформулированное другими словами, и наоборот.');
  md.push('');
  md.push('| Тяжесть по каталогу | Записей | Найдено в отчёте |');
  md.push('| :--- | :---: | :---: |');
  for (const r of c.rows) md.push(`| ${LABEL[r.severity] ?? r.severity} | ${r.total} | ${r.covered} (${Math.round((100 * r.covered) / Math.max(1, r.total))} %) |`);
  md.push('');
  md.push('## Записи каталога, которые сверка не нашла в отчёте');
  md.push('');
  if (c.missed.length === 0) md.push('Нет.');
  for (const g of c.missed) md.push(`- ${g.id} (${LABEL[g.severity] ?? g.severity}; встречается в ${g.found_by ?? 0} из 10 отчётов): ${g.statement}`);
  md.push('');
  md.push('## Ошибочные замечания из каталога, похожие на замечания отчёта');
  md.push('');
  md.push('В каталоге отмечены замечания, которые встречаются в чужих отчётах, но дефектом не являются. Если отчёт повторяет такое замечание, оно попадает сюда.');
  md.push('');
  if (c.falseHits.length === 0) md.push('Нет.');
  for (const h of c.falseHits) md.push(`- ${h.gold.id} ↔ ${h.by}: ${h.gold.statement}`);
  md.push('');
  const outPath = resolve(out);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, md.join('\n'));
  log(`coverage: ${c.rows.map((r) => `${r.severity} ${r.covered}/${r.total}`).join(', ')}; ошибочных совпадений ${c.falseHits.length}; отчёт: ${outPath}`);
  return 0;
}
