import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { basename, extname } from 'node:path';
import { LoadError, type Diagnostic, type DiagnosticCode, type DocFormat, type SourceDoc } from '../types.js';

const DEFAULT_MAX_BYTES = 20 * 1024 * 1024;
const LOW_DENSITY_CHARS_PER_PAGE = 200;
const BINARY_RATIO = 0.02;

const SUPPORTED = 'Markdown (.md), текст (.txt), PDF, DOCX, HTML';

const EXT_FORMAT: Readonly<Record<string, DocFormat>> = {
  '.md': 'md',
  '.markdown': 'md',
  '.txt': 'txt',
  '.pdf': 'pdf',
  '.docx': 'docx',
  '.html': 'html',
  '.htm': 'html',
};

const FORMAT_LABEL: Readonly<Record<DocFormat, string>> = {
  md: 'Markdown',
  txt: 'обычный текст',
  pdf: 'PDF',
  docx: 'DOCX',
  html: 'HTML',
};

type TextEncoding = 'utf-8' | 'utf-16le' | 'utf-16be' | 'windows-1251';

export type Sniff =
  | { kind: 'ok'; format: DocFormat; extFormat: DocFormat | null; by: 'magic' | 'extension' | 'content' }
  | {
      kind: 'unsupported' | 'corrupted' | 'binary';
      extFormat: DocFormat | null;
      /** What the file actually is, in Russian, for messages. */
      detected: string;
      /** Format-specific advice, when the generic one is not enough. */
      advice?: string;
    };

const SIGNATURES: readonly { bytes: readonly number[]; detected: string; advice: string }[] = [
  {
    bytes: [0x89, 0x50, 0x4e, 0x47],
    detected: 'изображение PNG',
    advice: 'Распознайте текст на изображении (OCR) и передайте результат как PDF с текстовым слоем, DOCX или текст.',
  },
  {
    bytes: [0xff, 0xd8, 0xff],
    detected: 'изображение JPEG',
    advice: 'Распознайте текст на изображении (OCR) и передайте результат как PDF с текстовым слоем, DOCX или текст.',
  },
  {
    bytes: [0x47, 0x49, 0x46, 0x38],
    detected: 'изображение GIF',
    advice: 'Распознайте текст на изображении (OCR) и передайте результат как PDF с текстовым слоем, DOCX или текст.',
  },
  {
    bytes: [0x49, 0x49, 0x2a, 0x00],
    detected: 'изображение TIFF',
    advice: 'Распознайте текст на изображении (OCR) и передайте результат как PDF с текстовым слоем, DOCX или текст.',
  },
  {
    bytes: [0x4d, 0x4d, 0x00, 0x2a],
    detected: 'изображение TIFF',
    advice: 'Распознайте текст на изображении (OCR) и передайте результат как PDF с текстовым слоем, DOCX или текст.',
  },
  {
    bytes: [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1],
    detected: 'документ старого формата Microsoft Office (DOC/XLS/PPT) или документ, защищённый паролем',
    advice: 'Откройте файл в Word, снимите защиту паролем, если она есть, и сохраните его как DOCX или PDF.',
  },
  {
    bytes: [0x7b, 0x5c, 0x72, 0x74, 0x66],
    detected: 'документ RTF',
    advice: 'Откройте файл в текстовом редакторе и сохраните его как DOCX или PDF.',
  },
  { bytes: [0x1f, 0x8b], detected: 'архив GZIP', advice: 'Распакуйте архив и передайте сам документ.' },
  {
    bytes: [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c],
    detected: 'архив 7z',
    advice: 'Распакуйте архив и передайте сам документ.',
  },
  {
    bytes: [0x52, 0x61, 0x72, 0x21, 0x1a, 0x07],
    detected: 'архив RAR',
    advice: 'Распакуйте архив и передайте сам документ.',
  },
];

const ZIP_KINDS: readonly { marker: string; detected: string; advice: string }[] = [
  {
    marker: 'xl/workbook.xml',
    detected: 'таблица Excel (XLSX)',
    advice: 'Перенесите требования в текстовый документ или экспортируйте таблицу в PDF с текстовым слоем.',
  },
  {
    marker: 'ppt/presentation.xml',
    detected: 'презентация PowerPoint (PPTX)',
    advice: 'Экспортируйте презентацию в PDF с текстовым слоем.',
  },
  {
    marker: 'application/vnd.oasis.opendocument',
    detected: 'документ OpenDocument (ODT/ODS/ODP)',
    advice: 'Сохраните документ как DOCX или PDF.',
  },
  { marker: 'application/epub+zip', detected: 'книга EPUB', advice: 'Сохраните документ как PDF или DOCX.' },
];

