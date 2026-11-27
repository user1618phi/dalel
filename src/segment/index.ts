import type { Block, ReqKind, Requirement, SourceDoc } from '../types.js';

export interface SegBlock extends Block {
  /** Index of the table the row belongs to; rows of one table share it. */
  tableId?: number;
}

const HEADING_RE = /^(#{1,6})\s+(.+?)\s*#*\s*$/;
const LIST_RE = /^(\s*)([*\-+•·▪◦]|\d{1,3}[.)])\s+(\S.*)$/;
const TABLE_SEP_RE = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;
const HR_RE = /^\s*([-*_])(\s*\1){2,}\s*$/;
const FENCE_RE = /^\s*(```|~~~)/;
const DOC_ID_RE = /^[\s*_>]*((?:[A-ZА-ЯЁ]{1,6}[-–.]?\d{1,4}(?:\.\d{1,3})*)|(?:\d{1,2}(?:\.\d{1,3}){1,4}))\.?[*_]*[.:)]?\s+\S/u;
const UNFILLED_CHOICE_RE = /^(да|yes)\s*\/\s*(нет|no)(\s*\/\s*(не требуется|n\/?a))?$/iu;

export function splitTableRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
  return s.split(/(?<!\\)\|/).map((c) => c.trim());
}

export function stripMarkdown(s: string): string {
  return s
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/(?<![\p{L}\p{N}*])\*([^*\n]+)\*(?![\p{L}\p{N}*])/gu, '$1')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

function looksLikePlainHeading(line: string, prev: string | undefined, next: string | undefined): number | null {
  const t = line.trim();
  if (t.length < 3 || t.length > 90) return null;
  if (/[.;,:!?]$/.test(t)) return null;
  const words = t.split(/\s+/);
  const isolated = (prev === undefined || prev.trim() === '') && (next === undefined || next.trim() === '');
  const letters = t.replace(/[^\p{L}]/gu, '');
  const numbered = /^(\d{1,2}(?:\.\d{1,2}){0,3})\.?\s+\p{Lu}/u.exec(t);
  // «1. Текст» is a heading only when it stands alone; otherwise it is an item of a numbered list.
  if (numbered?.[1] && isolated && words.length <= 10) return Math.min(6, numbered[1].split('.').length + 1);
  if (letters.length >= 4 && letters === letters.toUpperCase() && words.length <= 10) return 2;
  if (isolated && words.length <= 7 && /^\p{Lu}/u.test(t) && !/\d{3,}/.test(t)) return 3;
  return null;
}

/** Deterministic structural parse: the same text always yields the same blocks. */
export function parseBlocks(doc: SourceDoc): SegBlock[] {
  const lines = doc.lines;
  const hasMdHeadings = lines.some((l) => HEADING_RE.test(l));
  const blocks: SegBlock[] = [];
  const stack: { level: number; title: string }[] = [];
  const section = () => stack.map((s) => s.title);
  let tableCounter = 0;

  const pushHeading = (level: number, title: string, line: number) => {
    while (stack.length > 0 && (stack[stack.length - 1]?.level ?? 0) >= level) stack.pop();
    blocks.push({ kind: 'heading', text: title, lineStart: line, lineEnd: line, section: section(), level });
    stack.push({ level, title });
  };

  let i = 0;
  while (i < lines.length) {
    const raw = lines[i] ?? '';
    const ln = i + 1;
    if (raw.trim() === '' || HR_RE.test(raw)) {
      i++;
      continue;
    }

    if (FENCE_RE.test(raw)) {
      const fence = FENCE_RE.exec(raw)?.[1] ?? '```';
      let j = i + 1;
      while (j < lines.length && !(lines[j] ?? '').trim().startsWith(fence)) j++;
      const body = lines.slice(i + 1, j).join('\n');
      if (body.trim() !== '') {
        blocks.push({ kind: 'code', text: body, lineStart: Math.min(ln + 1, j), lineEnd: Math.max(ln + 1, j), section: section() });
      }
      i = Math.min(j + 1, lines.length);
      continue;
    }

    const h = HEADING_RE.exec(raw);
    if (h?.[1] && h[2]) {
      pushHeading(h[1].length, stripMarkdown(h[2]), ln);
      i++;
      continue;
    }

    if (raw.trim().startsWith('|') && raw.includes('|', raw.indexOf('|') + 1)) {
      let j = i;
      while (j < lines.length && (lines[j] ?? '').trim().startsWith('|')) j++;
      const rows = lines.slice(i, j);
      const hasSep = rows.length > 1 && TABLE_SEP_RE.test(rows[1] ?? '');
      const header = splitTableRow(rows[0] ?? '').map(stripMarkdown);
      const tableId = ++tableCounter;
      const first = hasSep ? 2 : 1;
      blocks.push({ kind: 'table', text: (rows[0] ?? '').trim(), lineStart: ln, lineEnd: j, section: section(), header, tableId });
      for (let r = first; r < rows.length; r++) {
        const cells = splitTableRow(rows[r] ?? '');
        blocks.push({
          kind: 'table_row',
          text: (rows[r] ?? '').trim(),
          lineStart: i + r + 1,
          lineEnd: i + r + 1,
          section: section(),
          header,
          cells,
          tableId,
        });
      }
      i = j;
      continue;
    }

    if (!hasMdHeadings) {
      const level = looksLikePlainHeading(raw, lines[i - 1], lines[i + 1]);
      if (level !== null) {
        pushHeading(level, raw.trim(), ln);
        i++;
        continue;
      }
    }

    const li = LIST_RE.exec(raw);
    if (li) {
      const indent = (li[1] ?? '').length;
      let j = i + 1;
      while (j < lines.length) {
        const nx = lines[j] ?? '';
        if (nx.trim() === '' || LIST_RE.test(nx) || HEADING_RE.test(nx) || FENCE_RE.test(nx) || nx.trim().startsWith('|')) break;
        if (nx.length - nx.trimStart().length <= indent && !hasMdHeadings) break;
        j++;
      }
      blocks.push({ kind: 'list_item', text: lines.slice(i, j).join('\n').trim(), lineStart: ln, lineEnd: j, section: section() });
      i = j;
      continue;
    }

    let j = i + 1;
    while (j < lines.length) {
      const nx = lines[j] ?? '';
      if (nx.trim() === '' || HEADING_RE.test(nx) || FENCE_RE.test(nx) || LIST_RE.test(nx) || nx.trim().startsWith('|') || HR_RE.test(nx)) break;
      // In plain text an «ID. text» line starts a new requirement even without a blank line.
      if (!hasMdHeadings && DOC_ID_RE.test(nx)) break;
      j++;
    }
    blocks.push({ kind: 'paragraph', text: lines.slice(i, j).join('\n').trim(), lineStart: ln, lineEnd: j, section: section() });
    i = j;
  }
  return blocks;
}

