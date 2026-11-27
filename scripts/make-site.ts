import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { KIT_CSS } from '../src/report/kit.js';
import type { Report } from '../src/types.js';

/**
 * Builds docs/index.html — a one-page introduction to the project for GitHub Pages.
 * Every number on the page is read from the committed report and evaluation files.
 */

const [reportPath = 'reports/requirements.report.json', out = 'docs/index.html'] = process.argv.slice(2);
const report = JSON.parse(readFileSync(reportPath, 'utf8')) as Report;
const read = (path: string) => (existsSync(path) ? readFileSync(path, 'utf8') : '');
const evalText = read('docs/EVAL.md');
const precisionText = read('docs/EVAL-precision.md');
const stabilityText = read('docs/EVAL-stability.md');
const recallText = read('docs/EVAL-recall.md');

const esc = (v: string | number) => String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const pick = (text: string, re: RegExp) => re.exec(text)?.[1]?.trim();
const sentences = (parts: string[]) => parts.map((x) => (/[.!?…]$/.test(x.trim()) ? x.trim() : `${x.trim()}.`)).join(' ');

const s = report.summary;
const conflict = report.findings.find((f) => f.counterexample && f.severity === 'critical') ?? report.findings.find((f) => f.counterexample);
const question = report.questions.find((q) => q.blocking && q.scenario) ?? report.questions[0];
const recIndex = question?.recommended ? question.options.findIndex((o) => o.label === question.recommended?.label) : -1;
const label = (id: string) => {
  const r = report.requirements.find((x) => x.id === id);
  if (r?.docId) return r.docId;
  if (r?.kind === 'acceptance') return 'критерию приёмки';
  return id;
};

const measured: [string, string][] = [];
const rules = pick(evalText, /Полнота слоя правил \| ([^|]+)\|/);
if (rules) measured.push(['внесённые дефекты', `Известные дефекты 24 классов вносятся в чистые ТЗ. Слой правил находит ${rules}.`]);
const recallRow = /\| ([^|\n]*Dalel[^|\n]*) \| \d+ \| ([^|]+)\| ([^|]+)\|/.exec(recallText);
const baselineRow = /\| ([^|\n]*один[^|\n]*) \| \d+ \| ([^|]+)\| ([^|]+)\|/i.exec(recallText);
if (recallRow) measured.push(['полнота по каталогу', `Независимая модель-судья: критичных ${recallRow[2]?.trim()}, существенных ${recallRow[3]?.trim()}${baselineRow ? `; один запрос к той же модели без агента — существенных ${baselineRow[3]?.trim()}` : ''}. В скобках — найдено частично.`]);
const precision = /\| Все \| (\d+) \| (\d+) \| (\d+) \| (\d+) \| ([^|]+)\| ([^|]+)\|/.exec(precisionText);
if (precision) measured.push(['точность', `Каждое из ${precision[1]} замечаний проверила другая модель: верно ${precision[2]}, частично ${precision[3]}, неверно ${precision[4]}.`]);
const stable = /## Критичные замечания\s+Разных замечаний за все прогоны: (\d+); найдено в каждом прогоне: (\d+)/.exec(stabilityText);
if (stable) measured.push(['стабильность', `Три прогона без кэша: критичных замечаний ${stable[1]}, в каждом прогоне найдено ${stable[2]}. Нарезка и правила совпадают полностью.`]);
measured.push(['оппонент и арбитр', `Отклонено замечаний модели: ${s.rejectedByOpponent}. Отброшено без подтверждённой цитаты: ${s.droppedUnverified}.`]);

const rows = (items: [string, string][]) => items.map(([k, v]) => `<div class="pair"><span class="label">${esc(k)}</span><p>${esc(v)}</p></div>`).join('\n');