function fail(code: DiagnosticCode, message: string, hint: string): never {
  throw new LoadError({ level: 'error', code, message, hint });
}

function startsWith(bytes: Uint8Array, signature: readonly number[], offset = 0): boolean {
  if (bytes.length < offset + signature.length) return false;
  return signature.every((b, i) => bytes[offset + i] === b);
}

/** Offset of the first byte that is not a UTF-8 BOM or ASCII whitespace. */
function contentStart(bytes: Uint8Array): number {
  let i = startsWith(bytes, [0xef, 0xbb, 0xbf]) ? 3 : 0;
  while (i < bytes.length && i < 1024) {
    const b = bytes[i];
    if (b !== 0x20 && b !== 0x09 && b !== 0x0a && b !== 0x0d) break;
    i++;
  }
  return i;
}

function detectUtf16(bytes: Uint8Array): 'utf-16le' | 'utf-16be' | null {
  if (startsWith(bytes, [0xff, 0xfe])) return 'utf-16le';
  if (startsWith(bytes, [0xfe, 0xff])) return 'utf-16be';
  // No BOM: text in UTF-16 has a zero in every second byte for ASCII and none in the other half.
  const pairs = Math.min(bytes.length, 4096) >> 1;
  if (pairs < 4) return null;
  let evenZeros = 0;
  let oddZeros = 0;
  for (let i = 0; i < pairs; i++) {
    if (bytes[2 * i] === 0) evenZeros++;
    if (bytes[2 * i + 1] === 0) oddZeros++;
  }
  if (oddZeros > pairs * 0.4 && evenZeros < pairs * 0.05) return 'utf-16le';
  if (evenZeros > pairs * 0.4 && oddZeros < pairs * 0.05) return 'utf-16be';
  return null;
}

/** Share of control bytes that never occur in text; a trailing run of NULs is padding and is ignored. */
function controlRatio(bytes: Uint8Array): number {
  let end = bytes.length;
  while (end > 0 && bytes[end - 1] === 0) end--;
  if (end === 0) return 0;
  let control = 0;
  for (let i = 0; i < end; i++) {
    const b = bytes[i] ?? 0;
    if (b === 0x7f || (b < 0x20 && b !== 0x09 && b !== 0x0a && b !== 0x0c && b !== 0x0d && b !== 0x1b)) control++;
  }
  return control / end;
}

function looksLikeHtml(bytes: Uint8Array): boolean {
  const start = contentStart(bytes);
  const head = Buffer.from(bytes.subarray(start, start + 256)).toString('latin1');
  return /^(?:<!doctype\s+html|<html[\s>])/i.test(head);
}

/** Decides how to read the file: magic bytes first, then the extension, then whether the content is text at all. */
export function sniffFormat(bytes: Uint8Array, path: string): Sniff {
  const ext = extname(path).toLowerCase();
  const extFormat = EXT_FORMAT[ext] ?? null;
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const pdfSignature = [0x25, 0x50, 0x44, 0x46, 0x2d];

  if (startsWith(bytes, pdfSignature, contentStart(bytes))) return { kind: 'ok', format: 'pdf', extFormat, by: 'magic' };
  // Readers accept junk before the header within the first kilobyte; only trust that for files named .pdf.
  if (extFormat === 'pdf' && buf.subarray(0, 1024).includes('%PDF-', 0, 'latin1')) {
    return { kind: 'ok', format: 'pdf', extFormat, by: 'magic' };
  }

  if (startsWith(bytes, [0x50, 0x4b, 0x03, 0x04]) || startsWith(bytes, [0x50, 0x4b, 0x05, 0x06])) {
    if (buf.includes('word/document.xml', 0, 'latin1')) return { kind: 'ok', format: 'docx', extFormat, by: 'magic' };
    if (extFormat === 'docx') {
      return { kind: 'corrupted', extFormat, detected: 'ZIP-архив без основной части документа (word/document.xml)' };
    }
    const known = ZIP_KINDS.find((k) => buf.includes(k.marker, 0, 'latin1'));
    return known
      ? { kind: 'unsupported', extFormat, detected: known.detected, advice: known.advice }
      : { kind: 'unsupported', extFormat, detected: 'ZIP-архив', advice: 'Распакуйте архив и передайте сам документ.' };
  }

  const signature = SIGNATURES.find((s) => startsWith(bytes, s.bytes));
  if (signature) return { kind: 'unsupported', extFormat, detected: signature.detected, advice: signature.advice };

  if (detectUtf16(bytes) === null && controlRatio(bytes) > BINARY_RATIO) {
    const detected = 'двоичный файл неизвестного типа';
    if (extFormat === 'pdf' || extFormat === 'docx') return { kind: 'corrupted', extFormat, detected };
    if (extFormat !== null) return { kind: 'binary', extFormat, detected };
    return { kind: 'unsupported', extFormat, detected };
  }

  if (extFormat === 'md' || extFormat === 'txt' || extFormat === 'html') {
    return { kind: 'ok', format: extFormat, extFormat, by: 'extension' };
  }
  return { kind: 'ok', format: looksLikeHtml(bytes) ? 'html' : 'txt', extFormat, by: 'content' };
}

