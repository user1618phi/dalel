import {
  CRITERION_LABEL,
  type Criterion,
  type Finding,
  KIND_LABEL,
  NON_REQUIREMENT_KINDS,
  type Question,
  REQUIREMENT_CRITERIA,
  type Report,
  type Requirement,
  SET_CRITERIA,
  SEVERITY_LABEL,
  type Severity,
} from '../types.js';

const RISK_LEVEL: Record<string, string> = { high: 'высокий', medium: 'средний', low: 'низкий' };
const RISK_KIND: Record<string, string> = {
  money: 'деньги',
  compliance: 'регулятор',
  security: 'безопасность',
  customer: 'клиент',
  operations: 'эксплуатация',
  delivery: 'сроки',
};
const STATUS_LABEL: Record<string, string> = {
  confirmed: 'подтверждён',
  downgraded: 'тяжесть снижена оппонентом',
  question: 'открытый вопрос',
  rejected: 'отклонён оппонентом',
  resolved: 'закрыт ответом автора',
};
const CRIT_SHORT: Record<Criterion, string> = {
  necessary: 'Необх.',
  appropriate: 'Уровень',
  unambiguous: 'Однозн.',
  complete: 'Полнота',
  singular: 'Атомарн.',
  feasible: 'Реализ.',
  verifiable: 'Провер.',
  correct: 'Коррект.',
  conforming: 'Шаблон',
  set_complete: '',
  set_consistent: '',
  set_feasible: '',
  set_comprehensible: '',
  set_validatable: '',
  ranked: '',
  modifiable: '',
  traceable: '',
};
const MARK: Record<Severity, string> = { critical: '✗✗', major: '✗', minor: '·' };

function cell(s: string): string {
  return s.replace(/\|/g, '\\|').replace(/\n+/g, ' ').trim();
}

function lines(a: number, b: number): string {
  return a === b ? `${a}` : `${a}–${b}`;
}

function reqLabel(r: Requirement | undefined, id: string): string {
  if (!r) return id;
  return r.docId ? `${id} («${r.docId}»)` : id;
}

function quoteBlock(f: Finding, reqs: Map<string, Requirement>): string[] {
  return f.evidence.map((e) => {
    const r = e.requirementId ? reqs.get(e.requirementId) : undefined;
    const page = r?.page ? `, с. ${r.page}` : '';
    return `> «${e.quote.replace(/\n/g, ' ')}» — строка ${lines(e.lineStart, e.lineEnd)}${page}${e.requirementId ? `, ${reqLabel(r, e.requirementId)}` : ''}`;
  });
}

function findingCard(f: Finding, reqs: Map<string, Requirement>): string[] {
  const out: string[] = [];
  out.push(`#### ${f.id} · ${SEVERITY_LABEL[f.severity]} · ${f.title}`);
  out.push('');
  const meta = [`${CRITERION_LABEL[f.criterion]} (${f.standardRef.split(';')[0]})`];
  if (f.normRef) meta.push(f.normRef);
  meta.push(f.source === 'rule' ? `правило ${f.ruleId ?? ''}` : 'модель');
  if (f.status !== 'confirmed') meta.push(STATUS_LABEL[f.status] ?? f.status);
  if (f.requirementIds.length > 0) meta.push(`пункты: ${f.requirementIds.map((id) => reqLabel(reqs.get(id), id)).join(', ')}`);
  out.push(`*${meta.join(' · ')}*`);
  out.push('');
  out.push(...quoteBlock(f, reqs));
  out.push('');
  out.push(f.explanation);
  if (f.counterexample) {
    const c = f.counterexample;
    out.push('');
    out.push(`**Контрпример**${c.arithmeticChecked ? ' (арифметика пересчитана кодом)' : ''}`);
    out.push('');
    const steps = (parts: string[]) => parts.map((x) => (/[.!?…;]$/.test(x.trim()) ? x.trim() : `${x.trim()}.`)).join(' ');
    if (c.given.length > 0) out.push(`- Дано: ${steps(c.given)}`);
    if (c.when.length > 0) out.push(`- Когда: ${steps(c.when)}`);
    for (const x of c.expectations) out.push(`- ${reqLabel(reqs.get(x.requirementId), x.requirementId)} требует: ${x.expected}`);
    out.push(`- Конфликт: ${c.conflict}`);
  }
  if (f.recommendation) {
    out.push('');
    out.push(`**Что исправить:** ${f.recommendation}`);
  }
  if (f.opponent && f.opponent.verdict === 'uphold') {
    out.push('');
    out.push('**Оппонент:** опровергнуть не удалось.');
  } else if (f.opponent && f.opponent.reason) {
    out.push('');
    out.push(`**Оппонент:** ${f.opponent.verdict === 'downgrade' ? 'тяжесть снижена' : 'отклонено'} — ${f.opponent.reason}`);
  }
  if (f.resolution) {
    out.push('');
    out.push(`**Ответ автора (${f.resolution.byQuestionId}):** ${f.resolution.note}`);
    if (f.resolution.proposedText) out.push(`\n**Предлагаемая формулировка:** ${f.resolution.proposedText}`);
  }
  out.push('');
  return out;
}

