import { createRequire } from 'node:module';
import path from 'node:path';
import PdfPrinter from 'pdfmake';
import type {
  Content,
  ContentTable,
  CustomTableLayout,
  TableCell,
  TDocumentDefinitions,
  TFontDictionary,
} from 'pdfmake/interfaces.js';
import type { Counterexample, Criterion, Evidence, Finding, Question, Report, Severity } from '../types.js';
import {
  CRITERION_LABEL,
  KIND_LABEL,
  NON_REQUIREMENT_KINDS,
  REQUIREMENT_CRITERIA,
  SEVERITY_LABEL,
} from '../types.js';
import {
  DIAGNOSTIC_LEVEL_LABEL,
  MODE_LABEL,
  OPPONENT_LABEL,
  RISK_KIND_LABEL,
  RISK_LEVEL_LABEL,
  SECTION_TITLES,
  SEVERITIES,
  STATUS_LABEL,
  VERDICT_LABEL,
  buildView,
  formatDate,
  formatDuration,
  formatInt,
  linesLabel,
  requirementLabel,
  shortHash,
  truncate,
} from './html.js';
import type { ReportView } from './html.js';

// The kit's light-theme tokens (--fg, --mut, --tick, --faint, --acc) converted from oklch to sRGB: PDF has no oklch.
const INK = '#16191c';
const MUTED = '#55585d';
const RULE = '#b0b1b2';
const FAINT = '#9c9fa2';
const ACCENT = '#2e75c9';

const MARGIN_X = 48;
const CONTENT_WIDTH = 595.28 - MARGIN_X * 2;

/** Severity is told apart by the glyph and the word; the PDF uses no status colours. */
const SEVERITY_GLYPH: Record<Severity, string> = { critical: '■', major: '◧', minor: '□' };

/** Nine full names do not fit across A4, so the matrix header is abbreviated and spelled out in the legend. */
const CRITERION_SHORT: Partial<Record<Criterion, string>> = {
  necessary: 'Необх.',
  appropriate: 'Умест.',
  unambiguous: 'Однозн.',
  complete: 'Полн.',
  singular: 'Атом.',
  feasible: 'Реализ.',
  verifiable: 'Провер.',
  correct: 'Корр.',
  conforming: 'Шабл.',
};

let cachedPrinter: PdfPrinter | undefined;

function printer(): PdfPrinter {
  if (cachedPrinter) return cachedPrinter;
  const require = createRequire(import.meta.url);
  const dir = path.join(path.dirname(require.resolve('dejavu-fonts-ttf/package.json')), 'ttf');
  const file = (name: string): string => path.join(dir, name);
  const fonts: TFontDictionary = {
    DejaVu: {
      normal: file('DejaVuSans.ttf'),
      bold: file('DejaVuSans-Bold.ttf'),
      italics: file('DejaVuSans-Oblique.ttf'),
      bolditalics: file('DejaVuSans-BoldOblique.ttf'),
    },
    DejaVuMono: {
      normal: file('DejaVuSansMono.ttf'),
      bold: file('DejaVuSansMono-Bold.ttf'),
      italics: file('DejaVuSansMono-Oblique.ttf'),
      bolditalics: file('DejaVuSansMono-BoldOblique.ttf'),
    },
  };
  cachedPrinter = new PdfPrinter(fonts);
  return cachedPrinter;
}

/** Tabs and control characters have no glyphs and would print as boxes. */
function clean(value: string): string {
  return value
    .replace(/\r\n?/g, '\n')
    .replace(/\t/g, '    ')
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f\u200b-\u200f\u2028\u2029\ufeff]/g, '');
}

function label(value: string, extra: Record<string, unknown> = {}): Content {
  return { text: clean(value), style: 'label', ...extra };
}

function body(value: string, extra: Record<string, unknown> = {}): Content {
  return { text: clean(value), ...extra };
}

const rowsLayout: CustomTableLayout = {
  hLineWidth: (rowIndex) => (rowIndex === 0 ? 0 : 0.5),
  vLineWidth: () => 0,
  hLineColor: (rowIndex, node) => (rowIndex === (node.table.headerRows ?? 0) && rowIndex > 0 ? MUTED : RULE),
  paddingLeft: (columnIndex) => (columnIndex === 0 ? 0 : 4),
  paddingRight: (columnIndex, node) => (columnIndex === (node.table.widths?.length ?? 0) - 1 ? 0 : 4),
  paddingTop: () => 4,
  paddingBottom: () => 4,
};

const plainLayout: CustomTableLayout = {
  hLineWidth: () => 0,
  vLineWidth: () => 0,
  paddingLeft: (columnIndex) => (columnIndex === 0 ? 0 : 8),
  paddingRight: () => 0,
  paddingTop: () => 2,
  paddingBottom: () => 3,
};

