import { type Finding, type Report, SEVERITY_LABEL } from '../types.js';

export interface Comparison {
  before: Report;
  after: Report;
  closed: Finding[];
  added: Finding[];
  remaining: Finding[];
}

/**
 * Identity of a finding across two editions of a document. Line numbers and report ids shift between
 * editions, so the key is built from what the finding is about: the rule or criterion, and the quoted text.
 */
function key(f: Finding): string {
  const quote = (f.evidence[0]?.quote ?? '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  return f.ruleId ? `${f.ruleId}|${quote.slice(0, 80)}` : `${f.criterion}|${quote.slice(0, 80)}`;
}

export function compareReports(before: Report, after: Report): Comparison {
  const live = (r: Report) => r.findings.filter((f) => f.status !== 'resolved');
  // The same edition checked twice (answers of the author applied): ids are stable, so they identify a finding exactly.
  const sameEdition = before.passport.documentSha256 === after.passport.documentSha256 && live(after).every((f) => before.findings.some((b) => b.id === f.id && b.title === f.title));
  // Several findings can share a rule or criterion and a quote; the ordinal keeps them apart instead of collapsing them into one.
  const index = (list: Finding[]) => {
    const seen = new Map<string, number>();
    return new Map(
      list.map((f) => {
        const base = sameEdition ? `${f.id}|${f.title}` : key(f);
        const n = seen.get(base) ?? 0;
        seen.set(base, n + 1);
        return [`${base}#${n}`, f] as const;
      }),
    );
  };
  const was = index(live(before));
  const now = index(live(after));
  return {
    before,
    after,
    closed: [...was.entries()].filter(([k]) => !now.has(k)).map(([, f]) => f),
    added: [...now.entries()].filter(([k]) => !was.has(k)).map(([, f]) => f),
    remaining: [...now.entries()].filter(([k]) => was.has(k)).map(([, f]) => f),
  };
}

export function renderComparison(c: Comparison): string {
  const out: string[] = [];
  const line = (f: Finding) => `- ${SEVERITY_LABEL[f.severity]} · ${f.title}${f.evidence[0] ? ` — «${f.evidence[0].quote.replace(/\n/g, ' ').slice(0, 140)}»` : ''}`;
  const count = (list: Finding[]) => `${list.length} (критичных ${list.filter((f) => f.severity === 'critical').length})`;
  out.push(`# Сравнение редакций: ${c.before.passport.documentName} → ${c.after.passport.documentName}`);
  out.push('');
  out.push(`Было: ${c.before.verdict.headline} (${c.before.passport.date.slice(0, 10)}, SHA-256 ${c.before.passport.documentSha256.slice(0, 12)}).`);
  out.push(`Стало: ${c.after.verdict.headline} (${c.after.passport.date.slice(0, 10)}, SHA-256 ${c.after.passport.documentSha256.slice(0, 12)}).`);
  out.push('');
  out.push('| | Замечаний |');
  out.push('| :--- | :--- |');
  out.push(`| Закрыто | ${count(c.closed)} |`);
  out.push(`| Появилось | ${count(c.added)} |`);
  out.push(`| Осталось | ${count(c.remaining)} |`);
  out.push('');
  for (const [title, list] of [['Закрытые замечания', c.closed], ['Новые замечания', c.added], ['Оставшиеся замечания', c.remaining]] as const) {
    out.push(`## ${title}`);
    out.push('');
    if (list.length === 0) out.push('Нет.');
    for (const f of [...list].sort((a, b) => a.severity.localeCompare(b.severity))) out.push(line(f));
    out.push('');
  }
  out.push('Сопоставление идёт по правилу или критерию и по тексту цитаты. Если формулировку требования переписали, старое замечание попадёт в «закрытые», а к новой формулировке может появиться новое.');
  out.push('');
  return out.join('\n');
}