/**
 * Strips the BOM and trailing NULs and unifies line endings. Characters inside lines are left alone
 * (including non-breaking spaces): quotes are later verified verbatim against this text.
 */
export function normalizeText(raw: string): string {
  let end = raw.length;
  while (end > 0 && raw.charCodeAt(end - 1) === 0) end--;
  const start = raw.charCodeAt(0) === 0xfeff ? 1 : 0;
  return raw.slice(start, end).replace(/\r\n?/g, '\n');
}

// windows-1251 bytes 0x80–0xBF; 0xC0–0xFF map linearly onto U+0410–U+044F.
const CP1251_HIGH =
  'ЂЃ‚ѓ„…†‡€‰Љ‹ЊЌЋЏђ‘’“”•–—\u0098™љ›њќћџ ЎўЈ¤Ґ¦§Ё©Є«¬­®Ї°±Ііґµ¶·ё№є»јЅѕї';

// Own table instead of TextDecoder('windows-1251'): that label needs a Node build with full ICU.
function decodeCp1251(bytes: Uint8Array): string {
  const codes = new Uint16Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i] ?? 0;
    codes[i] = b < 0x80 ? b : b >= 0xc0 ? 0x410 + b - 0xc0 : CP1251_HIGH.charCodeAt(b - 0x80);
  }
  const parts: string[] = [];
  for (let i = 0; i < codes.length; i += 8192) parts.push(String.fromCharCode(...codes.subarray(i, i + 8192)));
  return parts.join('');
}

interface Decoded {
  text: string;
  encoding: TextEncoding;
  /** Bytes replaced with U+FFFD when the file is UTF-8 with a few damaged sequences. */
  replaced: number;
}

function decodeText(bytes: Uint8Array): Decoded {
  const utf16 = detectUtf16(bytes);
  if (utf16) {
    const even = Buffer.from(bytes.subarray(0, bytes.length - (bytes.length % 2)));
    if (utf16 === 'utf-16be') even.swap16();
    return { text: even.toString('utf16le'), encoding: utf16, replaced: 0 };
  }
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(bytes), encoding: 'utf-8', replaced: 0 };
  } catch {
    // Invalid UTF-8. A single-byte Cyrillic file breaks on nearly every high byte; a UTF-8 file with
    // a damaged tail or a stray byte breaks on a few. Tell them apart by the share of broken bytes.
    const lossy = new TextDecoder('utf-8').decode(bytes);
    let replaced = 0;
    for (let i = lossy.indexOf('�'); i !== -1; i = lossy.indexOf('�', i + 1)) replaced++;
    let high = 0;
    for (const b of bytes) if (b >= 0x80) high++;
    if (replaced * 10 < high) return { text: lossy, encoding: 'utf-8', replaced };
    return { text: decodeCp1251(bytes), encoding: 'windows-1251', replaced: 0 };
  }
}

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', shy: '',
  laquo: '«', raquo: '»', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', sbquo: '‚', bdquo: '„',
  mdash: '—', ndash: '–', minus: '−', hellip: '…', bull: '•', middot: '·',
  copy: '©', reg: '®', trade: '™', sect: '§', para: '¶', deg: '°', micro: 'µ', permil: '‰',
  plusmn: '±', times: '×', divide: '÷', le: '≤', ge: '≥', ne: '≠', asymp: '≈', infin: '∞',
  euro: '€', pound: '£', yen: '¥', cent: '¢',
  rarr: '→', larr: '←', harr: '↔', uarr: '↑', darr: '↓',
  frac12: '½', frac14: '¼', frac34: '¾', sup2: '²', sup3: '³',
  thinsp: ' ', ensp: ' ', emsp: ' ', zwnj: '', zwj: '', lrm: '', rlm: '',
};

