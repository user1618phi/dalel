import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { parse } from 'yaml';
import { renderMarkdown } from '../report/markdown.js';
import { type Report, STAGE_LABEL, type Stage } from '../types.js';

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

/**
 * Strict variant: text only. An entry is covered when one block of the text (a heading section or a table row)
 * contains at least two thirds of its keyword stems. Works for any report, including ones written by other tools.
 */
export function coverageText(text: string, gold: GoldDefect[]): CoverageRow[] {
  const lower = text.toLowerCase();
  const blocks = lower.split(/\n(?=#{2,5} )|\n(?=\| )/).flatMap((b) => (b.length > 2500 ? b.split(/\n\n+/) : [b]));
  const rows = new Map<string, CoverageRow>();
  for (const g of gold) {
    if (!/REAL/i.test(g.verdict)) continue;
    const stems = (g.keywords ?? []).map((k) => k.toLowerCase());
    const best = Math.max(0, ...blocks.map((b) => stems.filter((k) => b.includes(k)).length / Math.max(1, stems.length)));
    const row = rows.get(g.severity) ?? { severity: g.severity, total: 0, covered: 0 };
    row.total++;
    if (best >= 0.67) row.covered++;
    rows.set(g.severity, row);
  }
  const order = ['critical', 'major', 'minor'];
  return [...rows.values()].sort((a, b) => order.indexOf(a.severity) - order.indexOf(b.severity));
}

/** Contribution of each agent: catalogue coverage as the stages are switched on one after another. */
export function ablation(report: Report, gold: GoldDefect[]): { label: string; added: number; rows: CoverageRow[] }[] {
  const order: Stage[] = ['rules', 'analyze', 'consistency', 'gaps', 'sweep'];
  const out: { label: string; added: number; rows: CoverageRow[] }[] = [];
  const enabled = new Set<Stage>();
  for (const stage of order) {
    const own = report.findings.filter((f) => (f.stage ?? (f.source === 'rule' ? 'rules' : 'analyze')) === stage);
    if (own.length === 0 && stage !== 'rules') continue;
    enabled.add(stage);
    const subset: Report = { ...report, questions: [], findings: report.findings.filter((f) => enabled.has(f.stage ?? (f.source === 'rule' ? 'rules' : 'analyze'))) };
    out.push({ label: `${out.length === 0 ? '' : '+ '}${STAGE_LABEL[stage]}`, added: own.length, rows: coverage(subset, gold).rows });
  }
  out.push({ label: '+ Интервьюер (вопросы автору)', added: report.questions.length, rows: coverage(report, gold).rows });
  return out;
}

const LABEL: Record<string, string> = { critical: 'Критичные', major: 'Существенные', minor: 'Незначительные' };

export function runCoverage(reportPath: string, goldPath: string, out: string, log: (m: string) => void, baselinePath?: string): number {
  const report = JSON.parse(readFileSync(reportPath, 'utf8')) as Report;
  const gold = (parse(readFileSync(goldPath, 'utf8')) as { defects: GoldDefect[] }).defects;
  const c = coverage(report, gold);
  const strict = coverageText(renderMarkdown(report), gold);
  const baseline = baselinePath ? coverageText(readFileSync(baselinePath, 'utf8'), gold) : null;
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
  const steps = ablation(report, gold);
  if (steps.length > 2) {
    md.push('## Вклад каждого агента');
    md.push('');
    md.push('Агенты включаются по одному, в порядке конвейера; в ячейках — сколько записей каталога покрыто к этому шагу (мягкая сверка). В столбце «Добавил» — число замечаний самого агента после оппонента, для интервьюера — число вопросов.');
    md.push('');
    md.push('| Конвейер к этому шагу | Добавил | Критичные | Существенные | Незначительные |');
    md.push('| :--- | :---: | :---: | :---: | :---: |');
    for (const st of steps) {
      const n = (sev: string) => {
        const r = st.rows.find((x) => x.severity === sev);
        return r ? `${r.covered} из ${r.total}` : '—';
      };
      md.push(`| ${st.label} | ${st.added} | ${n('critical')} | ${n('major')} | ${n('minor')} |`);
    }
    md.push('');
  }

  md.push('## Строгая сверка: только ключевые слова');
  md.push('');
  md.push('Без учёта строк цитат: запись найдена, когда один блок текста отчёта (раздел или строка таблицы) содержит не менее двух третей её ключевых слов. Этот способ применим к любому тексту, поэтому им можно сравнивать отчёты разных инструментов.');
  md.push('');
  md.push(`| Тяжесть по каталогу | Записей | Отчёт агента |${baseline ? ' Один запрос к той же модели |' : ''}`);
  md.push(`| :--- | :---: | :---: |${baseline ? ' :---: |' : ''}`);
  for (const r of strict) {
    const b = baseline?.find((x) => x.severity === r.severity);
    md.push(`| ${LABEL[r.severity] ?? r.severity} | ${r.total} | ${r.covered} |${b ? ` ${b.covered} |` : ''}`);
  }
  md.push('');
  if (baseline) {
    md.push(`«Один запрос» — это ответ той же модели на просьбу проверить документ по ISO/IEC/IEEE 29148 и IEEE 830 без конвейера агента (команда \`dalel baseline\`, текст ответа: \`${baselinePath}\`). Сравнение показывает, что даёт конвейер сверх самой модели; у ответа одним запросом нет проверенных цитат, оппонента, вопросов и вердикта, посчитанного кодом.`);
    md.push('');
  }
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
  log(`coverage: ${c.rows.map((r) => `${r.severity} ${r.covered}/${r.total}`).join(', ')}; строго: ${strict.map((r) => `${r.covered}/${r.total}`).join(', ')}${baseline ? `; один запрос: ${baseline.map((r) => `${r.covered}/${r.total}`).join(', ')}` : ''}; отчёт: ${outPath}`);
  return 0;
}