const quoteLayout: CustomTableLayout = {
  hLineWidth: () => 0,
  vLineWidth: (columnIndex) => (columnIndex === 0 ? 0.75 : 0),
  vLineColor: () => MUTED,
  paddingLeft: () => 8,
  paddingRight: () => 0,
  paddingTop: () => 1,
  paddingBottom: () => 1,
};

type Width = number | '*';

/**
 * Turns star columns into points. pdfmake widens `*` and `auto` columns to their longest unbreakable word, which pushes
 * the table off the page; with every width fixed it splits such a word inside the cell instead.
 * `gutters` is the horizontal padding and rules of the table layout in use.
 */
function fit(widths: Width[], gutters = (widths.length - 1) * 8): number[] {
  const fixed = widths.reduce<number>((sum, width) => sum + (width === '*' ? 0 : width), 0);
  const stars = widths.filter((width) => width === '*').length;
  const share = stars > 0 ? Math.max(24, (CONTENT_WIDTH - gutters - fixed - 0.5) / stars) : 0;
  return widths.map((width) => (width === '*' ? share : width));
}

function table(
  widths: Width[],
  header: string[] | null,
  rows: TableCell[][],
  options: { fontSize?: number; keepRows?: boolean; margin?: [number, number, number, number] } = {},
): ContentTable {
  const head: TableCell[][] = header ? [header.map((cell) => label(cell))] : [];
  return {
    table: {
      widths: fit(widths),
      headerRows: header ? 1 : 0,
      dontBreakRows: options.keepRows ?? false,
      body: [...head, ...rows],
    },
    layout: rowsLayout,
    fontSize: options.fontSize ?? 8,
    margin: options.margin ?? [0, 0, 0, 0],
  };
}

function kv(rows: [string, Content][], labelWidth = 112): Content {
  if (rows.length === 0) return [];
  return {
    table: {
      widths: fit([labelWidth, '*']),
      body: rows.map(([name, value]): TableCell[] => [label(name.toLowerCase(), { margin: [0, 1.5, 0, 0] }), value]),
    },
    layout: plainLayout,
    margin: [0, 4, 0, 0],
  };
}

function bullets(items: Content[]): Content {
  if (items.length === 0) return body('—');
  return { ul: items, markerColor: MUTED, margin: [0, 0, 0, 0] };
}

function sectionHead(index: number, title: string, note: string, first = false): Content {
  return {
    stack: [
      {
        canvas: [
          { type: 'line', x1: 0, y1: 0, x2: CONTENT_WIDTH, y2: 0, lineWidth: 0.5, lineColor: MUTED },
          { type: 'line', x1: 0, y1: 0, x2: 28, y2: 0, lineWidth: 1.5, lineColor: ACCENT },
        ],
      },
      label(`${String(index).padStart(2, '0')} · ${note}`, { margin: [0, 8, 0, 3] }),
      { text: title, style: 'h2' },
    ],
    headlineLevel: 1,
    margin: [0, first ? 26 : 30, 0, 12],
  };
}

function subHead(title: string): Content {
  return { text: title, style: 'h3', headlineLevel: 2, margin: [0, 18, 0, 6] };
}

function empty(message: string): Content {
  return { text: message, color: MUTED, margin: [0, 2, 0, 0] };
}

interface Ctx {
  report: Report;
  view: ReportView;
  /** Destinations that exist in the document, so links are only made to places that can be reached. */
  destinations: Set<string>;
  used: Set<string>;
}

function destination(ctx: Ctx, id: string): Record<string, unknown> {
  // pdfmake throws on a duplicate node id, and a report with repeated ids must still render.
  if (ctx.used.has(id) || !ctx.destinations.has(id)) return {};
  ctx.used.add(id);
  return { id: `dalel-${id}` };
}

function link(ctx: Ctx, id: string, extra: Record<string, unknown> = {}): Content {
  return ctx.destinations.has(id)
    ? { text: clean(id), linkToDestination: `dalel-${id}`, ...extra }
    : { text: clean(id), ...extra };
}

function requirementName(ctx: Ctx, id: string): string {
  const requirement = ctx.view.byId.get(id);
  return requirement ? requirementLabel(requirement) : id;
}

function quote(ctx: Ctx, item: Evidence): Content {
  const caption = [linesLabel(item.lineStart, item.lineEnd)];
  if (item.requirementId !== undefined) caption.push(requirementName(ctx, item.requirementId));
  return {
    table: {
      widths: fit(['*'], 8.75),
      body: [
        [
          {
            stack: [
              { text: clean(item.quote), font: 'DejaVuMono', fontSize: 8, lineHeight: 1.25, preserveLeadingSpaces: true },
              label(caption.join(' · '), { margin: [0, 2, 0, 0] }),
            ],
          },
        ],
      ],
    },
    layout: quoteLayout,
    margin: [0, 6, 0, 2],
  };
}

