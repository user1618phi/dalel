import type { Criterion, Evidence, Finding, Report, Requirement, Severity, SourceDoc } from '../../src/types.js';
import { NON_REQUIREMENT_KINDS } from '../../src/types.js';

const DOC_LINES = [
  '# ТЗ: Переводы с карты на карту в мобильном приложении',
  '',
  'Версия 0.3 · автор: продуктовая команда «Платежи»',
  '',
  '## 1. Функциональные требования',
  '',
  'Ф-1. Система должна позволять перевод с карты на карту на сумму от 100 ₸ до 500 000 ₸ за одну операцию.',
  'Ф-2. Суточный лимит переводов для одного клиента — 1 000 000 ₸.',
  'Ф-3. Комиссия за перевод до 10 000 ₸ составляет 1 % от суммы, но не менее 150 ₸ и не более 95 ₸.',
  'Ф-4. Перевод должен выполняться быстро, а при ошибке система должна корректно обработать ситуацию и уведомить клиента.',
  'Ф-5. Клиент может выполнить до трёх переводов по 400 000 ₸ в сутки без дополнительного подтверждения.',
  '',
  '## 2. Нефункциональные требования',
  '',
  'НФ-1. Номер карты получателя хранится в базе данных для повторных переводов.',
  '',
  '## 3. API',
  '',
  'POST /api/v1/transfers — создать перевод. Параметры: fromCardId, toCardNumber, amount, comment (пример значения: <script>alert(1)</script>).',
  '',
  '## 4. Приёмка',
  '',
  'ПР-1. Перевод 5 000 ₸ проходит успешно, комиссия списана.',
  '',
  '## 5. Открытые вопросы',
  '',
  '<заполнить после согласования с комплаенсом>',
];

const SHA256 = '9f2c41d7a0b35e8846c1f7d2e9a4b6035d17c8e2fa90b4c36e5d7a1108f3c2be';

function lineOf(fragment: string): number {
  const index = DOC_LINES.findIndex((line) => line.includes(fragment));
  if (index < 0) throw new Error(`fixture: fragment not found in the document: ${fragment}`);
  return index + 1;
}

function lineText(line: number): string {
  const text = DOC_LINES[line - 1];
  if (text === undefined) throw new Error(`fixture: no line ${line}`);
  return text;
}

function evidence(quote: string, requirementId?: string): Evidence {
  const line = lineOf(quote);
  return requirementId === undefined
    ? { quote, lineStart: line, lineEnd: line }
    : { quote, lineStart: line, lineEnd: line, requirementId };
}

export function sampleDoc(): SourceDoc {
  const text = DOC_LINES.join('\n');
  return {
    path: 'docs/tz-perevody.md',
    name: 'tz-perevody.md',
    format: 'md',
    sha256: SHA256,
    bytes: Buffer.byteLength(text, 'utf8'),
    text,
    lines: [...DOC_LINES],
    diagnostics: [],
  };
}

function requirements(): Requirement[] {
  const unit = (
    id: string,
    kind: Requirement['kind'],
    marker: string,
    summary: string,
    section: string[],
    docId?: string,
  ): Requirement => {
    const line = lineOf(marker);
    const base: Requirement = { id, kind, text: lineText(line), summary, section, lineStart: line, lineEnd: line };
    return docId === undefined ? base : { ...base, docId };
  };
  const functional = ['1. Функциональные требования'];
  return [
    unit('R-001', 'metadata', 'Версия 0.3', 'Версия и автор документа', []),
    unit('R-002', 'functional', 'Ф-1.', 'Перевод от 100 ₸ до 500 000 ₸ за операцию', functional, 'Ф-1'),
    unit('R-003', 'functional', 'Ф-2.', 'Суточный лимит 1 000 000 ₸ на клиента', functional, 'Ф-2'),
    unit('R-004', 'functional', 'Ф-3.', 'Комиссия 1 %, минимум 150 ₸, максимум 95 ₸', functional, 'Ф-3'),
    unit('R-005', 'functional', 'Ф-4.', 'Быстрое выполнение и обработка ошибок', functional, 'Ф-4'),
    unit('R-006', 'functional', 'Ф-5.', 'До трёх переводов по 400 000 ₸ в сутки', functional, 'Ф-5'),
    unit('R-007', 'nonfunctional', 'НФ-1.', 'Хранение номера карты получателя', ['2. Нефункциональные требования'], 'НФ-1'),
    unit('R-008', 'api_meta', 'POST /api/v1/transfers', 'Метод создания перевода и его параметры', ['3. API']),
    unit('R-009', 'acceptance', 'ПР-1.', 'Перевод 5 000 ₸ проходит, комиссия списана', ['4. Приёмка'], 'ПР-1'),
    unit('R-010', 'template', '<заполнить после', 'Раздел не заполнен', ['5. Открытые вопросы']),
  ];
}