const html = `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Dalel — проверка требований</title>
<meta name="description" content="Агент статической проверки технических заданий: каждое замечание подтверждено цитатой, каждое противоречие — сценарием с числами.">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter+Tight:wght@300..700&amp;family=IBM+Plex+Mono:wght@400;500&amp;display=swap">
<style>${KIT_CSS}
html { color-scheme: light dark; }
h1 { font-size: clamp(30px, 8.7vw, 96px); margin: var(--space-3) 0 var(--space-8); }
h1 .acc { white-space: nowrap; }
h2 { margin: var(--space-2) 0 var(--space-6); max-width: 32ch; text-wrap: balance; }
h2:has(+ .lead) { margin-bottom: var(--space-3); }
h2 + .lead { color: var(--fg); margin-bottom: var(--space-6); }
/* .wrap sets the side gutters with a shorthand, which would otherwise wipe the vertical rhythm of sections. */
section.wrap { padding-block: clamp(40px, 6vw, 88px); }
section.wrap.hero { padding-block: clamp(40px, 6vw, 72px) var(--space-8); }
.hero + section.wrap { padding-top: var(--space-8); }
.ruler { margin-bottom: var(--space-8); }
.mark { margin-top: var(--space-4); }
.actions { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-6); margin-top: var(--space-8); }
.actions a:not(.btn) { display: inline-block; padding-block: 12px; font-size: 14.5px; transition: transform var(--dur-spring) var(--ease-spring); }
.actions a:not(.btn):active { transform: scale(var(--press-scale)); transition-duration: var(--dur-press); }
@media (max-width: 640px) { .actions { gap: var(--space-2) var(--space-6); } .actions .btn { flex: 1 0 100%; justify-content: center; } }
.counts { display: grid; grid-template-columns: repeat(4, auto); justify-content: start; gap: var(--space-2) var(--space-12); margin-top: var(--space-8); }
.counts .n { display: block; font: var(--weight-heading) var(--text-title) / 1 var(--font-mono); letter-spacing: var(--tracking-heading); font-variant-numeric: tabular-nums; }
.counts .label { display: block; margin-top: var(--space-1); }
@media (max-width: 640px) { .counts { grid-template-columns: repeat(2, 1fr); row-gap: var(--space-6); } }
.pair { display: grid; grid-template-columns: minmax(140px, 220px) 1fr; gap: var(--space-2) var(--space-8); align-items: baseline; }
@media (max-width: 640px) { .pair { grid-template-columns: 1fr; } }
.pair p { max-width: 68ch; }
.note { color: var(--mut); margin-top: var(--space-6); }
pre { margin-top: var(--space-4); white-space: pre-wrap; overflow-wrap: anywhere; }
footer.wrap { padding-block: var(--space-12) var(--space-16); }
footer time { white-space: nowrap; }
</style>
</head>
<body>
<main>
<section class="wrap hero">
  <p class="label">dalel · агент проверки требований</p>
  <h1>Каждое замечание<br><span class="acc">с доказательством</span></h1>
  <p class="lead">Агент читает техническое задание до начала разработки. Замечание подтверждается дословной цитатой, противоречие — сценарием с числами, пропуск — вопросом с вариантами ответа.</p>
  <div class="actions"><a class="btn primary" href="report.html">Открыть отчёт по ТЗ кейса</a><a href="https://github.com/user1618phi/dalel">Репозиторий</a><a href="presentation.pdf">Презентация</a></div>
</section>

<section class="wrap">
  <div class="ruler"></div>
  <p class="label">результат на выданном документе</p>
  <p class="mark ${report.verdict.code === 'ready' ? 'ok' : report.verdict.code === 'ready_with_conditions' ? 'warn' : 'bad'}">${report.verdict.code === 'ready' ? 'готово' : report.verdict.code === 'ready_with_conditions' ? 'с оговорками' : 'не готово'}</p>
  <h2>${esc(report.verdict.headline)}</h2>
  <div class="counts">
    <div><span class="n">${s.requirements}</span><span class="label">требований</span></div>
    <div><span class="n">${s.findings}</span><span class="label">замечаний</span></div>
    <div><span class="n">${s.bySeverity.critical}</span><span class="label">критичных</span></div>
    <div><span class="n">${s.questions}</span><span class="label">вопросов автору</span></div>
  </div>
  <p class="label note">${esc(report.passport.model)} · ${(report.passport.durationMs / 60000).toFixed(1).replace('.', ',')} мин · обращений к модели: ${report.passport.llmCalls}</p>
</section>
${
  conflict?.counterexample
    ? `