const KIND_BY_SECTION: [RegExp, ReqKind][] = [
  [/критери\p{L}*\s+при[её]мк|acceptance/iu, 'acceptance'],
  [/нефункциональн|non-?functional|\bнфт\b/iu, 'nonfunctional'],
  [/функциональн|functional/iu, 'functional'],
  [/требования к данным|модель данных|data requirements|data model/iu, 'data'],
  [/интеграци|integration/iu, 'integration'],
  [/тестировани|testing/iu, 'testing'],
  [/ревью|согласующ|чек-?лист|approval|review/iu, 'metadata'],
  [/общие сведения|general information/iu, 'metadata'],
  [/общие параметры|general parameters/iu, 'api_meta'],
  [/логика|logic/iu, 'api_logic'],
  [/особые правила|special rules|правила/iu, 'api_rule'],
  [/параметры запроса|path-?парам|query-?парам|request body|тело запроса|заголовк|headers?/iu, 'api_param'],
  [/^\s*[1-5]\d\d\b|статус|status/iu, 'api_status'],
  [/^ответ|response/iu, 'api_response'],
  [/\bui\b|интерфейс|экран|макет/iu, 'ui'],
  [/архитектур|architecture|^схема/iu, 'architecture'],
  [/bpmn|sequence|диаграмм|процесс/iu, 'process'],
  [/^цел[иь]|goals?|назначение/iu, 'goal'],
];

export function kindFromSection(section: string[]): ReqKind | null {
  for (let d = section.length - 1; d >= 0; d--) {
    const title = section[d] ?? '';
    for (const [re, kind] of KIND_BY_SECTION) if (re.test(title)) return kind;
  }
  return null;
}

function isBlankCell(c: string): boolean {
  return c.replace(/[\s—–\-_.]/g, '') === '';
}

function isTemplateTable(rows: SegBlock[]): boolean {
  if (rows.length === 0) return false;
  let unfilled = 0;
  for (const r of rows) {
    const cells = r.cells ?? [];
    const allBlank = cells.every(isBlankCell);
    const hasChoice = cells.some((c) => UNFILLED_CHOICE_RE.test(stripMarkdown(c)));
    if (allBlank || hasChoice) unfilled++;
  }
  return unfilled / rows.length >= 0.5;
}