function findings(): Finding[] {
  return [
    {
      id: 'D-001',
      source: 'llm',
      scope: 'set',
      criterion: 'set_consistent',
      standardRef: 'ISO/IEC/IEEE 29148:2018 §5.2.6 Consistent; IEEE 830-1998 §4.3.4',
      severity: 'critical',
      title: 'Суточный лимит противоречит разрешённым трём переводам',
      explanation:
        'Ф-5 разрешает три перевода по 400 000 ₸ в сутки, то есть 1 200 000 ₸, а Ф-2 ограничивает сутки суммой 1 000 000 ₸. Третий перевод одновременно разрешён и запрещён.',
      recommendation:
        'Выбрать одно правило: либо поднять суточный лимит до 1 200 000 ₸, либо записать в Ф-5, что третий перевод проходит только в пределах остатка лимита.',
      requirementIds: ['R-003', 'R-006'],
      evidence: [
        evidence('Суточный лимит переводов для одного клиента — 1 000 000 ₸', 'R-003'),
        evidence('до трёх переводов по 400 000 ₸ в сутки', 'R-006'),
      ],
      counterexample: {
        given: ['Клиент за сутки уже выполнил два перевода по 400 000 ₸', '400 000 + 400 000 = 800 000 ₸ израсходовано'],
        when: ['Клиент отправляет третий перевод на 400 000 ₸'],
        expectations: [
          { requirementId: 'R-006', expected: 'перевод проходит: это третий перевод из трёх разрешённых' },
          { requirementId: 'R-003', expected: 'перевод отклонён: 800 000 + 400 000 = 1 200 000 ₸ больше лимита 1 000 000 ₸' },
        ],
        conflict: 'Один и тот же перевод должен быть и выполнен, и отклонён.',
        arithmeticChecked: true,
      },
      status: 'confirmed',
      opponent: { verdict: 'uphold', reason: 'Оба требования действуют в одних и тех же сутках, исключений в тексте нет.' },
      rootCauseId: 'RC-01',
    },
    {
      id: 'D-002',
      source: 'rule',
      ruleId: 'N-003',
      scope: 'requirement',
      criterion: 'correct',
      standardRef: 'ISO/IEC/IEEE 29148:2018 §5.2.5 Correct; IEEE 830-1998 §4.3.1',
      severity: 'critical',
      title: 'Минимальная комиссия больше максимальной',
      explanation:
        'Нижняя граница комиссии 150 ₸ выше верхней границы 95 ₸. Не существует суммы комиссии, которая удовлетворяет обоим условиям.',
      recommendation: 'Указать согласованные границы, например «не менее 95 ₸ и не более 150 ₸», и подтвердить их у владельца тарифа.',
      requirementIds: ['R-004'],
      evidence: [evidence('не менее 150 ₸ и не более 95 ₸', 'R-004')],
      status: 'confirmed',
      rootCauseId: 'RC-02',
    },
    {
      id: 'D-003',
      source: 'rule',
      ruleId: 'A-001',
      scope: 'requirement',
      criterion: 'verifiable',
      standardRef: 'ISO/IEC/IEEE 29148:2018 §5.2.5 Verifiable; IEEE 830-1998 §4.3.6',
      severity: 'major',
      title: 'Скорость перевода не измерима',
      explanation: 'Слово «быстро» не задаёт порога: тест не может ни подтвердить, ни опровергнуть требование.',
      recommendation: 'Задать порог и способ измерения: перцентиль, значение в секундах, точка замера.',
      requirementIds: ['R-005'],
      evidence: [evidence('Перевод должен выполняться быстро', 'R-005')],
      status: 'resolved',
      resolution: {
        byQuestionId: 'Q-03',
        note: 'Автор задал порог, находка снята.',
        proposedText: 'Ф-4а. 95 % переводов завершаются не дольше чем за 3 с от нажатия «Перевести» до экрана результата.',
      },
    },
    {
      id: 'D-004',
      source: 'llm',
      scope: 'requirement',
      criterion: 'singular',
      standardRef: 'ISO/IEC/IEEE 29148:2018 §5.2.5 Singular',
      severity: 'major',
      title: 'В одном требовании три обязательства',
      explanation:
        'Ф-4 объединяет скорость выполнения, обработку ошибок и уведомление клиента. Их нельзя принять или отклонить по отдельности, а «корректно обработать» не описывает ни одной конкретной ошибки.',
      recommendation: 'Разбить на три требования и перечислить ошибки: недостаточно средств, превышен лимит, отказ эмитента, таймаут процессинга.',
      requirementIds: ['R-005'],
      evidence: [evidence('а при ошибке система должна корректно обработать ситуацию и уведомить клиента', 'R-005')],
      status: 'confirmed',
      opponent: { verdict: 'uphold', reason: 'Три глагола с разными исполнителями и разными критериями приёмки.' },
    },
    {
      id: 'D-005',
      source: 'llm',
      scope: 'requirement',
      criterion: 'complete',
      standardRef: 'ISO/IEC/IEEE 29148:2018 §5.2.5 Complete; IEEE 830-1998 §4.3.3',
      normRef: 'PCI DSS v4.0, требование 3.5.1',
      severity: 'major',
      title: 'Не сказано, как защищён сохранённый номер карты',
      explanation:
        'Требование предписывает хранить номер карты, но не говорит, в каком виде: полный номер, маска или токен. Хранение полного номера в открытом виде запрещено стандартом.',
      recommendation: 'Записать, что хранится токен процессинга и маска вида 4400 43** **** 1234, а полный номер не сохраняется.',
      requirementIds: ['R-007'],
      evidence: [evidence('Номер карты получателя хранится в базе данных', 'R-007')],
      status: 'downgraded',
      opponent: {
        verdict: 'downgrade',
        reason: 'Нарушение стандарта из текста не следует: способ хранения просто не описан. Это пробел, а не ошибка.',
      },
    },
    {
      id: 'D-006',
      source: 'rule',
      ruleId: 'V-002',
      scope: 'requirement',
      criterion: 'verifiable',
      standardRef: 'ISO/IEC/IEEE 29148:2018 §5.2.5 Verifiable; IEEE 830-1998 §4.3.6',
      severity: 'minor',
      title: 'В критерии приёмки нет ожидаемой суммы комиссии',
      explanation: 'Формулировка «комиссия списана» не называет сумму, поэтому тест пройдёт при любой комиссии.',
      recommendation: 'Указать ожидаемую комиссию для 5 000 ₸ после того, как будут исправлены границы в Ф-3.',
      requirementIds: ['R-009'],
      evidence: [evidence('комиссия списана', 'R-009')],
      status: 'question',
    },
  ];
}