function counterexample(ctx: Ctx, example: Counterexample): Content {
  const expectations = example.expectations.map(
    (item): Content => ({
      text: [
        { text: `${clean(requirementName(ctx, item.requirementId))}  `, font: 'DejaVuMono', fontSize: 7.5, color: MUTED },
        clean(item.expected),
      ],
    }),
  );
  const rows: [string, Content][] = [
    ['Дано', bullets(example.given.map((line) => body(line)))],
    ['Когда', bullets(example.when.map((line) => body(line)))],
    ['Ожидания по требованиям', bullets(expectations)],
    ['Конфликт', body(example.conflict)],
  ];
  const stack: Content[] = [label('контрпример', { margin: [0, 8, 0, 0] }), kv(rows)];
  if (example.arithmeticChecked) stack.push(label('■ арифметика пересчитана кодом', { margin: [0, 4, 0, 0] }));
  return { stack };
}

function findingCard(ctx: Ctx, finding: Finding): Content {
  const meta = [
    finding.id,
    `${SEVERITY_GLYPH[finding.severity]} ${SEVERITY_LABEL[finding.severity]}`,
    CRITERION_LABEL[finding.criterion].toLowerCase(),
  ];
  if (finding.ruleId) meta.push(`правило ${finding.ruleId}`);
  if (finding.status !== 'confirmed') meta.push(STATUS_LABEL[finding.status]);
  const refs = [finding.standardRef, finding.normRef].filter((ref): ref is string => Boolean(ref));
  const rootCause = ctx.report.rootCauses.find((cause) => cause.id === finding.rootCauseId);

  const rows: [string, Content][] = [];
  if (finding.scope === 'set' && finding.requirementIds.length > 0) {
    rows.push(['Требования', body(finding.requirementIds.map((id) => requirementName(ctx, id)).join(', '))]);
  }
  rows.push(['Рекомендация', body(finding.recommendation)]);
  if (rootCause) rows.push(['Корневая причина', body(rootCause.title)]);
  if (finding.opponent) {
    rows.push(['Оппонент', body(`${OPPONENT_LABEL[finding.opponent.verdict]}: ${finding.opponent.reason}`)]);
  }
  if (finding.status !== 'confirmed') rows.push(['Статус', body(STATUS_LABEL[finding.status])]);
  if (finding.resolution) {
    rows.push(['Решение', body(`${finding.resolution.byQuestionId}: ${finding.resolution.note}`)]);
    if (finding.resolution.proposedText) {
      rows.push(['Предложенный текст', body(finding.resolution.proposedText, { font: 'DejaVuMono', fontSize: 8 })]);
    }
  }

  const stack: Content[] = [
    label(meta.join(' · '), { headlineLevel: 3, ...destination(ctx, finding.id) }),
    { text: clean(finding.title), style: 'cardTitle' },
    label(refs.join(' · ')),
    ...finding.evidence.map((item) => quote(ctx, item)),
    body(finding.explanation, { margin: [0, 6, 0, 0] }),
    ...(finding.aspects && finding.aspects.length > 0 ? [body(`Проявляется также: ${finding.aspects.join('; ')}`, { margin: [0, 4, 0, 0], color: MUTED })] : []),
  ];
  if (finding.counterexample) stack.push(counterexample(ctx, finding.counterexample));
  stack.push(kv(rows));
  stack.push(hairline());
  return { stack, margin: [0, 10, 0, 0] };
}

function hairline(): Content {
  return {
    canvas: [{ type: 'line', x1: 0, y1: 0, x2: CONTENT_WIDTH, y2: 0, lineWidth: 0.5, lineColor: RULE }],
    margin: [0, 10, 0, 0],
  };
}

function top(ctx: Ctx): Content[] {
  const { passport, verdict, summary } = ctx.report;
  const stats: [string, number][] = [
    ['требования', summary.requirements],
    ['находки', summary.findings],
    ['критичные', summary.bySeverity.critical],
    ['блокирующие вопросы', summary.blockingQuestions],
  ];
  return [
    label(`dalel ${passport.agentVersion} · ${formatDate(passport.date)} · ${MODE_LABEL[passport.mode]}`),
    { text: SECTION_TITLES.title, style: 'h1', margin: [0, 6, 0, 4] },
    { text: clean(passport.documentName), font: 'DejaVuMono', fontSize: 9, color: MUTED },
    {
      text: [{ text: '■ ', color: ACCENT }, VERDICT_LABEL[verdict.code]],
      style: 'label',
      margin: [0, 30, 0, 4],
    },
    { text: clean(verdict.headline), fontSize: 19, lineHeight: 1.12, margin: [0, 0, 0, 8] },
    { text: clean(verdict.rationale), fontSize: 10.5, color: MUTED, lineHeight: 1.35 },
    {
      table: {
        widths: fit(['*', '*', '*', '*']),
        body: [
          stats.map(([name]): TableCell => label(name)),
          stats.map(([, value]): TableCell => ({ text: formatInt(value), fontSize: 20 })),
        ],
      },
      layout: plainLayout,
      margin: [0, 24, 0, 0],
    },
  ];
}

