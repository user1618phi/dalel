import type {
  Counterexample,
  Diagnostic,
  Evidence,
  Finding,
  FindingStatus,
  Passport,
  Question,
  Report,
  Requirement,
  RiskKind,
  Severity,
  SourceDoc,
  VerdictCode,
} from '../types.js';
import {
  CRITERION_LABEL,
  KIND_LABEL,
  NON_REQUIREMENT_KINDS,
  REQUIREMENT_CRITERIA,
  SEVERITY_LABEL,
} from '../types.js';
import { KIT_CSS } from './kit.js';

// ---------------------------------------------------------------------------
// Labels, formatting and the view model. Shared with pdf.ts so both renderers
// show the same words and the same grouping.
// ---------------------------------------------------------------------------

export const STATUS_LABEL: Record<FindingStatus, string> = {
  confirmed: 'подтверждён',
  downgraded: 'понижен оппонентом',
  question: 'вынесен в вопрос автору',
  rejected: 'отклонён оппонентом',
  resolved: 'снят ответом автора',
};

export const OPPONENT_LABEL: Record<'uphold' | 'downgrade' | 'reject', string> = {
  uphold: 'оставил в силе',
  downgrade: 'понизил',
  reject: 'отклонил',
};

export const VERDICT_LABEL: Record<VerdictCode, string> = {
  ready: 'готово',
  ready_with_conditions: 'готово с условиями',
  not_ready: 'не готово',
  not_checked: 'не проверено',
};

export const RISK_LEVEL_LABEL: Record<Question['risk']['level'], string> = {
  high: 'высокий',
  medium: 'средний',
  low: 'низкий',
};

export const RISK_KIND_LABEL: Record<RiskKind, string> = {
  money: 'деньги',
  compliance: 'комплаенс',
  security: 'безопасность',
  customer: 'клиент',
  operations: 'операции',
  delivery: 'сроки',
};

export const MODE_LABEL: Record<Passport['mode'], string> = {
  'rules+llm': 'правила + LLM',
  'rules-only': 'только правила',
};

export const DIAGNOSTIC_LEVEL_LABEL: Record<Diagnostic['level'], string> = {
  error: 'ошибка',
  warning: 'предупреждение',
  info: 'сведение',
};

export const SEVERITIES: Severity[] = ['critical', 'major', 'minor'];

export const SECTION_TITLES = {
  title: 'Отчёт о проверке требований',
  passport: 'Паспорт прогона',
  slicing: 'Как агент нарезал требования',
  requirements: 'Проверка каждого требования',
  set: 'Проверка набора требований',
  questions: 'Вопросы автору',
  summary: 'Сводка',
  verdict: 'Итог',
  appendix: 'Приложение',
  document: 'Документ',
} as const;

const NBSP = '\u00a0';

export function formatInt(value: number): string {
  const sign = value < 0 ? '−' : '';
  return sign + String(Math.abs(Math.round(value))).replace(/\B(?=(\d{3})+(?!\d))/g, NBSP);
}

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  if (ms < 1000) return `${Math.round(ms)}${NBSP}мс`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1).replace('.', ',')}${NBSP}с`;
  const whole = Math.round(seconds);
  return `${Math.floor(whole / 60)}${NBSP}мин ${whole % 60}${NBSP}с`;
}

/** ISO timestamps are reformatted without timezone conversion, so the same report renders the same everywhere. */
export function formatDate(value: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?/.exec(value);
  if (!match) return value;
  const [, year, month, day, hours, minutes] = match;
  const date = `${day}.${month}.${year}`;
  if (hours === undefined || minutes === undefined) return date;
  return `${date} ${hours}:${minutes}${/Z$/.test(value) ? ' UTC' : ''}`;
}

export function shortHash(hash: string, length = 12): string {
  return hash.length > length ? `${hash.slice(0, length)}…` : hash;
}

export function linesLabel(lineStart: number, lineEnd: number): string {
  return lineEnd > lineStart ? `строки ${lineStart}–${lineEnd}` : `строка ${lineStart}`;
}

export function requirementLabel(requirement: Requirement): string {
  return requirement.docId ? `${requirement.id} · ${requirement.docId}` : requirement.id;
}

export function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max).trimEnd()}…` : text;
}

export interface MatrixRow {
  requirement: Requirement;
  /** One entry per REQUIREMENT_CRITERIA column. */
  cells: Finding[][];
}

export interface FindingGroup {
  /** null collects findings that reference no known requirement. */
  requirement: Requirement | null;
  findings: Finding[];
  /** Findings shown in full under another requirement that also reference this one. */
  seeAlso: Finding[];
}

export interface ReportView {
  byId: Map<string, Requirement>;
  counted: Requirement[];
  matrix: MatrixRow[];
  groups: FindingGroup[];
  setFindings: Finding[];
  minor: Finding[];
}

function referencedRequirementIds(finding: Finding): string[] {
  const ids = [...finding.requirementIds];
  for (const item of finding.evidence) {
    if (item.requirementId !== undefined && !ids.includes(item.requirementId)) ids.push(item.requirementId);
  }
  return ids;
}

export function buildView(report: Report): ReportView {
  const byId = new Map(report.requirements.map((requirement) => [requirement.id, requirement]));
  const counted = report.requirements.filter((requirement) => !NON_REQUIREMENT_KINDS.has(requirement.kind));

  const matrix: MatrixRow[] = counted.map((requirement) => ({
    requirement,
    cells: REQUIREMENT_CRITERIA.map((criterion) =>
      report.findings.filter(
        (finding) => finding.criterion === criterion && referencedRequirementIds(finding).includes(requirement.id),
      ),
    ),
  }));

  const full = report.findings.filter((finding) => finding.severity !== 'minor');
  const perRequirement = full.filter((finding) => finding.scope === 'requirement');
  const groupMap = new Map<string, FindingGroup>();
  const orphans: Finding[] = [];
  const groupFor = (requirement: Requirement): FindingGroup => {
    let group = groupMap.get(requirement.id);
    if (!group) {
      group = { requirement, findings: [], seeAlso: [] };
      groupMap.set(requirement.id, group);
    }
    return group;
  };
  for (const finding of perRequirement) {
    const known = referencedRequirementIds(finding)
      .map((id) => byId.get(id))
      .filter((requirement): requirement is Requirement => requirement !== undefined);
    const [primary, ...others] = known;
    if (!primary) {
      orphans.push(finding);
      continue;
    }
    groupFor(primary).findings.push(finding);
    for (const other of others) groupFor(other).seeAlso.push(finding);
  }
  // Document order, so the reader walks the report in the same order as the source text.
  const groups: FindingGroup[] = report.requirements
    .map((requirement) => groupMap.get(requirement.id))
    .filter((group): group is FindingGroup => group !== undefined);
  if (orphans.length > 0) groups.push({ requirement: null, findings: orphans, seeAlso: [] });

  return {
    byId,
    counted,
    matrix,
    groups,
    setFindings: full.filter((finding) => finding.scope === 'set'),
    minor: report.findings.filter((finding) => finding.severity === 'minor'),
  };
}

// ---------------------------------------------------------------------------
// HTML
// ---------------------------------------------------------------------------

const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