export function questionBlock(q: Question, withAnswerSlot: boolean): string[] {
  const out: string[] = [];
  out.push(`### ${q.id}${q.blocking ? ' · блокирует разработку' : ''} · риск ${RISK_LEVEL[q.risk.level] ?? q.risk.level} (${RISK_KIND[q.risk.kind] ?? q.risk.kind})`);
  out.push('');
  out.push(`**Кому:** ${q.addressee}`);
  out.push('');
  out.push(`**Вопрос:** ${q.text}`);
  out.push('');
  if (q.scenario) {
    out.push(`**Ситуация:** ${q.scenario}`);
    out.push('');
  }
  if (q.why) out.push(`**Зачем:** ${q.why}`);
  if (q.risk.note && q.risk.note !== q.why) out.push(`\n**Цена ошибки:** ${q.risk.note}`);
  out.push('');
  const withTests = q.options.some((o) => o.test);
  out.push(`| Вариант ответа | Что это меняет |${withTests ? ' Тест, если так |' : ''}`);
  out.push(`| :--- | :--- |${withTests ? ' :--- |' : ''}`);
  for (const o of q.options) out.push(`| ${cell(o.label)} | ${cell(o.consequence)} |${withTests ? ` ${cell(o.test ?? '')} |` : ''}`);
  out.push('');
  if (q.recommended) {
    out.push(`**Рекомендация агента:** ${q.recommended.label}${q.recommended.reason ? ` — ${q.recommended.reason}` : ''}`);
    out.push('');
  }
  out.push(`**Если ответа не будет, принимаем:** ${q.defaultAssumption}`);
  out.push('');
  out.push(`**Закрывает находки:** ${q.findingIds.join(', ') || '—'}`);
  out.push('');
  if (q.answer) out.push(`**Ответ:** ${q.answer}`);
  else if (withAnswerSlot) out.push('**Ответ:** ');
  out.push('');
  return out;
}

