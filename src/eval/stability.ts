import { readFileSync } from 'node:fs';
import { type Finding, type Report, SEVERITY_LABEL } from '../types.js';

/** A finding's identity across runs: what it is about and where it points, not how the model worded it. */
function key(f: Finding): string {
  return `${f.ruleId ?? f.criterion.replace(/^set_/, '')}|${[...new Set(f.evidence.map((e) => e.lineStart))].sort((a, b) => a - b).slice(0, 2).join(',')}`;
}

export function renderStability(paths: string[]): string {
  const runs = paths.map((p) => JSON.parse(readFileSync(p, 'utf8')) as Report);
  const out: string[] = [];
  out.push('# Стабильность между прогонами');
  out.push('');
  out.push(`Один и тот же документ проверен ${runs.length} раз(а) без кэша. Замечание считается тем же самым, если совпадают правило или характеристика качества и строки цитат. Формулировки модели при этом могут различаться.`);
  out.push('');
  out.push('| Прогон | Модель | Требований | Критичных | Существенных | Вопросов |');
  out.push('| :--- | :--- | :---: | :---: | :---: | :---: |');
  runs.forEach((r, i) => out.push(`| ${i + 1} | ${r.passport.model} | ${r.summary.requirements} | ${r.summary.bySeverity.critical} | ${r.summary.bySeverity.major} | ${r.summary.questions} |`));
  out.push('');
  for (const severity of ['critical', 'major'] as const) {
    const sets = runs.map((r) => new Map(r.findings.filter((f) => f.severity === severity && f.status !== 'resolved').map((f) => [key(f), f])));
    const all = new Set(sets.flatMap((s) => [...s.keys()]));
    const everywhere = [...all].filter((k) => sets.every((s) => s.has(k)));
    out.push(`## ${severity === 'critical' ? 'Критичные' : 'Существенные'} замечания`);
    out.push('');
    out.push(`Разных замечаний за все прогоны: ${all.size}; найдено в каждом прогоне: ${everywhere.length} (${all.size === 0 ? 100 : Math.round((100 * everywhere.length) / all.size)} %).`);
    out.push('');
    if (severity === 'critical') {
      for (const k of all) {
        const sample = sets.map((s) => s.get(k)).find((f): f is Finding => Boolean(f));
        out.push(`- ${sets.filter((s) => s.has(k)).length} из ${runs.length}: ${sample?.title ?? k} (${SEVERITY_LABEL[severity]})`);
      }
      out.push('');
    }
  }
  const slicing = new Set(runs.map((r) => r.requirements.map((q) => `${q.id}:${q.lineStart}:${q.kind}`).join('|')));
  out.push(`Нарезка требований одинакова во всех прогонах: ${slicing.size === 1 ? 'да' : 'нет'}. Замечания слоя правил одинаковы во всех прогонах: ${new Set(runs.map((r) => r.findings.filter((f) => f.source === 'rule').map((f) => `${f.ruleId}|${f.evidence[0]?.lineStart}`).sort().join('|'))).size === 1 ? 'да' : 'нет'}.`);
  out.push('');
  return out.join('\n');
}