function passportSection(ctx: Ctx, index: number): Content[] {
  const p = ctx.report.passport;
  const mono = (value: string): Content => ({ text: clean(value), font: 'DejaVuMono', fontSize: 8.5 });
  const rows: TableCell[][] = [
    [label('документ'), body(p.documentName)],
    // In full: the passport is where a reader checks that the report is about the issued document.
    [label('sha-256'), mono(p.documentSha256 || '—')],
    [label('формат'), mono(p.documentFormat)],
    [label('строк'), mono(formatInt(p.documentLines))],
    [label('дата'), mono(formatDate(p.date))],
    [label('провайдер / модель'), mono(`${p.provider} / ${p.model}`)],
    [label('режим'), body(MODE_LABEL[p.mode])],
    [label('версия агента'), mono(`${p.agentVersion} (${p.agentCommit})`)],
    [label('пакеты правил'), mono(p.rulePacks.length > 0 ? p.rulePacks.join(', ') : '—')],
    [label('хэш промптов'), mono(p.promptHash)],
    [label('длительность'), mono(formatDuration(p.durationMs))],
    [label('вызовы llm'), mono(`${formatInt(p.llmCalls)}, из кэша ${formatInt(p.llmCacheHits)}`)],
    [label('токены'), mono(`вход ${formatInt(p.tokensIn)}, выход ${formatInt(p.tokensOut)}`)],
  ];
  return [
    sectionHead(index, SECTION_TITLES.passport, 'чем и как проверяли', true),
    table([130, '*'], null, rows, { fontSize: 9, keepRows: true }),
  ];
}

function slicingSection(ctx: Ctx, index: number): Content[] {
  const { requirements } = ctx.report;
  const rows = requirements.map((requirement): TableCell[] => {
    const color = NON_REQUIREMENT_KINDS.has(requirement.kind) ? MUTED : INK;
    const cell = (value: string, extra: Record<string, unknown> = {}): TableCell => ({ text: clean(value), color, ...extra });
    const mono = { font: 'DejaVuMono', fontSize: 7.5 };
    return [
      cell(requirement.id, mono),
      cell(requirement.docId ?? '—', mono),
      cell(requirement.section.length > 0 ? requirement.section.join(' › ') : '—'),
      cell(linesLabel(requirement.lineStart, requirement.lineEnd).replace(/^строк[аи] /, ''), mono),
      cell(KIND_LABEL[requirement.kind]),
      cell(requirement.summary),
    ];
  });
  const skipped = requirements.length - ctx.view.counted.length;
  const content: Content[] = [
    sectionHead(
      index,
      SECTION_TITLES.slicing,
      `единиц ${formatInt(requirements.length)}, требований ${formatInt(ctx.view.counted.length)}`,
    ),
  ];
  if (requirements.length === 0) {
    content.push(empty('Агент не выделил в документе ни одной единицы текста.'));
    return content;
  }
  content.push(
    table([36, 42, 96, 34, 94, '*'], ['id отчёта', 'id в документе', 'раздел', 'строки', 'тип', 'суть'], rows, {
      keepRows: true,
    }),
  );
  if (skipped > 0) {
    content.push(
      label(`серым (${skipped}) — не требования: реквизиты, шаблоны, контекст. в подсчёт они не входят.`, {
        margin: [0, 6, 0, 0],
      }),
    );
  }
  return content;
}

function matrix(ctx: Ctx): Content[] {
  if (ctx.view.matrix.length === 0) return [empty('Требований для проверки нет.')];
  const header = ['требование', ...REQUIREMENT_CRITERIA.map((criterion, i) => CRITERION_SHORT[criterion] ?? String(i + 1))];
  const rows = ctx.view.matrix.map(({ requirement, cells }): TableCell[] => [
    {
      stack: [
        { text: clean(requirementLabel(requirement)), font: 'DejaVuMono', fontSize: 7.5 },
        { text: clean(truncate(requirement.summary, 80)), fontSize: 7, color: MUTED },
      ],
    },
    ...cells.map((findings): TableCell => {
      if (findings.length === 0) return { text: '·', color: FAINT };
      return {
        stack: findings.map(
          (finding): Content => ({
            text: [`${SEVERITY_GLYPH[finding.severity]} `, link(ctx, finding.id)],
            fontSize: 6.5,
            noWrap: true,
          }),
        ),
      };
    }),
  ]);
  const legend = SEVERITIES.map((severity) => `${SEVERITY_GLYPH[severity]} ${SEVERITY_LABEL[severity]}`);
  const names = REQUIREMENT_CRITERIA.map(
    (criterion, i) => `${CRITERION_SHORT[criterion] ?? String(i + 1)} — ${CRITERION_LABEL[criterion].toLowerCase()}`,
  );
  return [
    table([112, ...REQUIREMENT_CRITERIA.map((): Width => '*')], header, rows, { fontSize: 7, keepRows: true }),
    label(`${legend.join('   ')}   · замечаний нет`, { margin: [0, 6, 0, 0] }),
    label(names.join('; '), { margin: [0, 2, 0, 0] }),
  ];
}

