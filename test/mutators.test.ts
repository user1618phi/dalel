import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { MUTATORS, applyAll, type DefectClass, type Mutation } from '../src/eval/mutators.js';

const SPEC_NAMES = ['clean-card-alert.md', 'clean-phone-transfer.md'] as const;

// Record keeps this list exhaustive: a new DefectClass without an entry fails the type check.
const DEFECT_CLASSES: Record<DefectClass, true> = {
  vague_wording: true,
  open_ended: true,
  placeholder: true,
  unfilled_checklist: true,
  missing_id: true,
  unit_mismatch: true,
  timezone_missing: true,
  idempotency_missing: true,
  refund_rules_missing: true,
  push_text_missing: true,
  nfr_unmeasurable: true,
  get_changes_state: true,
  verb_in_url: true,
  prod_url_missing: true,
  type_mismatch: true,
  success_status_error_body: true,
  undocumented_status: true,
  sensitive_query_param: true,
  contradiction_numeric: true,
  contradiction_rule: true,
  acceptance_gap: true,
  missing_case: true,
  non_atomic: true,
  dangling_reference: true,
};

const FORBIDDEN_IN_CLEAN: [string, RegExp][] = [
  ['расплывчатые слова', /быстро|удобн|при необходимости|по возможности|как правило|оптимальн|в разумн/i],
  ['открытые перечни', /и т\.\s?д\.|и т\.\s?п\.|и другие|и далее/i],
  ['заглушки', /\bTBD\b|уточняется|заполняются/i],
  ['прочерк вместо значения', /\|\s*—\s*\||:\s*—\s*(?:\||$)/m],
  ['пустые ячейки', /\|\s*\|/],
  ['незаполненный чек-лист', /Да \/ Нет/],
  ['глагол в пути', /\/(?:save|get|set|update|create|delete)[A-Z]/],
];

function readSpec(name: string): string {
  return readFileSync(fileURLToPath(new URL(`../eval/specs/${name}`, import.meta.url)), 'utf8');
}

function mutationOf(id: string, text: string): Mutation {
  const mutator = MUTATORS.find((candidate) => candidate.id === id);
  if (!mutator) throw new Error(`unknown mutator ${id}`);
  const mutation = mutator.apply(text);
  if (!mutation) throw new Error(`${id} did not apply`);
  return mutation;
}

/**
 * 1-based numbers of mutated lines that a line diff attributes to the change:
 * lines absent from the longest common subsequence, plus both neighbours of every deletion point.
 */
function touchedLines(original: string[], mutated: string[]): Set<number> {
  const n = original.length;
  const m = mutated.length;
  const width = m + 1;
  const table = new Uint16Array((n + 1) * width);
  const cell = (i: number, j: number): number => table[i * width + j] ?? 0;
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      table[i * width + j] =
        original[i] === mutated[j] ? cell(i + 1, j + 1) + 1 : Math.max(cell(i + 1, j), cell(i, j + 1));
    }
  }
  const touched = new Set<number>();
  const aroundDeletion = (j: number): void => {
    if (j >= 1) touched.add(j);
    if (j + 1 <= m) touched.add(j + 1);
  };
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (original[i] === mutated[j]) {
      i++;
      j++;
    } else if (cell(i + 1, j) >= cell(i, j + 1)) {
      aroundDeletion(j);
      i++;
    } else {
      touched.add(j + 1);
      j++;
    }
  }
  if (i < n) aroundDeletion(j);
  for (; j < m; j++) touched.add(j + 1);
  return touched;
}

