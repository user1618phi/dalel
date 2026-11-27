import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type LlmClient, mapLimit } from '../llm/index.js';
import { agentVersion, check } from '../pipeline.js';
import type { Finding, Report } from '../types.js';
import { type Mutation, type Mutator, applyAll } from './mutators.js';

export interface EvalOptions {
  client: LlmClient | null;
  log: (m: string) => void;
  out: string;
  useCache: boolean;
}

interface Outcome {
  spec: string;
  mutator: Mutator;
  mutation: Mutation;
  evaluated: boolean;
  caught: boolean;
  by: string[];
}

const key = (f: Finding) => `${f.ruleId ?? 'llm'}|${f.ruleId ? f.title.replace(/\d+/g, '#') : ''}`;

/**
 * Mutation testing of the reviewer: known defects are injected into clean specs one at a time,
 * and the agent has to report something new that it did not report on the clean text.
 */
export async function runEval(opts: EvalOptions): Promise<number> {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const specDir = join(root, 'eval', 'specs');
  const specs = readdirSync(specDir).filter((f) => f.endsWith('.md')).sort();
  const work = mkdtempSync(join(tmpdir(), 'dalel-eval-'));
  const cacheDir = opts.useCache ? join(process.cwd(), '.dalel-cache') : null;
  // With a model: both set-level stages, the opponent, and the per-requirement stage for acceptance criteria only.
  const run = async (file: string, withModel: boolean): Promise<Report> =>
    (await check(file, { client: withModel ? opts.client : null, cacheDir, useCache: opts.useCache, skipStages: ['clarify'], analyzeKinds: ['acceptance'] })).report;

  const outcomes: Outcome[] = [];
  const clean: { spec: string; mode: string; findings: Finding[] }[] = [];

  for (const spec of specs) {
    const text = readFileSync(join(specDir, spec), 'utf8');
    opts.log(`eval: ${spec} — чистый документ`);
    const baseRules = await run(join(specDir, spec), false);
    clean.push({ spec, mode: 'правила', findings: baseRules.findings });
    const baseLlm = opts.client ? await run(join(specDir, spec), true) : null;
    if (baseLlm) clean.push({ spec, mode: 'правила + модель', findings: baseLlm.findings.filter((f) => f.source === 'llm') });
    const baseKeys = new Set(baseRules.findings.map(key));

    const mutants = applyAll(text);
    opts.log(`eval: ${spec} — мутантов: ${mutants.length}`);
    const results = await mapLimit(mutants, opts.client ? 3 : 8, async ({ mutator, mutation }, i) => {
      const file = join(work, `${spec.replace(/\.md$/, '')}.${String(i).padStart(2, '0')}.md`);
      writeFileSync(file, mutation.text);
      const rules = await run(file, false);
      const fresh = rules.findings.filter((f) => !baseKeys.has(key(f)));
      let caught = fresh.length > 0;
      const by = fresh.map((f) => f.ruleId ?? 'llm');
      let evaluated = mutator.layer === 'rules' || caught;
      if (!caught && mutator.layer === 'llm' && opts.client) {
        evaluated = true;
        const llm = await run(file, true);
        const modelFindings = llm.findings.filter((f) => f.source === 'llm');
        const baseModel = (baseLlm?.findings ?? []).filter((f) => f.source === 'llm');
        // (a) the finding quotes text that exists only in the mutant, at the mutated place;
        const citesMutation = modelFindings.filter((f) => f.evidence.some((e) => !text.includes(e.quote) && mutation.lines.some((l) => Math.abs(l - e.lineStart) <= 1)));
        // (b) for deletions: the finding names the requirement the mutation left uncovered, and the clean run has fewer such findings.
        const ids = [...mutation.note.matchAll(/[А-ЯЁA-Z]{1,3}-\d+/gu)].map((m) => m[0]);
        const names = (f: Finding) => ids.some((id) => new RegExp(`${id}(?!\\d)`, 'u').test(`${f.title} ${f.explanation}`));
        const namesTarget = modelFindings.filter((f) => ['set_validatable', 'set_complete'].includes(f.criterion) && names(f));
        const baseNames = baseModel.filter((f) => ['set_validatable', 'set_complete'].includes(f.criterion) && names(f));
        const hits = citesMutation.length > 0 ? citesMutation : ids.length > 0 && namesTarget.length > baseNames.length ? namesTarget : [];
        if (hits.length > 0) {
          caught = true;
          by.push(...hits.map((f) => `модель: ${f.criterion}`));
        }
      }
      return { spec, mutator, mutation, evaluated, caught, by: [...new Set(by)] };
    });
    outcomes.push(...results);
  }

  const evaluated = outcomes.filter((o) => o.evaluated);
  const layer = (l: 'rules' | 'llm') => evaluated.filter((o) => o.mutator.layer === l);
  const pct = (a: number, b: number) => (b === 0 ? '—' : `${Math.round((100 * a) / b)} %`);
  const rulesAll = layer('rules');
  const llmAll = layer('llm');
  const rulesCaught = rulesAll.filter((o) => o.caught).length;
  const llmCaught = llmAll.filter((o) => o.caught).length;

  const classes = [...new Set(outcomes.map((o) => o.mutator.defectClass))];
  const v = agentVersion();
  const md: string[] = [];
  md.push('# Замер качества: мутационное тестирование ревьюера');
  md.push('');
  md.push('Файл сформирован командой `npm run eval`. В два чистых ТЗ (`eval/specs/`) по одному вносятся известные дефекты; дефект считается найденным, если агент сообщил о мутанте то, чего не сообщал о чистом тексте. Документ хакатона в эталон не входит: правила под него не подгонялись.');
  md.push('');
  md.push(`Версия агента: ${v.version} (${v.commit}). Модель: ${opts.client ? `${opts.client.model} (${opts.client.provider}); для экономии запросов выполнялись этапы набора, оппонент и проверка критериев приёмки, без этапа вопросов` : 'не использовалась — замер только детерминированного слоя'}.`);
  md.push('');
  md.push('Как считается «найдено». Слой правил детерминирован, поэтому любое новое замечание на мутанте вызвано мутацией. Для модели требуется больше: замечание должно цитировать изменённое место текстом, которого нет в чистом документе, либо — для удалений — называть требование, оставшееся без покрытия, чаще, чем на чистом документе.');
  md.push('');
  md.push('Что замер не показывает. Правила разрабатывались с оглядкой на этот набор мутаторов, поэтому полнота правил — нижняя граница для документов в том же шаблоне, а не оценка на произвольном ТЗ. Чистые ТЗ написаны для замера и вычитаны только на дефекты, которые ловят правила; модель находит в них собственные пропуски, часть которых реальна. Поэтому число замечаний модели на чистых документах — не мера её ложных срабатываний: такой меры здесь нет.');
  md.push('');
  md.push('| Показатель | Значение |');
  md.push('| :--- | :--- |');
  md.push(`| Чистых документов | ${specs.length} |`);
  md.push(`| Мутантов всего | ${outcomes.length} |`);
  md.push(`| Полнота слоя правил | ${rulesCaught} из ${rulesAll.length} (${pct(rulesCaught, rulesAll.length)}) |`);
  md.push(`| Полнота на смысловых дефектах (нужна модель) | ${opts.client ? `${llmCaught} из ${llmAll.length} (${pct(llmCaught, llmAll.length)})` : `не измерялась: ${outcomes.filter((o) => o.mutator.layer === 'llm' && !o.evaluated).length} мутантов требуют модели`} |`);
  const rulesClean = clean.filter((c) => c.mode === 'правила').flatMap((c) => c.findings);
  const modelClean = clean.filter((c) => c.mode !== 'правила').flatMap((c) => c.findings);
  md.push(`| Замечаний правил на чистых документах | ${rulesClean.length} |`);
  md.push(`| Замечаний модели на чистых документах (критичных и существенных / незначительных) | ${opts.client ? `${modelClean.filter((f) => f.severity !== 'minor').length} / ${modelClean.filter((f) => f.severity === 'minor').length}` : 'не измерялось'} |`);
  md.push('');
  md.push('## По классам дефектов');
  md.push('');
  md.push('| Класс дефекта | Слой | Мутантов | Найдено | Чем найдено |');
  md.push('| :--- | :--- | :---: | :---: | :--- |');
  for (const c of classes) {
    const all = outcomes.filter((o) => o.mutator.defectClass === c);
    const ev = all.filter((o) => o.evaluated);
    const by = [...new Set(all.flatMap((o) => o.by))].join(', ') || '—';
    md.push(`| ${c} | ${all[0]?.mutator.layer === 'rules' ? 'правила' : 'модель'} | ${all.length} | ${ev.length === 0 ? 'не измерялось' : `${ev.filter((o) => o.caught).length} из ${ev.length}`} | ${by} |`);
  }
  md.push('');
  const missed = evaluated.filter((o) => !o.caught);
  md.push('## Пропущенные дефекты');
  md.push('');
  if (missed.length === 0) md.push('Нет.');
  for (const o of missed) md.push(`- ${o.spec} · ${o.mutator.id} (${o.mutator.defectClass}): ${o.mutation.note}`);
  md.push('');
  md.push('## Замечания на чистых документах');
  md.push('');
  if (clean.every((c) => c.findings.length === 0)) md.push('Нет.');
  for (const c of clean) for (const f of c.findings) md.push(`- ${c.spec} · ${c.mode} · ${f.severity} · ${f.ruleId ?? 'модель'}: ${f.title}`);
  md.push('');

  const outPath = resolve(opts.out);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, md.join('\n'));
  opts.log(`eval: правила ${rulesCaught}/${rulesAll.length}, модель ${opts.client ? `${llmCaught}/${llmAll.length}` : 'не измерялась'}, замечаний правил на чистых документах ${rulesClean.length}`);
  opts.log(`eval: отчёт записан: ${outPath}`);
  const recall = rulesAll.length === 0 ? 1 : rulesCaught / rulesAll.length;
  return recall >= 0.85 && clean.filter((c) => c.mode === 'правила').every((c) => c.findings.every((f) => f.severity === 'minor')) ? 0 : 1;
}