function requirementsSection(ctx: Ctx, index: number): Content[] {
  const content: Content[] = [
    sectionHead(index, SECTION_TITLES.requirements, 'девять характеристик ISO/IEC/IEEE 29148 §5.2.5'),
    ...matrix(ctx),
  ];
  const shown = ctx.view.groups.reduce((sum, group) => sum + group.findings.length, 0);
  if (shown === 0) {
    content.push(empty('Критичных и существенных замечаний к отдельным требованиям нет.'));
  }
  for (const group of ctx.view.groups) {
    const requirement = group.requirement;
    if (requirement) {
      content.push({
        stack: [
          label(
            `${requirementLabel(requirement)} · ${linesLabel(requirement.lineStart, requirement.lineEnd)} · ${KIND_LABEL[requirement.kind]}`,
          ),
          { text: clean(requirement.summary), style: 'h3', margin: [0, 2, 0, 0] },
        ],
        headlineLevel: 2,
        margin: [0, 20, 0, 0],
      });
    } else {
      content.push(subHead('Без привязки к требованию'));
    }
    for (const finding of group.findings) content.push(findingCard(ctx, finding));
    if (group.seeAlso.length > 0) {
      content.push({
        text: ['см. также: ', ...joined(group.seeAlso.map((finding) => link(ctx, finding.id)))],
        style: 'label',
        margin: [0, 6, 0, 0],
      });
    }
  }
  if (ctx.view.minor.length > 0) {
    content.push(
      label(`незначительные замечания (${ctx.view.minor.length}) вынесены в приложение.`, { margin: [0, 10, 0, 0] }),
    );
  }
  return content;
}

function joined(items: Content[], separator = ', '): Content[] {
  return items.flatMap((item, i): Content[] => (i === 0 ? [item] : [separator, item]));
}

function testCasesBlock(ctx: Ctx): Content[] {
  const cases = ctx.report.testCases ?? [];
  if (cases.length === 0) return [];
  const kind = { boundary: 'граница', counterexample: 'противоречие', acceptance: 'приёмка', decision: 'по ответу' } as const;
  const missing = cases.filter((t) => !t.coveredByAcceptance).length;
  return [
    subHead('Черновик тест-кейсов'),
    body(`Спроектировано из текста документа: ${cases.length}; не покрыто критериями приёмки документа: ${missing}.`, { color: MUTED }),
    table(
      [38, 58, '*', '*', '*', 34],
      ['№', 'тип', 'дано', 'когда', 'тогда', 'в приёмке'],
      cases.map((t): TableCell[] => [
        { text: clean(t.id), font: 'DejaVuMono', fontSize: 7 },
        body(kind[t.kind]),
        body(t.given.join(' ')),
        body(t.when.join(' ')),
        body(t.then.join(' ')),
        body(t.coveredByAcceptance ? 'да' : 'нет'),
      ]),
      { fontSize: 7.5, margin: [0, 4, 0, 0] },
    ),
  ];
}

function setSection(ctx: Ctx, index: number): Content[] {
  const content: Content[] = [sectionHead(index, SECTION_TITLES.set, 'ISO/IEC/IEEE 29148 §5.2.6, IEEE 830 §4.3')];
  if (ctx.view.setFindings.length === 0) {
    content.push(empty('Критичных и существенных замечаний к набору требований нет.'));
  }
  for (const finding of ctx.view.setFindings) content.push(findingCard(ctx, finding));

  const checklist = ctx.report.checklist ?? [];
  if (checklist.length > 0) {
    content.push(subHead('Чек-лист ревью из шаблона документа'));
    content.push(body('В документе чек-лист пуст. Ниже — черновик агента по результатам проверки; итоговую отметку ставит ревьюер.', { color: MUTED }));
    content.push(
      table(
        [150, 52, '*', 70],
        ['пункт чек-листа', 'ответ', 'основание', 'находки'],
        checklist.map((c): TableCell[] => [body(c.item), { text: clean(c.answer), bold: true }, body(c.basis), { text: clean(c.findingIds.join(', ') || '—'), font: 'DejaVuMono', fontSize: 7.5 }]),
        { keepRows: true, margin: [0, 4, 0, 0] },
      ),
    );
  }

  content.push(subHead('Матрица трассировки'));
  const { trace } = ctx.report;
  if (trace.length === 0) {
    content.push(empty('Матрица трассировки не построена: связей с API и приёмкой не найдено.'));
    content.push(...testCasesBlock(ctx));
    return content;
  }
  const mono = (items: string[]): TableCell =>
    items.length > 0 ? { text: clean(items.join('\n')), font: 'DejaVuMono', fontSize: 7.5 } : { text: '—', color: MUTED };
  const rows = trace.map((row): TableCell[] => [
    { text: clean(requirementName(ctx, row.requirementId)), font: 'DejaVuMono', fontSize: 7.5 },
    mono(row.apiRefs),
    mono(row.acceptanceRefs),
    row.gaps.length > 0 ? { stack: row.gaps.map((gap) => body(`◧ ${gap}`)) } : { text: '—', color: MUTED },
  ]);
  content.push(table([84, 140, 84, '*'], ['требование', 'api', 'приёмка', 'пробелы'], rows, { keepRows: true }));
  content.push(...testCasesBlock(ctx));
  return content;
}

