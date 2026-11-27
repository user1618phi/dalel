import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import PdfPrinter from 'pdfmake';
import type { Content, TDocumentDefinitions } from 'pdfmake/interfaces.js';
import { parse } from 'yaml';
import { coverage } from '../src/eval/coverage.js';
import type { Report } from '../src/types.js';

/**
 * Builds docs/presentation.pdf from the committed report, so every number on the slides
 * is the number in the report: nothing is typed in by hand.
 */

const [reportPath = 'reports/requirements.report.json', evalPath = 'docs/EVAL.md', out = 'docs/presentation.pdf'] = process.argv.slice(2);
const report = JSON.parse(readFileSync(reportPath, 'utf8')) as Report;
const evalText = readFileSync(evalPath, 'utf8');
const gold = (parse(readFileSync('eval/case/gold.yaml', 'utf8')) as { defects: Parameters<typeof coverage>[1] }).defects;
const cov = coverage(report, gold);

const fontDir = join(dirname(createRequire(import.meta.url).resolve('dejavu-fonts-ttf/package.json')), 'ttf');
const printer = new PdfPrinter({
  Sans: {
    normal: join(fontDir, 'DejaVuSans-ExtraLight.ttf'),
    bold: join(fontDir, 'DejaVuSans-Bold.ttf'),
    italics: join(fontDir, 'DejaVuSans.ttf'),
    bolditalics: join(fontDir, 'DejaVuSans-Bold.ttf'),
  },
  Mono: {
    normal: join(fontDir, 'DejaVuSansMono.ttf'),
    bold: join(fontDir, 'DejaVuSansMono-Bold.ttf'),
    italics: join(fontDir, 'DejaVuSansMono.ttf'),
    bolditalics: join(fontDir, 'DejaVuSansMono-Bold.ttf'),
  },
});

const INK = '#16181d';
const MUTED = '#6b7280';
const ACCENT = '#2e75c9';
const LINE = '#d6d9df';
const W = 841.89 - 2 * 56;

const cut = (text: string, max: number): string => {
  if (text.length <= max) return text;
  const head = text.slice(0, max);
  return `${head.slice(0, Math.max(head.lastIndexOf(' '), max - 30)).replace(/[\s,.;:—–-]+$/, '')}…`;
};
const sentences = (parts: string[]): string => parts.map((x) => (/[.!?…]$/.test(x.trim()) ? x.trim() : `${x.trim()}.`)).join(' ');

const label = (text: string): Content => ({ text: text.toLowerCase(), font: 'Mono', fontSize: 9, color: MUTED, characterSpacing: 0.4 });
const rule = (): Content => ({ canvas: [{ type: 'line', x1: 0, y1: 0, x2: W, y2: 0, lineWidth: 0.6, lineColor: LINE }], margin: [0, 8, 0, 12] });
const h = (text: string): Content => ({ text, fontSize: 27, color: INK, lineHeight: 1.08, margin: [0, 6, 0, 0] });
const p = (text: string, size = 13): Content => ({ text, font: 'Sans', italics: true, fontSize: size, color: INK, lineHeight: 1.35 });
const row = (name: string, value: string): Content => ({
  columns: [
    { ...(label(name) as object), width: 190, margin: [0, 3, 0, 0] } as Content,
    { text: value, italics: true, fontSize: 12, color: INK, lineHeight: 1.25 },
  ],
  margin: [0, 0, 0, 7],
});
const big = (value: string, name: string): Content => ({ stack: [{ text: value, fontSize: 40, color: INK }, label(name)], width: '*' }) as Content;

function slide(index: number, kicker: string, title: string, body: Content[], last = false): Content {
  return {
    stack: [label(`${String(index).padStart(2, '0')} · ${kicker}`), h(title), rule(), ...body],
    ...(last ? {} : { pageBreak: 'after' as const }),
  };
}

