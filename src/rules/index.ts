import { type SegBlock, splitTableRow, stripMarkdown } from '../segment/index.js';
import {
  CRITERION_REF,
  type Criterion,
  type Diagnostic,
  type Evidence,
  type Finding,
  type Question,
  type ReqKind,
  type Requirement,
  type Severity,
  type SourceDoc,
} from '../types.js';
import { findRanges, rangeCovered } from '../stages/testcases.js';
import { type RulePack, packApplies, termRegex } from './packs.js';

export type QuestionSeed = Pick<Question, 'addressee' | 'text' | 'why' | 'options' | 'defaultAssumption' | 'blocking' | 'risk'>;

export interface RuleFinding extends Omit<Finding, 'id' | 'status' | 'opponent' | 'rootCauseId' | 'resolution'> {
  questionSeed?: QuestionSeed;
}

export interface RuleResult {
  findings: RuleFinding[];
  diagnostics: Diagnostic[];
}

const BEHAVIOUR_KINDS: ReadonlySet<ReqKind> = new Set<ReqKind>([
  'functional',
  'nonfunctional',
  'data',
  'integration',
  'acceptance',
  'api_logic',
  'api_rule',
  'testing',
]);
const SKIP_LEXICON: ReadonlySet<ReqKind> = new Set<ReqKind>(['template', 'context']);
const SENTENCE_SPLIT = /(?<=[.!?…])\s+(?=[\p{Lu}«"(\d])/u;

function isCodeUnit(r: Requirement): boolean {
  return /^\s*[{[]/.test(r.text);
}

/** Trims list markers and table pipes from the edges only, so the result is still a verbatim substring of the line. */
function trimEdges(line: string): string {
  return line
    .replace(/^\s*(?:[*\-+•]|\d{1,3}[.)])\s+/, '')
    .replace(/^\s*\|\s*/, '')
    .replace(/\s*\|\s*$/, '')
    .trim();
}

function sentenceAt(lineText: string, index: number): string {
  const base = trimEdges(lineText);
  const offset = lineText.indexOf(base);
  const rel = Math.max(0, index - Math.max(0, offset));
  let pos = 0;
  for (const part of base.split(SENTENCE_SPLIT)) {
    const start = base.indexOf(part, pos);
    const end = start + part.length;
    if (rel >= start && rel <= end) return part.trim();
    pos = end;
  }
  return base;
}

function firstSentence(r: Requirement): string {
  const line = r.text.split('\n')[0] ?? r.text;
  const s = trimEdges(line).split(SENTENCE_SPLIT)[0] ?? trimEdges(line);
  return s.trim();
}

function ev(r: Requirement, quote: string, line?: number): Evidence {
  const ln = line ?? r.lineStart;
  return { quote, lineStart: ln, lineEnd: ln, requirementId: r.id };
}

function unitLines(doc: SourceDoc, r: Requirement): { line: number; text: string }[] {
  const out: { line: number; text: string }[] = [];
  for (let l = r.lineStart; l <= r.lineEnd; l++) out.push({ line: l, text: doc.lines[l - 1] ?? '' });
  return out;
}

function mk(
  partial: Pick<RuleFinding, 'ruleId' | 'scope' | 'criterion' | 'severity' | 'title' | 'explanation' | 'recommendation' | 'evidence'> &
    Partial<Pick<RuleFinding, 'normRef' | 'questionSeed' | 'counterexample'>>,
): RuleFinding {
  const requirementIds = [...new Set(partial.evidence.map((e) => e.requirementId).filter((x): x is string => Boolean(x)))];
  return { source: 'rule', standardRef: CRITERION_REF[partial.criterion], requirementIds, ...partial };
}

// ---------- §5.2.7 language rules ----------

const LEXICON_CRITERION: Record<string, { criterion: Criterion; ruleId: string }> = {
  vague: { criterion: 'unambiguous', ruleId: 'L-001' },
  open_ended: { criterion: 'complete', ruleId: 'L-002' },
  loophole: { criterion: 'unambiguous', ruleId: 'L-003' },
  superlative: { criterion: 'verifiable', ruleId: 'L-004' },
  unbounded_time: { criterion: 'verifiable', ruleId: 'L-005' },
  absolute: { criterion: 'verifiable', ruleId: 'L-006' },
  placeholder: { criterion: 'complete', ruleId: 'T-001' },
};

function lexiconRules(doc: SourceDoc, reqs: Requirement[], packs: RulePack[], claimed: Set<string>): RuleFinding[] {
  const out: RuleFinding[] = [];
  for (const pack of packs) {
    for (const [cat, def] of Object.entries(pack.lexicon ?? {})) {
      const meta = LEXICON_CRITERION[cat];
      if (!meta) continue;
      const regs = def.terms.map(termRegex);
      for (const r of reqs) {
        if (SKIP_LEXICON.has(r.kind) || isCodeUnit(r)) continue;
        if (cat !== 'placeholder' && r.kind === 'metadata') continue;
        if (cat === 'placeholder' && claimed.has(r.id)) continue;
        const hits: { word: string; line: number; quote: string }[] = [];
        for (const { line, text } of unitLines(doc, r)) {
          for (const re of regs) {
            re.lastIndex = 0;
            let m: RegExpExecArray | null;
            while ((m = re.exec(text)) !== null) {
              hits.push({ word: m[0], line, quote: sentenceAt(text, m.index) });
              if (m[0].length === 0) re.lastIndex++;
            }
          }
        }
        if (hits.length === 0) continue;
        const words = [...new Set(hits.map((h) => `«${h.word}»`))];
        const quotes = new Map<string, number>();
        for (const h of hits) if (!quotes.has(h.quote)) quotes.set(h.quote, h.line);
        const behavioural = BEHAVIOUR_KINDS.has(r.kind) || (cat === 'unbounded_time' && r.kind === 'goal');
        const severity: Severity = cat === 'superlative' || cat === 'absolute' ? 'minor' : behavioural && r.kind !== 'goal' ? 'major' : 'minor';
        out.push(
          mk({
            ruleId: meta.ruleId,
            scope: 'requirement',
            criterion: meta.criterion,
            severity,
            title: `${def.title}: ${words.join(', ')}`,
            explanation:
              cat === 'placeholder'
                ? 'Содержимое не заполнено: по этому месту документа нельзя ни разработать, ни проверить поведение.'
                : `Формулировка ${words.join(', ')} допускает разные прочтения; исполнитель и тестировщик не смогут одинаково определить, выполнено ли требование (ISO/IEC/IEEE 29148:2018 §5.2.7).`,
            recommendation: def.hint,
            evidence: [...quotes.entries()].slice(0, 3).map(([quote, line]) => ev(r, quote, line)),
          }),
        );
      }
    }
  }
  return out;
}

// ---------- template and structure ----------

function templateRules(doc: SourceDoc, reqs: Requirement[], claimed: Set<string>): RuleFinding[] {
  const out: RuleFinding[] = [];
  for (const r of reqs) {
    if (r.kind !== 'template') continue;
    const header = trimEdges(doc.lines[r.lineStart - 1] ?? '');
    const rows = Math.max(0, r.lineEnd - r.lineStart - 1);
    const choice = /(?:Да|Yes)\s*\/\s*(?:Нет|No)/iu.test(r.text);
    const where = r.section[r.section.length - 1] ?? 'таблица';
    out.push(
      mk({
        ruleId: choice ? 'T-002' : 'T-003',
        scope: 'set',
        criterion: 'conforming',
        severity: 'major',
        title: choice ? `«${where}»: чек-лист не заполнен, ${rows} пунктов без отметки` : `«${where}»: таблица пуста`,
        explanation: choice
          ? 'Все пункты содержат варианты из шаблона вместо выбранного ответа. Ревью требований формально не проведено: неизвестно, проверены ли тестируемость, откат, безопасность и согласования.'
          : 'В таблице нет ни одной заполненной строки. Документ никем не согласован, ответственные не названы.',
        recommendation: choice ? 'Проставить по каждому пункту один ответ и примечание с обоснованием.' : 'Заполнить строки: подразделение, ответственный, отметка о согласовании.',
        evidence: [ev(r, header, r.lineStart)],
      }),
    );
    claimed.add(r.id);
  }

  // Empty value in a key–value row, or an inline «Prod: —».
  for (const r of reqs) {
    if (r.kind === 'template' || !r.text.trim().startsWith('|')) continue;
    const cells = splitTableRow(r.text).map(stripMarkdown);
    const empties: string[] = [];
    if (cells.length === 2 && /^[—–\-_]*$/.test(cells[1] ?? '')) empties.push(cells[0] ?? 'значение');
    for (const m of r.text.matchAll(/([\p{L}][\p{L} ]{1,30}?):\s*[—–]\s*(?=$|[|.,;])/gu)) empties.push((m[1] ?? '').trim());
    if (empties.length === 0) continue;
    const key = cells[0] ?? '';
    out.push(
      mk({
        ruleId: 'T-001',
        scope: 'requirement',
        criterion: 'complete',
        severity: 'minor',
        title: `Не заполнено: ${[...new Set(empties.map((e) => (e === key ? key : `${key} → ${e}`)))].join(', ')}`,
        explanation: 'Значение отсутствует. Если поле не применимо, это нужно написать явно; иначе неизвестно, забыли его или оно не нужно.',
        recommendation: 'Указать значение либо «не применимо» с причиной.',
        evidence: [ev(r, trimEdges(r.text))],
      }),
    );
    claimed.add(r.id);
  }

  for (const r of reqs) {
    if (r.kind === 'template' || !r.text.trim().startsWith('|')) continue;
    const cells = splitTableRow(r.text).map(stripMarkdown);
    if (!cells.some((c) => /^(?:да|yes)\s*\/\s*(?:нет|no)(?:\s*\/\s*(?:не требуется|n\/?a))?$/iu.test(c))) continue;
    out.push(
      mk({
        ruleId: 'T-002',
        scope: 'requirement',
        criterion: 'conforming',
        severity: 'major',
        title: `Пункт чек-листа без отметки: ${(cells[0] ?? '').slice(0, 70)}`,
        explanation: 'В строке остались варианты ответа из шаблона вместо выбранного значения: проверка по этому пункту не проведена.',
        recommendation: 'Выбрать один ответ и дать примечание с обоснованием.',
        evidence: [ev(r, trimEdges(r.text))],
      }),
    );
    claimed.add(r.id);
  }

  for (const r of reqs) {
    if (r.kind === 'template' || !r.text.trim().startsWith('|')) continue;
    const cells = splitTableRow(r.text);
    if (cells.length < 2 || !cells.every((c) => c.replace(/[\s—–\-_.]/g, '') === '')) continue;
    const where = r.section[r.section.length - 1] ?? 'таблица';
    out.push(
      mk({
        ruleId: 'T-003',
        scope: 'requirement',
        criterion: 'conforming',
        severity: 'major',
        title: `«${where}»: пустая строка таблицы`,
        explanation: 'Строка таблицы не заполнена: неизвестно, какое значение должно в ней стоять и не потеряно ли оно.',
        recommendation: 'Заполнить строку или удалить её.',
        evidence: [ev(r, r.text.trim())],
      }),
    );
    claimed.add(r.id);
  }

  const hasVersion = /(?:верси[яию]|version|ревизи[яию]|редакци[яию])\s*[:№#]?\s*v?\d/iu.test(doc.text);
  if (!hasVersion) {
    const anchor = reqs.find((r) => r.kind !== 'template' && /верси/iu.test(r.text) && /не заполнен|не зафиксирован|отсутств/iu.test(r.text));
    const fallback = reqs.find((r) => r.kind !== 'context') ?? reqs[0];
    const target = anchor ?? fallback;
    if (target) {
      out.push(
        mk({
          ruleId: 'T-004',
          scope: 'set',
          criterion: 'modifiable',
          severity: 'major',
          title: 'У документа нет версии и даты',
          explanation:
            'Нельзя сослаться на конкретную редакцию требований: разработка, тесты и приёмка могут опираться на разные тексты, а изменение требований пройдёт незамеченным.',
          recommendation: 'Добавить номер версии, дату и историю изменений; ссылаться на версию в задачах и тест-кейсах.',
          evidence: [ev(target, anchor ? firstSentence(anchor) : firstSentence(target))],
        }),
      );
      if (anchor) claimed.add(anchor.id);
    }
  }
  return out;
}

function structureRules(doc: SourceDoc, reqs: Requirement[]): RuleFinding[] {
  const out: RuleFinding[] = [];

  for (const r of reqs) {
    if (!['functional', 'nonfunctional', 'data', 'integration'].includes(r.kind)) continue;
    const body = stripMarkdown(trimEdges(r.text)).replace(/^[A-ZА-ЯЁ]{1,6}[-–.]?\d+(?:\.\d+)*\.?\s+/u, '');
    const sentences = body.split(SENTENCE_SPLIT).filter((s) => s.trim().length > 3);
    const joined = /,\s+а также\s+\p{L}+|;\s+кроме того|\s+и дополнительно\s+/iu.test(body);
    if (sentences.length < 2 && !joined) continue;
    out.push(
      mk({
        ruleId: 'L-008',
        scope: 'requirement',
        criterion: 'singular',
        severity: 'minor',
        title: sentences.length >= 2 ? `В одном пункте несколько утверждений (${sentences.length})` : 'В одном пункте объединены два требования («а также»)',
        explanation:
          'Пункт объединяет несколько самостоятельных требований под одним идентификатором. Их нельзя по отдельности принять, отклонить, покрыть тестом и оттрассировать.',
        recommendation: 'Разбить на отдельные требования с собственными идентификаторами.',
        evidence: [ev(r, firstSentence(r))],
      }),
    );
  }

  // Table rows and «…:» lead-ins inside a requirements section are parts of a requirement, not requirements of their own.
  const needIds = reqs.filter(
    (r) => ['functional', 'nonfunctional', 'data', 'integration'].includes(r.kind) && !r.docId && !isCodeUnit(r) && !r.text.trim().startsWith('|') && !/:\s*$/.test(r.text.trim()),
  );
  if (needIds.length > 0) {
    const kinds = new Set(needIds.map((r) => r.section[r.section.length - 1] ?? r.kind));
    out.push(
      mk({
        ruleId: 'T-005',
        scope: 'set',
        criterion: 'traceable',
        severity: needIds.length >= 3 ? 'major' : 'minor',
        title: `${needIds.length} требований без идентификатора`,
        explanation: `В разделах ${[...kinds].map((k) => `«${k}»`).join(', ')} требования не пронумерованы. На них нельзя сослаться из тест-кейса, критерия приёмки или задачи, поэтому покрытие не проверить.`,
        recommendation: 'Присвоить каждому требованию уникальный идентификатор и ссылаться на него в критериях приёмки.',
        evidence: needIds.slice(0, 3).map((r) => ev(r, firstSentence(r))),
      }),
    );
  }

  // References to parts of the document that do not exist.
  const headings = new Set<string>();
  for (const r of reqs) for (const h of r.section) headings.add(h.toLowerCase());
  const allHeadings = [...headings].join('\n');
  for (const r of reqs) {
    if (r.kind === 'template' || isCodeUnit(r)) continue;
    for (const { line, text } of unitLines(doc, r)) {
      for (const m of text.matchAll(/(?<![\p{L}])(приложени[еяию]|appendix|раздел[еау]?|section|таблиц[аеыу]|table)\s+(?:№\s*)?(\d+(?:\.\d+)*|[A-ZА-Я](?![\p{L}]))/giu)) {
        const word = (m[1] ?? '').toLowerCase();
        const num = m[2] ?? '';
        const stem = word.startsWith('прил') || word === 'appendix' ? '(?:приложени|appendix)' : word.startsWith('разд') || word === 'section' ? '' : '(?:таблиц|table)';
        const present = stem === '' ? new RegExp(`(?:^|\\n)\\s*${num.replace(/\./g, '\\.')}[.)\\s]`, 'u').test(allHeadings) : new RegExp(`${stem}\\p{L}*\\s+(?:№\\s*)?${num}(?![\\d.])`, 'iu').test(allHeadings);
        if (present) continue;
        out.push(
          mk({
            ruleId: 'X-001',
            scope: 'requirement',
            criterion: 'complete',
            severity: 'major',
            title: `Ссылка на отсутствующую часть документа: «${m[0]}»`,
            explanation: 'Текст отсылает к части документа, которой в нём нет. Требование нельзя прочитать целиком, а значит — ни реализовать, ни проверить.',
            recommendation: 'Добавить указанную часть в документ или заменить ссылку содержанием.',
            evidence: [ev(r, sentenceAt(text, m.index ?? 0), line)],
          }),
        );
      }
    }
  }

  // «таблица «Тексты push»», «документ «…»» — a named part must appear somewhere besides the reference itself.
  for (const r of reqs) {
    if (r.kind === 'template' || isCodeUnit(r)) continue;
    for (const { line, text } of unitLines(doc, r)) {
      for (const m of text.matchAll(/(?<![\p{L}])(таблиц\p{L}*|раздел\p{L}*|приложени\p{L}*|документ\p{L}*|справочник\p{L}*)\s+«([^»]{3,120})»/giu)) {
        const name = m[2] ?? '';
        const elsewhere = doc.lines.some((l, i) => i + 1 !== line && l.includes(name));
        if (elsewhere) continue;
        out.push(
          mk({
            ruleId: 'X-001',
            scope: 'requirement',
            criterion: 'complete',
            severity: 'major',
            title: `Ссылка на отсутствующую часть документа: ${m[1]} «${name}»`,
            explanation: 'Текст отсылает к именованной части, которой в документе нет. Требование нельзя прочитать целиком, а значит — ни реализовать, ни проверить.',
            recommendation: 'Добавить указанную часть в документ или заменить ссылку содержанием.',
            evidence: [ev(r, sentenceAt(text, m.index ?? 0), line)],
          }),
        );
      }
    }
  }

  if (!/приоритет|priority|moscow|критичност|must have|should have|важност\p{L}* требован/iu.test(doc.text)) {
    const anchor = reqs.find((r) => r.kind === 'functional') ?? reqs.find((r) => r.kind !== 'context');
    if (anchor) {
      out.push(
        mk({
          ruleId: 'T-006',
          scope: 'set',
          criterion: 'ranked',
          severity: 'minor',
          title: 'Требования не ранжированы по важности',
          explanation: 'Нет приоритетов: при нехватке времени неясно, что обязательно к выпуску, а что можно отложить.',
          recommendation: 'Указать приоритет каждого требования (например, обязательное / желательное).',
          evidence: [ev(anchor, firstSentence(anchor))],
        }),
      );
    }
  }
  return out;
}

// ---------- consistency: units ----------

function unitRules(doc: SourceDoc, reqs: Requirement[]): RuleFinding[] {
  const minor: Evidence[] = [];
  const major: Evidence[] = [];
  const storage = new Set<ReqKind>(['data', 'api_param', 'api_response', 'api_rule', 'integration']);
  for (const r of reqs) {
    if (!storage.has(r.kind) || isCodeUnit(r)) continue;
    for (const { line, text } of unitLines(doc, r)) {
      // «1 ₸ = 100 тиын» states the conversion rule; it is not a second unit.
      const cleaned = text.replace(/1\s*(?:₸|тенге|KZT)\s*=\s*100\s*тиын\p{L}*/giu, (m) => ' '.repeat(m.length));
      const t = /(?<![\p{L}])тиын\p{L}*/iu.exec(cleaned);
      if (t) minor.push(ev(r, sentenceAt(text, t.index), line));
      const m = /(?<![\p{L}])(?:в\s+тенге|(?:целое\s+)?число\s+тенге|в\s+KZT)(?![\p{L}])/iu.exec(cleaned);
      if (m) major.push(ev(r, sentenceAt(text, m.index), line));
    }
  }
  if (minor.length === 0 || major.length === 0) return [];
  const evidence = [...minor.slice(0, 1), ...major.filter((e) => e.quote !== minor[0]?.quote).slice(0, 2)];
  if (evidence.length < 2 && major[0]) evidence.push(major[0]);
  return [
    mk({
      ruleId: 'C-001',
      scope: 'set',
      criterion: 'set_consistent',
      severity: 'major',
      title: 'Суммы заданы в разных единицах: тиын и тенге',
      explanation:
        'Одни суммы хранятся или передаются в тиынах, другие — в тенге, а правило пересчёта (1 ₸ = 100 тиын) и единица сравнения не названы. Сравнение таких значений без пересчёта ошибается в 100 раз.',
      recommendation: 'Выбрать одну единицу для хранения, API и событий (целые тиыны) и указать её у каждого денежного поля.',
      evidence,
    }),
  ];
}

// ---------- API lint ----------

const REASON: Record<string, string> = {
  ok: '200',
  created: '201',
  accepted: '202',
  'no content': '204',
  'bad request': '400',
  unauthorized: '401',
  forbidden: '403',
  'not found': '404',
  conflict: '409',
  'internal server error': '500',
};
const SENSITIVE_PARAM = /card|pan\b|iin|иин|phone|msisdn|token|account|iban|passport|email|password|secret|pin\b|cvv|client|customer|user/iu;
const STATE_URL = /\/(?:[a-z]*?)(save|set|update|delete|remove|create|add|edit|change|write)[A-Z_/\w]*/;
const STATE_RU = /сохран\p{L}*|замен\p{L}*|измен\p{L}*|удал\p{L}*|созда\p{L}*|обнов\p{L}*|запис\p{L}*/iu;

interface KvRow {
  req: Requirement;
  key: string;
  value: string;
}

function apiRules(doc: SourceDoc, blocks: SegBlock[], reqs: Requirement[]): RuleFinding[] {
  const out: RuleFinding[] = [];
  const kv: KvRow[] = [];
  for (const r of reqs) {
    if (r.kind !== 'api_meta' || !r.text.trim().startsWith('|')) continue;
    const cells = splitTableRow(r.text);
    if (cells.length === 2) kv.push({ req: r, key: stripMarkdown(cells[0] ?? ''), value: (cells[1] ?? '').trim() });
  }
  const methodRows = kv.filter((k) => /^(?:rest type|http[- ]?(?:method|метод)|method|метод)$/iu.test(k.key));

  for (const methodRow of methodRows) {
    const root = methodRow.req.section.slice(0, -1);
    const inScope = (section: string[]) => root.every((s, i) => section[i] === s);
    const scope = reqs.filter((r) => inScope(r.section));
    const scopeKv = kv.filter((k) => inScope(k.req.section));
    const method = stripMarkdown(methodRow.value).toUpperCase();
    const urlRow = scopeKv.find((k) => /url|endpoint|путь/iu.test(k.key) && /\//.test(k.value));
    const descRow = scopeKv.find((k) => /description|описание/iu.test(k.key));
    const logic = scope.filter((r) => r.kind === 'api_logic' || r.kind === 'api_rule');

    if (/\bGET\b/.test(method)) {
      const proof: Evidence[] = [ev(methodRow.req, trimEdges(methodRow.req.text))];
      if (urlRow && STATE_URL.test(urlRow.value)) proof.push(ev(urlRow.req, trimEdges(urlRow.req.text)));
      if (descRow && STATE_RU.test(descRow.value)) proof.push(ev(descRow.req, trimEdges(descRow.req.text)));
      for (const r of logic) {
        if (proof.length >= 4) break;
        if (STATE_RU.test(r.text)) proof.push(ev(r, trimEdges(r.text.split('\n')[0] ?? r.text)));
      }
      if (proof.length > 1) {
        out.push(
          mk({
            ruleId: 'A-001',
            scope: 'set',
            criterion: 'correct',
            severity: 'critical',
            normRef: 'RFC 9110 §9.2.1 (безопасные методы)',
            title: 'Метод GET изменяет состояние',
            explanation:
              'GET по стандарту HTTP не должен менять данные. Такой запрос могут повторить без ведома клиента браузер, прокси, предзагрузка ссылок и повтор при сбое сети; ответ может быть взят из кэша, а параметры попадают в журналы и историю. Настройка клиента изменится или не изменится непредсказуемо.',
            recommendation: 'Назначить для изменения метод PUT или POST с телом запроса; чтение настройки описать отдельным GET.',
            evidence: proof,
          }),
        );
      }
    }

    if (urlRow) {
      const verb = /\/(get|save|set|update|delete|create|add|remove|fetch|do)[A-Z]\w*/.exec(urlRow.value);
      if (verb) {
        out.push(
          mk({
            ruleId: 'A-002',
            scope: 'requirement',
            criterion: 'conforming',
            severity: 'minor',
            title: `Глагол в пути метода: ${verb[0]}`,
            explanation: 'Действие закодировано в адресе, а не в HTTP-методе. Один и тот же ресурс получает разные адреса для чтения и записи, что мешает описать API единообразно.',
            recommendation: 'Именовать путь по ресурсу, а действие выражать HTTP-методом.',
            evidence: [ev(urlRow.req, trimEdges(urlRow.req.text))],
          }),
        );
      }
    }

    const ct = scope.find((r) => /content-type/iu.test(r.text) && !r.text.trim().startsWith('|'));
    const noBody = scope.find((r) => /тело не используется|без тела|тело отсутствует|no (?:request )?body/iu.test(r.text));
    if (ct && noBody && ct.id !== noBody.id && ct.section.join('/') === noBody.section.join('/')) {
      out.push(
        mk({
          ruleId: 'A-004',
          scope: 'set',
          criterion: 'set_consistent',
          severity: 'minor',
          title: 'Указан Content-Type, хотя тело запроса не используется',
          explanation: 'Тип содержимого описывает тело запроса. Если тела нет, заголовок лишний; если тело есть, оно не описано.',
          recommendation: 'Либо описать тело запроса, либо убрать Content-Type.',
          evidence: [ev(ct, trimEdges(ct.text)), ev(noBody, trimEdges(noBody.text))],
        }),
      );
    }

    const paramRows = (kind: ReqKind) =>
      scope
        .filter((r) => r.kind === kind && r.text.trim().startsWith('|'))
        .map((r) => {
          const block = blocks.find((b) => b.kind === 'table_row' && b.lineStart === r.lineStart);
          const cells = (block?.cells ?? splitTableRow(r.text)).map(stripMarkdown);
          const header = (block?.header ?? []).map((h) => h.toLowerCase());
          const col = (name: RegExp) => {
            const idx = header.findIndex((h) => name.test(h));
            return idx >= 0 ? (cells[idx] ?? '') : '';
          };
          return { req: r, block, name: cells[0] ?? '', format: col(/format|формат|тип/), logic: col(/logic|логика/) };
        })
        .filter((p) => p.name !== '' && p.format !== '');
    const requestParams = paramRows('api_param');
    const responseParams = paramRows('api_response');

    const mismatches: Evidence[] = [];
    const names: string[] = [];
    for (const rq of requestParams) {
      const rs = responseParams.find((x) => x.name === rq.name);
      if (!rs || rs.format.toLowerCase() === rq.format.toLowerCase()) continue;
      names.push(`${rq.name}: ${rq.format} в запросе, ${rs.format} в ответе`);
      mismatches.push(ev(rq.req, trimEdges(rq.req.text)), ev(rs.req, trimEdges(rs.req.text)));
    }
    if (mismatches.length > 0) {
      out.push(
        mk({
          ruleId: 'A-005',
          scope: 'set',
          criterion: 'set_consistent',
          severity: 'major',
          title: `Тип одного поля различается в запросе и ответе (${names.length})`,
          explanation: `${names.join('; ')}. Клиенту придётся преобразовывать значение, которое он сам только что отправил; сравнение «отправлено = сохранено» в тестах потребует приведения типов, а ошибка преобразования останется незамеченной.`,
          recommendation: 'Задать один тип для поля во всех сообщениях.',
          evidence: mismatches.slice(0, 4),
        }),
      );
    }

    for (const r of scope) {
      if (r.kind !== 'api_param' || !/query/iu.test(r.section[r.section.length - 1] ?? '')) continue;
      const p = requestParams.find((x) => x.req.id === r.id);
      if (!p || !SENSITIVE_PARAM.test(p.name)) continue;
      out.push(
        mk({
          ruleId: 'A-010',
          scope: 'requirement',
          criterion: 'correct',
          severity: 'major',
          normRef: 'RFC 9110 §17.9 (раскрытие сведений в URI)',
          title: `Идентификатор «${p.name}» передаётся в строке запроса`,
          explanation:
            'Параметры строки запроса сохраняются в журналах веб-серверов и прокси, в истории и в заголовке Referer. Идентификатор, связанный с картой или клиентом, окажется в системах, которые не предназначены для таких данных.',
          recommendation: 'Передавать идентификатор в пути защищённого ресурса или в теле запроса и исключить его из журналов.',
          evidence: [ev(r, trimEdges(r.text))],
        }),
      );
    }

    // Status sections
    const statusHeadings = blocks.filter((b) => b.kind === 'heading' && inScope(b.section) && /^\s*[1-5]\d\d\b/.test(b.text));
    for (const h of statusHeadings) {
      const code = /^\s*([1-5]\d\d)/.exec(h.text)?.[1] ?? '';
      const lower = h.text.toLowerCase();
      for (const [phrase, owner] of Object.entries(REASON)) {
        if (owner === code) continue;
        if (!new RegExp(`(?<![a-z])${phrase}(?![a-z])`).test(lower)) continue;
        const holder = reqs.find((r) => r.section.includes(h.text));
        if (!holder) continue;
        out.push(
          mk({
            ruleId: 'A-007',
            scope: 'requirement',
            criterion: 'correct',
            severity: 'minor',
            normRef: 'RFC 9110 §15 (коды состояния)',
            title: `Статус ${code} подписан как «${phrase}» — это название статуса ${owner}`,
            explanation: `Код и его название не совпадают. Неясно, какой статус должен вернуть сервер: ${code} или ${owner}.`,
            recommendation: 'Привести код и название в соответствие и описать оба статуса, если нужны оба.',
            evidence: [{ quote: h.text, lineStart: h.lineStart, lineEnd: h.lineEnd, requirementId: holder.id }],
          }),
        );
      }
    }

    const statusUnits = scope.filter((r) => r.kind === 'api_status');
    for (const r of statusUnits) {
      if (isCodeUnit(r)) continue;
      const own = /^\s*([1-5]\d\d)\b/.exec(r.section[r.section.length - 1] ?? '')?.[1];
      if (!own) continue;
      const other = /возвраща\p{L}+\s+([1-5]\d\d)\b/iu.exec(r.text)?.[1];
      if (other && other !== own) {
        out.push(
          mk({
            ruleId: 'A-007',
            scope: 'set',
            criterion: 'set_consistent',
            severity: 'major',
            normRef: 'RFC 9110 §15.5.4 и §15.5.5',
            title: `В разделе статуса ${own} описан ответ ${other}`,
            explanation: `Раздел называется по коду ${own}, но текст говорит, что возвращается ${other}. Остаётся неизвестным, существует ли ответ ${own} вообще и в каком случае он возвращается.`,
            recommendation: `Решить, какой код возвращается в этом случае, и описать ${own} и ${other} отдельными разделами.`,
            evidence: [ev(r, sentenceAt(doc.lines[r.lineStart - 1] ?? r.text, 0))],
          }),
        );
      }
    }

    const described = new Set<string>();
    for (const h of statusHeadings) described.add(/^\s*([1-5]\d\d)/.exec(h.text)?.[1] ?? '');
    const mentions = new Map<string, Evidence>();
    for (const r of scope) {
      if (!['api_status', 'api_response', 'api_logic', 'api_rule'].includes(r.kind) || isCodeUnit(r) || r.text.trim().startsWith('|')) continue;
      const needsKeyword = r.kind === 'api_logic' || r.kind === 'api_rule';
      for (const { line, text } of unitLines(doc, r)) {
        for (const m of text.matchAll(/(?<![\d\p{L}])([1-5]\d\d)(?![\d\p{L}])/gu)) {
          const code = m[1] ?? '';
          const at = m.index ?? 0;
          const before = text.slice(0, at);
          const after = text.slice(at + code.length);
          // Thousands groups («1 000 000»), decimals and quantities are numbers, not status codes.
          if (/\d[\s\u00a0.,]?$/.test(before) && !/\d{3},\s$/.test(before)) continue;
          if (/^[\s\u00a0]?\d{3}(?!\d)|^[.,]\d|^\s?(?:₸|%|мс|с\b|сек|мин|запрос|событи|раз\b|знак|бит|bit|тиын|тенге|символ|кб|мб)/iu.test(after)) continue;
          if (needsKeyword && !/статус|код|http|возвраща|ответ|результат/iu.test(sentenceAt(text, at))) continue;
          if (/\*\*\s*$/.test(before) && /^\s*\.?\*\*\.?\s+\p{Lu}/u.test(after)) described.add(code);
          if (!mentions.has(code)) mentions.set(code, ev(r, sentenceAt(text, at), line));
        }
      }
    }
    const undescribed = [...mentions.keys()].filter((c) => !described.has(c)).sort();
    if (undescribed.length > 0) {
      out.push(
        mk({
          ruleId: 'A-009',
          scope: 'set',
          criterion: 'set_complete',
          severity: 'major',
          title: `Статусы ${undescribed.join(', ')} упомянуты, но не описаны`,
          explanation: 'Код встречается в тексте, но для него нет ни условия возврата, ни примера ответа. Разработчик и тестировщик не знают, когда его ждать и что в теле.',
          recommendation: 'Для каждого упомянутого кода дать условие возврата и пример тела, либо убрать упоминание.',
          evidence: undescribed.map((c) => mentions.get(c)).filter((e): e is Evidence => Boolean(e)).slice(0, 3),
        }),
      );
    }

    const keysOf = (r: Requirement): string | null => {
      try {
        const body: unknown = JSON.parse(r.text);
        return typeof body === 'object' && body !== null && !Array.isArray(body) ? Object.keys(body).sort().join(',') : null;
      } catch {
        return null;
      }
    };
    const statusOf = (r: Requirement) => /^\s*([1-5])\d\d\b/.exec(r.section[r.section.length - 1] ?? '')?.[1];
    const errorShapes = new Set(statusUnits.filter((r) => isCodeUnit(r) && ['4', '5'].includes(statusOf(r) ?? '')).map(keysOf).filter((k): k is string => k !== null && k !== ''));
    const errorInSuccess: Evidence[] = [];
    for (const r of statusUnits) {
      if (!isCodeUnit(r) || statusOf(r) !== '2') continue;
      const shape = keysOf(r);
      const looksLikeError = shape !== null && errorShapes.has(shape);
      for (const { line, text } of unitLines(doc, r)) {
        if (looksLikeError || /"(?:result|status)"\s*:\s*"(?:ERROR|FAIL\w*|error)"|"error"\s*:|"code"\s*:\s*"[A-Z_]*ERROR/.test(text)) {
          errorInSuccess.push(ev(r, text.trim(), line));
          break;
        }
      }
    }
    if (errorInSuccess.length > 0) {
      const rule = scope.find((r) => !isCodeUnit(r) && /\b400\b/.test(r.text) && /неверн|некорректн|ошиб|invalid/iu.test(r.text));
      const proof = [...errorInSuccess.slice(0, 1)];
      if (rule) {
        const hit = unitLines(doc, rule).find((l) => /\b400\b/.test(l.text));
        if (hit) proof.push(ev(rule, sentenceAt(hit.text, hit.text.indexOf('400')), hit.line));
      }
      out.push(
        mk({
          ruleId: 'A-006',
          scope: 'set',
          criterion: 'set_consistent',
          severity: 'critical',
          title: 'Успешный статус содержит тело ошибки',
          explanation:
            'Под успешным кодом приведён ответ с результатом ERROR, хотя для неверных параметров документ назначает код ошибки. Клиент, который судит об успехе по коду, покажет «сохранено» при отклонённой операции; тестировщик не может назвать ожидаемый код для неверной суммы.',
          recommendation: 'Выбрать одно правило: ошибка проверки параметров возвращается с кодом 4xx, под 2xx остаются только успешные тела.',
          evidence: proof,
        }),
      );
    }

    const unconditional = responseParams.filter((p) => !/при\s+(?:успех|ошибк)|on (?:success|error)/iu.test(p.logic));
    const missing = new Map<string, Evidence[]>();
    for (const r of statusUnits) {
      if (!isCodeUnit(r)) continue;
      let body: unknown;
      try {
        body = JSON.parse(r.text);
      } catch {
        continue;
      }
      if (typeof body !== 'object' || body === null || Array.isArray(body)) continue;
      for (const p of unconditional) {
        if (p.name in body) continue;
        const arr = missing.get(p.name) ?? [];
        arr.push(ev(r, (doc.lines[r.lineStart - 1] ?? r.text).trim(), r.lineStart));
        missing.set(p.name, arr);
      }
    }
    // A field absent from every body is optional in practice; the defect is a field present in some bodies only.
    const jsonBodies = statusUnits.filter(isCodeUnit).length;
    const partial = [...missing.entries()].filter(([, where]) => where.length !== jsonBodies);
    if (partial.length > 0) {
      const fieldNames = partial.map(([name]) => `«${name}»`).join(', ');
      const proof: Evidence[] = [];
      for (const [name, where] of partial) {
        const row = unconditional.find((p) => p.name === name);
        if (row && proof.length < 2) proof.push(ev(row.req, trimEdges(row.req.text)));
        for (const w of where) if (proof.length < 4 && !proof.some((e) => e.lineStart === w.lineStart)) proof.push(w);
      }
      out.push(
        mk({
          ruleId: 'A-008',
          scope: 'set',
          criterion: 'set_consistent',
          severity: 'major',
          title: `Примеры ответов не соответствуют таблице полей: ${fieldNames}`,
          explanation: `Таблица ответа описывает ${fieldNames} без условия присутствия, но часть примеров этих полей не содержит. У ответов нет единой модели: клиент не может разобрать ответ одним способом, а тестировщик — проверить схему.`,
          recommendation: 'Задать одну модель ответа и ошибки для всех кодов и указать для каждого поля, когда оно присутствует.',
          evidence: proof,
        }),
      );
    }
  }
  return out;
}

// ---------- injection ----------

function injectionRules(doc: SourceDoc, reqs: Requirement[], packs: RulePack[]): RuleResult {
  const regs = packs.flatMap((p) => p.injection ?? []).map(termRegex);
  const hits: Evidence[] = [];
  doc.lines.forEach((text, i) => {
    const hidden = /<!--[\s\S]*?-->|[​-‏⁠﻿]/.test(text);
    const matched = regs.some((re) => {
      re.lastIndex = 0;
      return re.test(text);
    });
    if (!hidden && !matched) return;
    const quote = text.trim().slice(0, 240);
    if (quote === '') return;
    const owner = reqs.find((r) => i + 1 >= r.lineStart && i + 1 <= r.lineEnd);
    hits.push({ quote, lineStart: i + 1, lineEnd: i + 1, ...(owner ? { requirementId: owner.id } : {}) });
  });
  if (hits.length === 0) return { findings: [], diagnostics: [] };
  return {
    findings: [
      mk({
        ruleId: 'S-001',
        scope: 'set',
        criterion: 'correct',
        severity: 'major',
        title: 'В документе есть текст, похожий на инструкцию для проверяющей модели, или скрытое содержимое',
        explanation:
          'Фрагмент адресован не читателю требований, а средству автоматической проверки, либо скрыт от глаз. Агент обрабатывает документ только как данные и такие указания не выполняет, но автору стоит объяснить происхождение фрагмента.',
        recommendation: 'Удалить фрагмент или объяснить его назначение.',
        evidence: hits.slice(0, 3),
      }),
    ],
    diagnostics: [
      {
        level: 'warning',
        code: 'suspicious_instruction',
        message: `В документе найдено ${hits.length} фрагм. с признаками инструкции для модели или скрытого текста (строки ${hits.map((h) => h.lineStart).join(', ')}).`,
        hint: 'Указания из документа не исполняются; фрагменты показаны в находке S-001.',
      },
    ],
  };
}

// ---------- domain omissions ----------

function omissionRules(doc: SourceDoc, reqs: Requirement[], packs: RulePack[]): RuleFinding[] {
  const out: RuleFinding[] = [];
  const live = reqs.filter((r) => r.kind !== 'template');
  const liveText = live.map((r) => r.text).join('\n');
  for (const pack of packs) {
    if (!packApplies(pack, doc.text)) continue;
    for (const rule of pack.omissions ?? []) {
      if (rule.unless.some((u) => termRegex(u).test(liveText))) continue;
      let anchor: Evidence | undefined;
      if (rule.when.length > 0) {
        const ordered = [...live.filter((r) => BEHAVIOUR_KINDS.has(r.kind)), ...live.filter((r) => !BEHAVIOUR_KINDS.has(r.kind) && r.kind !== 'context' && r.kind !== 'metadata')];
        outer: for (const w of rule.when) {
          for (const r of ordered) {
            if (isCodeUnit(r)) continue;
            for (const { line, text } of unitLines(doc, r)) {
              const m = termRegex(w).exec(text);
              if (m) {
                anchor = ev(r, sentenceAt(text, m.index), line);
                break outer;
              }
            }
          }
        }
        if (!anchor) continue;
      } else {
        const target = (rule.anchor ? live.find((r) => r.kind === rule.anchor) : undefined) ?? live.find((r) => r.kind === 'goal') ?? live.find((r) => r.kind !== 'context' && r.kind !== 'metadata');
        if (!target) continue;
        anchor = ev(target, firstSentence(target));
      }
      out.push(
        mk({
          ruleId: rule.id,
          scope: 'set',
          criterion: 'set_complete',
          severity: rule.severity,
          ...(rule.norm ? { normRef: rule.norm } : {}),
          title: rule.title,
          explanation: rule.explanation,
          recommendation: `Дописать в документ ответ на вопрос: ${rule.question}`,
          evidence: [anchor],
          questionSeed: {
            addressee: rule.addressee,
            text: rule.question,
            why: rule.explanation,
            options: rule.options,
            defaultAssumption: rule.default,
            blocking: rule.severity !== 'minor' && rule.risk.level === 'high',
            risk: { level: rule.risk.level, kind: rule.risk.kind, note: rule.title },
          },
        }),
      );
    }
  }
  return out;
}

// ---------- test design: boundary values ----------

function boundaryRules(doc: SourceDoc, reqs: Requirement[]): RuleFinding[] {
  const out: RuleFinding[] = [];
  if (!reqs.some((r) => r.kind === 'acceptance')) return out;
  for (const range of findRanges(reqs)) {
    if (rangeCovered(range, reqs)) continue;
    const owner = reqs.find((r) => r.id === range.requirementIds[0]);
    if (!owner) continue;
    const lineText = doc.lines[range.line - 1] ?? owner.text;
    const m = /\d/.exec(lineText);
    const fmt = (n: number) => n.toLocaleString('ru-RU').replace(/\u00a0/g, ' ');
    out.push(
      mk({
        ruleId: 'V-001',
        scope: 'set',
        criterion: 'set_validatable',
        severity: 'major',
        title: `Границы диапазона ${fmt(range.min)}–${fmt(range.max)} не проверяет ни один критерий приёмки`,
        explanation: `Диапазон задаёт четыре проверки: ${fmt(range.min - 1)}, ${fmt(range.min)}, ${fmt(range.max)} и ${fmt(range.max + 1)}. Ошибки на границах — самые частые, а в критериях приёмки нет ни одного из этих значений${range.inclusive === null ? '; к тому же документ не говорит, входят ли границы в диапазон' : ''}.`,
        recommendation: 'Добавить критерии приёмки на обе границы и на значения сразу за ними (см. черновик тест-кейсов в отчёте).',
        evidence: [{ quote: sentenceAt(lineText, m?.index ?? 0), lineStart: range.line, lineEnd: range.line, requirementId: owner.id }],
      }),
    );
  }
  return out;
}

/** Deterministic layer: runs without any model and always gives the same result for the same text. */
export function runRules(doc: SourceDoc, blocks: SegBlock[], reqs: Requirement[], packs: RulePack[]): RuleResult {
  const claimed = new Set<string>();
  const findings: RuleFinding[] = [];
  findings.push(...templateRules(doc, reqs, claimed));
  findings.push(...lexiconRules(doc, reqs, packs, claimed));
  findings.push(...structureRules(doc, reqs));
  findings.push(...unitRules(doc, reqs));
  findings.push(...apiRules(doc, blocks, reqs));
  findings.push(...boundaryRules(doc, reqs));
  const inj = injectionRules(doc, reqs, packs);
  findings.push(...inj.findings);
  findings.push(...omissionRules(doc, reqs, packs));
  return { findings: findings.filter((f) => f.evidence.length > 0), diagnostics: inj.diagnostics };
}
