export type DefectClass =
  | 'vague_wording'
  | 'open_ended'
  | 'placeholder'
  | 'unfilled_checklist'
  | 'missing_id'
  | 'unit_mismatch'
  | 'timezone_missing'
  | 'idempotency_missing'
  | 'refund_rules_missing'
  | 'push_text_missing'
  | 'nfr_unmeasurable'
  | 'get_changes_state'
  | 'verb_in_url'
  | 'prod_url_missing'
  | 'type_mismatch'
  | 'success_status_error_body'
  | 'undocumented_status'
  | 'sensitive_query_param'
  | 'contradiction_numeric'
  | 'contradiction_rule'
  | 'acceptance_gap'
  | 'missing_case'
  | 'non_atomic'
  | 'dangling_reference';

export interface Mutation {
  /** Mutated document text. */
  text: string;
  /** 1-based line numbers (in the mutated text) where the defect now lives. */
  lines: number[];
  /** Russian, one sentence: what was broken. */
  note: string;
}

export interface Mutator {
  id: string;
  defectClass: DefectClass;
  /** 'rules' = a deterministic rule should catch it; 'llm' = needs semantic analysis. */
  layer: 'rules' | 'llm';
  description: string;
  /** Returns null when the mutator cannot be applied to this text. Must be deterministic (no randomness, no dates). */
  apply(text: string): Mutation | null;
}

interface Section {
  heading: number;
  /** Body is the half-open range [start, end) of 0-based line indexes. */
  start: number;
  end: number;
}

