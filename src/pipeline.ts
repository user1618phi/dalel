import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type LlmClient, LlmCache, type LlmUsage, completeJson, mapLimit } from './llm/index.js';
import { loadDocument } from './load/index.js';
import { type QuestionSeed, type RuleFinding, runRules } from './rules/index.js';
import { type RulePack, loadPacks, packApplies } from './rules/packs.js';
import { parseBlocks, sliceRequirements, splitTableRow, stripMarkdown } from './segment/index.js';
import {
  ANALYZE_SYSTEM,
  ANSWERS_SYSTEM,
  AnalyzeSchema,
  AnswersSchema,
  CLARIFY_SYSTEM,
  ClarifySchema,
  GAPS_SYSTEM,
  OPPONENT_SYSTEM,
  OpponentSchema,
  PROMPT_HASH,
  SET_SYSTEM,
  SetSchema,
  numberedDocument,
  unitList,
} from './stages/prompts.js';
import { redact } from './stages/redact.js';
import { deriveTestCases } from './stages/testcases.js';
import { QuoteVerifier, checkArithmetic } from './stages/verify.js';
import {
  CRITERION_REF,
  type ChecklistItem,
  type Criterion,
  type Diagnostic,
  type Evidence,
  type Finding,
  LoadError,
  NON_REQUIREMENT_KINDS,
  type Question,
  REQUIREMENT_CRITERIA,
  type ReqKind,
  type Report,
  type Requirement,
  type RiskKind,
  type RootCause,
  SET_CRITERIA,
  type Severity,
  type SourceDoc,
  type TraceRow,
  type Verdict,
} from './types.js';

export interface CheckOptions {
  /** null → deterministic layer only. */
  client: LlmClient | null;
  cacheDir?: string | null;
  useCache?: boolean;
  concurrency?: number;
  /** Answers of the author keyed by question id (Q-01 → text). */
  answers?: Record<string, string>;
  answersFile?: string;
  packs?: string[];
  maxQuestions?: number;
  /** Lets the eval harness run only the set-level stage to keep the number of model calls small. */
  skipStages?: ('analyze' | 'gaps' | 'clarify')[];
  /** Restrict the per-requirement stage to these kinds (the eval harness checks acceptance criteria only). */
  analyzeKinds?: ReqKind[];
  /** Mask card numbers, IIN, phones and e-mails in the text sent to the model. Default: true. */
  redact?: boolean;
  now?: Date;
  onProgress?: (message: string) => void;
}

export interface CheckResult {
  report: Report;
  doc: SourceDoc | null;
}

const SEVERITY_RANK: Record<Severity, number> = { critical: 0, major: 1, minor: 2 };
const RISK_RANK: Record<string, number> = { high: 0, medium: 1, low: 2 };
const RISK_KINDS: RiskKind[] = ['money', 'compliance', 'security', 'customer', 'operations', 'delivery'];
const ALL_CRITERIA = new Set<string>([...REQUIREMENT_CRITERIA, ...SET_CRITERIA]);
const FAMILY: Partial<Record<Criterion, Criterion>> = {
  complete: 'set_complete',
  unambiguous: 'set_comprehensible',
  correct: 'set_consistent',
  verifiable: 'set_validatable',
  feasible: 'set_feasible',
};

type Draft = Omit<Finding, 'id'> & { questionSeed?: QuestionSeed };

function agentRoot(): string {
  return join(dirname(fileURLToPath(import.meta.url)), '..');
}

function listFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(full));
    else if (/\.(ts|js|yaml|yml)$/.test(entry.name) && !entry.name.endsWith('.d.ts')) out.push(full);
  }
  return out;
}

/** Hash of the agent's own code and rule packs: identifies the build even when there is no git history. */
function sourceFingerprint(): string {
  const root = agentRoot();
  const hash = createHash('sha256');
  const codeDir = existsSync(join(root, 'src')) ? join(root, 'src') : dirname(fileURLToPath(import.meta.url));
  for (const dir of [codeDir, join(root, 'packs')]) {
    if (!existsSync(dir)) continue;
    for (const file of listFiles(dir)) {
      hash.update(relative(root, file).replace(/\\/g, '/'));
      hash.update(readFileSync(file));
    }
  }
  return hash.digest('hex').slice(0, 12);
}