function rejected(): Finding[] {
  return [
    {
      id: 'D-007',
      source: 'llm',
      scope: 'requirement',
      criterion: 'unambiguous',
      standardRef: 'ISO/IEC/IEEE 29148:2018 §5.2.5 Unambiguous; IEEE 830-1998 §4.3.2',
      severity: 'minor',
      title: 'Не указана валюта лимита операции',
      explanation: 'В требовании названы суммы, но валюта якобы не определена.',
      recommendation: 'Указать валюту.',
      requirementIds: ['R-002'],
      evidence: [evidence('от 100 ₸ до 500 000 ₸ за одну операцию', 'R-002')],
      status: 'rejected',
      opponent: { verdict: 'reject', reason: 'Валюта указана в самой цитате: знак «₸» стоит у обеих границ.' },
    },
  ];
}

export function sampleReport(): Report {
  const doc = sampleDoc();
  const units = requirements();
  const active = findings();
  const counted = units.filter((unit) => !NON_REQUIREMENT_KINDS.has(unit.kind));

  const bySeverity: Record<Severity, number> = { critical: 0, major: 0, minor: 0 };
  const byCriterion: Partial<Record<Criterion, number>> = {};
  const touched = new Set<string>();
  for (const finding of active) {
    bySeverity[finding.severity] += 1;
    byCriterion[finding.criterion] = (byCriterion[finding.criterion] ?? 0) + 1;
    for (const id of finding.requirementIds) touched.add(id);
  }

  return {
    schema: 'dalel.report/1',
    passport: {
      documentName: doc.name,
      documentPath: doc.path,
      documentSha256: doc.sha256,
      documentFormat: doc.format,
      documentLines: doc.lines.length,
      date: '2026-11-27T09:41:00Z',
      provider: 'anthropic',
      model: 'claude-sonnet-4-5',
      mode: 'rules+llm',
      agentVersion: '0.1.0',
      agentCommit: 'a3f9c1e',
      rulePacks: ['core', 'fintech-kz'],
      promptHash: 'sha256:5b1d0c7e94aa2f6638e0d4c1b7f2a9053c6e8d1f',
      durationMs: 48200,
      llmCalls: 7,
      llmCacheHits: 2,
      tokensIn: 18450,
      tokensOut: 3920,
    },
    requirements: units,
    findings: active,
    rejected: rejected(),
    rootCauses: [
      { id: 'RC-01', title: 'Лимиты заданы в двух местах без общего правила', findingIds: ['D-001'] },
      { id: 'RC-02', title: 'Тариф комиссии не согласован с владельцем', findingIds: ['D-002', 'D-006'] },
    ],
    questions: [
      {
        id: 'Q-01',
        addressee: 'Владелец продукта «Платежи»',
        text: 'Какое правило главное: суточный лимит 1 000 000 ₸ или право на три перевода по 400 000 ₸?',
        why: 'От ответа зависит, отклонять ли третий перевод. Сейчас разработчик выберет сам, и клиент либо превысит лимит, либо получит неожиданный отказ.',
        findingIds: ['D-001'],
        rootCauseId: 'RC-01',
        options: [
          { label: 'Главный — суточный лимит', consequence: 'Третий перевод отклоняется, Ф-5 нужно переписать.' },
          { label: 'Главное — три перевода', consequence: 'Лимит поднимается до 1 200 000 ₸, нужно согласование с комплаенсом.' },
        ],
        defaultAssumption: 'Действует суточный лимит 1 000 000 ₸, третий перевод отклоняется.',
        blocking: true,
        risk: { level: 'high', kind: 'money', note: 'Превышение лимита на 200 000 ₸ на клиента в сутки.' },
      },
      {
        id: 'Q-02',
        addressee: 'Владелец тарифов',
        text: 'Каковы минимальная и максимальная комиссия для переводов до 10 000 ₸?',
        why: 'Указанные границы взаимно исключают друг друга, комиссию нельзя ни посчитать, ни проверить.',
        findingIds: ['D-002', 'D-006'],
        rootCauseId: 'RC-02',
        options: [
          { label: 'Минимум 95 ₸, максимум 150 ₸', consequence: 'Перевод 5 000 ₸ стоит 95 ₸.' },
          { label: 'Фиксированная комиссия 150 ₸', consequence: 'Процент для малых сумм не применяется, условие «1 %» нужно убрать.' },
        ],
        defaultAssumption: 'Границы перепутаны местами: минимум 95 ₸, максимум 150 ₸.',
        blocking: true,
        risk: { level: 'high', kind: 'money', note: 'Неверная комиссия в каждой операции.' },
      },
      {
        id: 'Q-03',
        addressee: 'Технический руководитель',
        text: 'Какое время выполнения перевода считается приемлемым и где оно измеряется?',
        why: 'Без порога нельзя написать нагрузочный тест и принять требование.',
        findingIds: ['D-003'],
        options: [
          { label: 'p95 не больше 3 с', consequence: 'Требуется нагрузочный тест на стенде с процессингом.' },
          { label: 'p95 не больше 10 с', consequence: 'Достаточно текущей архитектуры, нужен экран ожидания.' },
        ],
        defaultAssumption: 'p95 не больше 5 с от запроса до ответа API.',
        blocking: false,
        risk: { level: 'medium', kind: 'customer', note: 'Клиент уходит, если перевод «висит».' },
        answer: 'p95 не больше 3 с, измеряем от нажатия «Перевести» до экрана результата.',
      },
    ],
    trace: [
      { requirementId: 'R-002', apiRefs: ['POST /api/v1/transfers'], acceptanceRefs: ['ПР-1'], gaps: [] },
      { requirementId: 'R-004', apiRefs: [], acceptanceRefs: ['ПР-1'], gaps: ['В API нет поля с суммой комиссии'] },
      { requirementId: 'R-006', apiRefs: [], acceptanceRefs: [], gaps: ['Нет метода API', 'Нет критерия приёмки'] },
    ],
    summary: {
      units: units.length,
      requirements: counted.length,
      findings: active.length,
      bySeverity,
      byCriterion,
      requirementsWithFindings: counted.filter((unit) => touched.has(unit.id)).length,
      questions: 3,
      blockingQuestions: 2,
      rejectedByOpponent: 1,
      droppedUnverified: 1,
      critical: active
        .filter((finding) => finding.severity === 'critical')
        .map((finding) => ({ findingId: finding.id, title: finding.title, requirementIds: finding.requirementIds })),
    },
    verdict: {
      code: 'not_ready',
      headline: 'Документ не готов к разработке',
      rationale:
        'Два критичных дефекта касаются денег: лимиты противоречат друг другу, а границы комиссии взаимно исключают друг друга. Пока на них нет ответа, реализация будет угадывать.',
      fixFirst: [
        { findingId: 'D-001', text: 'Согласовать суточный лимит и число переводов.' },
        { findingId: 'D-002', text: 'Исправить границы комиссии в Ф-3.' },
        { findingId: 'D-004', text: 'Разбить Ф-4 на отдельные требования и перечислить ошибки.' },
      ],
    },
    diagnostics: [
      {
        level: 'info',
        code: 'quote_dropped',
        message: 'Одна находка отброшена: цитата не найдена в тексте документа.',
        hint: 'Это защита от выдуманных цитат, действий не требуется.',
      },
      {
        level: 'warning',
        code: 'note',
        message: 'Раздел «Открытые вопросы» содержит незаполненный шаблон.',
      },
    ],
    answersApplied: { count: 1, resolved: 1, file: 'answers.yaml' },
  };
}