const HEADING = /^(#{1,6})\s+(.*?)\s*$/;
const REQUIREMENT = /^(\s*[*-]\s+)\*\*((?:НФ|Ф|Д|И)-\d+)\.\*\*\s+(.*)$/;
const LIST_PREFIX = /^(\s*(?:[*-]|\d+\.)\s+(?:\*\*[^*]+\*\*\s+)?)?(.*)$/;
// Splits only before a capital letter, quote or code span, so «99,9 %», `eventId` and URLs stay inside one sentence.
const SENTENCE_BREAK = /(?<=[.!?])\s+(?=[А-ЯЁA-Z«`])/;
const AMOUNT = /(?<![\d.,])(\d{1,3}(?:[ \u00a0]\d{3})*)[ \u00a0]₸/g;
const STATUS_LIST = /\b[1-5]\d{2}(?:(?:, | и | или )[1-5]\d{2})+\b/g;

const TITLE = {
  goals: /^Цели/,
  functional: /^Функциональные требования/,
  sequence: /^Sequence Diagram/,
  nonFunctional: /^Нефункциональные требования/,
  data: /^Требования к данным/,
  acceptance: /^Критерии при[её]мки/,
  review: /^Ревью требований/,
  approvers: /^Блок согласующих/,
  pathParams: /^Path-параметры/,
  queryParams: /^Query-параметры/,
  requestBody: /^Request body/,
  response: /^Ответ/,
} as const;

const at = (lines: readonly string[], i: number): string => lines[i] ?? '';
const isBlank = (line: string): boolean => line.trim() === '';
const isRow = (line: string): boolean => /^\s*\|.*\|\s*$/.test(line);
const isSeparator = (line: string): boolean => /^\s*\|(?:\s*:?-{3,}:?\s*\|)+\s*$/.test(line);
const isFence = (line: string): boolean => /^\s*```/.test(line);
const cellsOf = (line: string): string[] =>
  line
    .trim()
    .slice(1, -1)
    .split('|')
    .map((cell) => cell.trim());
const rowOf = (cells: readonly string[]): string => `| ${cells.join(' | ')} |`;
const plain = (cell: string): string => cell.replace(/[*`]/g, '').trim();
const parseAmount = (raw: string): number => Number(raw.replace(/[ \u00a0]/g, ''));
const formatAmount = (value: number): string => String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');

function findSection(lines: readonly string[], title: RegExp): Section | null {
  for (let i = 0; i < lines.length; i++) {
    const match = HEADING.exec(at(lines, i));
    if (!match || !title.test(match[2] ?? '')) continue;
    const level = (match[1] ?? '').length;
    let end = lines.length;
    for (let j = i + 1; j < lines.length; j++) {
      const next = HEADING.exec(at(lines, j));
      if (next && (next[1] ?? '').length <= level) {
        end = j;
        break;
      }
    }
    return { heading: i, start: i + 1, end };
  }
  return null;
}

/** Body of a section without surrounding blank lines and horizontal rules. */
function bodyRange(lines: readonly string[], section: Section): { start: number; end: number } | null {
  const skip = (line: string): boolean => isBlank(line) || /^\s*---+\s*$/.test(line);
  let start = section.start;
  let end = section.end;
  while (start < end && skip(at(lines, start))) start++;
  while (end > start && skip(at(lines, end - 1))) end--;
  return start < end ? { start, end } : null;
}

function indexesIn(lines: readonly string[], section: Section, test: (line: string, i: number) => boolean): number[] {
  const found: number[] = [];
  for (let i = section.start; i < section.end; i++) {
    if (test(at(lines, i), i)) found.push(i);
  }
  return found;
}

/** Table rows that are neither a header nor a separator. */
function dataRows(lines: readonly string[], section: Section): number[] {
  return indexesIn(
    lines,
    section,
    (line, i) => isRow(line) && !isSeparator(line) && !isSeparator(at(lines, i + 1)),
  );
}

function requirementRows(lines: readonly string[], section: Section): number[] {
  return indexesIn(lines, section, (line) => REQUIREMENT.test(line));
}

/** Row of a two-column «Поле | Значение» table whose key matches. */
function findKeyRow(lines: readonly string[], key: RegExp): number {
  return lines.findIndex((line) => {
    if (!isRow(line) || isSeparator(line)) return false;
    const cells = cellsOf(line);
    return cells.length === 2 && key.test(plain(cells[0] ?? ''));
  });
}

function finish(original: string, lines: readonly string[], changed: readonly number[], note: string): Mutation | null {
  const text = lines.join('\n');
  if (text === original || changed.length === 0) return null;
  const last = Math.max(lines.length - 1, 0);
  const reported = [...new Set(changed.map((i) => Math.min(Math.max(i, 0), last) + 1))].sort((a, b) => a - b);
  return { text, lines: reported, note };
}

/**
 * Line-by-line rewrite: `undefined` keeps the line, `null` deletes it.
 * A deleted line is reported through its neighbours, because it has no number of its own in the mutated text.
 */
function rewrite(
  lines: readonly string[],
  fn: (line: string, i: number) => string | null | undefined,
): { lines: string[]; changed: number[] } {
  const out: string[] = [];
  const changed: number[] = [];
  lines.forEach((line, i) => {
    const next = fn(line, i);
    if (next === undefined || next === line) {
      out.push(line);
    } else if (next === null) {
      changed.push(out.length - 1, out.length);
    } else {
      changed.push(out.length);
      out.push(next);
    }
  });
  return { lines: out, changed };
}

function deleteLines(lines: string[], start: number, end: number): number[] {
  lines.splice(start, end - start);
  return [start - 1, start];
}

/** Removes the sentences that match; returns null when nothing is left of the line. */
function dropSentences(line: string, pattern: RegExp): string | null {
  const match = LIST_PREFIX.exec(line);
  const prefix = match?.[1] ?? '';
  const body = match?.[2] ?? line;
  const kept = body.split(SENTENCE_BREAK).filter((sentence) => !pattern.test(sentence));
  return kept.length === 0 ? null : prefix + kept.join(' ');
}

function setKeyValue(lines: string[], key: RegExp, value: (current: string) => string | null): number | null {
  const i = findKeyRow(lines, key);
  if (i < 0) return null;
  const cells = cellsOf(at(lines, i));
  const next = value(cells[1] ?? '');
  if (next === null) return null;
  lines[i] = rowOf([cells[0] ?? '', next]);
  return i;
}

/** The longest list of HTTP status codes in the prose of «Ответ». */
function findStatusList(lines: readonly string[]): { line: number; raw: string; codes: number[]; conjunction: string } | null {
  const section = findSection(lines, TITLE.response);
  if (!section) return null;
  let best: { line: number; raw: string; codes: number[]; conjunction: string } | null = null;
  for (let i = section.start; i < section.end; i++) {
    const line = at(lines, i);
    if (isRow(line) || isFence(line)) continue;
    for (const match of line.matchAll(STATUS_LIST)) {
      const raw = match[0];
      const codes = (raw.match(/\d{3}/g) ?? []).map(Number);
      if (best && best.codes.length >= codes.length) continue;
      best = { line: i, raw, codes, conjunction: / или /.test(raw) ? 'или' : 'и' };
    }
  }
  return best;
}

function joinCodes(codes: readonly number[], conjunction: string): string {
  if (codes.length < 2) return codes.join('');
  return `${codes.slice(0, -1).join(', ')} ${conjunction} ${codes[codes.length - 1]}`;
}

function define(
  id: string,
  defectClass: DefectClass,
  layer: Mutator['layer'],
  description: string,
  run: (lines: string[], text: string) => Mutation | null,
): Mutator {
  return { id, defectClass, layer, description, apply: (text) => run(text.split('\n'), text) };
}

export const MUTATORS: Mutator[] = [
  define(
    'M-01-vague-range',
    'vague_wording',
    'rules',
    'Числовой диапазон в функциональном требовании заменён на «в разумных пределах».',
    (lines, text) => {
      const section = findSection(lines, TITLE.functional);
      if (!section) return null;
      const range = /от \d[\d \u00a0]*₸ до \d[\d \u00a0]*₸(?: включительно)?/;
      const i = indexesIn(lines, section, (line) => REQUIREMENT.test(line) && range.test(line))[0];
      if (i === undefined) return null;
      lines[i] = at(lines, i).replace(range, 'в разумных пределах');
      return finish(text, lines, [i], 'Границы допустимой суммы заменены на «в разумных пределах».');
    },
  ),

  define(
    'M-02-vague-retry',
    'vague_wording',
    'rules',
    'Число и интервал повторных отправок заменены на «при необходимости … несколько раз».',
    (lines, text) => {
      const retry = /повторяет отправку \d+ раза? с интервалом \d+ [а-яё]+/;
      const i = lines.findIndex((line) => REQUIREMENT.test(line) && retry.test(line));
      if (i < 0) return null;
      lines[i] = at(lines, i).replace(retry, 'при необходимости повторяет отправку несколько раз');
      return finish(text, lines, [i], 'Число и интервал повторов отправки заменены расплывчатой формулировкой.');
    },
  ),

  define(
    'M-03-open-ended-list',
    'open_ended',
    'rules',
    'К закрытому перечислению в функциональном требовании добавлено «и т.д.».',
    (lines, text) => {
      const section = findSection(lines, TITLE.functional);
      if (!section) return null;
      const list = /(: [^.:]*, [^.:]* и [^.:]*)\.(\s*)$/;
      const i = indexesIn(lines, section, (line) => REQUIREMENT.test(line) && list.test(line))[0];
      if (i === undefined) return null;
      lines[i] = at(lines, i).replace(list, '$1 и т.д.$2');
      return finish(text, lines, [i], 'Закрытый перечень исключений стал открытым: добавлено «и т.д.».');
    },
  ),

  define(
    'M-04-open-ended-statuses',
    'open_ended',
    'rules',
    'Перечень неуспешных статусов в разделе «Ответ» оборван словами «и далее».',
    (lines, text) => {
      const list = findStatusList(lines);
      if (!list || list.codes.length < 3) return null;
      lines[list.line] = at(lines, list.line).replace(list.raw, `${list.codes[0]}, ${list.codes[1]} и далее`);
      return finish(text, lines, [list.line], 'Перечень статусов заменён на открытый: «и далее».');
    },
  ),

  define(
    'M-05-placeholder-goal',
    'placeholder',
    'rules',
    'Текст раздела «Цели» заменён на «Уточняется.».',
    (lines, text) => {
      const section = findSection(lines, TITLE.goals);
      const body = section && bodyRange(lines, section);
      if (!body) return null;
      lines.splice(body.start, body.end - body.start, 'Уточняется.');
      return finish(text, lines, [body.start], 'Цель задачи заменена заглушкой «Уточняется.».');
    },
  ),

  define(
    'M-06-placeholder-swagger',
    'placeholder',
    'rules',
    'Ссылка на Swagger заменена на «—».',
    (lines, text) => {
      const i = setKeyValue(lines, /^Swagger$/i, (current) => (current === '—' ? null : '—'));
      return i === null ? null : finish(text, lines, [i], 'Значение поля Swagger заменено прочерком.');
    },
  ),

  define(
    'M-07-placeholder-version',
    'placeholder',
    'rules',
    'Версия документа заменена на «TBD».',
    (lines, text) => {
      const i = setKeyValue(lines, /^Версия документа$/i, (current) => (current === 'TBD' ? null : 'TBD'));
      return i === null ? null : finish(text, lines, [i], 'Версия документа заменена на TBD.');
    },
  ),

  define(
    'M-08-placeholder-approvers',
    'placeholder',
    'rules',
    'Первая строка блока согласующих очищена.',
    (lines, text) => {
      const section = findSection(lines, TITLE.approvers);
      if (!section) return null;
      const i = dataRows(lines, section)[0];
      if (i === undefined) return null;
      const width = cellsOf(at(lines, i)).length;
      lines[i] = `|${' |'.repeat(width)}`;
      return finish(text, lines, [i], 'Строка согласующего оставлена пустой.');
    },
  ),

  define(
    'M-09-unfilled-checklist',
    'unfilled_checklist',
    'rules',
    'Отметки в строке чек-листа ревью возвращены к шаблонному «Да / Нет».',
    (lines, text) => {
      const section = findSection(lines, TITLE.review);
      if (!section) return null;
      const answer = /^(?:Да|Нет|Не требуется)$/;
      const i = dataRows(lines, section).find((row) => {
        const cells = cellsOf(at(lines, row));
        return cells.length >= 3 && answer.test(cells[1] ?? '') && answer.test(cells[2] ?? '');
      });
      if (i === undefined) return null;
      const cells = cellsOf(at(lines, i));
      cells[1] = 'Да / Нет';
      cells[2] = 'Да / Нет';
      lines[i] = rowOf(cells);
      return finish(text, lines, [i], 'В строке чек-листа ревью отметки заменены на незаполненное «Да / Нет».');
    },
  ),

  define(
    'M-10-missing-id',
    'missing_id',
    'rules',
    'У одного функционального требования удалён идентификатор.',
    (lines, text) => {
      const section = findSection(lines, TITLE.functional);
      if (!section) return null;
      const rows = requirementRows(lines, section);
      const i = rows[1] ?? rows[0];
      if (i === undefined) return null;
      const match = REQUIREMENT.exec(at(lines, i));
      if (!match) return null;
      lines[i] = `${match[1] ?? ''}${match[3] ?? ''}`;
      return finish(text, lines, [i], `У требования ${match[2] ?? ''} удалён идентификатор.`);
    },
  ),

  define(
    'M-11-unit-mismatch',
    'unit_mismatch',
    'rules',
    'В требованиях к данным одна сумма переведена из тиынов в тенге.',
    (lines, text) => {
      const section = findSection(lines, TITLE.data);
      if (!section) return null;
      const i = indexesIn(lines, section, (line) => line.includes('в тиынах'))[0];
      if (i === undefined) return null;
      lines[i] = at(lines, i).replace('в тиынах', 'в тенге');
      return finish(text, lines, [i], 'Одна сумма в требованиях к данным указана в тенге, остальные остались в тиынах.');
    },
  ),

  define(
    'M-12-timezone-missing',
    'timezone_missing',
    'rules',
    'Из документа удалены все упоминания часового пояса UTC+5 (Asia/Almaty).',
    (lines, text) => {
      // Every mention goes: a rule looks for the absence of a zone, so one surviving mention would hide the defect.
      const zone = /\s*(?:в часовом поясе\s+|по времени\s+)?(?:UTC\s?\+\s?0?5(?::00)?(?:\s*\(Asia\/Almaty\))?|Asia\/Almaty)/g;
      const result = rewrite(lines, (line) => line.replace(zone, ''));
      return finish(text, result.lines, result.changed, 'Часовой пояс расчётного периода больше не указан.');
    },
  ),

  define(
    'M-13-idempotency-missing',
    'idempotency_missing',
    'rules',
    'Удалено требование о ключе идемпотентности и повторной доставке события.',
    (lines, text) => {
      const pattern = /идемпотентн/i;
      const result = rewrite(lines, (line) => {
        if (!pattern.test(line) || isRow(line) || HEADING.test(line)) return undefined;
        return dropSentences(line, pattern);
      });
      return finish(text, result.lines, result.changed, 'Ключ идемпотентности и поведение при повторной доставке больше не описаны.');
    },
  ),

  define(
    'M-14-refund-rules-missing',
    'refund_rules_missing',
    'rules',
    'Удалено правило для частичного возврата.',
    (lines, text) => {
      const pattern = /частичн/i;
      const inline = /,\s*в том числе частичн[а-яё]*,/i;
      const result = rewrite(lines, (line) => {
        if (!pattern.test(line) || isRow(line) || HEADING.test(line)) return undefined;
        return inline.test(line) ? line.replace(inline, '') : dropSentences(line, pattern);
      });
      return finish(text, result.lines, result.changed, 'Поведение при частичном возврате больше не описано.');
    },
  ),

  define(
    'M-15-push-text-missing',
    'push_text_missing',
    'rules',
    'Удалена таблица с шаблонами текста push.',
    (lines, text) => {
      const header = lines.findIndex(
        (line, i) => isRow(line) && isSeparator(at(lines, i + 1)) && /шаблон текста/i.test(line),
      );
      if (header < 0) return null;
      let end = header;
      while (end < lines.length && isRow(at(lines, end))) end++;
      let start = header;
      let caption = header - 1;
      while (caption >= 0 && isBlank(at(lines, caption))) caption--;
      const captionLine = at(lines, caption);
      if (caption >= 0 && /^Таблица\s|тексты push/i.test(captionLine) && !REQUIREMENT.test(captionLine) && !HEADING.test(captionLine)) {
        start = caption;
      }
      if (isBlank(at(lines, start - 1)) && isBlank(at(lines, end))) end++;
      return finish(text, lines, deleteLines(lines, start, end), 'Шаблоны текста push на казахском и русском языках удалены.');
    },
  ),

  define(
    'M-16-nfr-unmeasurable',
    'nfr_unmeasurable',
    'rules',
    'Измеримый показатель времени в нефункциональном требовании заменён на «в разумное время».',
    (lines, text) => {
      const section = findSection(lines, TITLE.nonFunctional);
      if (!section) return null;
      const metric = /за время p\d+\s*≤[^.]*\./;
      const i = indexesIn(lines, section, (line) => metric.test(line))[0];
      if (i === undefined) return null;
      lines[i] = at(lines, i).replace(metric, 'в разумное время.');
      return finish(text, lines, [i], 'Перцентиль, нагрузка и окно измерения заменены на «в разумное время».');
    },
  ),

  define(
    'M-17-get-changes-state',
    'get_changes_state',
    'rules',
    'Тип метода сохранения изменён на GET при том же URL.',
    (lines, text) => {
      const i = setKeyValue(lines, /^REST type$/i, (current) => (/^(?:PUT|POST|PATCH|DELETE)$/.test(current) ? 'GET' : null));
      return i === null ? null : finish(text, lines, [i], 'Метод, изменяющий настройку, объявлен как GET.');
    },
  ),

  define(
    'M-18-verb-in-url',
    'verb_in_url',
    'rules',
    'Последний сегмент пути заменён глагольной формой.',
    (lines, text) => {
      const urlRow = findKeyRow(lines, /^Request URL$/i);
      if (urlRow < 0) return null;
      const segment = /`[^`]*\/([A-Za-z][\w-]*)`/.exec(at(lines, urlRow))?.[1];
      if (!segment || /[A-Z]/.test(segment) || /^(?:save|get|set|update|create|delete)/i.test(segment)) return null;
      const verb = `save${segment
        .split(/[-_]/)
        .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
        .join('')}`;
      const escaped = segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const tail = new RegExp(`/${escaped}(?=[\`"'\\s?]|$)`, 'g');
      const changed: number[] = [];
      for (const i of [urlRow, findKeyRow(lines, /^CURL$/i)]) {
        if (i < 0) continue;
        const renamed = at(lines, i).replace(tail, `/${verb}`);
        if (renamed === at(lines, i)) continue;
        lines[i] = renamed;
        changed.push(i);
      }
      return finish(text, lines, changed, `Ресурс «${segment}» в пути заменён на глагол «${verb}».`);
    },
  ),

  define(
    'M-19-prod-url-missing',
    'prod_url_missing',
    'rules',
    'Prod-адрес метода заменён на «—».',
    (lines, text) => {
      const i = findKeyRow(lines, /^Request URL$/i);
      const prod = /Prod:\s*`[^`]*`/;
      if (i < 0 || !prod.test(at(lines, i))) return null;
      lines[i] = at(lines, i).replace(prod, 'Prod: —');
      return finish(text, lines, [i], 'Prod-адрес метода заменён прочерком.');
    },
  ),

  define(
    'M-20-type-mismatch',
    'type_mismatch',
    'rules',
    'Тип поля в ответе изменён так, что он отличается от типа того же поля в запросе.',
    (lines, text) => {
      const body = findSection(lines, TITLE.requestBody);
      const response = findSection(lines, TITLE.response);
      if (!body || !response) return null;
      const requestTypes = new Map<string, string>();
      for (const i of dataRows(lines, body)) {
        const cells = cellsOf(at(lines, i));
        requestTypes.set(plain(cells[0] ?? ''), cells[1] ?? '');
      }
      const i = dataRows(lines, response).find((row) => {
        const cells = cellsOf(at(lines, row));
        const type = requestTypes.get(plain(cells[0] ?? ''));
        return type !== undefined && type === cells[1];
      });
      if (i === undefined) return null;
      const cells = cellsOf(at(lines, i));
      const from = cells[1] ?? '';
      const to = from === 'string' ? 'integer' : 'string';
      cells[1] = to;
      lines[i] = rowOf(cells);
      return finish(text, lines, [i], `Поле ${cells[0] ?? ''} в ответе объявлено как ${to}, в запросе оно ${from}.`);
    },
  ),

  define(
    'M-21-success-status-error-body',
    'success_status_error_body',
    'rules',
    'Под статусом 200 добавлен пример с телом ошибки.',
    (lines, text) => {
      const ok = findSection(lines, /^200\b/);
      const bad = findSection(lines, /^400\b/);
      if (!ok || !bad) return null;
      const okFences = indexesIn(lines, ok, isFence);
      const badFences = indexesIn(lines, bad, isFence);
      const okClose = okFences[1];
      const badOpen = badFences[0];
      const badClose = badFences[1];
      if (okClose === undefined || badOpen === undefined || badClose === undefined) return null;
      const errorBody = lines.slice(badOpen + 1, badClose);
      if (errorBody.length === 0) return null;
      const inserted = ['или', '```json', ...errorBody, '```'];
      lines.splice(okClose + 1, 0, ...inserted);
      const changed = inserted.map((_, offset) => okClose + 1 + offset);
      return finish(text, lines, changed, 'В примерах статуса 200 появилось тело ошибки.');
    },
  ),

  define(
    'M-22-undocumented-status',
    'undocumented_status',
    'rules',
    'В перечень статусов ответа добавлен код, который нигде не описан.',
    (lines, text) => {
      const list = findStatusList(lines);
      if (!list) return null;
      const code = [409, 422, 429, 503].find((candidate) => !new RegExp(`\\b${candidate}\\b`).test(text));
      if (code === undefined) return null;
      const codes = [...list.codes, code].sort((a, b) => a - b);
      lines[list.line] = at(lines, list.line).replace(list.raw, joinCodes(codes, list.conjunction));
      return finish(text, lines, [list.line], `Упомянут статус ${code}, для которого нет описания и примера.`);
    },
  ),

  define(
    'M-23-sensitive-query-param',
    'sensitive_query_param',
    'rules',
    'Идентификатор перенесён из path-параметров в query-параметры.',
    (lines, text) => {
      const path = findSection(lines, TITLE.pathParams);
      const query = findSection(lines, TITLE.queryParams);
      const pathBody = path && bodyRange(lines, path);
      const queryBody = query && bodyRange(lines, query);
      if (!pathBody || !queryBody || pathBody.end > queryBody.start) return null;
      const table = lines.slice(pathBody.start, pathBody.end);
      const stub = lines.slice(queryBody.start, queryBody.end);
      if (!table.some(isRow) || stub.some(isRow)) return null;
      const between = lines.slice(pathBody.end, queryBody.start);
      lines.splice(pathBody.start, queryBody.end - pathBody.start, ...stub, ...between, ...table);
      const movedStart = pathBody.start + stub.length + between.length;
      const changed = stub.map((_, offset) => pathBody.start + offset);
      table.forEach((line, offset) => {
        if (isRow(line) && !isSeparator(line) && !isSeparator(at(table, offset + 1))) changed.push(movedStart + offset);
      });
      return finish(text, lines, changed, 'Идентификатор из пути теперь передаётся в query-строке.');
    },
  ),

  define(
    'M-24-contradiction-numeric',
    'contradiction_numeric',
    'llm',
    'Ожидаемая сумма в одном критерии приёмки изменена и больше не сходится с исходными условиями.',
    (lines, text) => {
      const section = findSection(lines, TITLE.acceptance);
      if (!section) return null;
      for (const i of dataRows(lines, section)) {
        const line = at(lines, i);
        const cut = line.lastIndexOf('|', line.lastIndexOf('|') - 1);
        if (cut < 0) continue;
        const given = [...line.slice(0, cut).matchAll(AMOUNT)].map((match) => parseAmount(match[1] ?? ''));
        const derived = (value: number): boolean =>
          given.some((a, x) => given.some((b, y) => x < y && (a + b === value || Math.abs(a - b) === value)));
        const target = [...line.slice(cut).matchAll(AMOUNT)].find((match) => {
          const value = parseAmount(match[1] ?? '');
          return value > 0 && derived(value);
        });
        if (!target) continue;
        const before = parseAmount(target[1] ?? '');
        const after = before + 1000;
        lines[i] = line.slice(0, cut) + line.slice(cut).replace(target[0], `${formatAmount(after)} ₸`);
        return finish(
          text,
          lines,
          [i],
          `Ожидаемый результат изменён с ${formatAmount(before)} ₸ на ${formatAmount(after)} ₸ и противоречит исходным условиям.`,
        );
      }
      return null;
    },
  ),

  define(
    'M-25-contradiction-rule',
    'contradiction_rule',
    'llm',
    'В другой раздел добавлено предложение, которое определяет расчётный период по противоположной отметке времени.',
    (lines, text) => {
      const functional = findSection(lines, TITLE.functional);
      const sequence = findSection(lines, TITLE.sequence);
      const target = sequence && bodyRange(lines, sequence);
      if (!functional || !target) return null;
      const rule = /определя[ею]тся по времени ([^,.;]+), а не по времени ([^,.;]+)\./;
      const source = indexesIn(lines, functional, (line) => rule.test(line))[0];
      if (source === undefined) return null;
      const match = rule.exec(at(lines, source));
      const i = target.end - 1;
      if (!match || isRow(at(lines, i)) || isFence(at(lines, i))) return null;
      const added = `Период учёта операции определяется по времени ${(match[2] ?? '').trim()}, а не по времени ${(match[1] ?? '').trim()}.`;
      lines[i] = `${at(lines, i).trimEnd()} ${added}`;
      return finish(text, lines, [i], 'Добавлено правило расчёта периода, противоречащее функциональному требованию.');
    },
  ),

  define(
    'M-26-acceptance-gap',
    'acceptance_gap',
    'llm',
    'Удалён единственный критерий приёмки одного функционального требования.',
    (lines, text) => {
      const section = findSection(lines, TITLE.acceptance);
      if (!section) return null;
      const rows = dataRows(lines, section).map((i) => ({ i, ids: cellsOf(at(lines, i))[0]?.match(/Ф-\d+/g) ?? [] }));
      const usage = new Map<string, number>();
      for (const row of rows) for (const id of row.ids) usage.set(id, (usage.get(id) ?? 0) + 1);
      const single = rows.filter((row) => row.ids.length > 0 && row.ids.every((id) => usage.get(id) === 1));
      const victim = single[Math.floor(single.length / 2)];
      if (!victim) return null;
      return finish(
        text,
        lines,
        deleteLines(lines, victim.i, victim.i + 1),
        `Требование ${victim.ids.join(', ')} осталось без критерия приёмки.`,
      );
    },
  ),

  define(
    'M-27-missing-case',
    'missing_case',
    'llm',
    'Удалён случай «новое значение выше накопленной суммы» при изменении порога или лимита.',
    (lines, text) => {
      const section = findSection(lines, TITLE.functional);
      if (!section) return null;
      const above = /(?:порог|лимит)[а-яё]* выше /i;
      const i = requirementRows(lines, section)
        .filter((row) => above.test(at(lines, row)))
        .pop();
      if (i === undefined) return null;
      const id = REQUIREMENT.exec(at(lines, i))?.[2] ?? '';
      return finish(
        text,
        lines,
        deleteLines(lines, i, i + 1),
        `Удалено требование ${id}: поведение при новом значении выше накопленной суммы не описано.`,
      );
    },
  ),

  define(
    'M-28-non-atomic',
    'non_atomic',
    'rules',
    'Два нефункциональных требования склеены в одно через «а также».',
    (lines, text) => {
      const section = findSection(lines, TITLE.nonFunctional);
      if (!section) return null;
      const rows = requirementRows(lines, section);
      const second = rows[rows.length - 1];
      const first = rows[rows.length - 2];
      if (first === undefined || second === undefined) return null;
      const a = REQUIREMENT.exec(at(lines, first));
      const b = REQUIREMENT.exec(at(lines, second));
      if (!a || !b) return null;
      const tail = b[3] ?? '';
      // Acronyms and code spans keep their case when they move to the middle of a sentence.
      const lowered = /^[А-ЯЁ][а-яё]/.test(tail) ? tail.charAt(0).toLowerCase() + tail.slice(1) : tail;
      lines[first] = `${a[1] ?? ''}**${a[2] ?? ''}.** ${(a[3] ?? '').replace(/[.\s]+$/, '')}, а также ${lowered}`;
      lines.splice(second, 1);
      return finish(text, lines, [first], `Требования ${a[2] ?? ''} и ${b[2] ?? ''} объединены в одно предложение.`);
    },
  ),

  define(
    'M-29-dangling-reference',
    'dangling_reference',
    'rules',
    'В требование к данным добавлена ссылка на несуществующее приложение 7.',
    (lines, text) => {
      if (/приложени[еяю]\s+7\b/i.test(text)) return null;
      const section = findSection(lines, TITLE.data);
      if (!section) return null;
      const i = requirementRows(lines, section)[0];
      if (i === undefined) return null;
      lines[i] = at(lines, i).replace(/\.?\s*$/, ' (см. приложение 7).');
      return finish(text, lines, [i], 'Добавлена ссылка «см. приложение 7», хотя приложений в документе нет.');
    },
  ),
];

export function applyAll(text: string): { mutator: Mutator; mutation: Mutation }[] {
  const applied: { mutator: Mutator; mutation: Mutation }[] = [];
  for (const mutator of MUTATORS) {
    const mutation = mutator.apply(text);
    if (mutation) applied.push({ mutator, mutation });
  }
  return applied;
}