function questionBlock(ctx: Ctx, question: Question): Content {
  const meta = [
    question.id,
    question.blocking ? '■ блокирует разработку' : '□ не блокирует',
    `риск ${RISK_LEVEL_LABEL[question.risk.level]} · ${RISK_KIND_LABEL[question.risk.kind]}`,
  ];
  const rows: [string, Content][] = [
    ['Кому', body(question.addressee)],
    ['Почему важно', body(question.why)],
    ['Риск', body(question.risk.note)],
  ];
  if (question.options.length > 0) {
    rows.push([
      'Варианты и последствия',
      bullets(
        question.options.map(
          (option): Content => ({ text: [{ text: `${clean(option.label)} — `, bold: true }, clean(option.consequence)] }),
        ),
      ),
    ]);
  }
  if (question.scenario) rows.push(['Ситуация', body(question.scenario)]);
  if (question.recommended) rows.push(['Рекомендация агента', body(`${question.recommended.label}${question.recommended.reason ? ` — ${question.recommended.reason}` : ''}`)]);
  rows.push(['Если ответа не будет', body(question.defaultAssumption)]);
  if (question.findingIds.length > 0) {
    rows.push(['Находки', { text: joined(question.findingIds.map((id) => link(ctx, id))), font: 'DejaVuMono', fontSize: 8 }]);
  }
  if (question.answer !== undefined) rows.push(['Ответ автора', body(question.answer, { bold: true })]);
  return {
    stack: [
      label(meta.join(' · '), { headlineLevel: 3 }),
      { text: clean(question.text), style: 'cardTitle' },
      kv(rows),
      hairline(),
    ],
    margin: [0, 10, 0, 0],
  };
}

function questionsSection(ctx: Ctx, index: number): Content[] {
  const { questions, summary, answersApplied } = ctx.report;
  const content: Content[] = [
    sectionHead(
      index,
      SECTION_TITLES.questions,
      `всего ${formatInt(questions.length)}, блокирующих ${formatInt(summary.blockingQuestions)}`,
    ),
  ];
  if (questions.length === 0) content.push(empty('Вопросов к автору нет.'));
  for (const question of questions) content.push(questionBlock(ctx, question));
  if (answersApplied) {
    const file = answersApplied.file ? ` · ${answersApplied.file}` : '';
    content.push(
      label(
        `учтено ответов автора: ${formatInt(answersApplied.count)}, снято находок: ${formatInt(answersApplied.resolved)}${file}`,
        { margin: [0, 8, 0, 0] },
      ),
    );
  }
  return content;
}

function summarySection(ctx: Ctx, index: number): Content[] {
  const { summary } = ctx.report;
  const counts: [string, number][] = [
    ['единицы текста', summary.units],
    ['требования', summary.requirements],
    ['требования с находками', summary.requirementsWithFindings],
    ['находки', summary.findings],
    ['критичные', summary.bySeverity.critical],
    ['существенные', summary.bySeverity.major],
    ['незначительные', summary.bySeverity.minor],
    ['вопросы', summary.questions],
    ['блокирующие вопросы', summary.blockingQuestions],
    ['отклонено оппонентом', summary.rejectedByOpponent],
    ['отброшено без подтверждения цитатой', summary.droppedUnverified],
  ];
  const number = (value: number): TableCell => ({ text: formatInt(value), font: 'DejaVuMono', alignment: 'right' });
  const content: Content[] = [
    sectionHead(index, SECTION_TITLES.summary, 'числа прогона'),
    table(
      [230, 50],
      null,
      counts.map(([name, value]): TableCell[] => [label(name), number(value)]),
      { fontSize: 9, keepRows: true },
    ),
    subHead('По характеристикам'),
  ];
  const criteria = (Object.keys(CRITERION_LABEL) as Criterion[]).filter((criterion) => (summary.byCriterion[criterion] ?? 0) > 0);
  content.push(
    criteria.length > 0
      ? table(
          [230, 50],
          ['характеристика', 'находок'],
          criteria.map((criterion): TableCell[] => [
            body(CRITERION_LABEL[criterion]),
            number(summary.byCriterion[criterion] ?? 0),
          ]),
          { fontSize: 9, keepRows: true },
        )
      : empty('Находок нет.'),
  );
  content.push(subHead('Критичные дефекты'));
  content.push(
    summary.critical.length > 0
      ? table(
          [44, '*', 120],
          null,
          summary.critical.map((item): TableCell[] => [
            link(ctx, item.findingId, { font: 'DejaVuMono', fontSize: 7.5 }),
            body(item.title),
            { text: clean(item.requirementIds.map((id) => requirementName(ctx, id)).join(', ')), font: 'DejaVuMono', fontSize: 7.5, color: MUTED },
          ]),
          { fontSize: 9 },
        )
      : empty('Критичных дефектов нет.'),
  );
  return content;
}