function decodeEntities(text: string): string {
  return text.replace(/&(#[xX][0-9a-fA-F]{1,6}|#[0-9]{1,7}|[a-zA-Z][a-zA-Z0-9]{1,31});/g, (whole, body: string) => {
    if (body.startsWith('#')) {
      const hex = body[1] === 'x' || body[1] === 'X';
      const code = hex ? Number.parseInt(body.slice(2), 16) : Number.parseInt(body.slice(1), 10);
      const valid = code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff);
      return valid ? String.fromCodePoint(code) : whole;
    }
    return NAMED_ENTITIES[body] ?? NAMED_ENTITIES[body.toLowerCase()] ?? whole;
  });
}

const HTML_RAW_SKIP: ReadonlySet<string> = new Set(['script', 'style', 'noscript', 'template', 'svg', 'title', 'iframe']);

const HTML_BLOCK: ReadonlySet<string> = new Set([
  'p', 'div', 'section', 'article', 'header', 'footer', 'main', 'aside', 'nav', 'blockquote', 'figure',
  'figcaption', 'address', 'dl', 'dt', 'dd', 'form', 'fieldset', 'details', 'summary', 'hr', 'center',
  'caption', 'body', 'html',
]);

/** Tags that separate words when they occur inside a table cell. */
const HTML_CELL_BREAK: ReadonlySet<string> = new Set([
  ...HTML_BLOCK, 'br', 'li', 'ul', 'ol', 'pre', 'tr', 'td', 'th', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
]);

function collapse(text: string): string {
  return text.replace(/[ \t\n\r\f]+/g, ' ').trim();
}

class HtmlWriter {
  images = 0;
  private lines: string[] = [];
  private buf = '';
  private prefix = '';
  private heading = false;
  private pre = false;
  private lists: { ordered: boolean; n: number }[] = [];
  private tableDepth = 0;
  private tableRows = 0;
  private row: string[] | null = null;
  private cell: string | null = null;
  private span = 1;

  text(raw: string): void {
    // Soft hyphens are invisible in a browser and would split words for every later text match.
    const text = decodeEntities(raw).replace(/­/g, '');
    if (this.cell !== null) this.cell += text;
    else this.buf += text;
  }