<section class="wrap">
  <p class="label">противоречие · ${conflict.severity === 'critical' ? 'критичное' : 'существенное'}</p>
  <h2>Противоречие —<br>это сценарий с числами</h2>
  <p class="lead">${esc(conflict.title)}</p>
  <div class="rows">
${rows([
  ['дано', sentences(conflict.counterexample.given)],
  ['когда', sentences(conflict.counterexample.when)],
  ...conflict.counterexample.expectations.map((x): [string, string] => [`по ${label(x.requirementId)}`, x.expected]),
  ['конфликт', conflict.counterexample.conflict],
])}
  </div>
  <p class="note">Сценарий — готовый тест-кейс.</p>
</section>`
    : ''
}
${
  question
    ? `
<section class="wrap">
  <p class="label">вопрос автору · ${esc(question.addressee)}</p>
  <h2>Пропуск —<br>это вопрос с вариантами</h2>
  <p class="lead">${esc(question.text)}</p>
  <div class="rows">
${rows([
  ...(question.scenario ? [['ситуация', question.scenario] as [string, string]] : []),
  ...question.options.map((o, i): [string, string] => [`вариант ${i + 1}`, o.label]),
  ...(question.recommended ? [['рекомендация агента', `${recIndex >= 0 ? `Вариант ${recIndex + 1}. ` : `${question.recommended.label}. `}${question.recommended.reason}`] as [string, string]] : []),
])}
  </div>
  <p class="note">Автор отвечает в файле, в терминале или в браузере; агент снимает замечания, задаёт уточнение и пересчитывает вердикт.</p>
</section>`
    : ''
}
<section class="wrap">
  <p class="label">как устроено</p>
  <h2>Модель предлагает, код проверяет</h2>
  <div class="rows">
${rows([
  ['загрузчик · нарезчик', 'PDF, DOCX, Markdown, HTML, текст. Битый файл даёт диагностику, а не аварию. Нарезка по структуре документа одинакова при каждом прогоне.'],
  ['линтер', 'Правила без модели: формулировки, шаблон, единицы, таблицы API, пропуски финтеха, границы без приёмки. Работает без ключа и сети.'],
  ['аналитик · ревизор · искатель пропусков', 'Модель проверяет каждый пункт, ищет противоречия и примеряет линзы предметной области. Данные карт перед этим маскируются.'],
  ['вольный ревьюер', 'Свободный разбор без ограничений формата; каждое его замечание переносится в отчёт только с цитатой из документа.'],
  ['оппонент · арбитр', 'Оппонент защищает автора и пытается опровергнуть замечание; спор решает арбитр по тексту документа.'],
  ['интервьюер · тест-дизайнер', 'Коренные причины, вопросы с ситуацией и тестом, граничные значения и сценарии для тестировщика.'],
])}
  </div>
</section>

<section class="wrap">
  <p class="label">измерено</p>
  <h2>Агент проверяет и самого себя</h2>
  <div class="rows">
${rows(measured)}
  </div>
  <p class="note">Судьи — тоже модели, сверки эвристические: это порядок величин, а не точное место. Методика и оговорки — в папке docs репозитория.</p>
</section>

<section class="wrap">
  <p class="label">запуск</p>
  <h2>Одна команда</h2>
  <pre>npm run check -- docs/requirements.md reports/requirements.report.md</pre>
  <p class="note">Перед первым запуском — <code>npm ci</code>. Тот же агент работает в браузере на своей машине (<code>npm run serve</code>), в контейнере Docker, в шаге GitHub Actions, как инструмент MCP и как скилл для агентов-разработчиков: <code>npx skills add user1618phi/dalel</code>.</p>
</section>
</main>
<footer class="wrap"><p class="label">dalel ${esc(report.passport.agentVersion)} · mit · bcc-hub x mnu fintech hackathon · отчёт сформирован <time>${esc(report.passport.date.slice(0, 10))}</time></p></footer>
</body>
</html>
`;

writeFileSync(out, html);
process.stderr.write(`страница записана: ${out} (${Math.round(html.length / 1024)} КБ)\n`);