function verdictSection(ctx: Ctx, index: number): Content[] {
  const { verdict } = ctx.report;
  const content: Content[] = [
    sectionHead(index, SECTION_TITLES.verdict, VERDICT_LABEL[verdict.code]),
    { text: clean(verdict.headline), fontSize: 14, lineHeight: 1.15, margin: [0, 0, 0, 6] },
    { text: clean(verdict.rationale), color: MUTED, lineHeight: 1.35 },
    subHead('Что исправить в первую очередь'),
  ];
  content.push(
    verdict.fixFirst.length > 0
      ? table(
          [20, 44, '*'],
          null,
          verdict.fixFirst.map((item, i): TableCell[] => [
            label(String(i + 1).padStart(2, '0')),
            link(ctx, item.findingId, { font: 'DejaVuMono', fontSize: 7.5 }),
            body(item.text),
          ]),
          { fontSize: 9 },
        )
      : empty('Срочных исправлений нет.'),
  );
  return content;
}

function appendixSection(ctx: Ctx, index: number): Content[] {
  const { rejected, diagnostics } = ctx.report;
  const content: Content[] = [
    sectionHead(index, SECTION_TITLES.appendix, 'для полноты и проверки'),
    { text: 'Незначительные замечания', style: 'h3', headlineLevel: 2, margin: [0, 0, 0, 6] },
  ];

  if (ctx.view.minor.length === 0) {
    content.push(empty('Незначительных замечаний нет.'));
  } else {
    const rows = ctx.view.minor.map((finding): TableCell[] => {
      const lines = finding.evidence.map((item) => linesLabel(item.lineStart, item.lineEnd).replace(/^строк[аи] /, ''));
      const note: Content[] = [body(finding.title), body(finding.explanation, { color: MUTED, margin: [0, 2, 0, 0] })];
      if (finding.status !== 'confirmed') note.push(label(STATUS_LABEL[finding.status], { margin: [0, 2, 0, 0] }));
      return [
        { text: clean(finding.id), font: 'DejaVuMono', fontSize: 7, ...destination(ctx, finding.id) },
        { text: clean(finding.requirementIds.map((id) => requirementName(ctx, id)).join(', ') || '—'), font: 'DejaVuMono', fontSize: 7 },
        body(CRITERION_LABEL[finding.criterion]),
        { stack: note },
        { text: lines.join(', ') || '—', font: 'DejaVuMono', fontSize: 7 },
        body(finding.recommendation),
      ];
    });
    content.push(
      // 84: «Непротиворечивость набора» and «Ранжированность» fit without breaking inside the word.
      table([34, 54, 84, '*', 34, 116], ['id', 'требование', 'характеристика', 'замечание', 'строки', 'рекомендация'], rows, {
        fontSize: 7.5,
      }),
    );
  }

  content.push(subHead('Отклонено оппонентом'));
  content.push(
    label('эти находки не входят в итог. они показаны, чтобы было видно, что агент отбросил и почему.', {
      margin: [0, 0, 0, 2],
    }),
  );
  if (rejected.length === 0) content.push(empty('Оппонент не отклонил ни одной находки.'));
  // Same rule as the Markdown report: repeats of a kept finding are counted, not listed one by one.
  const duplicates = rejected.filter((finding) => /^\s*дубликат/iu.test(finding.opponent?.reason ?? ''));
  if (duplicates.length > 0) {
    content.push(
      body(`Как повторы других замечаний сняты ${formatInt(duplicates.length)}; они не перечисляются. Остальные отклонённые замечания — с причиной:`, {
        color: MUTED,
        margin: [0, 4, 0, 0],
      }),
    );
  }
  for (const finding of rejected) {
    if (duplicates.includes(finding)) continue;
    const meta = [finding.id, STATUS_LABEL.rejected, CRITERION_LABEL[finding.criterion].toLowerCase()];
    if (finding.requirementIds.length > 0) meta.push(finding.requirementIds.map((id) => requirementName(ctx, id)).join(', '));
    content.push({
      stack: [
        label(meta.join(' · '), { headlineLevel: 3 }),
        { text: clean(finding.title), fontSize: 10, margin: [0, 2, 0, 0] },
        ...finding.evidence.map((item) => quote(ctx, item)),
        kv([['Почему отклонено', body(finding.opponent ? finding.opponent.reason : 'Причина не записана.')]]),
        hairline(),
      ],
      margin: [0, 8, 0, 0],
    });
  }

  content.push(subHead('Диагностика'));
  content.push(
    diagnostics.length > 0
      ? table(
          [84, 100, '*'],
          ['уровень', 'код', 'сообщение'],
          diagnostics.map((item): TableCell[] => [
            label(DIAGNOSTIC_LEVEL_LABEL[item.level]),
            { text: clean(item.code), font: 'DejaVuMono', fontSize: 7.5 },
            {
              stack: item.hint ? [body(item.message), body(item.hint, { color: MUTED, margin: [0, 2, 0, 0] })] : [body(item.message)],
            },
          ]),
          { fontSize: 8.5 },
        )
      : empty('Диагностических сообщений нет.'),
  );
  return content;
}