  open(tag: string, attrs: string): void {
    if (this.pre) {
      if (tag === 'br') this.buf += '\n';
      return;
    }
    if (tag === 'img') this.images++;
    if (tag === 'table') {
      if (this.tableDepth++ === 0) {
        this.flush();
        this.blank();
        this.tableRows = 0;
      } else if (this.cell !== null) this.cell += ' ';
      return;
    }
    if (this.tableDepth > 0) {
      if (this.tableDepth === 1 && tag === 'tr') {
        this.endRow();
        this.flush();
        this.row = [];
        return;
      }
      if (this.tableDepth === 1 && (tag === 'td' || tag === 'th')) {
        this.endCell();
        this.row ??= [];
        this.cell = '';
        const colspan = /\bcolspan\s*=\s*["']?(\d+)/i.exec(attrs);
        this.span = Math.min(Math.max(Number(colspan?.[1] ?? 1), 1), 50);
        return;
      }
      if (this.cell !== null) {
        if (HTML_CELL_BREAK.has(tag)) this.cell += ' ';
        return;
      }
    }

    const level = /^h([1-6])$/.exec(tag)?.[1];
    if (level) {
      this.flush();
      this.blank();
      this.prefix = `${'#'.repeat(Number(level))} `;
      this.heading = true;
    } else if (tag === 'ul' || tag === 'ol') {
      this.flush();
      if (this.lists.length === 0) this.blank();
      this.lists.push({ ordered: tag === 'ol', n: 0 });
    } else if (tag === 'li') {
      this.flush();
      const list = this.lists.at(-1);
      const marker = list?.ordered ? `${++list.n}. ` : '- ';
      this.prefix = '  '.repeat(Math.max(this.lists.length - 1, 0)) + marker;
    } else if (tag === 'br') {
      if (this.heading) this.buf += ' ';
      else this.flush();
    } else if (tag === 'pre') {
      this.flush();
      this.blank();
      this.lines.push('```');
      this.pre = true;
    } else if (HTML_BLOCK.has(tag)) {
      this.flush();
      if (this.lists.length === 0) this.blank();
    }
  }

  close(tag: string): void {
    if (this.pre) {
      if (tag === 'pre') this.endPre();
      return;
    }
    if (tag === 'table') {
      if (this.tableDepth === 0) return;
      if (--this.tableDepth === 0) {
        this.endRow();
        this.blank();
      } else if (this.cell !== null) this.cell += ' ';
      return;
    }
    if (this.tableDepth > 0) {
      if (this.tableDepth === 1 && tag === 'tr') return this.endRow();
      if (this.tableDepth === 1 && (tag === 'td' || tag === 'th')) return this.endCell();
      if (this.cell !== null) {
        if (HTML_CELL_BREAK.has(tag)) this.cell += ' ';
        return;
      }
    }

    if (/^h[1-6]$/.test(tag)) {
      this.flush();
      this.prefix = '';
      this.blank();
    } else if (tag === 'ul' || tag === 'ol') {
      this.flush();
      this.lists.pop();
      this.prefix = '';
      if (this.lists.length === 0) this.blank();
    } else if (tag === 'li') {
      this.flush();
      this.prefix = '';
    } else if (HTML_BLOCK.has(tag)) {
      this.flush();
      if (this.lists.length === 0) this.blank();
    }
  }

  finish(): string {
    if (this.pre) this.endPre();
    this.endRow();
    this.flush();
    let start = 0;
    let end = this.lines.length;
    while (start < end && this.lines[start] === '') start++;
    while (end > start && this.lines[end - 1] === '') end--;
    return this.lines.slice(start, end).join('\n');
  }

  private flush(): void {
    const text = collapse(this.buf);
    this.buf = '';
    if (text) this.lines.push(this.prefix + text);
    if (this.heading) {
      this.heading = false;
      this.prefix = '';
    } else if (text) {
      // Further lines of the same list item align under its text instead of repeating the marker.
      this.prefix = ' '.repeat(this.prefix.length);
    }
  }

  private blank(): void {
    if (this.lines.length > 0 && this.lines[this.lines.length - 1] !== '') this.lines.push('');
  }

  private endPre(): void {
    const code = this.buf.replace(/\r\n?/g, '\n').replace(/^\n/, '').replace(/\n$/, '');
    this.buf = '';
    this.lines.push(...code.split('\n'), '```');
    this.pre = false;
    this.blank();
  }

  private endCell(): void {
    if (this.cell === null) return;
    this.row ??= [];
    this.row.push(collapse(this.cell).replace(/\|/g, '\\|'));
    for (let i = 1; i < this.span; i++) this.row.push('');
    this.cell = null;
    this.span = 1;
  }

  private endRow(): void {
    this.endCell();
    const row = this.row;
    this.row = null;
    if (!row || row.every((c) => c === '')) return;
    this.lines.push(`| ${row.join(' | ')} |`);
    if (this.tableRows++ === 0) this.lines.push(`| ${row.map(() => '---').join(' | ')} |`);
  }
}

function htmlToText(html: string): { text: string; images: number } {
  const writer = new HtmlWriter();
  const token = /<!--[\s\S]*?(?:-->|$)|<(\/?)([a-zA-Z][a-zA-Z0-9:-]*)((?:"[^"]*"|'[^']*'|[^'">])*)>|<[!?][^>]*>/g;
  let last = 0;
  for (let m = token.exec(html); m; m = token.exec(html)) {
    if (m.index > last) writer.text(html.slice(last, m.index));
    last = token.lastIndex;
    const tag = m[2]?.toLowerCase();
    if (!tag) continue;
    if (m[1] === '/') {
      writer.close(tag);
    } else if (HTML_RAW_SKIP.has(tag)) {
      const closing = new RegExp(`</${tag}\\s*>`, 'gi');
      closing.lastIndex = last;
      last = closing.exec(html) ? closing.lastIndex : html.length;
      token.lastIndex = last;
    } else {
      writer.open(tag, m[3] ?? '');
    }
  }
  if (last < html.length) writer.text(html.slice(last));
  return { text: writer.finish(), images: writer.images };
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} байт`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1).replace('.', ',')} КБ`;
  return `${(bytes / (1024 * 1024)).toFixed(1).replace('.', ',')} МБ`;
}

