import { randomUUID } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { type IncomingMessage, type Server, type ServerResponse, createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import type { LlmClient } from '../llm/index.js';
import { check } from '../pipeline.js';
import { renderHtml } from '../report/html.js';
import { KIT_CSS } from '../report/kit.js';
import { renderMarkdown } from '../report/markdown.js';
import { renderPdf } from '../report/pdf.js';
import { renderFeature } from '../stages/testcases.js';
import type { Report, SourceDoc } from '../types.js';

/**
 * A local web interface: upload a document, read the report, answer the agent's questions and see the verdict
 * recalculated. Listens on the loopback interface only — the document never leaves the machine through this server.
 */

const MAX_BYTES = 20 * 1024 * 1024;
const ALLOWED = new Set(['.md', '.markdown', '.txt', '.pdf', '.docx', '.html', '.htm']);

interface Session {
  path: string;
  name: string;
  rulesOnly: boolean;
  report: Report;
  doc: SourceDoc | null;
  answers: Record<string, string>;
}

const PAGE = `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Dalel — проверка требований</title>
<style>${KIT_CSS}
html { color-scheme: light dark; }
:root[data-theme="light"] { color-scheme: light; }
:root[data-theme="dark"] { color-scheme: dark; }
body { margin: 0; }
main { max-width: 920px; margin: 0 auto; padding: var(--space-12) 16px var(--space-16); }
h1 { font-size: clamp(28px, 7.6vw, 72px); margin: var(--space-3) 0 var(--space-8); }
form { display: grid; grid-template-columns: 1fr; gap: var(--space-4); justify-items: start; }
form .wide { justify-self: stretch; }
.file { position: relative; display: flex; flex-wrap: wrap; justify-content: space-between; align-items: baseline; gap: var(--space-1) var(--space-4); cursor: pointer; }
.file input { position: absolute; inset: 0; width: 100%; height: 100%; opacity: 0; cursor: pointer; }
.file:has(:focus-visible) { border-color: var(--fg); outline: 2px solid var(--fg); outline-offset: 2px; }
input[type=checkbox], input[type=radio] { flex: none; width: 16px; height: 16px; margin: 4px 0 0; accent-color: var(--fg); }
.q label, form label:not(.field) { display: flex; gap: var(--space-3); align-items: flex-start; margin: 0; padding: var(--space-2) 0; cursor: pointer; }
.btn:disabled { opacity: .5; pointer-events: none; }
#status { margin: var(--space-4) 0 0; }
#result, #questions { padding: 0; margin-top: var(--space-16); }
#result[hidden], #questions[hidden], #status[hidden] { display: none; }
#code { margin-top: var(--space-4); }
#headline { margin: var(--space-2) 0 var(--space-4); text-wrap: balance; }
.counts { display: grid; grid-template-columns: repeat(4, auto); justify-content: start; gap: var(--space-2) var(--space-8); margin: var(--space-8) 0 var(--space-6); }
@media (max-width: 640px) { .counts { grid-template-columns: repeat(2, 1fr); } }
.counts .n { display: block; font: var(--weight-heading) var(--text-title) / 1 var(--font-mono); letter-spacing: var(--tracking-heading); font-variant-numeric: tabular-nums; }
.links { display: flex; gap: var(--space-4); flex-wrap: wrap; margin: 0; }
.q { padding: var(--space-6) 0; }
.q p { margin: var(--space-2) 0; }
.q .why { display: block; color: var(--mut); font-size: 14.5px; }
.q .field { width: 100%; box-sizing: border-box; margin-top: var(--space-2); }
.q .field::placeholder { color: var(--mut); }
#apply { margin-top: var(--space-8); }
</style>
</head>
<body>
<main>
<p class="label">dalel · проверка требований</p>
<h1>Проверьте ТЗ<br><span class="acc">до первой строки кода</span></h1>
<form id="f">
  <label class="field file wide"><input type="file" id="file" accept=".pdf,.docx,.md,.markdown,.txt,.html,.htm" required><span id="fname">Выберите документ</span><span class="label">pdf, docx, md, html, txt · до 20 мб</span></label>
  <label><input type="checkbox" id="rules"><span>Только правила, без модели</span></label>
  <button class="btn primary" id="go" type="submit">Проверить</button>
</form>
<p class="mark" id="status" role="status" aria-live="polite" hidden></p>
<section id="result" hidden>
  <div class="ruler"></div>
  <p class="mark" id="code"></p>
  <h2 id="headline"></h2>
  <p id="rationale"></p>
  <div class="counts" id="counts"></div>
  <div class="links" id="links"></div>
  <section id="questions" hidden>
    <p class="label">вопросы автору · ответьте и пересчитайте отчёт</p>
    <div id="qlist" class="rows"></div>
    <button class="btn" id="apply" type="button">Учесть ответы</button>
  </section>
</section>
</main>
<script>
const $ = (id) => document.getElementById(id);
let session = null;
function text(tag, value, cls) { const el = document.createElement(tag); el.textContent = value; if (cls) el.className = cls; return el; }
function say(msg, kind) { const s = $('status'); s.hidden = !msg; s.className = 'mark' + (kind ? ' ' + kind : ''); s.textContent = msg; }
function busy(btn, on) { btn.disabled = on; if (on) btn.setAttribute('aria-busy', 'true'); else btn.removeAttribute('aria-busy'); }
$('file').addEventListener('change', () => { const f = $('file').files[0]; $('fname').textContent = f ? f.name : 'Выберите документ'; });
function show(data) {
  session = data.id;
  $('result').hidden = false;
  $('code').className = 'mark ' + ({ ready: 'ok', ready_with_conditions: 'warn', not_ready: 'bad' }[data.verdict.code] || '');
  $('code').textContent = { ready: 'готово', ready_with_conditions: 'с оговорками', not_ready: 'не готово', not_checked: 'не проверено' }[data.verdict.code] || data.verdict.code;
  $('headline').textContent = data.verdict.headline;
  $('rationale').textContent = data.verdict.rationale;
  const counts = $('counts'); counts.replaceChildren();
  for (const [name, value] of [['требований', data.summary.requirements], ['замечаний', data.summary.findings], ['критичных', data.summary.bySeverity.critical], ['вопросов', data.summary.questions]]) {
    const d = document.createElement('div'); d.append(text('span', String(value), 'n'), text('span', name, 'label')); counts.append(d);
  }
  const links = $('links'); links.replaceChildren();
  const full = text('a', 'полный отчёт'); full.href = '/api/report/' + data.id + '.html'; full.target = '_blank'; full.rel = 'noopener'; links.append(full);
  for (const [ext, name] of [['md', 'Markdown'], ['pdf', 'PDF'], ['json', 'JSON'], ['feature', 'тест-кейсы']]) {
    const a = text('a', name); a.href = '/api/report/' + data.id + '.' + ext; a.download = ''; links.append(a);
  }
  const list = $('qlist'); list.replaceChildren();
  const hasQ = data.questions.length > 0;
  $('questions').hidden = !hasQ;
  // One primary action per state: before a result it is «Проверить», with open questions it is «Учесть ответы».
  $('go').classList.toggle('primary', !hasQ);
  $('apply').classList.toggle('primary', hasQ);
  for (const q of data.questions) {
    const box = document.createElement('div'); box.className = 'q'; box.dataset.id = q.id;
    const pid = 'qt-' + q.id;
    const title = text('p', q.text); title.id = pid;
    box.setAttribute('role', 'group'); box.setAttribute('aria-labelledby', pid);
    box.append(text('p', q.id + (q.blocking ? ' · блокирует разработку' : '') + ' · ' + q.addressee, 'label'), title);
    if (q.scenario) box.append(text('p', 'Ситуация: ' + q.scenario, 'why'));
    for (const o of q.options) {
      const l = document.createElement('label'); const r = document.createElement('input');
      r.type = 'radio'; r.name = q.id; r.value = o.label; if (q.answer === o.label) r.checked = true;
      const t = document.createElement('span'); t.append(o.label, text('span', o.consequence, 'why'));
      if (q.recommended && q.recommended.label === o.label) t.append(text('span', 'рекомендация агента', 'mark'));
      l.append(r, t); box.append(l);
    }
    const free = document.createElement('input'); free.type = 'text'; free.className = 'field'; free.placeholder = 'или свой ответ';
    free.setAttribute('aria-label', 'Свой ответ на ' + q.id);
    if (q.answer && !q.options.some((o) => o.label === q.answer)) free.value = q.answer;
    box.append(free); list.append(box);
  }
}
async function call(url, options) {
  const res = await fetch(url, options);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'ошибка сервера');
  return data;
}
$('f').addEventListener('submit', async (e) => {
  e.preventDefault();
  const file = $('file').files[0]; if (!file) return;
  say('проверяю: ' + file.name); busy($('go'), true);
  try {
    show(await call('/api/check?name=' + encodeURIComponent(file.name) + ($('rules').checked ? '&rules=1' : ''), { method: 'POST', body: file }));
    say('готово', 'ok');
  } catch (err) { say('не получилось: ' + err.message, 'bad'); }
  busy($('go'), false);
});
$('apply').addEventListener('click', async () => {
  const answers = {};
  for (const box of document.querySelectorAll('.q')) {
    const free = box.querySelector('input[type=text]').value.trim();
    const picked = box.querySelector('input[type=radio]:checked');
    if (free) answers[box.dataset.id] = free; else if (picked) answers[box.dataset.id] = picked.value;
  }
  say('учитываю ответы'); busy($('apply'), true);
  try {
    show(await call('/api/answer', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: session, answers }) }));
    say('отчёт пересчитан', 'ok');
  } catch (err) { say('не получилось: ' + err.message, 'bad'); }
  busy($('apply'), false);
});
</script>
</body>
</html>`;

function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        reject(Object.assign(new Error('Файл больше 20 МБ.'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

function view(id: string, s: Session) {
  return { id, verdict: s.report.verdict, summary: s.report.summary, questions: s.report.questions, diagnostics: s.report.diagnostics };
}

export function createApp(client: LlmClient | null): Server {
  const sessions = new Map<string, Session>();
  const work = mkdtempSync(join(tmpdir(), 'dalel-serve-'));

  return createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const fail = (e: unknown) => json(res, typeof (e as { status?: unknown }).status === 'number' ? (e as { status: number }).status : 500, { error: e instanceof Error ? e.message : String(e) });

    (async () => {
      if (req.method === 'GET' && url.pathname === '/') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': "default-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'" });
        res.end(PAGE);
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/check') {
        const original = (url.searchParams.get('name') ?? 'document.md').split(/[\\/]/).pop() ?? 'document.md';
        const ext = extname(original).toLowerCase();
        if (!ALLOWED.has(ext)) throw Object.assign(new Error(`Формат «${ext || 'без расширения'}» не поддерживается. Подойдут: ${[...ALLOWED].join(', ')}.`), { status: 415 });
        const body = await readBody(req, MAX_BYTES);
        const id = randomUUID();
        // The stored name is ours; the client's name is kept only for display.
        const path = join(work, `${id}${ext}`);
        writeFileSync(path, body);
        const rulesOnly = url.searchParams.get('rules') === '1' || !client;
        const { report, doc } = await check(path, { client: rulesOnly ? null : client });
        report.passport.documentName = original.replace(/[^\p{L}\p{N} ._-]/gu, '_').slice(0, 120);
        const session: Session = { path, name: report.passport.documentName, rulesOnly, report, doc, answers: {} };
        sessions.set(id, session);
        json(res, 200, view(id, session));
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/answer') {
        const payload = JSON.parse((await readBody(req, 1024 * 1024)).toString('utf8')) as { id?: string; answers?: Record<string, unknown> };
        const session = payload.id ? sessions.get(payload.id) : undefined;
        if (!session || !payload.id) throw Object.assign(new Error('Сессия не найдена: загрузите документ заново.'), { status: 404 });
        const known = new Set(session.report.questions.map((q) => q.id));
        for (const [k, v] of Object.entries(payload.answers ?? {})) if (known.has(k) && typeof v === 'string' && v.trim() !== '') session.answers[k] = v.trim().slice(0, 2000);
        const { report, doc } = await check(session.path, { client: session.rulesOnly ? null : client, answers: session.answers });
        report.passport.documentName = session.name;
        session.report = report;
        session.doc = doc;
        json(res, 200, view(payload.id, session));
        return;
      }
      const dl = /^\/api\/report\/([0-9a-f-]{36})\.(md|json|pdf|feature|html)$/.exec(url.pathname);
      if (req.method === 'GET' && dl) {
        const session = sessions.get(dl[1] ?? '');
        if (!session) throw Object.assign(new Error('Отчёт не найден.'), { status: 404 });
        const kind = dl[2] ?? 'md';
        if (kind === 'html') {
          // Opened in a tab, not downloaded: the report carries its own restrictive content policy.
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
          res.end(renderHtml(session.report, session.doc));
          return;
        }
        const body: string | Buffer =
          kind === 'md' ? renderMarkdown(session.report) : kind === 'json' ? JSON.stringify(session.report, null, 2) : kind === 'pdf' ? await renderPdf(session.report) : renderFeature(session.name, session.report.testCases ?? []);
        const type = kind === 'pdf' ? 'application/pdf' : kind === 'json' ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8';
        res.writeHead(200, { 'content-type': type, 'content-disposition': `attachment; filename="dalel-report.${kind}"` });
        res.end(body);
        return;
      }
      json(res, 404, { error: 'Не найдено.' });
    })().catch(fail);
  });
}

export function serve(client: LlmClient | null, port: number, log: (m: string) => void): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createApp(client);
    server.on('error', reject);
    // Loopback only: this is a tool for one person's machine, not a public service.
    server.listen(port, '127.0.0.1', () => {
      log(`веб-интерфейс: http://127.0.0.1:${port} (${client ? `модель ${client.model}` : 'только правила, модель не подключена'}); остановить — Ctrl+C`);
    });
    process.on('SIGINT', () => server.close(() => resolve(0)));
  });
}