export function agentVersion(): { version: string; commit: string } {
  let version = '0.0.0';
  try {
    version = (JSON.parse(readFileSync(join(agentRoot(), 'package.json'), 'utf8')) as { version?: string }).version ?? version;
  } catch {
    /* version stays unknown */
  }
  let commit = 'без git-коммита';
  try {
    const run = (args: string[]) => execFileSync('git', args, { cwd: agentRoot(), stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    // The agent's own repository, not a parent one it merely happens to sit inside.
    if (resolve(run(['rev-parse', '--show-toplevel'])) === resolve(agentRoot())) {
      const hash = run(['rev-parse', '--short=10', 'HEAD']);
      const dirty = run(['status', '--porcelain', '--untracked-files=no']) !== '';
      commit = dirty ? `${hash} + незакоммиченные изменения` : hash;
    }
  } catch {
    /* not a git checkout */
  }
  let fingerprint = '';
  try {
    fingerprint = sourceFingerprint();
  } catch {
    /* fingerprint is optional */
  }
  return { version, commit: fingerprint ? `${commit}; отпечаток исходников ${fingerprint}` : commit };
}

function toSeverity(s: string | null | undefined, fallback: Severity): Severity {
  const v = (s ?? '').toLowerCase();
  return v === 'critical' || v === 'major' || v === 'minor' ? v : fallback;
}

function toCriterion(raw: string, scope: 'requirement' | 'set'): Criterion {
  const v = raw.toLowerCase().replace(/[^a-z_]/g, '');
  if (scope === 'set') {
    if (ALL_CRITERIA.has(v) && (SET_CRITERIA as string[]).includes(v)) return v as Criterion;
    if (ALL_CRITERIA.has(`set_${v}`)) return `set_${v}` as Criterion;
    if (v.includes('consist') || v.includes('contradict')) return 'set_consistent';
    if (v.includes('valid')) return 'set_validatable';
    if (v.includes('compreh')) return 'set_comprehensible';
    return 'set_complete';
  }
  if ((REQUIREMENT_CRITERIA as string[]).includes(v)) return v as Criterion;
  return 'unambiguous';
}

function evidenceLines(f: { evidence: Evidence[] }): Set<number> {
  const s = new Set<number>();
  for (const e of f.evidence) for (let l = e.lineStart; l <= e.lineEnd; l++) s.add(l);
  return s;
}

function subset(a: Set<number>, b: Set<number>): boolean {
  if (a.size === 0) return false;
  for (const x of a) if (!b.has(x)) return false;
  return true;
}

function emptyReport(passport: Report['passport'], diagnostics: Diagnostic[], headline: string, rationale: string): Report {
  return {
    schema: 'dalel.report/1',
    passport,
    requirements: [],
    findings: [],
    rejected: [],
    rootCauses: [],
    questions: [],
    trace: [],
    summary: {
      units: 0,
      requirements: 0,
      findings: 0,
      bySeverity: { critical: 0, major: 0, minor: 0 },
      byCriterion: {},
      requirementsWithFindings: 0,
      questions: 0,
      blockingQuestions: 0,
      rejectedByOpponent: 0,
      droppedUnverified: 0,
      critical: [],
    },
    verdict: { code: 'not_checked', headline, rationale, fixFirst: [] },
    diagnostics,
  };
}

export function parseAnswers(markdown: string): Record<string, string> {
  const out: Record<string, string> = {};
  const parts = markdown.split(/^#{2,3}\s+(Q-\d+)\b.*$/m);
  for (let i = 1; i + 1 < parts.length; i += 2) {
    const id = parts[i];
    const m = /\*\*Ответ:\*\*([\s\S]*?)(?=\n-{3,}\s*\n|\n#{2,3}\s|$)/u.exec(parts[i + 1] ?? '');
    const answer = (m?.[1] ?? '').trim();
    if (id && answer !== '' && !/^[_.…\s]+$/.test(answer)) out[id] = answer;
  }
  return out;
}

function computeVerdict(findings: Finding[], questions: Question[], fixFirst: Verdict['fixFirst'], llmUsed: boolean): Verdict {
  const active = findings.filter((f) => f.status !== 'resolved');
  const critical = active.filter((f) => f.severity === 'critical' && f.status !== 'question');
  const major = active.filter((f) => f.severity === 'major');
  const blocking = questions.filter((q) => q.blocking && !q.answer);
  const scopeNote = llmUsed ? '' : ' Проверка выполнена только детерминированными правилами, без модели: смысловые противоречия и пропуски могли остаться незамеченными.';
  let fix = fixFirst.filter((x) => active.some((f) => f.id === x.findingId));
  if (fix.length === 0) {
    fix = [...critical, ...major].slice(0, 7).map((f) => ({ findingId: f.id, text: f.recommendation || f.title }));
  }
  if (critical.length > 0) {
    return {
      code: 'not_ready',
      headline: 'По этому документу нельзя начинать разработку и тестирование',
      rationale: `Критичных дефектов: ${critical.length}. Они относятся к ключевому поведению: по тексту его нельзя однозначно реализовать или проверить. Существенных замечаний: ${major.length}; блокирующих вопросов к автору: ${blocking.length}.${scopeNote}`,
      fixFirst: fix,
    };
  }
  if (major.length > 0 || blocking.length > 0) {
    return {
      code: 'ready_with_conditions',
      headline: 'Начинать можно только после ответов на блокирующие вопросы',
      rationale: `Критичных дефектов нет. Существенных замечаний: ${major.length}; блокирующих вопросов: ${blocking.length}. Части документа без замечаний можно брать в работу, остальное — после правок.${scopeNote}`,
      fixFirst: fix,
    };
  }
  return {
    code: 'ready',
    headline: 'Документ пригоден для начала разработки и тестирования',
    rationale: `Критичных и существенных замечаний нет; незначительных: ${active.length}.${scopeNote}`,
    fixFirst: fix,
  };
}

export async function check(path: string, opts: CheckOptions): Promise<CheckResult> {
  const started = Date.now();
  const now = opts.now ?? new Date();
  const progress = opts.onProgress ?? (() => undefined);
  const usage: LlmUsage = { calls: 0, cacheHits: 0, tokensIn: 0, tokensOut: 0 };
  const { version, commit } = agentVersion();
  const client = opts.client;
  const diagnostics: Diagnostic[] = [];
  const packs: RulePack[] = loadPacks(undefined, opts.packs);

  const passport = (doc: SourceDoc | null): Report['passport'] => ({
    documentName: doc?.name ?? path.split(/[\\/]/).pop() ?? path,
    documentPath: path,
    documentSha256: doc?.sha256 ?? '',
    documentFormat: doc?.format ?? 'txt',
    documentLines: doc?.lines.length ?? 0,
    date: now.toISOString(),
    provider: client?.provider ?? 'нет',
    model: client?.model ?? 'нет',
    mode: client ? 'rules+llm' : 'rules-only',
    agentVersion: version,
    agentCommit: commit,
    rulePacks: packs.map((p) => `${p.id}@${p.version}`),
    promptHash: PROMPT_HASH,
    durationMs: Date.now() - started,
    llmCalls: usage.calls,
    llmCacheHits: usage.cacheHits,
    tokensIn: usage.tokensIn,
    tokensOut: usage.tokensOut,
  });

  let doc: SourceDoc;
  try {
    doc = await loadDocument(path);
  } catch (e) {
    const d: Diagnostic = e instanceof LoadError ? e.diagnostic : { level: 'error', code: 'corrupted', message: `Не удалось прочитать файл: ${e instanceof Error ? e.message : String(e)}`, hint: 'Проверьте файл и повторите запуск.' };
    return {
      report: emptyReport(passport(null), [d], 'Документ не проверен: файл не удалось прочитать', `${d.message}${d.hint ? ` ${d.hint}` : ''}`),
      doc: null,
    };
  }
  diagnostics.push(...doc.diagnostics);

  progress('нарезка требований');
  const blocks = parseBlocks(doc);
  const reqs = sliceRequirements(doc, blocks);
  if (reqs.length === 0) {
    diagnostics.push({ level: 'error', code: 'empty_file', message: 'В документе не найдено ни одного пункта для проверки.', hint: 'Убедитесь, что файл содержит текст требований.' });
    return { report: emptyReport(passport(doc), diagnostics, 'Документ не проверен: в нём нет текста требований', 'После разбора файла не осталось ни одного пункта.'), doc };
  }
  const reqById = new Map(reqs.map((r) => [r.id, r]));

  progress('правила без модели');
  const ruled = runRules(doc, blocks, reqs, packs);
  diagnostics.push(...ruled.diagnostics);
  const drafts: Draft[] = ruled.findings.map((f: RuleFinding) => ({ ...f, status: f.questionSeed ? 'question' : 'confirmed' }));
  const rejected: Draft[] = [];
  let droppedUnverified = 0;
  let traceRaw: { requirementId: string; api: string[]; acceptance: string[] }[] = [];
  let llmUsed = false;
  /** Findings in the order the opponent saw them (C-01…); used to translate its cross-references into final ids. */
  let contestedOrder: Draft[] = [];

  const cache = new LlmCache(opts.cacheDir === undefined ? join(process.cwd(), '.dalel-cache') : opts.cacheDir, opts.useCache ?? true);
  const masked = client && (opts.redact ?? true) ? redact(doc.text) : { text: doc.text, count: 0, kinds: [] as string[] };
  if (masked.count > 0) {
    diagnostics.push({ level: 'info', code: 'note', message: `Перед отправкой модели замаскировано фрагментов: ${masked.count} (${masked.kinds.join(', ')}). В отчёте цитаты приведены по исходному тексту.` });
  }
  // Summaries, quotes and rule titles are built from the source text, so everything that leaves the process is masked, not only the document body.
  const outgoing = (t: string) => ((opts.redact ?? true) ? redact(t).text : t);
  const verifier = new QuoteVerifier(doc, reqs, masked.text);
  const docText = numberedDocument(doc, masked.text.split('\n'));
  const lenses = packs.filter((p) => packApplies(p, doc.text)).flatMap((p) => p.lenses ?? []);
  // Bookkeeping rows of an API card say nothing about behaviour; sending them to the model only breeds noise.
  const bookkeeping = /^\|?\s*\**\s*(controller|gitlab project|framework|author|developer|url type|swagger)\b/iu;
  const known = (ids?: Set<string>) =>
    ruled.findings
      .filter((f) => !ids || f.requirementIds.some((id) => ids.has(id)))
      .map((f) => `- ${f.ruleId} [${f.requirementIds.join(', ')}]: ${f.title}`)
      .join('\n') || '- нет';

  if (client) {
    // --- per-requirement analysis ---
    const targets = opts.skipStages?.includes('analyze') ? [] : reqs.filter((r) => !NON_REQUIREMENT_KINDS.has(r.kind) && !/^\s*[{[]/.test(r.text) && !(r.kind === 'api_meta' && bookkeeping.test(r.text)) && (!opts.analyzeKinds || opts.analyzeKinds.includes(r.kind)));
    const batches: Requirement[][] = [];
    for (let i = 0; i < targets.length; i += 14) batches.push(targets.slice(i, i + 14));
    if (batches.length > 0) progress(`анализ требований моделью: ${targets.length} пунктов, ${batches.length} запр.`);
    const llmDrafts: Draft[] = [];
    await mapLimit(batches, opts.concurrency ?? 3, async (batch, bi) => {
      try {
        const ids = new Set(batch.map((r) => r.id));
        const res = await completeJson(client, cache, usage, {
          stage: `анализ требований ${bi + 1}/${batches.length}`,
          system: ANALYZE_SYSTEM,
          user: outgoing(`${docText}\n\nПункты для проверки:\n${unitList(batch)}\n\nУже найдено правилами (не повторять):\n${known(ids)}`),
          schema: AnalyzeSchema,
        });
        llmUsed = true;
        for (const item of res.items) {
          const req = reqById.get(item.id);
          if (!req || !ids.has(item.id)) continue;
          if (item.summary && item.summary.length <= 170) req.summary = item.summary;
          const cap = req.kind === 'functional' || req.kind === 'nonfunctional' ? 3 : 2;
          for (const f of item.findings.slice(0, cap)) {
            // Wording-level remarks are the deterministic layer's job; a model minor is mostly noise.
            if (toSeverity(f.severity, 'major') === 'minor') continue;
            const evidence = verifier.verify(f.quote, req.id);
            if (!evidence) {
              droppedUnverified++;
              continue;
            }
            const criterion = toCriterion(f.criterion, 'requirement');
            if (criterion === 'singular') continue;
            llmDrafts.push({
              source: 'llm',
              scope: 'requirement',
              criterion,
              standardRef: CRITERION_REF[criterion],
              severity: toSeverity(f.severity, 'major'),
              title: f.title,
              explanation: f.explanation,
              recommendation: f.recommendation,
              requirementIds: [req.id],
              evidence: [{ ...evidence, requirementId: evidence.requirementId ?? req.id }],
              status: 'confirmed',
            });
          }
        }
      } catch (e) {
        diagnostics.push({ level: 'warning', code: 'llm_stage_failed', message: `Этап анализа требований (пакет ${bi + 1}) не выполнен: ${e instanceof Error ? e.message : String(e)}`, hint: 'Пункты этого пакета проверены только правилами.' });
      }
    });

    // --- set-level analysis: consistency, then gaps ---
    const setStages = [
      { name: 'согласованность набора', system: SET_SYSTEM, extra: '' },
      ...(opts.skipStages?.includes('gaps') ? [] : [{ name: 'пропуски в наборе', system: GAPS_SYSTEM, extra: `\n\nЛинзы предметной области:\n${lenses.map((l) => `- ${l}`).join('\n') || '- нет'}` }]),
    ];
    progress(`проверка набора требований моделью: ${setStages.length} запр.`);
    await mapLimit(setStages, 2, async (stage) => {
      try {
        const res = await completeJson(client, cache, usage, {
          stage: stage.name,
          system: stage.system,
          user: outgoing(`${docText}\n\nСписок пунктов:\n${unitList(reqs)}\n\nУже найдено правилами (не повторять):\n${known()}${stage.extra}`),
          schema: SetSchema,
        });
        llmUsed = true;
        if (res.trace.length > 0) traceRaw = res.trace;
        for (const f of res.findings.slice(0, 14)) {
          const evidence: Evidence[] = [];
          for (const q of f.quotes) {
            const e = verifier.verify(q);
            if (e && !evidence.some((x) => x.lineStart === e.lineStart && x.quote === e.quote)) evidence.push(e);
            else if (!e) droppedUnverified++;
          }
          if (evidence.length === 0) continue;
          const criterion = toCriterion(f.criterion, 'set');
          const ce = f.counterexample;
          const expectations = (ce?.expectations ?? []).filter((x) => reqById.has(x.requirementId));
          const hasCe = Boolean(ce && (ce.given.length > 0 || ce.when.length > 0) && ce.conflict !== '');
          const arithmetic = ce ? checkArithmetic([...ce.given, ...ce.when, ...expectations.map((x) => x.expected), ce.conflict]) : { found: 0, ok: true };
          if (hasCe && !arithmetic.ok) {
            // A counterexample whose own numbers do not add up proves nothing.
            droppedUnverified++;
            continue;
          }
          const requirementIds = [...new Set([...evidence.map((e) => e.requirementId), ...expectations.map((x) => x.requirementId)].filter((x): x is string => Boolean(x)))];
          llmDrafts.push({
            source: 'llm',
            scope: 'set',
            criterion,
            standardRef: CRITERION_REF[criterion],
            severity: toSeverity(f.severity, 'major'),
            title: f.title,
            explanation: f.explanation,
            recommendation: f.recommendation,
            requirementIds,
            evidence,
            ...(hasCe && ce ? { counterexample: { given: ce.given, when: ce.when, expectations, conflict: ce.conflict, ...(arithmetic.found > 0 ? { arithmeticChecked: true } : {}) } } : {}),
            status: 'confirmed',
          });
        }
      } catch (e) {
        diagnostics.push({ level: 'warning', code: 'llm_stage_failed', message: `Этап «${stage.name}» не выполнен: ${e instanceof Error ? e.message : String(e)}`, hint: 'Эта часть проверки набора моделью не проведена.' });
      }
    });

    // --- dedupe against rules and between the two model stages ---
    const sameTopic = (x: Criterion, y: Criterion) => x === y || FAMILY[x] === y || FAMILY[y] === x;
    const ruleLines = ruled.findings.map((f) => evidenceLines(f));
    const kept: Draft[] = [];
    // Set-level findings go first so that a per-requirement duplicate of the same gap is the one that is dropped.
    const ordered = [...llmDrafts.filter((d) => d.scope === 'set'), ...llmDrafts.filter((d) => d.scope === 'requirement')];
    for (const d of ordered) {
      const lines = evidenceLines(d);
      const dupOfRule = ruled.findings.some((rf, i) => !rf.questionSeed && sameTopic(rf.criterion, d.criterion) && subset(lines, ruleLines[i] ?? new Set()));
      if (dupOfRule && !d.counterexample) continue;
      const dupOfKept = kept.some((k) => sameTopic(k.criterion, d.criterion) && (subset(lines, evidenceLines(k)) || k.title === d.title));
      if (dupOfKept) continue;
      kept.push(d);
    }

    // --- opponent ---
    const contested = kept.filter((d) => d.severity !== 'minor');
    contestedOrder = contested;
    if (contested.length > 0) {
      progress(`оппонент: ${contested.length} замечаний`);
      try {
        const listing = contested
          .map((d, i) => {
            const ce = d.counterexample ? `\n  Контрпример: ${[...d.counterexample.given, ...d.counterexample.when].join(' ')} Конфликт: ${d.counterexample.conflict}` : '';
            return `C-${String(i + 1).padStart(2, '0')} [${d.severity}, ${d.criterion}] ${d.title}\n  ${d.explanation}\n  Цитаты: ${d.evidence.map((e) => `стр. ${e.lineStart}: «${e.quote}»`).join(' | ')}${ce}`;
          })
          .join('\n\n');
        const res = await completeJson(client, cache, usage, {
          stage: 'оппонент',
          system: OPPONENT_SYSTEM,
          user: outgoing(`${docText}\n\nЗамечания ревьюера:\n${listing}`),
          schema: OpponentSchema,
        });
        for (const v of res.verdicts) {
          const idx = Number(/(\d+)/.exec(v.id)?.[1] ?? '0') - 1;
          const d = contested[idx];
          if (!d) continue;
          const verdict = v.verdict.toLowerCase();
          if (verdict.startsWith('reject')) {
            d.status = 'rejected';
            d.opponent = { verdict: 'reject', reason: v.reason };
          } else if (verdict.startsWith('down')) {
            const next = toSeverity(v.severity, d.severity === 'critical' ? 'major' : 'minor');
            if (SEVERITY_RANK[next] > SEVERITY_RANK[d.severity]) {
              d.severity = next;
              d.status = 'downgraded';
            }
            d.opponent = { verdict: 'downgrade', reason: v.reason };
          } else {
            d.opponent = { verdict: 'uphold', reason: v.reason };
          }
        }
      } catch (e) {
        diagnostics.push({ level: 'warning', code: 'llm_stage_failed', message: `Этап оппонента не выполнен: ${e instanceof Error ? e.message : String(e)}`, hint: 'Замечания модели показаны без независимой перепроверки.' });
      }
    }
    for (const d of kept) (d.status === 'rejected' ? rejected : drafts).push(d);
  } else {
    diagnostics.push({
      level: 'warning',
      code: 'llm_unavailable',
      message: 'Модель не подключена: выполнен только детерминированный слой правил.',
      hint: 'Чтобы включить смысловую проверку, задайте ключ провайдера в .env (см. README).',
    });
  }

  // --- final ids ---
  drafts.sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || (a.status === 'question' ? 1 : 0) - (b.status === 'question' ? 1 : 0) || (a.evidence[0]?.lineStart ?? 0) - (b.evidence[0]?.lineStart ?? 0));
  const seeds = new Map<string, { seed: QuestionSeed; findingId: string; ruleId: string }>();
  const findings: Finding[] = drafts.map((d, i) => {
    const { questionSeed, ...rest } = d;
    const id = `D-${String(i + 1).padStart(3, '0')}`;
    if (questionSeed && rest.ruleId) seeds.set(rest.ruleId, { seed: questionSeed, findingId: id, ruleId: rest.ruleId });
    return { id, ...rest };
  });
  const rejectedFinal: Finding[] = rejected.map((d, i) => {
    const { questionSeed: _unused, ...rest } = d;
    return { id: `X-${String(i + 1).padStart(3, '0')}`, ...rest };
  });
  const findingIds = new Set(findings.map((f) => f.id));
  // The opponent refers to other remarks by its own numbering; readers only know the final ids.
  const finalIdOf = new Map<Draft, string>();
  drafts.forEach((d, i) => finalIdOf.set(d, findings[i]?.id ?? ''));
  const translate = (reason: string) =>
    reason.replace(/C-(\d{1,3})/g, (m, n: string) => {
      const target = contestedOrder[Number(n) - 1];
      if (!target) return m;
      return finalIdOf.get(target) || `отклонённого замечания «${target.title}»`;
    });
  for (const f of [...findings, ...rejectedFinal]) if (f.opponent) f.opponent.reason = translate(f.opponent.reason);

  // --- the document's own review checklist ---
  const checklistRows: { item: string; options: string; line: number }[] = [];
  for (const r of reqs) {
    if (r.kind !== 'template') continue;
    for (let l = r.lineStart; l <= r.lineEnd; l++) {
      const cells = splitTableRow(doc.lines[l - 1] ?? '').map(stripMarkdown);
      const choice = cells.find((c) => /^(?:да|yes)\s*\/\s*(?:нет|no)/iu.test(c));
      if (choice && cells[0]) checklistRows.push({ item: cells[0], options: choice, line: l });
    }
  }
  let checklist: ChecklistItem[] = [];

  // --- questions ---
  let rootCauses: RootCause[] = [];
  let fixFirst: Verdict['fixFirst'] = [];
  const questionDrafts: Omit<Question, 'id'>[] = [];
  const absorbed = new Set<string>();
  if (client && llmUsed && !opts.skipStages?.includes('clarify')) {
    progress('вопросы автору');
    try {
      const listing = findings
        .map((f) => `${f.id} [${f.severity}, ${f.criterion}${f.ruleId ? `, правило ${f.ruleId}` : ''}; пункты ${f.requirementIds.join(', ') || '—'}] ${f.title} — ${f.explanation}`)
        .join('\n');
      const seedListing = [...seeds.values()].map((s) => `${s.ruleId} (находка ${s.findingId}): ${s.seed.text}`).join('\n') || 'нет';
      const res = await completeJson(client, cache, usage, {
        stage: 'вопросы автору',
        system: CLARIFY_SYSTEM,
        user: outgoing(
          `${docText}\n\nПодтверждённые находки:\n${listing}\n\nГотовые seed-вопросы пакета правил:\n${seedListing}${
            checklistRows.length > 0 ? `\n\nЧек-лист ревью из шаблона документа (index. пункт — допустимые ответы):\n${checklistRows.map((c, i) => `${i + 1}. ${c.item} — ${c.options}`).join('\n')}` : ''
          }`,
        ),
        schema: ClarifySchema,
      });
      const used = new Set<string>();
      rootCauses = res.rootCauses
        .map((rc, i) => ({ id: `RC-${String(i + 1).padStart(2, '0')}`, title: rc.title, findingIds: rc.findingIds.filter((id) => findingIds.has(id) && !used.has(id) && Boolean(used.add(id))) }))
        .filter((rc) => rc.findingIds.length > 0);
      for (const rc of rootCauses) for (const id of rc.findingIds) {
        const f = findings.find((x) => x.id === id);
        if (f) f.rootCauseId = rc.id;
      }
      fixFirst = res.fixFirst.filter((x) => findingIds.has(x.findingId)).slice(0, 7);
      for (const c of res.checklist) {
        const row = checklistRows[c.index - 1];
        if (!row || checklist.some((x) => x.line === row.line)) continue;
        const allowed = row.options.split('/').map((o) => o.trim());
        const answer = allowed.find((o) => o.toLowerCase() === c.answer.toLowerCase());
        // An answer outside the template's own options is not a checklist answer.
        if (!answer) continue;
        checklist.push({ item: row.item, answer, basis: c.basis, findingIds: c.findingIds.filter((id) => findingIds.has(id)), line: row.line });
      }
      checklist = checklist.sort((x, y) => x.line - y.line);
      for (const q of res.questions.slice(0, 10)) {
        const ids = q.findingIds.filter((id) => findingIds.has(id));
        for (const a of q.absorbs) {
          const s = seeds.get(a);
          if (s) {
            absorbed.add(a);
            if (!ids.includes(s.findingId)) ids.push(s.findingId);
          }
        }
        if (q.text === '' || q.options.length < 2) continue;
        const level = q.risk && q.risk.level in RISK_RANK ? (q.risk.level as 'high' | 'medium' | 'low') : 'medium';
        const kind = q.risk && (RISK_KINDS as string[]).includes(q.risk.kind) ? (q.risk.kind as RiskKind) : 'delivery';
        const rc = rootCauses.find((r) => r.findingIds.some((id) => ids.includes(id)));
        questionDrafts.push({
          addressee: q.addressee,
          text: q.text,
          why: q.why,
          findingIds: ids,
          ...(rc ? { rootCauseId: rc.id } : {}),
          options: q.options,
          defaultAssumption: q.defaultAssumption,
          blocking: q.blocking,
          risk: { level, kind, note: q.risk?.note ?? '' },
        });
      }
    } catch (e) {
      diagnostics.push({ level: 'warning', code: 'llm_stage_failed', message: `Этап вопросов автору не выполнен: ${e instanceof Error ? e.message : String(e)}`, hint: 'Показаны только вопросы из пакета правил.' });
    }
  }
  for (const s of seeds.values()) {
    if (absorbed.has(s.ruleId)) continue;
    questionDrafts.push({ ...s.seed, findingIds: [s.findingId] });
  }
  // «Blocking» must stay rare to mean anything: the question has to guard a critical finding, or a major one with high risk.
  for (const q of questionDrafts) {
    const linked = q.findingIds.map((id) => findings.find((f) => f.id === id)).filter((f): f is Finding => Boolean(f));
    const guardsCritical = linked.some((f) => f.severity === 'critical');
    const guardsMajor = linked.some((f) => f.severity === 'major');
    q.blocking = guardsCritical || (q.blocking && guardsMajor && q.risk.level === 'high');
  }
  questionDrafts.sort(
    (a, b) => Number(b.blocking) - Number(a.blocking) || (RISK_RANK[a.risk.level] ?? 1) - (RISK_RANK[b.risk.level] ?? 1) || b.findingIds.length - a.findingIds.length,
  );
  const maxQ = opts.maxQuestions ?? 12;
  const questions: Question[] = questionDrafts.slice(0, maxQ).map((q, i) => ({ id: `Q-${String(i + 1).padStart(2, '0')}`, ...q }));
  if (questionDrafts.length > maxQ) {
    diagnostics.push({ level: 'info', code: 'note', message: `Вопросов подготовлено ${questionDrafts.length}; в отчёт вошли ${maxQ} с наибольшим риском. Остальные темы остались в находках.` });
  }

  // --- answers of the author ---
  let answersApplied: Report['answersApplied'];
  const answers = opts.answers ?? {};
  const answered = questions.filter((q) => answers[q.id]);
  if (answered.length > 0) {
    for (const q of answered) q.answer = answers[q.id] ?? '';
    let resolved = 0;
    if (client) {
      progress('учёт ответов автора');
      try {
        const listing = answered
          .map((q) => `${q.id}: ${q.text}\n  Ответ автора: ${q.answer}\n  Связанные находки: ${q.findingIds.map((id) => `${id} — ${findings.find((f) => f.id === id)?.title ?? ''}`).join('; ')}`)
          .join('\n\n');
        const res = await completeJson(client, cache, usage, {
          stage: 'учёт ответов',
          system: ANSWERS_SYSTEM,
          user: outgoing(`${docText}\n\nВопросы и ответы:\n${listing}`),
          schema: AnswersSchema,
        });
        for (const r of res.resolutions) {
          const f = findings.find((x) => x.id === r.findingId);
          const q = answered.find((x) => x.id === r.questionId);
          if (!f || !q || !q.findingIds.includes(f.id)) continue;
          if (r.status.toLowerCase().startsWith('resolv')) {
            f.status = 'resolved';
            f.resolution = { byQuestionId: q.id, note: r.note, ...(r.proposedText ? { proposedText: r.proposedText } : {}) };
            resolved++;
          } else {
            f.resolution = { byQuestionId: q.id, note: r.note };
          }
        }
      } catch (e) {
        diagnostics.push({ level: 'warning', code: 'llm_stage_failed', message: `Этап учёта ответов не выполнен: ${e instanceof Error ? e.message : String(e)}`, hint: 'Ответы записаны в отчёт, но находки не пересмотрены.' });
      }
    } else {
      diagnostics.push({ level: 'info', code: 'note', message: 'Ответы автора записаны в отчёт. Без модели находки не пересматриваются автоматически.' });
    }
    answersApplied = { count: answered.length, resolved, ...(opts.answersFile ? { file: opts.answersFile } : {}) };
  }

  // --- traceability ---
  const functional = reqs.filter((r) => r.kind === 'functional');
  const hasApi = reqs.some((r) => r.kind.startsWith('api_'));
  const hasAcceptance = reqs.some((r) => r.kind === 'acceptance');
  const trace: TraceRow[] = llmUsed
    ? functional.map((r) => {
        const row = traceRaw.find((t) => t.requirementId === r.id);
        const apiRefs = (row?.api ?? []).filter((id) => reqById.get(id)?.kind.startsWith('api_'));
        const acceptanceRefs = (row?.acceptance ?? []).filter((id) => reqById.get(id)?.kind === 'acceptance');
        const gaps: string[] = [];
        if (hasAcceptance && acceptanceRefs.length === 0) gaps.push('нет критерия приёмки');
        if (!hasAcceptance) gaps.push('в документе нет критериев приёмки');
        if (hasApi && apiRefs.length === 0) gaps.push('нет связанного пункта API');
        return { requirementId: r.id, apiRefs, acceptanceRefs, gaps };
      })
    : [];

  // --- summary ---
  const active = findings.filter((f) => f.status !== 'resolved');
  const bySeverity: Record<Severity, number> = { critical: 0, major: 0, minor: 0 };
  const byCriterion: Partial<Record<Criterion, number>> = {};
  for (const f of active) {
    bySeverity[f.severity]++;
    byCriterion[f.criterion] = (byCriterion[f.criterion] ?? 0) + 1;
  }
  const counted = reqs.filter((r) => !NON_REQUIREMENT_KINDS.has(r.kind));
  const touched = new Set(active.flatMap((f) => f.requirementIds));
  const verdict = computeVerdict(findings, questions, fixFirst, llmUsed);

  const report: Report = {
    schema: 'dalel.report/1',
    passport: passport(doc),
    requirements: reqs,
    findings,
    rejected: rejectedFinal,
    rootCauses,
    questions,
    trace,
    summary: {
      units: reqs.length,
      requirements: counted.length,
      findings: active.length,
      bySeverity,
      byCriterion,
      requirementsWithFindings: counted.filter((r) => touched.has(r.id)).length,
      questions: questions.length,
      blockingQuestions: questions.filter((q) => q.blocking && !q.answer).length,
      rejectedByOpponent: rejectedFinal.length,
      droppedUnverified,
      critical: active.filter((f) => f.severity === 'critical').map((f) => ({ findingId: f.id, title: f.title, requirementIds: f.requirementIds })),
    },
    verdict,
    diagnostics,
    ...(checklist.length > 0 ? { checklist } : {}),
    testCases: deriveTestCases(reqs, findings),
    ...(answersApplied ? { answersApplied } : {}),
  };
  if (droppedUnverified > 0) {
    report.diagnostics.push({ level: 'info', code: 'quote_dropped', message: `Отброшено находок и цитат модели без подтверждения в тексте документа: ${droppedUnverified}.` });
  }
  return { report, doc };
}
