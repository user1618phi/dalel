import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { extractText, extractTextItems } from 'unpdf';
import { describe, expect, it } from 'vitest';
import { renderHtml } from '../src/report/html.js';
import { KIT_CSS } from '../src/report/kit.js';
import { renderPdf } from '../src/report/pdf.js';
import { renderSarif } from '../src/report/sarif.js';
import { sampleDoc, sampleReport } from './fixtures/sample-report.js';

const SECTION_HEADINGS = [
  'Отчёт о проверке требований',
  'Паспорт прогона',
  'Как агент нарезал требования',
  'Проверка каждого требования',
  'Проверка набора требований',
  'Вопросы автору',
  'Сводка',
  'Итог',
  'Приложение',
];

describe('fixture', () => {
  it('quotes are verbatim and sit on the lines they claim', () => {
    const report = sampleReport();
    const doc = sampleDoc();
    for (const finding of [...report.findings, ...report.rejected]) {
      for (const item of finding.evidence) {
        expect(doc.lines.slice(item.lineStart - 1, item.lineEnd).join('\n')).toContain(item.quote);
      }
    }
  });
});

describe('kit', () => {
  it('matches design/kit.css except for the web font import', () => {
    const source = readFileSync(fileURLToPath(new URL('../design/kit.css', import.meta.url)), 'utf8');
    const expected = source
      .split('\n')
      .filter((line) => !line.startsWith('@import'))
      .join('\n');
    expect(KIT_CSS).toBe(expected);
    expect(KIT_CSS).not.toContain('@import');
  });
});

