import { stripMarkdown } from '../segment/index.js';
import type { Finding, Question, Requirement, TestCase } from '../types.js';

export interface Range {
  min: number;
  max: number;
  unit: string;
  /** null — the document does not say whether the bounds are included. */
  inclusive: boolean | null;
  requirementIds: string[];
  quote: string;
  line: number;
}

const NUM = String.raw`\d{1,3}(?:[  ]\d{3})+|\d+`;
const RANGE_RE = new RegExp(String.raw`(?:от\s+)?(${NUM})\s*(₸|тг|тенге|тиын\p{L}*|%|мс|сек\p{L}*|символ\p{L}*)?\s*(?:до|[–—-])\s*(${NUM})\s*(₸|тг|тенге|тиын\p{L}*|%|мс|сек\p{L}*|символ\p{L}*)?`, 'giu');
const toNumber = (s: string) => Number(s.replace(/[  ]/g, ''));
const fmt = (n: number) => n.toLocaleString('ru-RU').replace(/ /g, ' ');

/** Numeric ranges that constrain an input: «от 1 000 до 1 000 000 ₸ включительно», «1 000–1 000 000». */
export function findRanges(reqs: Requirement[]): Range[] {
  const out: Range[] = [];
  const inclusiveSomewhere = reqs.some((r) => /границ\p{L}* включен|включительно|inclusive/iu.test(r.text));
  for (const r of reqs) {
    if (!['functional', 'api_param', 'api_rule', 'nonfunctional'].includes(r.kind)) continue;
    const lines = r.text.split('\n');
    lines.forEach((text, i) => {
      for (const m of text.matchAll(RANGE_RE)) {
        const min = toNumber(m[1] ?? '');
        const max = toNumber(m[3] ?? '');
        // Dates, versions and size hints like «1–64» with tiny spans are not input ranges worth four tests.
        if (!Number.isFinite(min) || !Number.isFinite(max) || max <= min || max < 100) continue;
        const hasFrom = /от\s+\d/iu.test(m[0]);
        if (!hasFrom && !/[–—-]/.test(m[0])) continue;
        const local = /включительно|включен|inclusive/iu.test(text) ? true : /не включ|исключая|exclusive/iu.test(text) ? false : inclusiveSomewhere ? true : null;
        const same = out.find((x) => x.min === min && x.max === max);
        if (same) {
          if (!same.requirementIds.includes(r.id)) same.requirementIds.push(r.id);
          if (same.inclusive === null) same.inclusive = local;
          continue;
        }
        out.push({ min, max, unit: (m[2] ?? m[4] ?? '').trim(), inclusive: local, requirementIds: [r.id], quote: stripMarkdown(m[0]).trim(), line: r.lineStart + i });
      }
    });
  }
  return out;
}

/** true when at least one acceptance criterion mentions a boundary value of the range. */
export function rangeCovered(range: Range, reqs: Requirement[]): boolean {
  const base = [range.min - 1, range.min, range.max, range.max + 1];
  // A criterion may state the same boundary in the other money unit (1 ₸ = 100 тиын).
  const values = [...base, ...base.filter((v) => v % 100 === 0).map((v) => v / 100), ...base.map((v) => v * 100)];
  const acceptance = reqs.filter((r) => r.kind === 'acceptance').map((r) => r.text.replace(/[  ]/g, ''));
  return acceptance.some((t) => values.some((v) => new RegExp(`(?<!\\d)${v}(?!\\d)`).test(t)));
}

/**
 * Test design straight from the document: boundary values for every range, a scenario for every
 * counterexample, and the acceptance criteria the document already has.
 */