function errorCode(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string') return error.code;
  return '';
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function failFs(error: unknown, path: string): never {
  const code = errorCode(error);
  if (code === 'ENOENT' || code === 'ENOTDIR') {
    fail('file_not_found', `Файл не найден: ${path}.`, 'Проверьте путь и имя файла; путь с пробелами возьмите в кавычки.');
  }
  if (code === 'EISDIR') {
    fail('not_a_file', `Путь указывает на папку, а не на файл: ${path}.`, `Укажите путь к одному документу: ${SUPPORTED}.`);
  }
  if (code === 'EACCES' || code === 'EPERM') {
    fail(
      'file_not_found',
      `Файл недоступен: нет прав на чтение ${path}.`,
      'Выдайте права на чтение файла или скопируйте его в папку, доступную текущему пользователю.',
    );
  }
  fail(
    'file_not_found',
    `Файл не удалось открыть: ${path} (${code || errorText(error)}).`,
    'Проверьте путь и то, что файл доступен (например, диск подключён), и запустите проверку снова.',
  );
}

function imagesNote(images: number): Diagnostic {
  return {
    level: 'info',
    code: 'note',
    message: `В документе есть изображения (${images} шт.): их содержимое агент не читает.`,
    hint: 'Если на изображениях есть требования (схемы, таблицы, скриншоты), продублируйте их текстом.',
  };
}

interface Extracted {
  text: string;
  lines?: string[];
  pageOfLine?: number[];
  pages?: number;
}

function loadText(bytes: Uint8Array, format: 'md' | 'txt' | 'html', name: string, diagnostics: Diagnostic[]): Extracted {
  const decoded = decodeText(bytes);
  if (decoded.encoding === 'windows-1251') {
    diagnostics.push({
      level: 'warning',
      code: 'encoding_repaired',
      message: `Файл ${name} не в кодировке UTF-8: он прочитан как windows-1251.`,
      hint: 'Если в отчёте вместо текста нечитаемые символы, пересохраните документ в UTF-8.',
    });
  } else if (decoded.encoding !== 'utf-8') {
    diagnostics.push({
      level: 'info',
      code: 'encoding_repaired',
      message: `Файл ${name} в кодировке ${decoded.encoding.toUpperCase()}: он перекодирован в UTF-8.`,
    });
  } else if (decoded.replaced > 0) {
    diagnostics.push({
      level: 'warning',
      code: 'encoding_repaired',
      message: `В файле ${name} есть повреждённые последовательности UTF-8 (${decoded.replaced} шт.): они заменены символом «�».`,
      hint: 'Проверьте, что файл скопирован полностью, и пересохраните его в UTF-8.',
    });
  }

  const hadBom = decoded.text.charCodeAt(0) === 0xfeff || startsWith(bytes, [0xef, 0xbb, 0xbf]);
  const hadCr = decoded.text.includes('\r');
  const hadNul = decoded.text.endsWith('\0');
  const normalized = normalizeText(decoded.text);

  if (format === 'html') {
    const { text, images } = htmlToText(normalized);
    if (!text.trim()) {
      fail(
        'empty_file',
        `В файле ${name} нет текста: после удаления разметки HTML ничего не осталось.`,
        'Проверьте, что страница сохранена целиком, а не только её каркас; текст, который подгружается скриптами, в файл не попадает.',
      );
    }
    if (images > 0) diagnostics.push(imagesNote(images));
    return { text };
  }

  if (!normalized.trim()) {
    fail(
      'empty_file',
      `В файле ${name} нет текста: только пробелы и пустые строки.`,
      'Проверьте, что документ сохранён и выгружен полностью, и запустите проверку снова.',
    );
  }
  const fixes = [
    hadBom ? 'удалена метка BOM' : '',
    hadCr ? 'переводы строк CRLF/CR заменены на LF' : '',
    hadNul ? 'удалены нулевые байты в конце файла' : '',
  ].filter(Boolean);
  if (fixes.length > 0) {
    diagnostics.push({
      level: 'info',
      code: 'encoding_repaired',
      message: `Текст файла ${name} нормализован: ${fixes.join(', ')}.`,
    });
  }
  return { text: normalized };
}

async function loadPdf(bytes: Uint8Array, name: string, diagnostics: Diagnostic[]): Promise<Extracted> {
  const tail = Buffer.from(bytes.subarray(Math.max(bytes.length - 2048, 0))).toString('latin1');
  const hasEof = tail.includes('%%EOF');
  let pageTexts: string[];
  try {
    const { extractText, getDocumentProxy } = await import('unpdf');
    // pdf.js takes ownership of the buffer it is given, so it gets a copy. verbosity 0 keeps its warnings off stdout.
    const pdf = await getDocumentProxy(new Uint8Array(bytes), { verbosity: 0 });
    try {
      pageTexts = (await extractText(pdf, { mergePages: false })).text;
    } finally {
      await pdf.loadingTask.destroy().catch(() => undefined);
    }
  } catch (error) {
    if (error instanceof Error && (error.name === 'PasswordException' || /password/i.test(error.message))) {
      fail(
        'encrypted',
        `PDF ${name} защищён паролем: его содержимое нельзя прочитать.`,
        'Откройте документ с паролем и сохраните копию без защиты (например, через «Печать → Сохранить как PDF»), затем проверьте копию.',
      );
    }
    if (!hasEof) {
      fail(
        'corrupted',
        `PDF ${name} обрезан: в конце файла нет маркера %%EOF, структуру документа разобрать не удалось.`,
        'Файл скачан или скопирован не полностью. Получите его заново и проверьте, что он открывается в программе просмотра PDF.',
      );
    }
    fail(
      'corrupted',
      `PDF ${name} повреждён: структуру документа разобрать не удалось (${errorText(error)}).`,
      'Проверьте, что файл открывается в программе просмотра PDF, и экспортируйте его заново из исходного документа.',
    );
  }

  const lines: string[] = [];
  const pageOfLine: number[] = [];
  const charsPerPage: number[] = [];
  pageTexts.forEach((pageText, index) => {
    const pageLines = normalizeText(pageText).split('\n');
    if (pageLines.length > 1 && pageLines[pageLines.length - 1] === '') pageLines.pop();
    for (const line of pageLines) {
      lines.push(line);
      pageOfLine.push(index + 1);
    }
    charsPerPage.push(pageText.replace(/\s/g, '').length);
  });

  const pages = pageTexts.length;
  const chars = charsPerPage.reduce((sum, n) => sum + n, 0);
  if (chars === 0) {
    fail(
      'no_text_layer',
      `В PDF ${name} нет текстового слоя (страниц: ${pages}): похоже, это скан или набор изображений.`,
      'Распознайте документ (OCR) или экспортируйте его из исходного редактора как PDF с текстовым слоем; подойдёт и DOCX или Markdown.',
    );
  }

  if (!hasEof) {
    diagnostics.push({
      level: 'warning',
      code: 'truncated',
      message: `PDF ${name} может быть обрезан: в конце файла нет маркера %%EOF.`,
      hint: 'Сверьте число страниц с оригиналом; если страниц не хватает, получите файл заново.',
    });
  }

  const average = chars / pages;
  const emptyPages = charsPerPage.flatMap((n, i) => (n === 0 ? [i + 1] : []));
  if (average < LOW_DENSITY_CHARS_PER_PAGE || emptyPages.length > 0) {
    const shown = emptyPages.slice(0, 10).join(', ') + (emptyPages.length > 10 ? ' и ещё ' + (emptyPages.length - 10) : '');
    const details = [
      `в среднем ${Math.round(average)} знаков на страницу (страниц: ${pages})`,
      emptyPages.length > 0 ? `страницы без текста: ${shown}` : '',
    ].filter(Boolean);
    diagnostics.push({
      level: 'warning',
      code: 'low_text_density',
      message: `Из PDF ${name} извлечено мало текста: ${details.join('; ')}.`,
      hint: 'Часть содержимого может быть изображениями или сканами, и агент её не видит. Сверьте с оригиналом; при необходимости распознайте документ (OCR) или экспортируйте его с текстовым слоем.',
    });
  }

  return { text: lines.join('\n'), lines, pageOfLine, pages };
}

async function loadDocx(bytes: Uint8Array, name: string, diagnostics: Diagnostic[]): Promise<Extracted> {
  const buffer = Buffer.from(bytes);
  let text: string;
  let images: number;
  try {
    const { default: mammoth } = await import('mammoth');
    // Through HTML rather than convertToMarkdown: the latter backslash-escapes punctuation («Ф\-1\.»),
    // which breaks verbatim quotes, and flattens tables into paragraphs.
    const html = await mammoth.convertToHtml(
      { buffer },
      { convertImage: mammoth.images.imgElement(async () => ({ src: '' })) },
    );
    ({ text, images } = htmlToText(html.value));
    if (!text.trim()) text = normalizeText((await mammoth.extractRawText({ buffer })).value).trim();
  } catch (error) {
    fail(
      'corrupted',
      `DOCX ${name} повреждён: документ не удалось разобрать (${errorText(error)}).`,
      'Откройте файл в Word или LibreOffice и сохраните заново как DOCX; если он не открывается, получите файл заново.',
    );
  }
  if (!text.trim()) {
    fail(
      'empty_file',
      `В документе ${name} нет текста.`,
      'Если требования вставлены картинками, продублируйте их текстом; иначе проверьте, что отправлен нужный файл.',
    );
  }
  if (images > 0) diagnostics.push(imagesNote(images));
  return { text };
}

function failSniff(sniff: Exclude<Sniff, { kind: 'ok' }>, name: string, ext: string): never {
  if (sniff.kind === 'corrupted') {
    const expected = sniff.extFormat === 'docx' ? 'DOCX' : 'PDF';
    fail(
      'corrupted',
      `Файл ${name} повреждён: у него расширение ${ext}, но содержимое — не ${expected} (${sniff.detected}).`,
      `Файл испорчен или получен не полностью. Скачайте или экспортируйте его заново и проверьте, что он открывается как ${expected}.`,
    );
  }
  if (sniff.kind === 'binary') {
    fail(
      'binary_content',
      `Файл ${name} не похож на текст: в нём много непечатаемых символов.`,
      `Проверьте, что отправлен сам документ, а не архив или программа. Поддерживаются: ${SUPPORTED}.`,
    );
  }
  fail(
    'unsupported_format',
    `Формат файла ${name} не поддерживается: это ${sniff.detected}.`,
    `${sniff.advice ? `${sniff.advice} ` : ''}Поддерживаются: ${SUPPORTED}.`,
  );
}

async function load(path: string, maxBytes: number): Promise<SourceDoc> {
  const name = basename(path);
  if (!path.trim()) {
    fail('file_not_found', 'Путь к файлу не указан.', `Передайте путь к документу: ${SUPPORTED}.`);
  }

  const info = await stat(path).catch((error: unknown) => failFs(error, path));
  if (info.isDirectory()) {
    fail('not_a_file', `Путь указывает на папку, а не на файл: ${path}.`, `Укажите путь к одному документу: ${SUPPORTED}.`);
  }
  if (!info.isFile()) {
    fail('not_a_file', `Путь указывает не на обычный файл: ${path}.`, `Укажите путь к документу на диске: ${SUPPORTED}.`);
  }
  const emptyHint = 'Проверьте, что документ сохранён и выгружен полностью, и запустите проверку снова.';
  if (info.size === 0) fail('empty_file', `Файл ${name} пуст (0 байт).`, emptyHint);
  const tooLarge = (size: number): never =>
    fail(
      'too_large',
      `Файл ${name} слишком большой: ${formatSize(size)} при лимите ${formatSize(maxBytes)}.`,
      'Разделите документ на части или сохраните его без встроенных изображений.',
    );
  if (info.size > maxBytes) tooLarge(info.size);

  const bytes = await readFile(path).catch((error: unknown) => failFs(error, path));
  // The file may have changed between stat and read.
  if (bytes.length === 0) fail('empty_file', `Файл ${name} пуст (0 байт).`, emptyHint);
  if (bytes.length > maxBytes) tooLarge(bytes.length);

  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const ext = extname(path).toLowerCase();
  const sniff = sniffFormat(bytes, path);
  if (sniff.kind !== 'ok') failSniff(sniff, name, ext);

  const diagnostics: Diagnostic[] = [];
  const { format } = sniff;
  if (sniff.extFormat !== null && sniff.extFormat !== format) {
    diagnostics.push({
      level: 'info',
      code: 'note',
      message: `Расширение файла ${name} не соответствует содержимому: он прочитан как ${FORMAT_LABEL[format]}.`,
      hint: 'Переименуйте файл, чтобы расширение совпадало с форматом.',
    });
  } else if (sniff.extFormat === null) {
    diagnostics.push({
      level: 'info',
      code: 'note',
      message: `${ext ? `Расширение ${ext} не входит в список поддерживаемых` : `У файла ${name} нет расширения`}: по содержимому он прочитан как ${FORMAT_LABEL[format]}.`,
    });
  }

  const extracted =
    format === 'pdf'
      ? await loadPdf(bytes, name, diagnostics)
      : format === 'docx'
        ? await loadDocx(bytes, name, diagnostics)
        : loadText(bytes, format, name, diagnostics);

  const doc: SourceDoc = {
    path,
    name,
    format,
    sha256,
    bytes: bytes.length,
    text: extracted.text,
    lines: extracted.lines ?? extracted.text.split('\n'),
    diagnostics,
  };
  if (extracted.pageOfLine && extracted.pages !== undefined) {
    doc.pageOfLine = extracted.pageOfLine;
    doc.pages = extracted.pages;
  }
  return doc;
}

/**
 * Reads a requirements document into normalised text. Every failure is a `LoadError` whose diagnostic
 * says what is wrong and what to do; nothing else is thrown.
 */
export async function loadDocument(path: string, opts: { maxBytes?: number } = {}): Promise<SourceDoc> {
  try {
    return await load(path, opts.maxBytes ?? DEFAULT_MAX_BYTES);
  } catch (error) {
    if (error instanceof LoadError) throw error;
    throw new LoadError({
      level: 'error',
      code: 'corrupted',
      message: `Файл ${basename(String(path))} не удалось прочитать: ${errorText(error)}.`,
      hint: `Проверьте, что файл открывается в обычной программе, и сохраните его заново в одном из форматов: ${SUPPORTED}.`,
    });
  }
}