describe('renderHtml', () => {
  const report = sampleReport();
  const doc = sampleDoc();
  const html = renderHtml(report, doc);

  it('is a Russian document with a meaningful title', () => {
    expect(html).toMatch(/^<!doctype html>\n<html lang="ru">/);
    expect(html).toMatch(/<title>tz-perevody\.md — отчёт о проверке требований · Dalel<\/title>/);
  });

  it('contains every section heading', () => {
    for (const heading of [...SECTION_HEADINGS, 'Документ']) {
      expect(html).toMatch(new RegExp(`<h[12][^>]*>${heading}</h[12]>`));
    }
  });

  it('puts the verdict before the first section', () => {
    expect(html.indexOf(report.verdict.headline)).toBeGreaterThan(-1);
    expect(html.indexOf(report.verdict.headline)).toBeLessThan(html.indexOf('<section'));
  });

  it('contains every finding id and question id as an anchor', () => {
    for (const finding of [...report.findings, ...report.rejected]) {
      expect(html).toContain(`id="${finding.id}"`);
    }
    for (const question of report.questions) {
      expect(html).toContain(`id="${question.id}"`);
    }
  });

  it('shows critical and major findings as cards and minor ones only in the appendix table', () => {
    const cards = [...html.matchAll(/<article class="entry finding" id="([^"]+)"/g)].map((match) => match[1]);
    expect(cards.sort()).toEqual(['D-001', 'D-002', 'D-003', 'D-004', 'D-005']);
    expect(html).toMatch(/<tr id="D-006" data-finding data-severity="minor">/);
    expect(html.indexOf('id="D-006"')).toBeGreaterThan(html.indexOf('<section id="appendix"'));
  });

  it('renders the counterexample of the set-level finding', () => {
    const set = html.slice(html.indexOf('<section id="set"'), html.indexOf('<section id="questions"'));
    for (const part of ['Дано', 'Когда', 'Ожидания по требованиям', 'Конфликт', 'арифметика пересчитана кодом']) {
      expect(set).toContain(part);
    }
    expect(set).toContain('id="D-001"');
  });

  it('renders untrusted text inert', () => {
    expect(report.requirements.some((requirement) => requirement.text.includes('<script>alert(1)</script>'))).toBe(true);
    expect(html).not.toContain('<script>alert(1)');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    // The only script element is the renderer's own.
    expect(html.match(/<script/g)).toHaveLength(1);
  });

  it('escapes markup in every text field, attributes included', () => {
    const hostile = sampleReport();
    const payload = '"><img src=x onerror=alert(1)>';
    hostile.passport.documentName = payload;
    const [finding] = hostile.findings;
    const [question] = hostile.questions;
    if (!finding || !question) throw new Error('fixture has no findings or questions');
    finding.id = payload;
    finding.title = payload;
    question.id = payload;
    question.text = payload;
    const out = renderHtml(hostile, doc);
    expect(out).not.toContain('<img');
    expect(out).not.toMatch(/"\s*onerror=/);
  });

  it('references no external resources', () => {
    expect(html).not.toMatch(/(?:src|href)\s*=\s*["']?\s*(?:https?:)?\/\//i);
    expect(html).not.toMatch(/url\(\s*["']?\s*(?:https?:)?\/\//i);
    expect(html).not.toContain('@import');
    expect(html).not.toMatch(/<link\b/i);
  });

  it('has line anchors, quote links and backlinks when the document is given', () => {
    for (let line = 1; line <= doc.lines.length; line += 1) {
      expect(html).toContain(`id="L${line}"`);
    }
    for (const finding of report.findings) {
      for (const item of finding.evidence) {
        expect(html).toContain(`href="#L${item.lineStart}"`);
        const row = new RegExp(`<div class="ln hit" id="L${item.lineStart}">.*href="#${finding.id}"`);
        expect(html).toMatch(row);
      }
    }
  });

  it('has no document section and no line links without the document', () => {
    const bare = renderHtml(report, null);
    expect(bare).not.toContain('<section id="document"');
    expect(bare).not.toContain('href="#L');
    expect(bare).not.toContain('href="#document"');
    for (const heading of SECTION_HEADINGS) expect(bare).toContain(heading);
  });

  it('links only to anchors that exist', () => {
    const ids = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]));
    const targets = [...html.matchAll(/href="#([^"]+)"/g)].map((match) => match[1]);
    expect(targets.length).toBeGreaterThan(20);
    for (const target of targets) expect(ids.has(target), `#${target}`).toBe(true);
  });

  it('renders an empty report without throwing', () => {
    const blank = sampleReport();
    blank.requirements = [];
    blank.findings = [];
    blank.rejected = [];
    blank.questions = [];
    blank.trace = [];
    blank.diagnostics = [];
    blank.verdict.fixFirst = [];
    blank.summary.critical = [];
    const out = renderHtml(blank, null);
    for (const heading of SECTION_HEADINGS) expect(out).toContain(heading);
  });
});

describe('renderPdf', () => {
  it('produces a readable PDF with Cyrillic text and the tenge sign', async () => {
    const report = sampleReport();
    const pdf = await renderPdf(report);
    expect(pdf.subarray(0, 4).toString('latin1')).toBe('%PDF');
    expect(pdf.length).toBeGreaterThan(10_000);

    const { text } = await extractText(new Uint8Array(pdf), { mergePages: true });
    const flat = text.replace(/\s+/g, ' ');
    for (const heading of SECTION_HEADINGS) expect(flat).toContain(heading);
    expect(flat).toContain('Минимальная комиссия больше максимальной');
    expect(flat).toContain('₸');
    for (const finding of [...report.findings, ...report.rejected]) expect(flat).toContain(finding.id);
    for (const question of report.questions) expect(flat).toContain(question.id);
  }, 30_000);

  it('keeps long unbreakable strings inside the page', async () => {
    const report = sampleReport();
    const token = 'x'.repeat(260);
    report.passport.documentName = `${token}.md`;
    report.passport.promptHash = `sha256:${'ab12'.repeat(40)}`;
    const [requirement] = report.requirements.slice(1);
    const [, finding] = report.findings;
    const [row] = report.trace;
    const [item] = finding?.evidence ?? [];
    if (!requirement || !finding || !row || !item) throw new Error('fixture is too small');
    requirement.docId = 'REQ-PAYMENTS-TRANSFERS-0001-ALPHA-BETA-GAMMA';
    requirement.summary = token;
    finding.title = token;
    item.quote = token;
    row.apiRefs = [`POST /api/v1/${token}`];
    row.gaps = [token];

    const pdf = await renderPdf(report);
    const { items } = await extractTextItems(new Uint8Array(pdf));
    const A4_WIDTH = 595.28;
    const MARGIN = 48;
    let checked = 0;
    for (const page of items) {
      for (const text of page) {
        if (text.str.trim().length === 0) continue;
        checked += 1;
        expect(text.x, text.str).toBeGreaterThanOrEqual(MARGIN - 1);
        expect(text.x + text.width, text.str).toBeLessThanOrEqual(A4_WIDTH - MARGIN + 1);
      }
    }
    expect(checked).toBeGreaterThan(100);
  }, 30_000);

  it('renders an empty report', async () => {
    const blank = sampleReport();
    blank.requirements = [];
    blank.findings = [];
    blank.rejected = [];
    blank.questions = [];
    blank.trace = [];
    blank.diagnostics = [];
    blank.verdict.fixFirst = [];
    blank.summary.critical = [];
    const pdf = await renderPdf(blank);
    expect(pdf.subarray(0, 4).toString('latin1')).toBe('%PDF');
  }, 30_000);
});

describe('renderSarif', () => {
  const report = sampleReport();
  const sarif = JSON.parse(renderSarif(report)) as {
    version: string;
    runs: {
      tool: { driver: { name: string; version: string; rules: { id: string; shortDescription: { text: string }; helpUri?: string }[] } };
      results: {
        ruleId: string;
        ruleIndex: number;
        level: string;
        message: { text: string };
        locations: { physicalLocation: { artifactLocation: { uri: string }; region?: { startLine: number; endLine: number } } }[];
        properties: { severity: string; criterion: string; status: string; requirementIds: string[] };
      }[];
    }[];
  };
  const run = sarif.runs[0];
  if (!run) throw new Error('SARIF log has no runs');

  it('is SARIF 2.1.0 produced by Dalel', () => {
    expect(sarif.version).toBe('2.1.0');
    expect(sarif.runs).toHaveLength(1);
    expect(run.tool.driver.name).toBe('Dalel');
    expect(run.tool.driver.version).toBe(report.passport.agentVersion);
  });

  it('has one result per active finding', () => {
    expect(run.results).toHaveLength(report.findings.length);
    expect(run.results.map((result) => result.level)).toEqual(['error', 'error', 'warning', 'warning', 'warning', 'note']);
  });

  it('derives rules from rule ids and criteria', () => {
    const ids = run.tool.driver.rules.map((rule) => rule.id);
    expect(ids).toEqual(['set_consistent', 'N-003', 'A-001', 'singular', 'complete', 'V-002']);
    for (const rule of run.tool.driver.rules) {
      expect(rule.shortDescription.text).toMatch(/[А-Яа-я]/);
      expect(rule.helpUri).toBeUndefined();
    }
    for (const result of run.results) {
      expect(run.tool.driver.rules[result.ruleIndex]?.id).toBe(result.ruleId);
    }
  });

  it('carries locations with positive integer lines and the finding properties', () => {
    run.results.forEach((result, index) => {
      const finding = report.findings[index];
      if (!finding) throw new Error('result without a finding');
      expect(result.message.text).toContain(finding.title);
      expect(result.message.text).toContain(finding.explanation);
      expect(result.locations).toHaveLength(finding.evidence.length);
      for (const location of result.locations) {
        expect(location.physicalLocation.artifactLocation.uri).toBe(report.passport.documentPath);
        const region = location.physicalLocation.region;
        if (!region) throw new Error('location without a region');
        expect(Number.isInteger(region.startLine)).toBe(true);
        expect(region.startLine).toBeGreaterThan(0);
        expect(region.endLine).toBeGreaterThanOrEqual(region.startLine);
      }
      expect(result.properties).toMatchObject({
        severity: finding.severity,
        criterion: finding.criterion,
        status: finding.status,
        requirementIds: finding.requirementIds,
      });
    });
  });

  it('never emits a non-positive line and encodes paths as URIs', () => {
    const odd = sampleReport();
    odd.passport.documentPath = '/tmp/мои документы/ТЗ v2.md';
    const [finding] = odd.findings;
    const [item] = finding?.evidence ?? [];
    if (!item) throw new Error('fixture has no evidence');
    item.lineStart = 0;
    item.lineEnd = 0;
    const out = renderSarif(odd);
    expect(out).not.toMatch(/"startLine": (0|-)/);
    const uri = (JSON.parse(out) as typeof sarif).runs[0]?.results[0]?.locations[0]?.physicalLocation.artifactLocation.uri;
    expect(uri).toMatch(/^file:\/\/\/tmp\/[%0-9A-Fa-f.v/md]+$/);
    expect(decodeURI(uri ?? '')).toBe('file:///tmp/мои документы/ТЗ v2.md');
  });
});
