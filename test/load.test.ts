import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import PdfPrinter from 'pdfmake';
import type { TDocumentDefinitions } from 'pdfmake/interfaces.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadDocument, normalizeText, sniffFormat } from '../src/load/index.js';
import { LoadError, type Diagnostic, type DiagnosticCode } from '../src/types.js';

const FONT = fileURLToPath(new URL('../node_modules/dejavu-fonts-ttf/ttf/DejaVuSans.ttf', import.meta.url));
const PDF_TIMEOUT = 30_000;

let dir = '';

async function put(name: string, data: Uint8Array | string): Promise<string> {
  const path = join(dir, name);
  await writeFile(path, data);
  return path;
}

async function expectFatal(path: string, code: DiagnosticCode, opts?: { maxBytes?: number }): Promise<Diagnostic> {
  const error: unknown = await loadDocument(path, opts).then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(LoadError);
  if (!(error instanceof LoadError)) throw new Error('unreachable');
  const { diagnostic } = error;
  expect(diagnostic.code).toBe(code);
  expect(diagnostic.level).toBe('error');
  expect(diagnostic.message).toMatch(/[А-Яа-яЁё]{3,}/);
  expect(diagnostic.hint ?? '').toMatch(/[А-Яа-яЁё]{3,}/);
  return diagnostic;
}

/** Deterministic noise: a seeded LCG keeps the fixtures identical between runs. */
function noise(length: number, seed = 1): Buffer {
  const out = Buffer.alloc(length);
  let state = seed;
  for (let i = 0; i < length; i++) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    out[i] = state >>> 24;
  }
  return out;
}

function makePdf(definition: TDocumentDefinitions): Promise<Buffer> {
  const printer = new PdfPrinter({ DejaVu: { normal: FONT, bold: FONT, italics: FONT, bolditalics: FONT } });
  return new Promise((resolve, reject) => {
    const doc = printer.createPdfKitDocument({ ...definition, defaultStyle: { font: 'DejaVu' } });
    const chunks: Buffer[] = [];
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    doc.end();
  });
}