export function renderMarkdown(report: Report): string {
  const p = report.passport;
  const s = report.summary;
  const reqs = new Map(report.requirements.map((r) => [r.id, r]));
  const active = report.findings.filter((f) => f.status !== 'resolved');
  const out: string[] = [];

  out.push(`# Отчёт о проверке требований: ${p.documentName}`);
  out.push('');
  out.push(`**Итог: ${report.verdict.headline}.** ${report.verdict.rationale}`);
  out.push('');
  out.push(
    `Пунктов в документе: ${s.units}, из них требований: ${s.requirements}. Замечаний: ${s.findings} (критичных ${s.bySeverity.critical}, существенных ${s.bySeverity.major}, незначительных ${s.bySeverity.minor}). Вопросов автору: ${s.questions}, блокирующих: ${s.blockingQuestions}.`,
  );
  out.push('');
  out.push('Каждое замечание опирается на дословную цитату документа с номером строки; цитаты сверены с текстом программно.');
  out.push('');
  if (report.verdict.fixFirst.length > 0 || report.questions.some((q) => q.blocking)) {
    out.push('### Главное за минуту');
    out.push('');
    if (report.verdict.fixFirst.length > 0) {
      out.push('Что исправить в первую очередь:');
      out.push('');
      report.verdict.fixFirst.slice(0, 5).forEach((x, i) => out.push(`${i + 1}. ${x.text} (${x.findingId})`));
      out.push('');
    }
    const blockers = report.questions.filter((q) => q.blocking && !q.answer);
    if (blockers.length > 0) {
      out.push(`Вопросы, без ответа на которые нельзя начинать (${blockers.length}; первые три — здесь, все — в разделе 5):`);
      out.push('');
      for (const q of blockers.slice(0, 3)) {
        out.push(`**${q.id} · ${q.addressee}.** ${q.text}`);
        out.push('');
        if (q.scenario) out.push(`- Ситуация: ${q.scenario}`);
        q.options.forEach((o, i) => out.push(`- Вариант ${i + 1}: ${o.label} → ${o.consequence}`));
        if (q.recommended) out.push(`- Рекомендация агента: ${q.recommended.label}${q.recommended.reason ? ` — ${q.recommended.reason}` : ''}`);
        out.push('');
      }
    }
  }
  if (report.answersApplied?.before) {
    const b = report.answersApplied.before;
    out.push('### Что изменили ответы автора');
    out.push('');
    out.push('| | До ответов | После ответов |');
    out.push('| :--- | :---: | :---: |');
    out.push(`| Ответов учтено | — | ${report.answersApplied.count} |`);
    out.push(`| Открытых замечаний | ${b.findings} | ${s.findings} |`);
    out.push(`| Критичных | ${b.critical} | ${s.bySeverity.critical} |`);
    out.push(`| Существенных | ${b.major} | ${s.bySeverity.major} |`);
    out.push(`| Итог | ${b.headline} | ${report.verdict.headline} |`);
    out.push('');
  }
  out.push('## 1. Паспорт прогона');
  out.push('');
  out.push('| Параметр | Значение |');
  out.push('| :--- | :--- |');
  out.push(`| Документ | ${cell(p.documentName)} (${p.documentFormat}, строк: ${p.documentLines}) |`);
  out.push(`| Путь к документу | \`${cell(p.documentPath)}\` |`);
  out.push(`| SHA-256 документа | \`${p.documentSha256 || '—'}\` |`);
  out.push(`| Дата прогона | ${p.date} |`);
  out.push(`| Модель | ${p.provider === 'нет' ? 'не использовалась' : `${p.model} (провайдер: ${p.provider})`} |`);
  out.push(`| Режим | ${p.mode === 'rules+llm' ? 'правила + модель' : 'только правила, без модели'} |`);
  out.push(`| Версия агента | Dalel ${p.agentVersion}, коммит ${p.agentCommit} |`);
  out.push(`| Пакеты правил | ${p.rulePacks.join(', ')} |`);
  out.push(`| Хэш промптов | \`${p.promptHash}\` |`);
  out.push(`| Обращений к модели | ${p.llmCalls} новых, ${p.llmCacheHits} из кэша; токенов: ${p.tokensIn} на вход, ${p.tokensOut} на выход |`);
  out.push(`| Длительность | ${(p.durationMs / 1000).toFixed(1)} с |`);
  out.push('');

  if (report.requirements.length === 0) {
    out.push('## Диагностика');
    out.push('');
    for (const d of report.diagnostics) out.push(`- **${d.level === 'error' ? 'Ошибка' : d.level === 'warning' ? 'Предупреждение' : 'Примечание'}** (${d.code}): ${d.message}${d.hint ? ` ${d.hint}` : ''}`);
    out.push('');
    out.push('Проверка требований не выполнялась: агент не получил текста документа.');
    out.push('');
    return out.join('\n');
  }

  out.push('## 2. Как агент нарезал требования');
  out.push('');
  out.push('Границы пунктов определяет структура документа (пункт списка, абзац, строка таблицы, блок примера), а не модель, поэтому нарезка одинакова при каждом прогоне. Пункты вида «реквизит документа», «незаполненный шаблон» и «контекст» перечислены, но в число требований не входят.');
  out.push('');
  out.push('| Идентификатор в отчёте | Идентификатор в документе | Строки | Вид | Краткая формулировка |');
  out.push('| :--- | :--- | :--- | :--- | :--- |');
  for (const r of report.requirements) {
    out.push(`| ${r.id} | ${r.docId ?? '—'} | ${lines(r.lineStart, r.lineEnd)} | ${KIND_LABEL[r.kind]} | ${cell(r.summary)} |`);
  }
  out.push('');

  out.push('## 3. Проверка каждого требования');
  out.push('');
  const llm = p.mode === 'rules+llm';
  const okMark = llm ? '✓' : '';
  out.push(
    `Обозначения: «✗✗» — критичное замечание, «✗» — существенное, «·» — незначительное, ${llm ? '«✓» — замечаний по характеристике нет' : 'пусто — правила замечаний не нашли (смысловая проверка моделью не выполнялась)'}. Характеристики — ISO/IEC/IEEE 29148:2018 §5.2.5. В столбце «В составе набора» — замечания к набору требований (раздел 4), которые затрагивают этот пункт.`,
  );
  out.push('');
  out.push(`| Пункт | ${REQUIREMENT_CRITERIA.map((c) => CRIT_SHORT[c]).join(' | ')} | Замечания к пункту | В составе набора |`);
  out.push(`| :--- | ${REQUIREMENT_CRITERIA.map(() => ':---:').join(' | ')} | :--- | :--- |`);
  const perReq = active.filter((f) => f.scope === 'requirement');
  const perSet = active.filter((f) => f.scope === 'set');
  const rank: Record<Severity, number> = { critical: 0, major: 1, minor: 2 };
  for (const r of report.requirements) {
    if (NON_REQUIREMENT_KINDS.has(r.kind)) continue;
    const mine = perReq.filter((f) => f.requirementIds.includes(r.id));
    const inSet = perSet.filter((f) => f.requirementIds.includes(r.id));
    const cells = REQUIREMENT_CRITERIA.map((c) => {
      const hit = mine.filter((f) => f.criterion === c).sort((x, y) => rank[x.severity] - rank[y.severity])[0];
      return hit ? MARK[hit.severity] : okMark;
    });
    out.push(`| ${reqLabel(r, r.id)} | ${cells.join(' | ')} | ${mine.map((f) => f.id).join(', ') || '—'} | ${inSet.map((f) => f.id).join(', ') || '—'} |`);
  }
  out.push('');
  const detailed = perReq.filter((f) => f.severity !== 'minor');
  if (detailed.length > 0) {
    out.push('### Критичные и существенные замечания к отдельным пунктам');
    out.push('');
    for (const f of detailed) out.push(...findingCard(f, reqs));
  } else {
    out.push('Критичных и существенных замечаний к отдельным пунктам нет.');
    out.push('');
  }

  out.push('## 4. Проверка всего набора требований');
  out.push('');
  out.push('Характеристики набора — ISO/IEC/IEEE 29148:2018 §5.2.6 и IEEE 830-1998 §4.3.');
  out.push('');
  const setFindings = active.filter((f) => f.scope === 'set');
  out.push('| Характеристика набора | Критичных | Существенных | Незначительных | Замечания |');
  out.push('| :--- | :---: | :---: | :---: | :--- |');
  for (const c of SET_CRITERIA) {
    const mine = setFindings.filter((f) => f.criterion === c);
    const n = (sev: Severity) => mine.filter((f) => f.severity === sev).length;
    out.push(`| ${CRITERION_LABEL[c]} | ${n('critical')} | ${n('major')} | ${n('minor')} | ${mine.map((f) => f.id).join(', ') || 'нет'} |`);
  }
  const other = setFindings.filter((f) => !SET_CRITERIA.includes(f.criterion));
  if (other.length > 0) out.push(`| Прочее | ${other.filter((f) => f.severity === 'critical').length} | ${other.filter((f) => f.severity === 'major').length} | ${other.filter((f) => f.severity === 'minor').length} | ${other.map((f) => f.id).join(', ')} |`);
  out.push('');
  const setDetailed = setFindings.filter((f) => f.severity !== 'minor');
  for (const f of setDetailed) out.push(...findingCard(f, reqs));

  if (report.trace.length > 0) {
    out.push('### Трассировка: требование → API → критерий приёмки');
    out.push('');
    out.push('| Функциональное требование | Пункты API | Критерии приёмки | Пробелы |');
    out.push('| :--- | :--- | :--- | :--- |');
    for (const t of report.trace) {
      out.push(`| ${reqLabel(reqs.get(t.requirementId), t.requirementId)} | ${t.apiRefs.join(', ') || '—'} | ${t.acceptanceRefs.join(', ') || '—'} | ${t.gaps.join('; ') || 'нет'} |`);
    }
    out.push('');
  }
  if (report.rootCauses.length > 0) {
    out.push('### Коренные причины');
    out.push('');
    out.push('Замечания сгруппированы: одно решение автора закрывает всю группу.');
    out.push('');
    for (const rc of report.rootCauses) out.push(`- **${rc.id}. ${rc.title}** — ${rc.findingIds.join(', ')}`);
    out.push('');
  }

  const tcs = report.testCases ?? [];
  if (tcs.length > 0) {
    const kind = { boundary: 'граница', counterexample: 'противоречие', acceptance: 'приёмка из документа', decision: 'по ответу автора' } as const;
    const missing = tcs.filter((t) => !t.coveredByAcceptance).length;
    out.push('### Черновик тест-кейсов');
    out.push('');
    out.push(
      `Агент спроектировал ${tcs.length} тест-кейсов прямо из текста: граничные значения каждого диапазона, сценарий для каждого противоречия и критерии приёмки, которые в документе уже есть. Не покрыты критериями приёмки документа: ${missing}. Раздел «Тестирование требований» в документе пуст — этот список можно взять за основу. Тот же набор выгружается в формате Gherkin (\`--tests <файл>.feature\`).`,
    );
    out.push('');
    out.push('| № | Тип | Пункты | Дано | Когда | Тогда | В приёмке документа |');
    out.push('| :--- | :--- | :--- | :--- | :--- | :--- | :---: |');
    for (const t of tcs) {
      out.push(`| ${t.id} | ${kind[t.kind]}${t.findingId ? ` (${t.findingId})` : ''} | ${t.requirementIds.join(', ') || '—'} | ${cell(t.given.join(' '))} | ${cell(t.when.join(' '))} | ${cell(t.then.join(' '))} | ${t.coveredByAcceptance ? 'да' : 'нет'} |`);
    }
    out.push('');
  }

  if (report.checklist && report.checklist.length > 0) {
    out.push('### Чек-лист ревью из шаблона документа — черновик, заполненный агентом');
    out.push('');
    out.push('В документе чек-лист оставлен пустым. Ниже — ответы, которые следуют из результатов проверки; итоговую отметку ставит ревьюер.');
    out.push('');
    out.push('| Пункт чек-листа | Ответ агента | Основание | Находки |');
    out.push('| :--- | :--- | :--- | :--- |');
    for (const c of report.checklist) out.push(`| ${cell(c.item)} | **${cell(c.answer)}** | ${cell(c.basis)} | ${c.findingIds.join(', ') || '—'} |`);
    out.push('');
  }

  out.push('## 5. Вопросы автору');
  out.push('');
  if (report.questions.length === 0) {
    out.push('Вопросов нет.');
    out.push('');
  } else {
    out.push('Вопросы упорядочены: сначала блокирующие, затем по риску для банка. У каждого — варианты ответа и следствие каждого варианта. Ответы можно вписать в файл вопросов и передать агенту повторно (см. README).');
    out.push('');
    if (report.answersApplied) {
      out.push(`Учтено ответов автора: ${report.answersApplied.count}; закрыто находок: ${report.answersApplied.resolved}.`);
      out.push('');
    }
    for (const q of report.questions) out.push(...questionBlock(q, false));
  }

  out.push('## 6. Сводка');
  out.push('');
  out.push('| Показатель | Значение |');
  out.push('| :--- | :--- |');
  out.push(`| Пунктов в документе | ${s.units} |`);
  out.push(`| Из них требований | ${s.requirements} |`);
  out.push(`| Требований с замечаниями | ${s.requirementsWithFindings} |`);
  out.push(`| Замечаний всего | ${s.findings} |`);
  out.push(`| Критичных | ${s.bySeverity.critical} |`);
  out.push(`| Существенных | ${s.bySeverity.major} |`);
  out.push(`| Незначительных | ${s.bySeverity.minor} |`);
  out.push(`| Вопросов автору (блокирующих) | ${s.questions} (${s.blockingQuestions}) |`);
  out.push(`| Отклонено оппонентом | ${s.rejectedByOpponent} |`);
  out.push(`| Отброшено без подтверждённой цитаты | ${s.droppedUnverified} |`);
  out.push('');
  out.push('По характеристикам качества:');
  out.push('');
  for (const [c, n] of Object.entries(s.byCriterion).sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0))) out.push(`- ${CRITERION_LABEL[c as Criterion]}: ${n}`);
  out.push('');
  out.push('### Критичные дефекты');
  out.push('');
  if (s.critical.length === 0) out.push('Критичных дефектов нет.');
  for (const c of s.critical) out.push(`- **${c.findingId}** — ${c.title} (${c.requirementIds.map((id) => reqLabel(reqs.get(id), id)).join(', ') || 'набор в целом'})`);
  out.push('');

  out.push('## 7. Итог');
  out.push('');
  out.push(`**${report.verdict.headline}.** ${report.verdict.rationale}`);
  out.push('');
  if (report.verdict.fixFirst.length > 0) {
    out.push('### Что исправить в первую очередь');
    out.push('');
    report.verdict.fixFirst.forEach((x, i) => out.push(`${i + 1}. **${x.findingId}.** ${x.text}`));
    out.push('');
  }

  out.push('## Приложение');
  out.push('');
  const minors = active.filter((f) => f.severity === 'minor');
  out.push('### А. Незначительные замечания');
  out.push('');
  if (minors.length === 0) out.push('Нет.');
  else {
    out.push('| № | Пункты | Критерий | Замечание | Цитата | Строка |');
    out.push('| :--- | :--- | :--- | :--- | :--- | :--- |');
    for (const f of minors) {
      const e = f.evidence[0];
      out.push(`| ${f.id} | ${f.requirementIds.join(', ') || '—'} | ${CRITERION_LABEL[f.criterion]} | ${cell(f.title)} | «${cell(e?.quote ?? '')}» | ${e ? lines(e.lineStart, e.lineEnd) : '—'} |`);
    }
  }
  out.push('');
  const resolved = report.findings.filter((f) => f.status === 'resolved');
  if (resolved.length > 0) {
    out.push('### Б. Замечания, закрытые ответами автора');
    out.push('');
    for (const f of resolved) out.push(...findingCard(f, reqs));
  }
  out.push(`### ${resolved.length > 0 ? 'В' : 'Б'}. Замечания модели, отклонённые оппонентом`);
  out.push('');
  if (report.rejected.length === 0) out.push('Нет.');
  const duplicates = report.rejected.filter((f) => /^\s*дубликат/iu.test(f.opponent?.reason ?? ''));
  if (duplicates.length > 0) {
    out.push(`Как повторы других замечаний сняты ${duplicates.length}; они не перечисляются. Остальные отклонённые замечания — с причиной:`);
    out.push('');
  }
  for (const f of report.rejected) {
    if (duplicates.includes(f)) continue;
    const e = f.evidence[0];
    out.push(`- **${f.title}** (${CRITERION_LABEL[f.criterion]}; строка ${e ? lines(e.lineStart, e.lineEnd) : '—'}). Причина отклонения: ${f.opponent?.reason ?? '—'}`);
  }
  out.push('');
  out.push(`### ${resolved.length > 0 ? 'Г' : 'В'}. Диагностика прогона`);
  out.push('');
  if (report.diagnostics.length === 0) out.push('Замечаний к файлу и ходу прогона нет.');
  for (const d of report.diagnostics) out.push(`- ${d.level === 'error' ? 'Ошибка' : d.level === 'warning' ? 'Предупреждение' : 'Примечание'} (${d.code}): ${d.message}${d.hint ? ` ${d.hint}` : ''}`);
  out.push('');
  return out.join('\n');
}

/** A fill-in file: the author writes answers after «**Ответ:**» and passes it back with --answers. */
export function renderQuestionsFile(report: Report): string {
  const out: string[] = [];
  out.push(`# Вопросы автору документа: ${report.passport.documentName}`);
  out.push('');
  out.push('Впишите ответ после метки «**Ответ:**» под нужным вопросом и передайте файл агенту: `--answers <этот файл>`. Вопросы без ответа останутся открытыми.');
  out.push('');
  for (const q of report.questions) {
    out.push(...questionBlock(q, true).map((l) => (l.startsWith('### ') ? `## ${l.slice(4)}` : l)));
    out.push('---');
    out.push('');
  }
  return out.join('\n');
}