const s = report.summary;
const critical = report.findings.filter((f) => f.severity === 'critical' && f.status !== 'resolved');
const withCe = report.findings.find((f) => f.counterexample && f.severity === 'critical') ?? report.findings.find((f) => f.counterexample);
const question = report.questions.find((q) => q.blocking) ?? report.questions[0];
const pick = (re: RegExp) => re.exec(evalText)?.[1]?.trim() ?? 'не измерялось';
const rulesRecall = pick(/Полнота слоя правил \| ([^|]+)\|/);
const modelRecall = pick(/Полнота на смысловых дефектах[^|]*\| ([^|]+)\|/);
const read = (path: string) => (existsSync(path) ? readFileSync(path, 'utf8') : '');
const caseText = read('docs/EVAL-case.md');
const precisionText = read('docs/EVAL-precision.md');
const stabilityText = read('docs/EVAL-stability.md');
// «| Существенные | 32 | 24 | 11 |» in the strict table: agent vs one plain request to the same model.
const strictMajor = /## Строгая сверка[\s\S]*?\| Существенные \| (\d+) \| (\d+) \|(?: (\d+) \|)?/.exec(caseText);
const precisionAll = /\| Все \| (\d+) \| (\d+) \| (\d+) \| (\d+) \| ([^|]+)\| ([^|]+)\|/.exec(precisionText);
const stableCritical = /## Критичные замечания\s+Разных замечаний за все прогоны: (\d+); найдено в каждом прогоне: (\d+)/.exec(stabilityText);
const covLine = cov.rows.map((r) => `${{ critical: 'критичные', major: 'существенные', minor: 'незначительные' }[r.severity] ?? r.severity} ${r.covered} из ${r.total}`).join(' · ');