export function deriveTestCases(reqs: Requirement[], findings: Finding[], questions: Question[] = []): TestCase[] {
  const cases: Omit<TestCase, 'id'>[] = [];
  const label = (id: string) => {
    const r = reqs.find((x) => x.id === id);
    return r?.docId ? `${id} («${r.docId}»)` : id;
  };

  for (const range of findRanges(reqs)) {
    const unit = range.unit ? ` ${range.unit}` : '';
    const covered = rangeCovered(range, reqs);
    const points: [number, boolean | null, string][] = [
      [range.min - 1, false, 'ниже нижней границы'],
      [range.min, range.inclusive, 'нижняя граница'],
      [range.max, range.inclusive, 'верхняя граница'],
      [range.max + 1, false, 'выше верхней границы'],
    ];
    for (const [value, accept, name] of points) {
      cases.push({
        kind: 'boundary',
        title: `Граница диапазона ${fmt(range.min)}–${fmt(range.max)}${unit}: ${name}`,
        requirementIds: range.requirementIds,
        given: [`Допустимый диапазон по документу: ${range.quote}`],
        when: [`Задать значение ${fmt(value)}${unit}`],
        then: [accept === null ? 'Ожидаемый результат не определён: документ не говорит, входят ли границы в диапазон' : accept ? 'Значение принимается' : 'Значение отклоняется'],
        coveredByAcceptance: covered,
      });
    }
  }

  for (const f of findings) {
    if (!f.counterexample || f.status === 'resolved') continue;
    const c = f.counterexample;
    cases.push({
      kind: 'counterexample',
      title: f.title,
      requirementIds: f.requirementIds,
      given: c.given,
      when: c.when,
      then: [...c.expectations.map((x) => `По ${label(x.requirementId)}: ${x.expected}`), `Ожидаемый результат противоречив: ${c.conflict}`],
      findingId: f.id,
      coveredByAcceptance: false,
    });
  }

  for (const r of reqs) {
    if (r.kind !== 'acceptance' || !r.text.trim().startsWith('|')) continue;
    const cells = r.text
      .trim()
      .replace(/^\||\|$/g, '')
      .split(/(?<!\\)\|/)
      .map((c) => stripMarkdown(c));
    const three = cells.slice(-3);
    if (three.length < 3 || three.some((c) => c === '')) continue;
    cases.push({
      kind: 'acceptance',
      title: `Критерий приёмки из документа (строка ${r.lineStart})`,
      requirementIds: [r.id],
      given: [three[0] ?? ''],
      when: [three[1] ?? ''],
      then: [three[2] ?? ''],
      coveredByAcceptance: true,
    });
  }
  // Once the author has decided, the test attached to the chosen option stops being hypothetical.
  for (const q of questions) {
    const chosen = q.answer ? q.options.find((o) => o.label === q.answer) : undefined;
    if (!chosen?.test) continue;
    const reqIds = [...new Set(q.findingIds.flatMap((id) => findings.find((f) => f.id === id)?.requirementIds ?? []))];
    cases.push({
      kind: 'decision',
      title: `По ответу на ${q.id}: ${chosen.label}`,
      requirementIds: reqIds,
      given: q.scenario ? [q.scenario] : [],
      when: [`Принято решение автора: ${chosen.label}`],
      then: [chosen.test],
      coveredByAcceptance: false,
    });
  }
  return cases.map((c, i) => ({ id: `TC-${String(i + 1).padStart(3, '0')}`, ...c }));
}

/** Gherkin with Russian keywords: opens in any BDD tool and in an IDE as is. */
export function renderFeature(documentName: string, cases: TestCase[]): string {
  const out: string[] = ['# language: ru', `# Черновик тест-кейсов, составленный агентом Dalel по документу «${documentName}».`, '# Сценарии с противоречивым или неопределённым результатом помечены @требует_решения.', '', `Функция: ${documentName}`, ''];
  const step = (keyword: string, lines: string[]) => lines.map((l, i) => `    ${i === 0 ? keyword : 'И'} ${l.replace(/\s+/g, ' ').trim()}`);
  for (const c of cases) {
    const undecided = c.kind === 'counterexample' || c.then.some((t) => t.startsWith('Ожидаемый результат не определён'));
    const tags = [`@${c.kind === 'boundary' ? 'границы' : c.kind === 'counterexample' ? 'противоречие' : c.kind === 'decision' ? 'решение_автора' : 'приёмка'}`, ...(undecided ? ['@требует_решения'] : []), ...(c.coveredByAcceptance ? [] : ['@нет_в_приёмке'])];
    out.push(`  ${tags.join(' ')}`);
    out.push(`  Сценарий: ${c.id} ${c.title.replace(/\s+/g, ' ')}`);
    out.push(...step('Дано', c.given.length > 0 ? c.given : ['исходное состояние не задано документом']));
    out.push(...step('Когда', c.when.length > 0 ? c.when : ['действие не задано документом']));
    out.push(...step('Тогда', c.then));
    out.push('');
  }
  return out.join('\n');
}