function summarize(text: string, max = 150): string {
  const s = stripMarkdown(text.replace(LIST_RE, '$3').replace(/\n/g, ' '));
  return s.length <= max ? s : `${s.slice(0, max - 1).trimEnd()}…`;
}

function rowSummary(b: SegBlock): string {
  const cells = (b.cells ?? []).map(stripMarkdown);
  const header = b.header ?? [];
  if (cells.length === 2) return summarize(`${cells[0]}: ${cells[1]}`);
  const parts: string[] = [];
  cells.forEach((c, k) => {
    if (c === '') return;
    const hname = header[k];
    parts.push(k === 0 || !hname ? c : `${hname}: ${c}`);
  });
  return summarize(parts.join(' · '));
}

export function detectDocId(text: string): string | undefined {
  const first = text.split('\n')[0] ?? '';
  const cleaned = first.replace(LIST_RE, '$3');
  const m = DOC_ID_RE.exec(cleaned);
  if (!m?.[1]) return undefined;
  // A bare «1.» from an ordered list is a position, not an identifier.
  if (/^\d+$/.test(m[1])) return undefined;
  return m[1];
}

/**
 * Cuts the document into units. Boundaries come from structure only (list item, paragraph,
 * table row, code block), never from a model, so the slicing is identical on every run.
 */
export function sliceRequirements(doc: SourceDoc, blocks: SegBlock[]): Requirement[] {
  const reqs: Requirement[] = [];
  const byTable = new Map<number, SegBlock[]>();
  for (const b of blocks) {
    if (b.kind === 'table_row' && b.tableId !== undefined) {
      const arr = byTable.get(b.tableId) ?? [];
      arr.push(b);
      byTable.set(b.tableId, arr);
    }
  }
  const templateTables = new Set<number>();
  for (const [id, rows] of byTable) if (isTemplateTable(rows)) templateTables.add(id);
  const emitted = new Set<number>();
  const firstH2 = blocks.find((b) => b.kind === 'heading' && (b.level ?? 1) >= 2)?.lineStart ?? 0;

  const push = (b: { text: string; section: string[]; lineStart: number; lineEnd: number }, kind: ReqKind, summary: string) => {
    const id = `R-${String(reqs.length + 1).padStart(3, '0')}`;
    const docId = kind === 'template' ? undefined : detectDocId(b.text);
    const page = doc.pageOfLine?.[b.lineStart - 1];
    reqs.push({
      id,
      ...(docId ? { docId } : {}),
      kind,
      text: b.text,
      summary,
      section: b.section,
      lineStart: b.lineStart,
      lineEnd: b.lineEnd,
      ...(page ? { page } : {}),
    });
  };

  for (const b of blocks) {
    if (b.kind === 'heading') continue;
    if (b.kind === 'table') {
      if (b.tableId !== undefined && templateTables.has(b.tableId)) {
        const rows = byTable.get(b.tableId) ?? [];
        const last = rows[rows.length - 1];
        const head = (b.header ?? []).filter((x) => x !== '').join(' | ');
        push(
          { text: doc.lines.slice(b.lineStart - 1, last?.lineEnd ?? b.lineEnd).join('\n'), section: b.section, lineStart: b.lineStart, lineEnd: last?.lineEnd ?? b.lineEnd },
          'template',
          summarize(`Незаполненная таблица (${rows.length} строк): ${head}`),
        );
        emitted.add(b.tableId);
      }
      continue;
    }
    if (b.kind === 'table_row') {
      if (b.tableId !== undefined && emitted.has(b.tableId)) continue;
      const kind = kindFromSection(b.section) ?? 'statement';
      push(b, kind, rowSummary(b));
      continue;
    }
    const plain = stripMarkdown(b.text);
    if (plain.length < 2) continue;
    let kind: ReqKind = kindFromSection(b.section) ?? 'statement';
    const wordCount = plain.split(/\s+/).length;
    if (firstH2 > 0 && b.lineStart < firstH2) kind = 'context';
    else if (b.kind === 'paragraph' && wordCount === 1 && /^(или|либо|и|or|and)$/iu.test(plain)) kind = 'context';
    push(b, kind, b.kind === 'code' ? summarize(`${b.section[b.section.length - 1] ?? 'Пример'}: ${plain}`) : summarize(b.text));
  }
  return reqs;
}

export function requirementAtLine(reqs: Requirement[], line: number): Requirement | undefined {
  return reqs.find((r) => line >= r.lineStart && line <= r.lineEnd);
}