describe('mutator registry', () => {
  it('has unique ids', () => {
    const ids = MUTATORS.map((mutator) => mutator.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('covers every defect class', () => {
    const covered = new Set(MUTATORS.map((mutator) => mutator.defectClass));
    const missing = Object.keys(DEFECT_CLASSES).filter((name) => !covered.has(name as DefectClass));
    expect(missing).toEqual([]);
  });

  it('describes every mutator and assigns a known layer', () => {
    for (const mutator of MUTATORS) {
      expect(mutator.id).toMatch(/^M-\d{2}-[a-z-]+$/);
      expect(mutator.description.trim().length).toBeGreaterThan(10);
      expect(['rules', 'llm']).toContain(mutator.layer);
    }
  });

  it('returns null when the document has no anchors', () => {
    for (const text of ['', '# Заголовок\n\nПроизвольный текст без разделов шаблона.\n']) {
      expect(applyAll(text)).toEqual([]);
    }
  });
});

describe.each(SPEC_NAMES)('%s', (name) => {
  const text = readSpec(name);
  const originalLines = text.split('\n');
  const applied = applyAll(text);

  it('exists and has at least 100 lines', () => {
    expect(originalLines.length).toBeGreaterThanOrEqual(100);
  });

  it.each(FORBIDDEN_IN_CLEAN)('is free of defects: %s', (_label, pattern) => {
    const hits = originalLines.filter((line) => pattern.test(line));
    expect(hits).toEqual([]);
  });

  it('accepts at least 20 mutators', () => {
    expect(applied.length).toBeGreaterThanOrEqual(20);
  });

  it('accepts a mutator of every defect class', () => {
    const covered = new Set(applied.map(({ mutator }) => mutator.defectClass));
    const missing = Object.keys(DEFECT_CLASSES).filter((defect) => !covered.has(defect as DefectClass));
    expect(missing).toEqual([]);
  });

  it('is mutated deterministically', () => {
    for (const mutator of MUTATORS) {
      expect(mutator.apply(text)).toEqual(mutator.apply(text));
    }
  });

  it.each(applied.map(({ mutator, mutation }) => [mutator.id, mutation] as const))(
    '%s changes the text and reports the lines it touched',
    (_id, mutation) => {
      expect(mutation.text).not.toBe(text);
      expect(mutation.note.trim().length).toBeGreaterThan(10);

      const mutatedLines = mutation.text.split('\n');
      expect(mutation.lines.length).toBeGreaterThan(0);
      expect(new Set(mutation.lines).size).toBe(mutation.lines.length);
      for (const line of mutation.lines) {
        expect(Number.isInteger(line)).toBe(true);
        expect(line).toBeGreaterThanOrEqual(1);
        expect(line).toBeLessThanOrEqual(mutatedLines.length);
      }

      // With an unchanged line count the numbers are stable, so a reported line must differ in place;
      // a diff is ambiguous there for a block that moved. Otherwise the diff decides.
      const touched = touchedLines(originalLines, mutatedLines);
      const unchanged =
        mutatedLines.length === originalLines.length
          ? mutation.lines.filter((line) => mutatedLines[line - 1] === originalLines[line - 1])
          : mutation.lines.filter((line) => !touched.has(line));
      expect(unchanged).toEqual([]);
    },
  );

  it('introduces exactly the defect each mutator names', () => {
    const lineOf = (id: string): string => {
      const mutation = mutationOf(id, text);
      return mutation.lines.map((line) => mutation.text.split('\n')[line - 1] ?? '').join('\n');
    };

    expect(lineOf('M-01-vague-range')).toContain('в разумных пределах');
    expect(lineOf('M-03-open-ended-list')).toMatch(/ и т\.д\.$/);
    expect(lineOf('M-04-open-ended-statuses')).toContain('400, 401 и далее');
    expect(lineOf('M-05-placeholder-goal')).toBe('Уточняется.');
    expect(lineOf('M-08-placeholder-approvers')).toBe('| | | |');
    expect(lineOf('M-09-unfilled-checklist')).toMatch(/\| Да \/ Нет \| Да \/ Нет \|/);
    expect(lineOf('M-10-missing-id')).toMatch(/^\* (?!\*\*)/);
    expect(lineOf('M-16-nfr-unmeasurable')).toMatch(/в разумное время\.$/);
    expect(lineOf('M-17-get-changes-state')).toBe('| **REST type** | GET |');
    expect(lineOf('M-18-verb-in-url')).toMatch(/\/save[A-Z]\w+`.*\n.*\/save[A-Z]\w+"/);
    expect(lineOf('M-19-prod-url-missing')).toMatch(/Prod: — \|$/);
    expect(lineOf('M-20-type-mismatch')).toMatch(/^\| `\w+Tiyn` \| string \|/);
    expect(lineOf('M-22-undocumented-status')).toContain('400, 401, 403, 404, 409 и 500');
    expect(lineOf('M-28-non-atomic')).toContain(', а также откат выполняется');
    expect(lineOf('M-29-dangling-reference')).toMatch(/ \(см\. приложение 7\)\.$/);

    expect(mutationOf('M-11-unit-mismatch', text).text.match(/в тенге/g)).toHaveLength(1);
    expect(mutationOf('M-12-timezone-missing', text).text).not.toMatch(/UTC|Asia\/Almaty|часовом поясе/);
    expect(mutationOf('M-13-idempotency-missing', text).text).not.toMatch(/идемпотентн/i);
    expect(mutationOf('M-14-refund-rules-missing', text).text).not.toMatch(/частичн/i);
    expect(mutationOf('M-15-push-text-missing', text).text).not.toMatch(/Шаблон текста push|Казахский/);
    expect(mutationOf('M-27-missing-case', text).text).not.toMatch(/^\* \*\*Ф-17\.\*\*/m);
  });

  it('puts the error body under status 200 and the identifier under query parameters', () => {
    const errorUnderOk = mutationOf('M-21-success-status-error-body', text).text;
    const okBlock = errorUnderOk.slice(errorUnderOk.indexOf('#### 200.'), errorUnderOk.indexOf('#### 400.'));
    expect(okBlock).toMatch(/\nили\n```json\n\{"code":"VALIDATION_ERROR"/);

    const moved = mutationOf('M-23-sensitive-query-param', text).text;
    expect(moved).toMatch(/#### Path-параметры\nНе используются\./);
    expect(moved).toMatch(/#### Query-параметры\n\| Parameter \|.*\n\|.*\n\| `(?:cardId|clientId)` \|/);
  });

  it('breaks the arithmetic of one acceptance row and removes another', () => {
    const numeric = mutationOf('M-24-contradiction-numeric', text);
    const changed = numeric.text.split('\n')[(numeric.lines[0] ?? 0) - 1] ?? '';
    expect(changed).toMatch(/^\| Ф-3 \|/);
    expect(changed).not.toBe(originalLines[(numeric.lines[0] ?? 0) - 1]);

    const acceptanceRows = (source: string): string[] => source.split('\n').filter((line) => /^\| Ф-\d+ \|/.test(line));
    const gap = mutationOf('M-26-acceptance-gap', text);
    expect(acceptanceRows(gap.text)).toHaveLength(acceptanceRows(text).length - 1);

    const contradiction = mutationOf('M-25-contradiction-rule', text);
    expect(contradiction.text.match(/, а не по времени /g)).toHaveLength(2);
  });
});