/**
 * A heading that starts below this share of the page height (by headline level) would be stranded at the bottom,
 * so it moves to the next page. Counting the nodes that follow it is not reliable: pdfmake reports repeated table
 * headers and page footers among them.
 */
const HEADING_LIMIT: Record<number, number> = { 1: 0.8, 2: 0.82, 3: 0.87 };

export async function renderPdf(report: Report): Promise<Buffer> {
  const view = buildView(report);
  const ctx: Ctx = {
    report,
    view,
    // Cards for critical/major findings and rows of the minor table: both carry a destination.
    destinations: new Set(report.findings.map((finding) => finding.id)),
    used: new Set(),
  };
  const { passport } = report;
  const created = new Date(passport.date);

  const definition: TDocumentDefinitions = {
    pageSize: 'A4',
    pageMargins: [MARGIN_X, 62, MARGIN_X, 56],
    info: {
      title: `${passport.documentName} — отчёт о проверке требований`,
      author: 'Dalel',
      subject: SECTION_TITLES.title,
      creator: `Dalel ${passport.agentVersion}`,
      producer: `Dalel ${passport.agentVersion}`,
      // Taken from the passport so that the same report gives the same file.
      ...(Number.isNaN(created.getTime()) ? {} : { creationDate: created, modDate: created }),
    },
    defaultStyle: { font: 'DejaVu', fontSize: 9.5, lineHeight: 1.3, color: INK },
    styles: {
      h1: { fontSize: 24, lineHeight: 1.05 },
      h2: { fontSize: 16, lineHeight: 1.1 },
      h3: { fontSize: 12, lineHeight: 1.2 },
      cardTitle: { fontSize: 11.5, lineHeight: 1.2, margin: [0, 3, 0, 2] },
      label: { font: 'DejaVuMono', fontSize: 7.5, color: MUTED, lineHeight: 1.3 },
    },
    header: (currentPage) =>
      currentPage === 1
        ? null
        : {
            columns: [
              { text: clean(truncate(passport.documentName, 70)), style: 'label' },
              { text: 'отчёт о проверке требований · dalel', style: 'label', alignment: 'right', width: 'auto' },
            ],
            columnGap: 12,
            margin: [MARGIN_X, 30, MARGIN_X, 0],
          },
    footer: (currentPage, pageCount) => ({
      columns: [
        { text: `dalel ${clean(passport.agentVersion)} · ${formatDate(passport.date)} · sha-256 ${shortHash(passport.documentSha256)}`, style: 'label' },
        { text: `стр. ${currentPage} из ${pageCount}`, style: 'label', alignment: 'right', width: 'auto' },
      ],
      columnGap: 12,
      margin: [MARGIN_X, 22, MARGIN_X, 0],
    }),
    pageBreakBefore: (node) => {
      if (node.headlineLevel === undefined) return false;
      const limit = HEADING_LIMIT[node.headlineLevel];
      return limit !== undefined && node.startPosition.verticalRatio > limit;
    },
    content: [
      ...top(ctx),
      ...passportSection(ctx, 1),
      ...slicingSection(ctx, 2),
      ...requirementsSection(ctx, 3),
      ...setSection(ctx, 4),
      ...questionsSection(ctx, 5),
      ...summarySection(ctx, 6),
      ...verdictSection(ctx, 7),
      ...appendixSection(ctx, 8),
    ],
  };

  const document = printer().createPdfKitDocument(definition);
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    document.on('data', (chunk: Buffer) => chunks.push(chunk));
    document.on('end', () => resolve(Buffer.concat(chunks)));
    document.on('error', reject);
    document.end();
  });
}
