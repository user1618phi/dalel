import type { Criterion, Finding, FindingStatus, Report, Severity } from '../types.js';
import { CRITERION_LABEL } from '../types.js';

type SarifLevel = 'error' | 'warning' | 'note';

interface SarifRegion {
  startLine: number;
  endLine: number;
  snippet: { text: string };
}

interface SarifLocation {
  physicalLocation: {
    artifactLocation: { uri: string };
    region?: SarifRegion;
  };
}

interface SarifRule {
  id: string;
  shortDescription: { text: string };
  fullDescription: { text: string };
  defaultConfiguration: { level: SarifLevel };
  properties: { criterion: Criterion; source: Finding['source'] };
}

interface SarifResult {
  ruleId: string;
  ruleIndex: number;
  level: SarifLevel;
  message: { text: string };
  locations: SarifLocation[];
  properties: {
    findingId: string;
    severity: Severity;
    criterion: Criterion;
    status: FindingStatus;
    requirementIds: string[];
    scope: Finding['scope'];
    standardRef: string;
    normRef?: string;
  };
}

interface SarifLog {
  $schema: string;
  version: '2.1.0';
  runs: {
    tool: { driver: { name: string; version: string; rules: SarifRule[] } };
    results: SarifResult[];
    properties: { documentSha256: string; mode: string; rulePacks: string[] };
  }[];
}

const LEVEL: Record<Severity, SarifLevel> = { critical: 'error', major: 'warning', minor: 'note' };
const LEVEL_RANK: Record<SarifLevel, number> = { error: 3, warning: 2, note: 1 };

function ruleIdOf(finding: Finding): string {
  return finding.ruleId ?? finding.criterion;
}

/** SARIF wants a URI reference, the passport holds a file path: spaces and Cyrillic are percent-encoded, absolute paths become file URIs. */
function toUri(documentPath: string): string {
  const normalised = documentPath.replace(/\\/g, '/');
  const encoded = encodeURI(normalised).replace(/[?#]/g, (char) => encodeURIComponent(char));
  if (/^[A-Za-z]:\//.test(normalised)) return `file:///${encoded}`;
  if (normalised.startsWith('/')) return `file://${encoded}`;
  return encoded;
}

function messageText(finding: Finding): string {
  const title = finding.title.trim();
  const explanation = finding.explanation.trim();
  if (explanation.length === 0) return title;
  return `${title}${/[.!?…:]$/.test(title) ? '' : '.'} ${explanation}`;
}

function locations(finding: Finding, uri: string): SarifLocation[] {
  return finding.evidence.map((item) => {
    const startLine = Math.trunc(item.lineStart);
    // A region with a non-positive line is invalid SARIF; the location then points at the file as a whole.
    if (!Number.isFinite(startLine) || startLine < 1) return { physicalLocation: { artifactLocation: { uri } } };
    const endLine = Math.max(startLine, Number.isFinite(item.lineEnd) ? Math.trunc(item.lineEnd) : startLine);
    return {
      physicalLocation: {
        artifactLocation: { uri },
        region: { startLine, endLine, snippet: { text: item.quote } },
      },
    };
  });
}

export function renderSarif(report: Report): string {
  const { passport, findings } = report;
  const uri = toUri(passport.documentPath);

  const rules: SarifRule[] = [];
  const ruleIndex = new Map<string, number>();
  for (const finding of findings) {
    const id = ruleIdOf(finding);
    const level = LEVEL[finding.severity];
    const existing = ruleIndex.get(id);
    if (existing !== undefined) {
      const rule = rules[existing];
      // The rule's default level is the strongest one seen among its findings.
      if (rule && LEVEL_RANK[level] > LEVEL_RANK[rule.defaultConfiguration.level]) rule.defaultConfiguration.level = level;
      continue;
    }
    ruleIndex.set(id, rules.length);
    const criterion = CRITERION_LABEL[finding.criterion];
    rules.push({
      id,
      shortDescription: { text: finding.ruleId ? `${criterion} (правило ${finding.ruleId})` : criterion },
      fullDescription: { text: `Характеристика качества требований «${criterion}». ${finding.standardRef}` },
      defaultConfiguration: { level },
      properties: { criterion: finding.criterion, source: finding.source },
    });
  }

  const results: SarifResult[] = findings.map((finding) => {
    const id = ruleIdOf(finding);
    return {
      ruleId: id,
      ruleIndex: ruleIndex.get(id) ?? 0,
      level: LEVEL[finding.severity],
      message: { text: messageText(finding) },
      locations: locations(finding, uri),
      properties: {
        findingId: finding.id,
        severity: finding.severity,
        criterion: finding.criterion,
        status: finding.status,
        requirementIds: finding.requirementIds,
        scope: finding.scope,
        standardRef: finding.standardRef,
        ...(finding.normRef ? { normRef: finding.normRef } : {}),
      },
    };
  });

  const log: SarifLog = {
    $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
    version: '2.1.0',
    runs: [
      {
        tool: { driver: { name: 'Dalel', version: passport.agentVersion, rules } },
        results,
        properties: {
          documentSha256: passport.documentSha256,
          mode: passport.mode,
          rulePacks: passport.rulePacks,
        },
      },
    ],
  };
  return `${JSON.stringify(log, null, 2)}\n`;
}