const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of data) crc = (CRC_TABLE[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** Store-only ZIP: enough for mammoth to open a DOCX without committing a binary fixture. */
function zipStore(files: Record<string, string>): Buffer {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [fileName, content] of Object.entries(files)) {
    const nameBytes = Buffer.from(fileName, 'utf8');
    const data = Buffer.from(content, 'utf8');
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    locals.push(local, nameBytes, data);

    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(0x0800, 8);
    entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(data.length, 20);
    entry.writeUInt32LE(data.length, 24);
    entry.writeUInt16LE(nameBytes.length, 28);
    entry.writeUInt32LE(offset, 42);
    central.push(entry, nameBytes);

    offset += local.length + nameBytes.length + data.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

function makeDocx(body: string): Buffer {
  const xml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
  return zipStore({
    '[Content_Types].xml': `${xml}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`,
    '_rels/.rels': `${xml}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`,
    'word/document.xml': `${xml}<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`,
  });
}

const para = (text: string, style?: string): string =>
  `<w:p>${style ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : ''}<w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;
const cell = (text: string): string => `<w:tc>${para(text)}</w:tc>`;

const PAGE_ONE =
  'Ф-1. Комиссия за перевод между своими счетами не взимается, за перевод на счёт другого клиента банка ' +
  'составляет 150 ₸, а за перевод в другой банк — 0,95 % от суммы, но не менее 300 ₸ и не более 5 000 ₸ за операцию. ' +
  'Комиссия списывается одновременно с суммой перевода и отображается клиенту до подтверждения операции.';
const PAGE_TWO =
  'Ф-2. Суточный лимит переводов для клиента без подтверждённой личности составляет 500 000 ₸; при превышении ' +
  'лимита операция отклоняется с кодом E-07, клиент получает уведомление с причиной отказа и остатком лимита на сутки. ' +
  'Лимит обнуляется в 00:00 по времени Астаны, отклонённые операции в расчёте лимита не участвуют.';

let pdfBytes: Buffer = Buffer.alloc(0);

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'dalel-load-'));
  pdfBytes = await makePdf({
    content: [
      { text: 'Требования к переводам', fontSize: 18 },
      PAGE_ONE,
      { text: PAGE_TWO, pageBreak: 'before' },
    ],
  });
}, PDF_TIMEOUT);

afterAll(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

describe('helpers', () => {
  it('normalizeText strips BOM, line endings and trailing NULs but keeps characters inside lines', () => {
    expect(normalizeText('﻿а б\r\nв\rг\n\0\0')).toBe('а б\nв\nг\n');
    expect(normalizeText('150 ₸')).toBe('150 ₸');
  });

  it('sniffFormat prefers magic bytes over the extension', () => {
    expect(sniffFormat(Buffer.from('%PDF-1.7\n'), 'a.md')).toMatchObject({ kind: 'ok', format: 'pdf', by: 'magic' });
    expect(sniffFormat(Buffer.from('# Заголовок\n'), 'a.markdown')).toMatchObject({ kind: 'ok', format: 'md' });
    expect(sniffFormat(Buffer.from('<!DOCTYPE html><html></html>'), 'page')).toMatchObject({ kind: 'ok', format: 'html' });
    expect(sniffFormat(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]), 'a.txt')).toMatchObject({ kind: 'unsupported' });
    expect(sniffFormat(noise(2048), 'a.pdf')).toMatchObject({ kind: 'corrupted' });
    expect(sniffFormat(noise(2048), 'a.txt')).toMatchObject({ kind: 'binary' });
  });
});

describe('text and markdown', () => {
  it('reads markdown with BOM and CRLF', async () => {
    const source = '﻿# Требования\r\n\r\nФ-1. Лимит 500 000 ₸.\r\n';
    const bytes = Buffer.from(source, 'utf8');
    const doc = await loadDocument(await put('spec.md', bytes));

    expect(doc.format).toBe('md');
    expect(doc.name).toBe('spec.md');
    expect(doc.bytes).toBe(bytes.length);
    expect(doc.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
    expect(doc.text).toBe('# Требования\n\nФ-1. Лимит 500 000 ₸.\n');
    expect(doc.lines).toEqual(['# Требования', '', 'Ф-1. Лимит 500 000 ₸.', '']);
    expect(doc.pageOfLine).toBeUndefined();
    const repaired = doc.diagnostics.filter((d) => d.code === 'encoding_repaired');
    expect(repaired).toHaveLength(1);
    expect(repaired[0]).toMatchObject({ level: 'info' });
    expect(repaired[0]?.message).toMatch(/BOM.*CRLF/);
  });

  it('adds no diagnostics for a clean UTF-8 file', async () => {
    const doc = await loadDocument(await put('clean.txt', 'Система должна отвечать за 2 секунды.\n'));
    expect(doc.format).toBe('txt');
    expect(doc.diagnostics).toEqual([]);
  });

  it('repairs windows-1251 text', async () => {
    const text = 'Требование №1: «Система должна» хранить журнал — 5 лет.\nЁжик ёлка.\n';
    const reference = new TextDecoder('windows-1251');
    const table = Buffer.from(Array.from({ length: 128 }, (_, i) => i + 0x80).filter((b) => b !== 0x98));
    const cp1251 = Buffer.concat([table, Buffer.from('\n')]);
    // Encode through the reference decoder's inverse: every char of `text` is a single cp1251 byte.
    const reverse = new Map<string, number>();
    for (let b = 0; b < 256; b++) reverse.set(reference.decode(Uint8Array.of(b)), b);
    const encoded = Buffer.from(Array.from(text, (ch) => reverse.get(ch) ?? 0x3f));

    const doc = await loadDocument(await put('legacy.txt', Buffer.concat([encoded, cp1251])));
    expect(doc.format).toBe('txt');
    expect(doc.text.startsWith(text)).toBe(true);
    expect(doc.text).toBe(reference.decode(Buffer.concat([encoded, cp1251])));
    const repaired = doc.diagnostics.find((d) => d.code === 'encoding_repaired');
    expect(repaired?.message).toMatch(/windows-1251/);
    expect(repaired?.hint).toMatch(/UTF-8/);
  });

  it('keeps UTF-8 when only a few bytes are damaged', async () => {
    const bytes = Buffer.concat([Buffer.from('Система должна хранить журнал операций пять лет. ', 'utf8'), Buffer.from([0xd0])]);
    const doc = await loadDocument(await put('cut.txt', bytes));
    expect(doc.text).toContain('Система должна хранить журнал');
    expect(doc.diagnostics.find((d) => d.code === 'encoding_repaired')).toMatchObject({ level: 'warning' });
  });

  it('reads UTF-16 with BOM', async () => {
    const bytes = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('Ф-1. Лимит 100 ₸.\r\n', 'utf16le')]);
    const doc = await loadDocument(await put('utf16.txt', bytes));
    expect(doc.text).toBe('Ф-1. Лимит 100 ₸.\n');
    expect(doc.diagnostics.some((d) => d.code === 'encoding_repaired' && /UTF-16LE/.test(d.message))).toBe(true);
  });

  it('reads plain text behind a .pdf extension by content', async () => {
    const doc = await loadDocument(await put('really-text.pdf', 'Ф-1. Система должна вести журнал.\n'));
    expect(doc.format).toBe('txt');
    expect(doc.text).toBe('Ф-1. Система должна вести журнал.\n');
    expect(doc.diagnostics).toContainEqual(expect.objectContaining({ level: 'info', code: 'note' }));
  });

  it('reads a text file with an unknown extension as text and says so', async () => {
    const doc = await loadDocument(await put('spec.rst', 'Требования\n==========\n'));
    expect(doc.format).toBe('txt');
    expect(doc.diagnostics).toContainEqual(expect.objectContaining({ level: 'info', code: 'note' }));
  });
});

describe('fatal problems', () => {
  it('missing file', async () => {
    const diagnostic = await expectFatal(join(dir, 'нет-такого.md'), 'file_not_found');
    expect(diagnostic.message).toContain('нет-такого.md');
  });

  it('directory', async () => {
    const sub = join(dir, 'folder.md');
    await mkdir(sub);
    await expectFatal(sub, 'not_a_file');
  });

  it('empty file', async () => {
    await expectFatal(await put('empty.md', ''), 'empty_file');
  });

  it('whitespace-only file', async () => {
    await expectFatal(await put('blank.txt', ' \r\n\t\n  \n'), 'empty_file');
  });

  it('file larger than maxBytes', async () => {
    const diagnostic = await expectFatal(await put('big.md', 'а'.repeat(2000)), 'too_large', { maxBytes: 1024 });
    expect(diagnostic.message).toMatch(/3,9 КБ.*1,0 КБ/);
  });

  it('random binary with .pdf extension', async () => {
    await expectFatal(await put('noise.pdf', noise(4096)), 'corrupted');
  });

  it('random binary with .txt extension', async () => {
    await expectFatal(await put('noise.txt', noise(4096, 7)), 'binary_content');
  });

  it('unsupported .xlsx names the detected type and lists supported formats', async () => {
    const xlsx = zipStore({ '[Content_Types].xml': '<Types/>', 'xl/workbook.xml': '<workbook/>' });
    const diagnostic = await expectFatal(await put('table.xlsx', xlsx), 'unsupported_format');
    expect(diagnostic.message).toContain('Excel');
    expect(diagnostic.hint).toMatch(/PDF.*DOCX/);
  });

  it('unsupported image', async () => {
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), noise(256)]);
    const diagnostic = await expectFatal(await put('scan.png', png), 'unsupported_format');
    expect(diagnostic.message).toContain('PNG');
    expect(diagnostic.hint).toContain('OCR');
  });

  it('unknown binary without a known extension', async () => {
    await expectFatal(await put('data.bin', noise(4096, 3)), 'unsupported_format');
  });

  it('garbage .docx', async () => {
    await expectFatal(await put('garbage.docx', noise(4096, 5)), 'corrupted');
  });

  it('.docx that is a ZIP without word/document.xml', async () => {
    await expectFatal(await put('not-word.docx', zipStore({ 'readme.txt': 'hello' })), 'corrupted');
  });

  it('.docx with a ZIP signature and a broken archive', async () => {
    const broken = Buffer.concat([Buffer.from('PK\x03\x04', 'latin1'), Buffer.from('word/document.xml'), noise(2048, 9)]);
    await expectFatal(await put('broken.docx', broken), 'corrupted');
  });
});

describe('pdf', () => {
  it(
    'extracts text and pages from a real PDF',
    async () => {
      const doc = await loadDocument(await put('spec.pdf', pdfBytes));

      expect(doc.format).toBe('pdf');
      expect(doc.pages).toBe(2);
      expect(doc.sha256).toBe(createHash('sha256').update(pdfBytes).digest('hex'));
      expect(doc.lines).toEqual(doc.text.split('\n'));
      expect(doc.pageOfLine).toHaveLength(doc.lines.length);
      expect(doc.lines[0]).toBe('Требования к переводам');
      expect(doc.pageOfLine?.[0]).toBe(1);
      expect(doc.pageOfLine?.at(-1)).toBe(2);

      const flat = doc.text.replace(/\s+/g, ' ');
      expect(flat).toContain('составляет 150 ₸');
      expect(flat).toContain('не более 5 000 ₸');
      const secondPageStart = doc.lines.findIndex((line) => line.startsWith('Ф-2.'));
      expect(doc.pageOfLine?.[secondPageStart]).toBe(2);
      expect(doc.diagnostics).toEqual([]);
    },
    PDF_TIMEOUT,
  );

  it(
    'parses PDF bytes behind a .md extension as PDF with an info diagnostic',
    async () => {
      const doc = await loadDocument(await put('really-pdf.md', pdfBytes));
      expect(doc.format).toBe('pdf');
      expect(doc.pages).toBe(2);
      const note = doc.diagnostics.find((d) => d.code === 'note');
      expect(note).toMatchObject({ level: 'info' });
      expect(note?.message).toContain('PDF');
    },
    PDF_TIMEOUT,
  );

  it(
    'truncated PDF is fatal',
    async () => {
      const half = pdfBytes.subarray(0, Math.floor(pdfBytes.length / 2));
      const diagnostic = await expectFatal(await put('half.pdf', half), 'corrupted');
      expect(diagnostic.message).toContain('обрезан');
    },
    PDF_TIMEOUT,
  );

  it(
    'PDF without text is reported as a scan',
    async () => {
      const empty = await makePdf({ content: [{ text: '' }] });
      const diagnostic = await expectFatal(await put('scan.pdf', empty), 'no_text_layer');
      expect(diagnostic.hint).toContain('OCR');
    },
    PDF_TIMEOUT,
  );

  it(
    'password-protected PDF',
    async () => {
      const locked = await makePdf({ userPassword: 'not-a-real-secret', content: ['Секретные требования'] });
      await expectFatal(await put('locked.pdf', locked), 'encrypted');
    },
    PDF_TIMEOUT,
  );

  it(
    'warns about low text density',
    async () => {
      const sparse = await makePdf({ content: ['Ф-1. Комиссия 150 ₸.', { text: '', pageBreak: 'before' }] });
      const doc = await loadDocument(await put('sparse.pdf', sparse));
      expect(doc.pages).toBe(2);
      expect(doc.pageOfLine).toHaveLength(doc.lines.length);
      const warning = doc.diagnostics.find((d) => d.code === 'low_text_density');
      expect(warning).toMatchObject({ level: 'warning' });
      expect(warning?.message).toContain('страницы без текста: 2');
    },
    PDF_TIMEOUT,
  );
});

describe('docx', () => {
  it('extracts headings, lists of paragraphs and tables from a minimal DOCX', async () => {
    const docx = makeDocx(
      para('Требования к переводам', 'Heading1') +
        para('Ф-1. Комиссия составляет 1.5% (не менее 150 ₸) — см. п. 2_1 [черновик].') +
        `<w:tbl><w:tr>${cell('Код')}${cell('Описание')}</w:tr><w:tr>${cell('E-01')}${cell('Недостаточно средств')}</w:tr></w:tbl>`,
    );
    const doc = await loadDocument(await put('spec.docx', docx));

    expect(doc.format).toBe('docx');
    expect(doc.lines).toEqual([
      '# Требования к переводам',
      '',
      'Ф-1. Комиссия составляет 1.5% (не менее 150 ₸) — см. п. 2_1 [черновик].',
      '',
      '| Код | Описание |',
      '| --- | --- |',
      '| E-01 | Недостаточно средств |',
    ]);
    expect(doc.pageOfLine).toBeUndefined();
  });

  it('DOCX without text is an empty document', async () => {
    await expectFatal(await put('blank.docx', makeDocx('<w:p/>')), 'empty_file');
  });
});

describe('html', () => {
  it('converts headings, lists, tables and drops scripts', async () => {
    const html = `<!DOCTYPE html>
<html><head><title>Спецификация</title><style>p { color: red; }</style></head>
<body>
<script>var secret = "не требование";</script>
<h1>Требования &laquo;Переводы&raquo;</h1>
<p>Комиссия&nbsp;&mdash; 150&#160;&#x20B8;,
   если сумма &lt; 10&nbsp;000.</p>
<h2>Ограничения</h2>
<ul><li>Лимит в сутки</li><li>Лимит <b>в месяц</b><ol><li>для физлиц</li></ol></li></ul>
<table>
  <tr><th>Код</th><th>Описание</th></tr>
  <tr><td>E-01</td><td>Недостаточно<br>средств</td></tr>
</table>
<pre>GET /transfers
  ?limit=10</pre>
<img src="scheme.png" alt="Схема">
<!-- <p>закомментировано</p> -->
</body></html>`;
    const doc = await loadDocument(await put('spec.html', html));

    expect(doc.format).toBe('html');
    expect(doc.lines).toEqual([
      '# Требования «Переводы»',
      '',
      'Комиссия — 150 ₸, если сумма < 10 000.',
      '',
      '## Ограничения',
      '',
      '- Лимит в сутки',
      '- Лимит в месяц',
      '  1. для физлиц',
      '',
      '| Код | Описание |',
      '| --- | --- |',
      '| E-01 | Недостаточно средств |',
      '',
      '```',
      'GET /transfers',
      '  ?limit=10',
      '```',
    ]);
    expect(doc.text).not.toMatch(/secret|color|закомментировано|Спецификация/);
    expect(doc.diagnostics).toContainEqual(expect.objectContaining({ level: 'info', code: 'note' }));
  });

  it('HTML without visible text is empty', async () => {
    await expectFatal(await put('shell.html', '<html><body><script>render()</script><div></div></body></html>'), 'empty_file');
  });
});