function esc(value: string | number): string {
  return String(value).replace(/[&<>"']/g, (char) => HTML_ESCAPES[char] ?? char);
}

/** Ids come from the report and end up in id="" and href="#…": keep them to a safe alphabet. */
function anchor(id: string): string {
  const safe = id.replace(/[^\p{L}\p{N}_-]+/gu, '-');
  return safe.length > 0 ? safe : 'x';
}

interface Ctx {
  report: Report;
  view: ReportView;
  doc: SourceDoc | null;
  findingIds: Set<string>;
  questionIds: Set<string>;
}

function idLink(id: string, known: boolean, text?: string): string {
  const label = esc(text ?? id);
  return known ? `<a class="label id" href="#${esc(anchor(id))}">${label}</a>` : `<span class="label id">${label}</span>`;
}

function findingLink(ctx: Ctx, id: string): string {
  return idLink(id, ctx.findingIds.has(id));
}

function requirementLink(ctx: Ctx, id: string): string {
  const requirement = ctx.view.byId.get(id);
  return idLink(id, requirement !== undefined, requirement ? requirementLabel(requirement) : id);
}

function linesLink(ctx: Ctx, lineStart: number, lineEnd: number): string {
  const text = esc(linesLabel(lineStart, lineEnd));
  const inDoc = ctx.doc !== null && Number.isInteger(lineStart) && lineStart >= 1 && lineStart <= ctx.doc.lines.length;
  return inDoc ? `<a href="#L${lineStart}">${text}</a>` : text;
}

function severityMark(severity: Severity): string {
  return `<span class="mark sev-${severity}">${esc(SEVERITY_LABEL[severity])}</span>`;
}

function list(items: string[], cls = 'plain'): string {
  if (items.length === 0) return '—';
  return `<ul class="${cls}">${items.map((item) => `<li>${item}</li>`).join('')}</ul>`;
}

function kv(rows: [label: string, valueHtml: string][]): string {
  if (rows.length === 0) return '';
  const body = rows.map(([label, value]) => `<dt class="label">${esc(label)}</dt><dd>${value}</dd>`).join('');
  return `<dl class="kv">${body}</dl>`;
}

function text(value: string): string {
  return `<span class="pre">${esc(value)}</span>`;
}

function scroll(label: string, tableHtml: string, cls = ''): string {
  return `<div class="scroll${cls ? ` ${cls}` : ''}" role="region" aria-label="${esc(label)}" tabindex="0">${tableHtml}</div>`;
}

function sectionOpen(index: number, id: keyof typeof SECTION_TITLES, note: string, attrs = ''): string {
  const no = String(index).padStart(2, '0');
  return `<section id="${id}" aria-labelledby="h-${id}"${attrs}>
<div class="sec-head"><div class="ruler" aria-hidden="true"><i style="--i:${index}"></i></div><p class="label id">${no} · ${esc(note)}</p><h2 id="h-${id}">${esc(SECTION_TITLES[id])}</h2></div>`;
}

function renderQuote(ctx: Ctx, item: Evidence): string {
  const caption = [linesLink(ctx, item.lineStart, item.lineEnd)];
  if (item.requirementId !== undefined) caption.push(requirementLink(ctx, item.requirementId));
  return `<figure class="quote"><blockquote>${esc(item.quote)}</blockquote><figcaption class="label">${caption.join(' · ')}</figcaption></figure>`;
}

function renderCounterexample(ctx: Ctx, example: Counterexample): string {
  const expectations = example.expectations.map(
    (item) => `${requirementLink(ctx, item.requirementId)} <span class="pre">${esc(item.expected)}</span>`,
  );
  const rows: [string, string][] = [
    ['Дано', list(example.given.map(esc))],
    ['Когда', list(example.when.map(esc))],
    ['Ожидания по требованиям', list(expectations)],
    ['Конфликт', text(example.conflict)],
  ];
  const checked = example.arithmeticChecked ? '<p class="mark ok">арифметика пересчитана кодом</p>' : '';
  return `<div class="case"><p class="label">Контрпример</p>${kv(rows)}${checked}</div>`;
}

function renderFinding(ctx: Ctx, finding: Finding, heading: 'h3' | 'h4'): string {
  const refs = [finding.standardRef, finding.normRef].filter((ref): ref is string => Boolean(ref));
  const requirements = finding.requirementIds.map((id) => requirementLink(ctx, id));
  const rootCause = ctx.report.rootCauses.find((cause) => cause.id === finding.rootCauseId);

  const meta = [
    `<span class="label id">${esc(finding.id)}</span>`,
    severityMark(finding.severity),
    `<span class="label">${esc(CRITERION_LABEL[finding.criterion])}</span>`,
  ];
  if (finding.ruleId) meta.push(`<span class="label id">правило ${esc(finding.ruleId)}</span>`);
  if (finding.status !== 'confirmed') meta.push(`<span class="mark">${esc(STATUS_LABEL[finding.status])}</span>`);

  const rows: [string, string][] = [];
  if (finding.scope === 'set' && requirements.length > 0) rows.push(['Требования', requirements.join(', ')]);
  rows.push(['Рекомендация', text(finding.recommendation)]);
  if (rootCause) rows.push(['Корневая причина', esc(rootCause.title)]);
  if (finding.opponent) {
    rows.push(['Оппонент', `${esc(OPPONENT_LABEL[finding.opponent.verdict])}: ${text(finding.opponent.reason)}`]);
  }
  if (finding.status !== 'confirmed') rows.push(['Статус', esc(STATUS_LABEL[finding.status])]);
  if (finding.resolution) {
    const question = idLink(finding.resolution.byQuestionId, ctx.questionIds.has(finding.resolution.byQuestionId));
    rows.push(['Решение', `${question} ${text(finding.resolution.note)}`]);
    if (finding.resolution.proposedText) {
      rows.push(['Предложенный текст', `<span class="pre mono">${esc(finding.resolution.proposedText)}</span>`]);
    }
  }

  return `<article class="entry finding" id="${esc(anchor(finding.id))}" data-finding data-severity="${finding.severity}">
<div class="entry-meta">${meta.join('')}</div>
<div class="entry-body">
<${heading} class="entry-title">${esc(finding.title)}</${heading}>
<p class="label id ref">${refs.map(esc).join(' · ')}</p>
${finding.evidence.map((item) => renderQuote(ctx, item)).join('\n')}
<p class="pre">${esc(finding.explanation)}</p>
${finding.counterexample ? renderCounterexample(ctx, finding.counterexample) : ''}
${kv(rows)}
</div>
</article>`;
}

function renderTop(ctx: Ctx): string {
  const { passport, verdict, summary } = ctx.report;
  const verdictClass: Record<VerdictCode, string> = {
    ready: ' ok',
    ready_with_conditions: ' warn',
    not_ready: ' bad',
    not_checked: '',
  };
  const stats: [string, number][] = [
    ['Требования', summary.requirements],
    ['Находки', summary.findings],
    ['Критичные', summary.bySeverity.critical],
    ['Блокирующие вопросы', summary.blockingQuestions],
  ];
  return `<header class="top">
<p class="label">dalel ${esc(passport.agentVersion)} · ${esc(formatDate(passport.date))} · ${esc(MODE_LABEL[passport.mode])}</p>
<h1>${esc(SECTION_TITLES.title)}</h1>
<p class="label id doc-name">${esc(passport.documentName)}</p>
<div class="tldr">
<p class="mark${verdictClass[verdict.code]}">${esc(VERDICT_LABEL[verdict.code])}</p>
<p class="verdict-line">${esc(verdict.headline)}</p>
<p class="lead pre">${esc(verdict.rationale)}</p>
</div>
<dl class="stats">${stats
    .map(([label, value]) => `<div><dt class="label">${esc(label)}</dt><dd>${esc(formatInt(value))}</dd></div>`)
    .join('')}</dl>
</header>`;
}

function renderNav(ctx: Ctx): string {
  const links: [string, string][] = [
    ['passport', 'паспорт'],
    ['slicing', 'нарезка'],
    ['requirements', 'требования'],
    ['set', 'набор'],
    ['questions', 'вопросы'],
    ['summary', 'сводка'],
    ['verdict', 'итог'],
    ['appendix', 'приложение'],
  ];
  if (ctx.doc) links.push(['document', 'документ']);
  const { bySeverity } = ctx.report.summary;
  const filters: [string, string][] = [
    ['all', 'все'],
    ['critical', `критичные ${bySeverity.critical}`],
    ['major', `существенные ${bySeverity.major}`],
    ['minor', `незначительные ${bySeverity.minor}`],
  ];
  // The filter needs JS, so it ships hidden and the script reveals it: without JS the page shows everything.
  return `<nav class="panel bar" aria-label="Разделы отчёта">
<div class="bar-links">${links.map(([id, label]) => `<a class="label" href="#${id}">${esc(label)}</a>`).join('')}</div>
<div class="bar-filter" data-filter-ui hidden>
<div class="seg" role="group" aria-label="Фильтр находок по критичности"><span class="seg-ind" aria-hidden="true"></span>${filters
    .map(
      ([value, label], index) =>
        `<button type="button" data-filter="${value}" aria-pressed="${index === 0 ? 'true' : 'false'}">${esc(label)}</button>`,
    )
    .join('')}</div>
</div>
</nav>
<p class="label filter-status" id="filter-status" role="status" aria-live="polite"></p>`;
}

function renderPassport(ctx: Ctx, index: number): string {
  const p = ctx.report.passport;
  const rows: [string, string][] = [
    ['Документ', `<span class="any">${esc(p.documentName)}</span>`],
    ['SHA-256', `<span class="mono" title="${esc(p.documentSha256)}">${esc(shortHash(p.documentSha256))}</span>`],
    ['Формат', `<span class="mono">${esc(p.documentFormat)}</span>`],
    ['Строк', `<span class="mono">${esc(formatInt(p.documentLines))}</span>`],
    ['Дата', `<span class="mono">${esc(formatDate(p.date))}</span>`],
    ['Провайдер / модель', `<span class="mono any">${esc(p.provider)} / ${esc(p.model)}</span>`],
    ['Режим', esc(MODE_LABEL[p.mode])],
    ['Версия агента', `<span class="mono any">${esc(p.agentVersion)} (${esc(p.agentCommit)})</span>`],
    ['Пакеты правил', `<span class="mono any">${p.rulePacks.length > 0 ? esc(p.rulePacks.join(', ')) : '—'}</span>`],
    ['Хэш промптов', `<span class="mono any">${esc(p.promptHash)}</span>`],
    ['Длительность', `<span class="mono">${esc(formatDuration(p.durationMs))}</span>`],
    ['Вызовы LLM', `<span class="mono">${esc(formatInt(p.llmCalls))}, из кэша ${esc(formatInt(p.llmCacheHits))}</span>`],
    ['Токены', `<span class="mono">вход ${esc(formatInt(p.tokensIn))}, выход ${esc(formatInt(p.tokensOut))}</span>`],
  ];
  return `${sectionOpen(index, 'passport', 'чем и как проверяли')}
<dl class="props">${rows.map(([label, value]) => `<div><dt class="label">${esc(label)}</dt><dd>${value}</dd></div>`).join('')}</dl>
</section>`;
}

function renderSlicing(ctx: Ctx, index: number): string {
  const { requirements } = ctx.report;
  const rows = requirements
    .map((requirement) => {
      const muted = NON_REQUIREMENT_KINDS.has(requirement.kind);
      return `<tr id="${esc(anchor(requirement.id))}"${muted ? ' class="muted"' : ''}>
<td class="label id">${esc(requirement.id)}</td>
<td class="label id">${requirement.docId ? esc(requirement.docId) : '—'}</td>
<td>${requirement.section.length > 0 ? esc(requirement.section.join(' › ')) : '—'}</td>
<td class="label nowrap">${linesLink(ctx, requirement.lineStart, requirement.lineEnd)}</td>
<td class="label">${esc(KIND_LABEL[requirement.kind])}</td>
<td>${esc(requirement.summary)}</td>
</tr>`;
    })
    .join('\n');
  const skipped = requirements.length - ctx.view.counted.length;
  const body =
    requirements.length === 0
      ? '<p class="empty">Агент не выделил в документе ни одной единицы текста.</p>'
      : scroll(
          'Таблица нарезки требований',
          `<table class="slicing"><thead><tr><th>id отчёта</th><th>id в документе</th><th>раздел</th><th>строки</th><th>тип</th><th>суть</th></tr></thead><tbody>${rows}</tbody></table>`,
        );
  const note =
    skipped > 0
      ? `<p class="label note">Приглушённые строки (${skipped}) — не требования: реквизиты, шаблоны, контекст. В подсчёт они не входят.</p>`
      : '';
  return `${sectionOpen(index, 'slicing', `единиц ${formatInt(requirements.length)}, требований ${formatInt(ctx.view.counted.length)}`)}
${body}
${note}
</section>`;
}

function renderMatrix(ctx: Ctx): string {
  if (ctx.view.matrix.length === 0) return '<p class="empty">Требований для проверки нет.</p>';
  const head = REQUIREMENT_CRITERIA.map((criterion) => `<th scope="col">${esc(CRITERION_LABEL[criterion])}</th>`).join('');
  const rows = ctx.view.matrix
    .map(({ requirement, cells }) => {
      const tds = cells
        .map((findings) => {
          if (findings.length === 0) return '<td><span class="nil" aria-label="замечаний нет">·</span></td>';
          const marks = findings
            .map(
              (finding) =>
                `<a class="mark sev-${finding.severity} id" data-severity="${finding.severity}" href="#${esc(anchor(finding.id))}" title="${esc(`${SEVERITY_LABEL[finding.severity]}: ${finding.title}`)}">${esc(finding.id)}<span class="vh">, ${esc(SEVERITY_LABEL[finding.severity])}</span></a>`,
            )
            .join('');
          return `<td>${marks}</td>`;
        })
        .join('');
      return `<tr><th scope="row"><span class="id">${esc(requirementLabel(requirement))}</span><span class="sub">${esc(requirement.summary)}</span></th>${tds}</tr>`;
    })
    .join('\n');
  const legend = SEVERITIES.map((severity) => severityMark(severity)).join('');
  return `${scroll(
    'Матрица: требования и характеристики качества',
    `<table class="matrix"><thead><tr><th scope="col">требование</th>${head}</tr></thead><tbody>${rows}</tbody></table>`,
  )}
<p class="legend">${legend}<span class="label">· замечаний нет</span></p>`;
}

function renderRequirements(ctx: Ctx, index: number): string {
  const groups = ctx.view.groups
    .map((group) => {
      const requirement = group.requirement;
      const head = requirement
        ? `<p class="label"><span class="id">${esc(requirementLabel(requirement))}</span> · ${linesLink(ctx, requirement.lineStart, requirement.lineEnd)} · ${esc(KIND_LABEL[requirement.kind])}</p>
<h3 class="group-title">${esc(requirement.summary)}</h3>
<p class="req-text">${esc(truncate(requirement.text, 700))}</p>`
        : '<h3 class="group-title">Без привязки к требованию</h3>';
      const seeAlso =
        group.seeAlso.length > 0
          ? `<p class="label note">См. также: ${group.seeAlso.map((finding) => findingLink(ctx, finding.id)).join(', ')}</p>`
          : '';
      return `<div class="group" data-group>
<div class="group-head">${head}</div>
${group.findings.map((finding) => renderFinding(ctx, finding, 'h4')).join('\n')}
${seeAlso}
</div>`;
    })
    .join('\n');
  const shown = ctx.view.groups.reduce((sum, group) => sum + group.findings.length, 0);
  const body =
    shown > 0
      ? groups
      : '<p class="empty">Критичных и существенных замечаний к отдельным требованиям нет.</p>';
  const minorNote =
    ctx.view.minor.length > 0
      ? `<p class="label note">Незначительные замечания (${ctx.view.minor.length}) вынесены в <a href="#appendix">приложение</a>.</p>`
      : '';
  return `${sectionOpen(index, 'requirements', 'девять характеристик ISO/IEC/IEEE 29148 §5.2.5', ' data-filter-scope')}
${renderMatrix(ctx)}
<div class="findings">
${body}
<p class="empty" data-filter-empty hidden>В этом разделе нет находок выбранной критичности.</p>
</div>
${minorNote}
</section>`;
}

function renderTrace(ctx: Ctx): string {
  const { trace } = ctx.report;
  if (trace.length === 0) return '<p class="empty">Матрица трассировки не построена: связей с API и приёмкой не найдено.</p>';
  const cell = (items: string[]): string =>
    items.length > 0 ? items.map((item) => `<span class="mono any">${esc(item)}</span>`).join('<br>') : '—';
  const rows = trace
    .map((row) => {
      const gaps =
        row.gaps.length > 0 ? row.gaps.map((gap) => `<span class="mark warn multi">${esc(gap)}</span>`).join('') : '—';
      return `<tr><td>${requirementLink(ctx, row.requirementId)}</td><td>${cell(row.apiRefs)}</td><td>${cell(row.acceptanceRefs)}</td><td class="gaps">${gaps}</td></tr>`;
    })
    .join('\n');
  return scroll(
    'Матрица трассировки',
    `<table class="trace"><thead><tr><th>требование</th><th>API</th><th>приёмка</th><th>пробелы</th></tr></thead><tbody>${rows}</tbody></table>`,
  );
}

function renderChecklist(ctx: Ctx): string {
  const items = ctx.report.checklist ?? [];
  if (items.length === 0) return '';
  const rows = items
    .map(
      (c) =>
        `<tr><td>${esc(c.item)}</td><td><span class="label">${esc(c.answer)}</span></td><td>${esc(c.basis)}</td><td>${c.findingIds.map((id) => findingLink(ctx, id)).join(', ') || '—'}</td></tr>`,
    )
    .join('\n');
  return `<h3 class="sub-title">Чек-лист ревью из шаблона документа</h3>
<p class="label note">в документе чек-лист пуст · ниже черновик агента · итоговую отметку ставит ревьюер</p>
${scroll('Чек-лист ревью', `<table class="trace"><thead><tr><th>пункт чек-листа</th><th>ответ агента</th><th>основание</th><th>находки</th></tr></thead><tbody>${rows}</tbody></table>`)}`;
}

function renderTestCases(ctx: Ctx): string {
  const cases = ctx.report.testCases ?? [];
  if (cases.length === 0) return '';
  const kind = { boundary: 'граница', counterexample: 'противоречие', acceptance: 'приёмка из документа' } as const;
  const rows = cases
    .map(
      (t) =>
        `<tr><td><span class="mono any">${esc(t.id)}</span></td><td>${esc(kind[t.kind])}${t.findingId ? ` · ${findingLink(ctx, t.findingId)}` : ''}</td><td>${esc(t.given.join(' '))}</td><td>${esc(t.when.join(' '))}</td><td>${esc(t.then.join(' '))}</td><td><span class="label">${t.coveredByAcceptance ? 'да' : 'нет'}</span></td></tr>`,
    )
    .join('\n');
  const missing = cases.filter((t) => !t.coveredByAcceptance).length;
  return `<h3 class="sub-title">Черновик тест-кейсов</h3>
<p class="label note">спроектировано из текста: ${cases.length} · не покрыто приёмкой документа: ${missing}</p>
${scroll('Черновик тест-кейсов', `<table class="trace"><thead><tr><th>№</th><th>тип</th><th>дано</th><th>когда</th><th>тогда</th><th>в приёмке</th></tr></thead><tbody>${rows}</tbody></table>`)}`;
}

function renderSet(ctx: Ctx, index: number): string {
  const findings = ctx.view.setFindings;
  const body =
    findings.length > 0
      ? findings.map((finding) => renderFinding(ctx, finding, 'h3')).join('\n')
      : '<p class="empty">Критичных и существенных замечаний к набору требований нет.</p>';
  return `${sectionOpen(index, 'set', 'ISO/IEC/IEEE 29148 §5.2.6, IEEE 830 §4.3', ' data-filter-scope')}
<div class="findings">
${body}
<p class="empty" data-filter-empty hidden>В этом разделе нет находок выбранной критичности.</p>
</div>
${renderChecklist(ctx)}
<h3 class="sub-title">Матрица трассировки</h3>
<p class="label note">требование → API → приёмка → пробелы</p>
${renderTrace(ctx)}
${renderTestCases(ctx)}
</section>`;
}

function renderQuestion(ctx: Ctx, question: Question): string {
  const riskClass: Record<Question['risk']['level'], string> = { high: ' bad', medium: ' warn', low: ' info' };
  const meta = [
    `<span class="label id">${esc(question.id)}</span>`,
    question.blocking ? '<span class="mark bad">блокирует разработку</span>' : '<span class="mark">не блокирует</span>',
    `<span class="mark${riskClass[question.risk.level]}">риск ${esc(RISK_LEVEL_LABEL[question.risk.level])} · ${esc(RISK_KIND_LABEL[question.risk.kind])}</span>`,
  ];
  const options = question.options.map(
    (option) => `<span class="opt">${esc(option.label)}</span> <span class="pre">${esc(option.consequence)}</span>`,
  );
  const rows: [string, string][] = [
    ['Кому', esc(question.addressee)],
    ['Почему важно', text(question.why)],
    ['Риск', text(question.risk.note)],
  ];
  if (options.length > 0) rows.push(['Варианты и последствия', list(options)]);
  rows.push(['Если ответа не будет', text(question.defaultAssumption)]);
  if (question.findingIds.length > 0) {
    rows.push(['Находки', question.findingIds.map((id) => findingLink(ctx, id)).join(', ')]);
  }
  if (question.answer !== undefined) rows.push(['Ответ автора', `<span class="pre answer">${esc(question.answer)}</span>`]);
  return `<li class="entry question" id="${esc(anchor(question.id))}">
<div class="entry-meta">${meta.join('')}</div>
<div class="entry-body">
<h3 class="entry-title">${esc(question.text)}</h3>
${kv(rows)}
</div>
</li>`;
}

function renderQuestions(ctx: Ctx, index: number): string {
  const { questions, summary, answersApplied } = ctx.report;
  const body =
    questions.length > 0
      ? `<ol class="questions">${questions.map((question) => renderQuestion(ctx, question)).join('\n')}</ol>`
      : '<p class="empty">Вопросов к автору нет.</p>';
  const applied = answersApplied
    ? `<p class="label note">Учтено ответов автора: ${formatInt(answersApplied.count)}, снято находок: ${formatInt(answersApplied.resolved)}${answersApplied.file ? ` · <span class="id any">${esc(answersApplied.file)}</span>` : ''}</p>`
    : '';
  return `${sectionOpen(index, 'questions', `всего ${formatInt(questions.length)}, блокирующих ${formatInt(summary.blockingQuestions)}`)}
${body}
${applied}
</section>`;
}

function renderSummary(ctx: Ctx, index: number): string {
  const { summary } = ctx.report;
  const counts: [string, string][] = [
    ['Единицы текста', formatInt(summary.units)],
    ['Требования', formatInt(summary.requirements)],
    ['Требования с находками', formatInt(summary.requirementsWithFindings)],
    ['Находки', formatInt(summary.findings)],
    ['Критичные', formatInt(summary.bySeverity.critical)],
    ['Существенные', formatInt(summary.bySeverity.major)],
    ['Незначительные', formatInt(summary.bySeverity.minor)],
    ['Вопросы', formatInt(summary.questions)],
    ['Блокирующие вопросы', formatInt(summary.blockingQuestions)],
    ['Отклонено оппонентом', formatInt(summary.rejectedByOpponent)],
    ['Отброшено без подтверждения цитатой', formatInt(summary.droppedUnverified)],
  ];
  const criteria = (Object.keys(CRITERION_LABEL) as (keyof typeof CRITERION_LABEL)[])
    .map((criterion): [string, number] => [CRITERION_LABEL[criterion], summary.byCriterion[criterion] ?? 0])
    .filter(([, count]) => count > 0);
  const criteriaTable =
    criteria.length > 0
      ? `<table class="narrow"><thead><tr><th>характеристика</th><th class="r">находок</th></tr></thead><tbody>${criteria
          .map(([label, count]) => `<tr><td>${esc(label)}</td><td class="mono r">${esc(formatInt(count))}</td></tr>`)
          .join('')}</tbody></table>`
      : '<p class="empty">Находок нет.</p>';
  const critical =
    summary.critical.length > 0
      ? `<ul class="rows crit">${summary.critical
          .map(
            (item) =>
              `<li data-severity="critical">${findingLink(ctx, item.findingId)}<span>${esc(item.title)}</span><span class="label">${item.requirementIds.map((id) => requirementLink(ctx, id)).join(', ')}</span></li>`,
          )
          .join('')}</ul>`
      : '<p class="empty">Критичных дефектов нет.</p>';
  return `${sectionOpen(index, 'summary', 'числа прогона')}
<dl class="stats">${counts.map(([label, value]) => `<div><dt class="label">${esc(label)}</dt><dd>${esc(value)}</dd></div>`).join('')}</dl>
<h3 class="sub-title">По характеристикам</h3>
${criteriaTable}
<h3 class="sub-title">Критичные дефекты</h3>
${critical}
</section>`;
}

function renderVerdict(ctx: Ctx, index: number): string {
  const { verdict } = ctx.report;
  const fixFirst =
    verdict.fixFirst.length > 0
      ? `<ol class="rows fix">${verdict.fixFirst
          .map((item) => `<li>${findingLink(ctx, item.findingId)}<span class="pre">${esc(item.text)}</span></li>`)
          .join('')}</ol>`
      : '<p class="empty">Срочных исправлений нет.</p>';
  return `${sectionOpen(index, 'verdict', VERDICT_LABEL[verdict.code])}
<p class="verdict-line small">${esc(verdict.headline)}</p>
<p class="lead pre">${esc(verdict.rationale)}</p>
<h3 class="sub-title">Что исправить в первую очередь</h3>
${fixFirst}
</section>`;
}

function renderAppendix(ctx: Ctx, index: number): string {
  const { rejected, diagnostics } = ctx.report;
  const minor = ctx.view.minor;
  const minorRows = minor
    .map((finding) => {
      const lines = finding.evidence.map((item) => linesLink(ctx, item.lineStart, item.lineEnd)).join(', ');
      const status = finding.status !== 'confirmed' ? `<span class="label sub">${esc(STATUS_LABEL[finding.status])}</span>` : '';
      return `<tr id="${esc(anchor(finding.id))}" data-finding data-severity="minor">
<td class="label id">${esc(finding.id)}</td>
<td>${finding.requirementIds.map((id) => requirementLink(ctx, id)).join(', ') || '—'}</td>
<td class="label">${esc(CRITERION_LABEL[finding.criterion])}</td>
<td>${esc(finding.title)}<span class="sub pre">${esc(finding.explanation)}</span>${status}</td>
<td class="label nowrap">${lines || '—'}</td>
<td class="pre">${esc(finding.recommendation)}</td>
</tr>`;
    })
    .join('\n');
  const minorBlock =
    minor.length > 0
      ? `${scroll(
          'Незначительные замечания',
          `<table class="minor"><thead><tr><th>id</th><th>требование</th><th>характеристика</th><th>замечание</th><th>строки</th><th>рекомендация</th></tr></thead><tbody>${minorRows}</tbody></table>`,
        )}<p class="empty" data-filter-empty hidden>Незначительные замечания скрыты фильтром.</p>`
      : '<p class="empty">Незначительных замечаний нет.</p>';

  const rejectedBlock =
    rejected.length > 0
      ? `<ul class="rejected">${rejected
          .map((finding) => {
            const quotes = finding.evidence.map((item) => renderQuote(ctx, item)).join('');
            const reason = finding.opponent ? text(finding.opponent.reason) : 'Причина не записана.';
            return `<li class="entry" id="${esc(anchor(finding.id))}">
<div class="entry-meta"><span class="label id">${esc(finding.id)}</span><span class="mark">${esc(STATUS_LABEL.rejected)}</span><span class="label">${esc(CRITERION_LABEL[finding.criterion])}</span></div>
<div class="entry-body"><h4 class="entry-title">${esc(finding.title)}</h4>${quotes}${kv([
              ['Требования', finding.requirementIds.map((id) => requirementLink(ctx, id)).join(', ') || '—'],
              ['Почему отклонено', reason],
            ])}</div>
</li>`;
          })
          .join('\n')}</ul>`
      : '<p class="empty">Оппонент не отклонил ни одной находки.</p>';

  const levelClass: Record<Diagnostic['level'], string> = { error: ' bad', warning: ' warn', info: ' info' };
  const diagnosticsBlock =
    diagnostics.length > 0
      ? `<ul class="rows diag">${diagnostics
          .map(
            (item) =>
              `<li><span class="mark${levelClass[item.level]}">${esc(DIAGNOSTIC_LEVEL_LABEL[item.level])}</span><span class="label id">${esc(item.code)}</span><span><span class="pre">${esc(item.message)}</span>${item.hint ? `<span class="sub pre">${esc(item.hint)}</span>` : ''}</span></li>`,
          )
          .join('')}</ul>`
      : '<p class="empty">Диагностических сообщений нет.</p>';

  return `${sectionOpen(index, 'appendix', 'для полноты и проверки', ' data-filter-scope')}
<h3 class="sub-title first">Незначительные замечания</h3>
${minorBlock}
<h3 class="sub-title">Отклонено оппонентом</h3>
<p class="label note">Эти находки не входят в итог. Они показаны, чтобы было видно, что агент отбросил и почему.</p>
${rejectedBlock}
<h3 class="sub-title">Диагностика</h3>
${diagnosticsBlock}
</section>`;
}

function renderDocument(ctx: Ctx, doc: SourceDoc, index: number): string {
  const hits = new Map<number, Finding[]>();
  for (const finding of ctx.report.findings) {
    for (const item of finding.evidence) {
      const from = Math.max(1, Math.trunc(item.lineStart));
      const to = Math.min(doc.lines.length, Math.max(from, Math.trunc(item.lineEnd)));
      for (let line = from; line <= to; line += 1) {
        const bucket = hits.get(line) ?? [];
        if (!bucket.includes(finding)) bucket.push(finding);
        hits.set(line, bucket);
      }
    }
  }
  const rows = doc.lines
    .map((lineText, lineIndex) => {
      const line = lineIndex + 1;
      const findings = hits.get(line);
      const refs = findings
        ? `<span class="refs">${findings
            .map(
              (finding) =>
                `<a class="mark sev-${finding.severity} id" href="#${esc(anchor(finding.id))}" title="${esc(`${SEVERITY_LABEL[finding.severity]}: ${finding.title}`)}">${esc(finding.id)}</a>`,
            )
            .join('')}</span>`
        : '';
      return `<div class="ln${findings ? ' hit' : ''}" id="L${line}"><span class="no">${line}</span><span class="tx">${esc(lineText)}</span>${refs}</div>`;
    })
    .join('\n');
  return `${sectionOpen(index, 'document', `${doc.name} · строк ${formatInt(doc.lines.length)} · отмечено ${formatInt(hits.size)}`)}
<p class="label note">Отмеченные строки процитированы в находках. Идентификатор под строкой ведёт к находке.</p>
<div class="src">
${rows}
</div>
</section>`;
}

const REPORT_CSS = `
/* Report layer on top of the kit: only layout and report-specific pieces, all colours via kit tokens. */
:root { --bar-h: 120px; }
html { scroll-padding-top: var(--bar-h); }
body { overflow-wrap: break-word; }
[hidden] { display: none !important; }
main > section { padding: 0 0 var(--space-24); }
.id { text-transform: none; }
.mono { font-family: var(--font-mono); font-size: 0.86em; font-variant-numeric: tabular-nums; }
.any { overflow-wrap: anywhere; }
.pre { white-space: pre-line; }
.nowrap { white-space: nowrap; }
.r { text-align: right; }
.vh { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
.sub { display: block; margin-top: var(--space-1); color: var(--mut); font-size: 13.5px; }
.note { margin-top: var(--space-4); max-width: 72ch; }
.empty { color: var(--mut); padding: var(--space-4) 0; border-top: var(--border) solid var(--line); border-bottom: var(--border) solid var(--line); max-width: none; }
ul.plain { margin: 0; padding-left: 1.1em; list-style: square; }
ul.plain li::marker { color: var(--mut); }
ul.plain li + li { margin-top: var(--space-1); }

/* top: the verdict is the one idea of the first screen */
.top { padding: var(--space-16) 0 var(--space-12); }
.top h1 { margin-top: var(--space-3); font-size: var(--text-title); letter-spacing: var(--tracking-heading); }
.doc-name { margin-top: var(--space-2); overflow-wrap: anywhere; }
.tldr { margin-top: var(--space-16); }
.verdict-line { max-width: none; margin-top: var(--space-4); font-family: var(--font-heading); font-weight: var(--weight-heading); font-size: clamp(32px, 6vw, 76px); line-height: 1.04; letter-spacing: -0.04em; text-wrap: balance; }
.verdict-line.small { margin-top: 0; font-size: var(--text-title); line-height: 1.1; letter-spacing: var(--tracking-heading); }
.tldr .lead, .verdict-line + .lead { margin-top: var(--space-6); }
.stats { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: var(--space-8); margin: var(--space-16) 0 0; }
section .stats { margin-top: 0; }
.stats > div { padding-top: var(--space-3); border-top: var(--border) solid var(--line); }
.stats dd { margin: var(--space-2) 0 0; font-family: var(--font-heading); font-weight: var(--weight-heading); font-size: 40px; line-height: 1; letter-spacing: var(--tracking-heading); font-variant-numeric: tabular-nums; }

/* floating navigation */
.bar { position: sticky; top: var(--space-2); z-index: 5; display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 0 var(--space-4); margin: 0 calc(var(--space-3) * -1) var(--space-2); padding: var(--space-1) var(--space-3); }
.bar-links, .bar-filter { display: flex; min-width: 0; max-width: 100%; overflow-x: auto; scrollbar-width: none; }
.bar-links::-webkit-scrollbar, .bar-filter::-webkit-scrollbar { display: none; }
.bar-links a { display: inline-flex; align-items: center; gap: 6px; padding: 12px var(--space-2); white-space: nowrap; text-decoration: none; }
.bar-links a::before { content: ""; width: 6px; height: 6px; background: var(--acc); opacity: 0; transition: opacity 0.2s; }
.bar-links a[aria-current="true"] { color: var(--fg); }
.bar-links a[aria-current="true"]::before { opacity: 1; }
.seg { position: relative; display: inline-flex; padding: 3px; border: var(--border) solid var(--line); border-radius: var(--radius-control); }
.seg button { appearance: none; position: relative; z-index: 1; padding: 10px var(--space-3); border: 0; border-radius: var(--radius-small); background: none; color: var(--mut); font: 400 var(--text-label) / 1 var(--font-mono); text-transform: lowercase; white-space: nowrap; cursor: pointer; transition: transform var(--dur-spring) var(--ease-spring); }
.seg button[aria-pressed="true"] { color: var(--fg); }
.seg button:active { transform: scale(var(--press-scale)); transition-duration: var(--dur-press); }
.seg-ind { position: absolute; top: 3px; bottom: 3px; left: 0; width: 0; border-radius: var(--radius-small); background: var(--line); transition: transform var(--dur-spring) var(--ease-spring); }
.filter-status { min-height: 1.45em; margin-bottom: var(--space-8); }

/* section head: ruler with an accent tick at the section number */
.ruler { position: relative; overflow: hidden; }
.ruler i { position: absolute; left: 0; bottom: 0; width: 1px; height: 14px; background: var(--acc); transform: translateX(calc(var(--i) * 40px)); }
.sec-head { padding: 0 0 var(--space-12); }
.sec-head .label { margin-top: var(--space-6); }
.sec-head h2 { margin-top: var(--space-3); }
.sub-title { margin: var(--space-16) 0 var(--space-4); font: var(--weight-heading) 22px / 1.2 var(--font-heading); letter-spacing: var(--tracking-heading); }
.sub-title.first { margin-top: 0; }
.sub-title + .note { margin: calc(var(--space-2) * -1) 0 var(--space-4); }

/* passport */
.props { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 380px), 1fr)); column-gap: var(--space-12); margin: 0; }
.props > div { display: grid; grid-template-columns: 150px minmax(0, 1fr); gap: var(--space-4); padding: var(--space-3) 0; border-top: var(--border) solid var(--line); }
.props dt { padding-top: 3px; }
.props dd { margin: 0; min-width: 0; }

/* tables scroll inside their own container, never the page */
.scroll { overflow-x: auto; -webkit-overflow-scrolling: touch; }
.scroll table { min-width: 720px; }
table.matrix { min-width: 1000px; }
table.narrow { max-width: 480px; }
td:last-child, th:last-child { padding-right: 0; }
tr.muted td { color: var(--mut); }
.matrix th[scope="col"] { vertical-align: bottom; hyphens: auto; }
.matrix th[scope="row"] { min-width: 200px; color: var(--fg); text-transform: none; }
.matrix th[scope="row"] .sub { font-family: var(--font-sans); }
.matrix td .mark + .mark { margin-top: var(--space-2); }
.matrix td .mark { display: flex; }
.nil { color: var(--faint); }
.legend { display: flex; flex-wrap: wrap; gap: var(--space-2) var(--space-6); margin-top: var(--space-4); max-width: none; }
.trace .gaps .mark + .mark { margin-top: var(--space-2); }
.minor td:nth-child(4), .minor td:nth-child(6) { min-width: 220px; }

/* severity is carried by the word and by the shape of the square, colour only supports it */
/* position: the visually hidden severity text inside must not escape the table's scroll container */
a.mark { position: relative; color: var(--fg); text-decoration: none; }
.scroll a.label.id, td.id { white-space: nowrap; }
.mark.multi { display: flex; align-items: baseline; white-space: normal; line-height: 1.45; text-transform: none; }
.mark.sev-critical::before { background: var(--bad); }
.mark.sev-major::before { background: transparent; border: var(--border) solid var(--tick); border-left: 4px solid var(--warn); }
.mark.sev-minor::before { background: transparent; border: var(--border) solid var(--mut); }

/* findings and questions: rows separated by lines, meta column on the left */
.findings { margin-top: var(--space-16); }
#set .findings { margin-top: 0; }
.group + .group { margin-top: var(--space-16); }
.group-head { padding-bottom: var(--space-6); }
.group-title { margin-top: var(--space-2); font: var(--weight-heading) 22px / 1.2 var(--font-heading); letter-spacing: var(--tracking-heading); }
.req-text { margin-top: var(--space-3); max-width: 80ch; color: var(--mut); font-size: 14.5px; white-space: pre-line; overflow-wrap: anywhere; }
.questions, .rejected { margin: 0; padding: 0; list-style: none; }
.entry { display: grid; grid-template-columns: minmax(0, 1fr); gap: var(--space-4); padding: var(--space-6) 0; border-top: var(--border) solid var(--line); }
.entry:last-of-type { border-bottom: var(--border) solid var(--line); }
.entry-meta { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-2) var(--space-4); }
.entry-body { min-width: 0; }
.entry-body > * + * { margin-top: var(--space-4); }
.entry-title { margin: 0; font: 500 20px / 1.3 var(--font-sans); max-width: 40ch; }
.entry .ref { margin-top: var(--space-2); max-width: none; }
.quote { margin-left: 0; margin-right: 0; padding-left: var(--space-4); border-left: var(--border) solid var(--tick); }
.quote blockquote { margin: 0; font: 400 14px / 1.55 var(--font-mono); white-space: pre-wrap; overflow-wrap: anywhere; }
.quote figcaption { margin-top: var(--space-1); }
.case { padding: var(--space-4) 0 0; border-top: var(--border) solid var(--line); }
.case > * + * { margin-top: var(--space-3); }
.kv { display: grid; grid-template-columns: minmax(0, 1fr); margin-bottom: 0; }
.kv dt { padding-top: var(--space-3); }
.kv dd { margin: var(--space-1) 0 0; min-width: 0; }
.opt { font-weight: 500; }
.opt::after { content: " —"; font-weight: 400; color: var(--mut); }
.answer { font-weight: 500; }
@media (min-width: 640px) {
  .kv { grid-template-columns: 168px minmax(0, 1fr); column-gap: var(--space-6); row-gap: var(--space-3); }
  .kv dt { padding-top: 3px; }
  .kv dd { margin: 0; }
}
@media (min-width: 900px) {
  .entry { grid-template-columns: 200px minmax(0, 1fr); gap: var(--space-8); }
  .entry-meta { flex-direction: column; align-items: flex-start; }
}
.rows { margin: 0; padding: 0; list-style: none; }
.rows.crit > li, .rows.fix > li, .rows.diag > li { display: grid; grid-template-columns: minmax(0, 1fr); gap: var(--space-1) var(--space-6); }
ol.fix { counter-reset: fix; }
ol.fix > li { counter-increment: fix; }
ol.fix > li::before { content: counter(fix, decimal-leading-zero); font: 400 var(--text-label) / 1.9 var(--font-mono); color: var(--mut); }
@media (min-width: 640px) {
  .rows.crit > li { grid-template-columns: 88px minmax(0, 1fr) minmax(120px, auto); align-items: baseline; }
  .rows.crit > li > :last-child { text-align: right; }
  .rows.fix > li { grid-template-columns: 32px 88px minmax(0, 1fr); align-items: baseline; }
  .rows.diag > li { grid-template-columns: 150px 150px minmax(0, 1fr); align-items: baseline; }
}

/* source document */
.src { padding: var(--space-3) 0; border-top: var(--border) solid var(--line); border-bottom: var(--border) solid var(--line); font: 400 13px / 1.6 var(--font-mono); }
.ln { display: grid; grid-template-columns: 5ch minmax(0, 1fr); column-gap: var(--space-4); padding: 1px 0 1px var(--space-2); border-left: 2px solid transparent; }
.ln .no { color: var(--mut); text-align: right; font-variant-numeric: tabular-nums; -webkit-user-select: none; user-select: none; }
.ln .tx { min-height: 1.6em; white-space: pre-wrap; overflow-wrap: anywhere; }
.ln.hit { border-left-color: var(--fg); }
.ln .refs { grid-column: 2; display: flex; flex-wrap: wrap; gap: var(--space-2) var(--space-4); padding: 2px 0 var(--space-2); }
.entry:target, tr:target, .ln:target { background: color-mix(in oklch, var(--acc) 13%, transparent); }
footer { padding: var(--space-8) 0 var(--space-16); }

@media print {
  /* paper is always light, whatever theme the screen had: the kit's light tokens again, on white */
  :root:root:root {
    --bg: oklch(100% 0 0); --raise: oklch(100% 0 0); --fg: oklch(21% 0.008 255); --mut: oklch(46% 0.008 255); --faint: oklch(70% 0.006 255);
    --line: oklch(21% 0.008 255 / 0.2); --tick: oklch(21% 0.008 255 / 0.34);
    --acc: oklch(56% 0.148 255); --acc-text: oklch(55% 0.145 255);
    --ok: oklch(64% 0.121 165); --warn: oklch(80% 0.149 80); --bad: oklch(55% 0.2 25); --info: oklch(52% 0.096 222);
    --text-body: 10.5pt; --text-lead: 12pt; --text-label: 8pt; --text-title: 20pt;
  }
  @page { size: A4; margin: 16mm 14mm; }
  html { scroll-padding-top: 0; }
  .wrap { max-width: none; padding: 0; }
  .bar, .filter-status { display: none; }
  .top { padding: 0 0 var(--space-8); }
  .tldr, .stats { margin-top: var(--space-8); }
  .verdict-line { font-size: 26pt; }
  main > section { padding-bottom: var(--space-8); }
  .sec-head { padding-bottom: var(--space-6); }
  .sec-head, .group-head, .sub-title, .sub-title + .note, h2, h3, h4 { break-after: avoid; }
  .sec-head, .group-head, .entry, .quote, .case, tr, .rows > li, .stats > div, .props > div { break-inside: avoid; }
  .scroll { overflow: visible; }
  .scroll table, table.matrix { min-width: 0; font-size: 8.5pt; }
  .matrix th[scope="row"] { min-width: 0; }
  .entry { grid-template-columns: 34mm minmax(0, 1fr); gap: var(--space-6); }
  .entry-meta { flex-direction: column; align-items: flex-start; }
  .kv { grid-template-columns: 34mm minmax(0, 1fr); column-gap: var(--space-4); row-gap: var(--space-2); }
  .kv dt { padding-top: 2px; } .kv dd { margin: 0; }
  .src { font-size: 8pt; }
  .entry:target, tr:target, .ln:target { background: none; }
  a { text-decoration: none; }
  * { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
}
`;

// Static script: no report data is interpolated here, everything is read from the DOM.
const REPORT_JS = `
(function () {
  var root = document.documentElement;
  var bar = document.querySelector('.bar');
  var ui = document.querySelector('[data-filter-ui]');
  var status = document.getElementById('filter-status');
  var buttons = ui ? Array.prototype.slice.call(ui.querySelectorAll('button[data-filter]')) : [];
  var indicator = ui ? ui.querySelector('.seg-ind') : null;

  function measure() {
    if (bar) root.style.setProperty('--bar-h', (bar.offsetHeight + 24) + 'px');
    var pressed = ui ? ui.querySelector('button[aria-pressed="true"]') : null;
    if (pressed && indicator) {
      indicator.style.width = pressed.offsetWidth + 'px';
      indicator.style.transform = 'translateX(' + pressed.offsetLeft + 'px)';
    }
  }

  function apply(value) {
    var shown = 0;
    var total = 0;
    document.querySelectorAll('[data-severity]').forEach(function (el) {
      var on = value === 'all' || el.getAttribute('data-severity') === value;
      el.hidden = !on;
      if (el.hasAttribute('data-finding')) { total += 1; if (on) shown += 1; }
    });
    document.querySelectorAll('[data-group]').forEach(function (group) {
      group.hidden = !group.querySelector('[data-finding]:not([hidden])');
    });
    document.querySelectorAll('[data-filter-scope]').forEach(function (scope) {
      var note = scope.querySelector('[data-filter-empty]');
      if (!note) return;
      var box = note.parentElement;
      var any = box.querySelector('[data-finding]');
      note.hidden = !any || !!box.querySelector('[data-finding]:not([hidden])');
    });
    buttons.forEach(function (button) {
      button.setAttribute('aria-pressed', button.getAttribute('data-filter') === value ? 'true' : 'false');
    });
    if (status) status.textContent = value === 'all' ? '' : 'Показано находок: ' + shown + ' из ' + total;
    measure();
  }

  if (ui) {
    ui.hidden = false;
    buttons.forEach(function (button) {
      button.addEventListener('click', function () { apply(button.getAttribute('data-filter')); });
    });
  }

  // A link may point at a finding the filter has hidden: show everything, then go there.
  function reveal() {
    var id = decodeURIComponent(location.hash.slice(1));
    var target = id ? document.getElementById(id) : null;
    if (target && target.closest('[hidden]')) {
      apply('all');
      target.scrollIntoView();
    }
  }
  window.addEventListener('hashchange', reveal);
  window.addEventListener('resize', measure);
  measure();
  reveal();

  if ('IntersectionObserver' in window) {
    var links = {};
    document.querySelectorAll('.bar-links a').forEach(function (a) { links[a.getAttribute('href').slice(1)] = a; });
    var observer = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting) return;
        Object.keys(links).forEach(function (key) { links[key].removeAttribute('aria-current'); });
        var link = links[entry.target.id];
        if (link) link.setAttribute('aria-current', 'true');
      });
    }, { rootMargin: '-25% 0px -70% 0px' });
    document.querySelectorAll('main > section[id]').forEach(function (section) { observer.observe(section); });
  }
})();
`;

export function renderHtml(report: Report, doc: SourceDoc | null): string {
  const ctx: Ctx = {
    report,
    view: buildView(report),
    doc,
    // Rejected findings have anchors too (appendix), so links to them resolve.
    findingIds: new Set([...report.findings, ...report.rejected].map((finding) => finding.id)),
    questionIds: new Set(report.questions.map((question) => question.id)),
  };
  const { passport } = report;

  const sections = [
    renderPassport(ctx, 1),
    renderSlicing(ctx, 2),
    renderRequirements(ctx, 3),
    renderSet(ctx, 4),
    renderQuestions(ctx, 5),
    renderSummary(ctx, 6),
    renderVerdict(ctx, 7),
    renderAppendix(ctx, 8),
  ];
  if (doc) sections.push(renderDocument(ctx, doc, 9));

  // The CSP is a second line of defence: even if some text slipped through unescaped, the page cannot load or send anything.
  return `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'">
<meta name="generator" content="Dalel ${esc(passport.agentVersion)}">
<title>${esc(`${passport.documentName} — отчёт о проверке требований · Dalel`)}</title>
<style>${KIT_CSS}</style>
<style>${REPORT_CSS}</style>
</head>
<body>
<div class="wrap">
${renderTop(ctx)}
${renderNav(ctx)}
<main>
${sections.join('\n')}
</main>
<footer><p class="label">dalel ${esc(passport.agentVersion)} · ${esc(passport.agentCommit)} · ${esc(formatDate(passport.date))} · sha-256 <span class="id">${esc(shortHash(passport.documentSha256))}</span></p></footer>
</div>
<script>${REPORT_JS}</script>
</body>
</html>
`;
}
