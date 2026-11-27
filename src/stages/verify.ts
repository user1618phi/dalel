import type { Evidence, Requirement, SourceDoc } from '../types.js';

interface Normalized {
  text: string;
  /** For every character of `text`: offset of the source character it came from. */
  map: number[];
}

const DROP = /[*_`|]/;
const DASH = /[‐‑‒–—−]/;
const QUOTE = /[«»“”„"']/;

/** Folds away markup and typographic variation so that a quote copied by a model still matches the source. */
export function normalizeForMatch(src: string): Normalized {
  let text = '';
  const map: number[] = [];
  let lastSpace = true;
  for (let i = 0; i < src.length; i++) {
    let ch = src[i] ?? '';
    if (DROP.test(ch)) continue;
    if (/\s| | /.test(ch)) {
      if (lastSpace) continue;
      text += ' ';
      map.push(i);
      lastSpace = true;
      continue;
    }
    if (DASH.test(ch)) ch = '-';
    else if (QUOTE.test(ch)) ch = '"';
    else if (ch === 'ё') ch = 'е';
    else if (ch === 'Ё') ch = 'Е';
    text += ch.toLowerCase();
    map.push(i);
    lastSpace = false;
  }
  return { text, map };
}

function lineOfOffset(lineStarts: number[], offset: number): number {
  let lo = 0;
  let hi = lineStarts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if ((lineStarts[mid] ?? 0) <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}

export class QuoteVerifier {
  private norm: Normalized;
  private lineStarts: number[] = [];

  /**
   * @param matchText text the model actually saw (masked copy of the document); it must have the same
   *   length as the source so that offsets found in it point at the same place of the original.
   */
  constructor(
    private doc: SourceDoc,
    private reqs: Requirement[],
    matchText: string = doc.text,
  ) {
    this.norm = normalizeForMatch(matchText.length === doc.text.length ? matchText : doc.text);
    let off = 0;
    for (const l of doc.lines) {
      this.lineStarts.push(off);
      off += l.length + 1;
    }
  }

  private locate(needle: string, preferLines?: [number, number]): { start: number; end: number } | null {
    const n = normalizeForMatch(needle).text.trim();
    if (n.length < 4) return null;
    const hits: number[] = [];
    let from = 0;
    for (;;) {
      const idx = this.norm.text.indexOf(n, from);
      if (idx < 0) break;
      hits.push(idx);
      from = idx + 1;
    }
    if (hits.length === 0) return null;
    let best = hits[0] ?? 0;
    if (preferLines && hits.length > 1) {
      const inside = hits.find((h) => {
        const line = lineOfOffset(this.lineStarts, this.norm.map[h] ?? 0);
        return line >= preferLines[0] && line <= preferLines[1];
      });
      if (inside !== undefined) best = inside;
    }
    const start = this.norm.map[best] ?? 0;
    const end = (this.norm.map[best + n.length - 1] ?? start) + 1;
    return { start, end };
  }

  /**
   * Returns evidence whose quote is a verbatim substring of the document, or null.
   * A quote that only partly matches is shrunk to its longest matching piece rather than trusted.
   */
  verify(quote: string, hintRequirementId?: string): Evidence | null {
    const hint = hintRequirementId ? this.reqs.find((r) => r.id === hintRequirementId) : undefined;
    const prefer: [number, number] | undefined = hint ? [hint.lineStart, hint.lineEnd] : undefined;
    let loc = this.locate(quote, prefer);
    if (!loc) {
      const pieces = quote
        .split(/…|\.{3}|\[\.\.\.\]|\n/)
        .map((p) => p.trim())
        .filter((p) => p.length >= 12)
        .sort((a, b) => b.length - a.length);
      for (const p of pieces) {
        loc = this.locate(p, prefer);
        if (loc) break;
      }
    }
    if (!loc) {
      const words = quote.split(/\s+/).filter((w) => w.length > 0);
      for (let size = words.length - 1; size >= 4 && !loc; size--) {
        for (let s = 0; s + size <= words.length && !loc; s++) loc = this.locate(words.slice(s, s + size).join(' '), prefer);
      }
    }
    if (!loc) return null;
    const raw = this.doc.text.slice(loc.start, loc.end);
    const verbatim = raw.replace(/^[\s*_`|]+/, '').replace(/[\s|]+$/, '');
    if (verbatim.length < 4) return null;
    const startOffset = loc.start + raw.indexOf(verbatim);
    const lineStart = lineOfOffset(this.lineStarts, startOffset);
    const lineEnd = lineOfOffset(this.lineStarts, startOffset + verbatim.length - 1);
    const owner = this.reqs.find((r) => lineStart >= r.lineStart && lineStart <= r.lineEnd);
    return { quote: verbatim, lineStart, lineEnd, ...(owner ? { requirementId: owner.id } : {}) };
  }
}

/** Recomputes «a + b = c» / «a − b = c» statements found in free text; returns false when any of them is wrong. */
export function checkArithmetic(texts: string[]): { found: number; ok: boolean } {
  const re = /(\d[\d\s ]*(?:[.,]\d+)?)\s*(?:₸|тг|тенге|тиын)?\s*([+\-−–])\s*(\d[\d\s ]*(?:[.,]\d+)?)\s*(?:₸|тг|тенге|тиын)?\s*=\s*(\d[\d\s ]*(?:[.,]\d+)?)/gu;
  const toNum = (s: string) => Number(s.replace(/[\s ]/g, '').replace(',', '.'));
  let found = 0;
  let ok = true;
  for (const t of texts) {
    for (const m of t.matchAll(re)) {
      const a = toNum(m[1] ?? '');
      const b = toNum(m[3] ?? '');
      const c = toNum(m[4] ?? '');
      if (![a, b, c].every(Number.isFinite)) continue;
      found++;
      const res = m[2] === '+' ? a + b : a - b;
      if (Math.abs(res - c) > 1e-9) ok = false;
    }
  }
  return { found, ok };
}