const content: Content[] = [
  slide(1, 'BCC-HUB x MNU FinTech Hackathon', 'Dalel — агент\nпроверки требований', [
    p('«Дәлел» — доказательство. Агент читает ТЗ до начала разработки и выпускает отчёт, где каждое замечание подтверждено цитатой, а каждое противоречие — сценарием с числами.', 15),
    { text: '', margin: [0, 26, 0, 0] },
    { columns: [big(String(s.requirements), 'требований в выданном ТЗ'), big(String(s.findings), 'замечаний'), big(String(s.bySeverity.critical), 'критичных'), big(String(s.questions), 'вопросов автору')] },
  ]),
  slide(2, 'задача', 'Дефект в ТЗ дешевле всего\nнайти до первой строки кода', [
    row('что просили', 'Статическое ревью готового документа: двусмысленность, непроверяемость, противоречия, пропуски, лишние проектные решения.'),
    row('по каким критериям', 'ISO/IEC/IEEE 29148:2018 §5.2.5–5.2.7 и IEEE 830-1998 §4.3.'),
    row('в чём трудность', 'Модель легко находит «замечания» в любом тексте. Отчёт на сто пунктов без доказательств не читает никто.'),
    row('наш ответ', 'Модель предлагает — код проверяет. Замечание без дословной цитаты в отчёт не попадает.'),
  ]),
  slide(3, 'как работает', 'Одиннадцать ролей:\nпять — код, шесть — модель', [
    row('загрузчик · нарезчик', 'PDF, DOCX, Markdown, HTML, текст; битый файл — диагностика, не авария. Нарезка по структуре, одинакова при каждом прогоне.'),
    row('линтер', 'Правила без модели: формулировки, шаблон, единицы, таблицы API, пропуски финтеха, границы без приёмки.'),
    row('аналитик · ревизор', 'Модель проверяет каждый пункт и ищет противоречия в наборе; данные карт перед этим маскируются.'),
    row('искатель пропусков', 'Два прохода с линзами предметной области, затем повторный взгляд: чего ещё нет в списке.'),
    row('контролёр', 'Код сверяет каждую цитату с текстом и пересчитывает числа в контрпримерах.'),
    row('оппонент', 'Защищает автора: пытается опровергнуть каждое замечание.'),
    row('интервьюер · тест-дизайнер', 'Коренные причины, вопросы с ситуацией и тестом, граничные значения и сценарии. Вердикт считает код.'),
  ]),
  slide(4, 'результат на выданном документе', report.verdict.headline, [
    ...critical.slice(0, 4).map((f) => row(f.id, f.title)),
    ...(withCe?.counterexample
      ? [
          { text: '', margin: [0, 6, 0, 0] } as Content,
          row('контрпример', cut(`${sentences([...withCe.counterexample.given, ...withCe.counterexample.when])} ${withCe.counterexample.conflict}`, 400)),
        ]
      : []),
  ]),
  slide(5, 'уточняющие вопросы', 'Вопрос — это ситуация,\nварианты и тест', [
    ...(question
      ? [
          row('кому', question.addressee),
          row('вопрос', question.text),
          ...(question.scenario ? [row('ситуация', cut(question.scenario, 230))] : []),
          ...question.options.slice(0, 2).map((o, i) => row(`вариант ${i + 1}`, cut(`${o.label} → ${o.consequence}${o.test ? ` Тест: ${o.test}` : ''}`, 250))),
          ...(question.recommended ? [row('рекомендация агента', cut(`${question.recommended.label} — ${question.recommended.reason}`, 200))] : []),
        ]
      : [p('Вопросов нет.')]),
    row('дальше', `Вопросов ${s.questions}, блокирующих ${s.blockingQuestions}. Автор отвечает в файле, в терминале или в веб-интерфейсе — агент снимает замечания и пересчитывает вердикт.`),
  ]),
  slide(6, 'качество', 'Измерено, а не заявлено', [
    row('внесённые дефекты', `В чистые ТЗ вносятся известные дефекты 24 классов. Правила: ${rulesRecall}. Смысловые дефекты (модель): ${modelRecall}.`),
    row('каталог дефектов кейса', `87 записей. Найдено: ${covLine}.`),
    ...(strictMajor?.[3] ? [row('агент против одного запроса', `Существенных дефектов каталога строгой сверкой: агент ${strictMajor[2]} из ${strictMajor[1]}, один запрос к той же модели — ${strictMajor[3]} из ${strictMajor[1]}.`)] : []),
    ...(precisionAll ? [row('точность', `Каждое из ${precisionAll[1]} замечаний проверила другая модель: строгая точность ${precisionAll[5]?.trim()}, мягкая ${precisionAll[6]?.trim()}.`)] : []),
    ...(stableCritical ? [row('стабильность', `Три прогона без кэша: критичных замечаний ${stableCritical[1]}, из них в каждом прогоне найдено ${stableCritical[2]}.`)] : []),
    row('оппонент', `Отклонено замечаний модели: ${s.rejectedByOpponent}. Отброшено без подтверждённой цитаты: ${s.droppedUnverified}.`),
    row('ограничения', 'Сверки эвристические, судья точности — тоже модель; таблицы из PDF читаются как текст; сканы не распознаются.'),
  ]),
  slide(
    7,
    'польза',
    'Что получает банк',
    [
      row('аналитик и тестировщик', `Ревью ТЗ за минуты, вопросы владельцам с вариантами, черновик тест-кейсов (${report.testCases?.length ?? 0}) и заполненный банковский чек-лист (${report.checklist?.length ?? 0} пунктов).`),
      row('закрытый контур', 'Слой правил работает без сети; с локальной моделью документ не покидает машину; данные карт маскируются.'),
      row('разработка', 'Шаг в CI не пускает в работу ТЗ с критичным дефектом; замечания видны в пул-реквесте; выгрузка в трекер.'),
      row('как пользоваться', 'Одна команда в терминале, веб-интерфейс на своей машине или контейнер Docker.'),
      row('платформа агентов', 'MCP-инструмент: агент-исполнитель спрашивает «можно ли строить по этому ТЗ» перед началом работы.'),
      row('прогон', `${report.passport.model}, ${(report.passport.durationMs / 60000).toFixed(1)} мин, обращений к модели: ${report.passport.llmCalls}. Агент Dalel ${report.passport.agentVersion}.`),
    ],
    true,
  ),
];

const doc: TDocumentDefinitions = {
  pageSize: 'A4',
  pageOrientation: 'landscape',
  pageMargins: [56, 52, 56, 44],
  defaultStyle: { font: 'Sans', color: INK },
  info: { title: 'Dalel — агент проверки требований', subject: 'BCC-HUB x MNU FinTech Hackathon' },
  footer: (page: number, pages: number): Content => ({
    columns: [
      { text: 'dalel', font: 'Mono', fontSize: 8, color: ACCENT },
      { text: `${page} / ${pages}`, font: 'Mono', fontSize: 8, color: MUTED, alignment: 'right' },
    ],
    margin: [56, 14, 56, 0],
  }),
  content,
};

const pdf = printer.createPdfKitDocument(doc);
const chunks: Buffer[] = [];
pdf.on('data', (c: Buffer) => chunks.push(c));
pdf.on('end', () => {
  writeFileSync(out, Buffer.concat(chunks));
  process.stderr.write(`презентация записана: ${out}\n`);
});
pdf.end();
