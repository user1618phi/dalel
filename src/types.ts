export type Severity = 'critical' | 'major' | 'minor';

/** ISO/IEC/IEEE 29148:2018 §5.2.5 (requirement), §5.2.6 (set), IEEE 830-1998 §4.3 extras. */
export type Criterion =
  | 'necessary'
  | 'appropriate'
  | 'unambiguous'
  | 'complete'
  | 'singular'
  | 'feasible'
  | 'verifiable'
  | 'correct'
  | 'conforming'
  | 'set_complete'
  | 'set_consistent'
  | 'set_feasible'
  | 'set_comprehensible'
  | 'set_validatable'
  | 'ranked'
  | 'modifiable'
  | 'traceable';

export type DocFormat = 'md' | 'txt' | 'pdf' | 'docx' | 'html';

export type DiagnosticCode =
  | 'file_not_found'
  | 'not_a_file'
  | 'empty_file'
  | 'too_large'
  | 'unsupported_format'
  | 'corrupted'
  | 'encrypted'
  | 'no_text_layer'
  | 'binary_content'
  | 'encoding_repaired'
  | 'truncated'
  | 'low_text_density'
  | 'suspicious_instruction'
  | 'llm_unavailable'
  | 'llm_stage_failed'
  | 'quote_dropped'
  | 'note';

export interface Diagnostic {
  level: 'error' | 'warning' | 'info';
  code: DiagnosticCode;
  message: string;
  /** What the user can do about it. */
  hint?: string;
}

export interface SourceDoc {
  path: string;
  name: string;
  format: DocFormat;
  sha256: string;
  bytes: number;
  /** Normalised text: \n line endings, no BOM. Line numbers everywhere are 1-based indexes into `lines`. */
  text: string;
  lines: string[];
  /** For paged formats: 1-based page number of every line (same length as `lines`). */
  pageOfLine?: number[];
  pages?: number;
  diagnostics: Diagnostic[];
}

export class LoadError extends Error {
  constructor(public diagnostic: Diagnostic) {
    super(diagnostic.message);
    this.name = 'LoadError';
  }
}

export type BlockKind = 'heading' | 'paragraph' | 'list_item' | 'table_row' | 'table' | 'code';

export interface Block {
  kind: BlockKind;
  text: string;
  lineStart: number;
  lineEnd: number;
  /** Heading path above the block, outermost first. */
  section: string[];
  level?: number;
  /** For table rows: header cells and this row's cells. */
  header?: string[];
  cells?: string[];
}

export type ReqKind =
  | 'functional'
  | 'nonfunctional'
  | 'data'
  | 'integration'
  | 'ui'
  | 'architecture'
  | 'process'
  | 'goal'
  | 'acceptance'
  | 'testing'
  | 'api_meta'
  | 'api_logic'
  | 'api_rule'
  | 'api_param'
  | 'api_response'
  | 'api_status'
  | 'statement'
  | 'metadata'
  | 'template'
  | 'context';

/** Kinds that are document scaffolding rather than requirements; listed in the slicing table but not counted. */
export const NON_REQUIREMENT_KINDS: ReadonlySet<ReqKind> = new Set(['metadata', 'template', 'context']);

export interface Requirement {
  /** Report id, stable for a given document text: R-001… */
  id: string;
  /** Identifier used by the document itself (e.g. «Ф-1»), if any. */
  docId?: string;
  kind: ReqKind;
  /** Verbatim text of the unit. */
  text: string;
  /** Short wording for the slicing table. */
  summary: string;
  section: string[];
  lineStart: number;
  lineEnd: number;
  page?: number;
}

export interface Evidence {
  /** Verbatim quote from the document (verified by code against the source text). */
  quote: string;
  lineStart: number;
  lineEnd: number;
  requirementId?: string;
}

export interface Counterexample {
  given: string[];
  when: string[];
  expectations: { requirementId: string; expected: string }[];
  conflict: string;
  /** true when every «a + b = c» style statement inside the scenario was recomputed by code and holds. */
  arithmeticChecked?: boolean;
}

export type FindingStatus = 'confirmed' | 'downgraded' | 'question' | 'rejected' | 'resolved';

export interface Finding {
  /** D-001… */
  id: string;
  source: 'rule' | 'llm';
  /** Rule id for deterministic findings, e.g. «A-001». */
  ruleId?: string;
  scope: 'requirement' | 'set';
  criterion: Criterion;
  /** Human-readable reference, e.g. «ISO/IEC/IEEE 29148:2018 §5.2.5 Verifiable». */
  standardRef: string;
  /** Extra norm the finding leans on (RFC, PCI DSS, law), if any. */
  normRef?: string;
  severity: Severity;
  title: string;
  explanation: string;
  recommendation: string;
  requirementIds: string[];
  evidence: Evidence[];
  counterexample?: Counterexample;
  status: FindingStatus;
  /** Verdict of the opponent pass. */
  opponent?: { verdict: 'uphold' | 'downgrade' | 'reject'; reason: string };
  rootCauseId?: string;
  /** Set when an answer from the author closed or changed the finding. */
  resolution?: { byQuestionId: string; note: string; proposedText?: string };
}

export interface RootCause {
  id: string;
  title: string;
  findingIds: string[];
}

export type RiskKind = 'money' | 'compliance' | 'security' | 'customer' | 'operations' | 'delivery';

export interface Question {
  /** Q-01… */
  id: string;
  addressee: string;
  text: string;
  why: string;
  findingIds: string[];
  rootCauseId?: string;
  options: { label: string; consequence: string }[];
  /** What the team will assume if nobody answers. */
  defaultAssumption: string;
  blocking: boolean;
  risk: { level: 'high' | 'medium' | 'low'; kind: RiskKind; note: string };
  /** A concrete situation from the document, with numbers, where the options lead to different results. */
  scenario?: string;
  /** The option the agent itself would choose, and why. */
  recommended?: { label: string; reason: string };
  answer?: string;
}

export interface TraceRow {
  requirementId: string;
  apiRefs: string[];
  acceptanceRefs: string[];
  gaps: string[];
}

export interface ChecklistItem {
  item: string;
  /** One of the options the template itself offers, e.g. «Да», «Нет», «Не требуется». */
  answer: string;
  basis: string;
  findingIds: string[];
  line: number;
}

export interface TestCase {
  /** TC-001… */
  id: string;
  kind: 'boundary' | 'counterexample' | 'acceptance';
  title: string;
  requirementIds: string[];
  given: string[];
  when: string[];
  then: string[];
  /** For scenarios built from a contradiction: the finding they illustrate. */
  findingId?: string;
  /** false — the document has no acceptance criterion for this case. */
  coveredByAcceptance: boolean;
}

export type VerdictCode = 'ready' | 'ready_with_conditions' | 'not_ready' | 'not_checked';

export interface Verdict {
  code: VerdictCode;
  headline: string;
  rationale: string;
  /** Ordered: what to fix first. */
  fixFirst: { findingId: string; text: string }[];
}

export interface Passport {
  documentName: string;
  documentPath: string;
  documentSha256: string;
  documentFormat: DocFormat;
  documentLines: number;
  date: string;
  provider: string;
  model: string;
  /** rules+llm | rules-only */
  mode: 'rules+llm' | 'rules-only';
  agentVersion: string;
  agentCommit: string;
  rulePacks: string[];
  promptHash: string;
  durationMs: number;
  llmCalls: number;
  llmCacheHits: number;
  tokensIn: number;
  tokensOut: number;
}

export interface Summary {
  units: number;
  requirements: number;
  findings: number;
  bySeverity: Record<Severity, number>;
  byCriterion: Partial<Record<Criterion, number>>;
  requirementsWithFindings: number;
  questions: number;
  blockingQuestions: number;
  rejectedByOpponent: number;
  droppedUnverified: number;
  critical: { findingId: string; title: string; requirementIds: string[] }[];
}

export interface Report {
  schema: 'dalel.report/1';
  passport: Passport;
  requirements: Requirement[];
  /** Active findings (confirmed, downgraded, question, resolved). */
  findings: Finding[];
  /** Kept for transparency: rejected by the opponent pass. */
  rejected: Finding[];
  rootCauses: RootCause[];
  questions: Question[];
  trace: TraceRow[];
  summary: Summary;
  verdict: Verdict;
  diagnostics: Diagnostic[];
  /** The document's own review checklist, filled in by the agent as a draft for the human reviewer. */
  checklist?: ChecklistItem[];
  /** Test design derived from the document: boundaries, counterexamples, existing acceptance criteria. */
  testCases?: TestCase[];
  /** Present when answers from the author were applied. */
  answersApplied?: { count: number; resolved: number; file?: string };
}

export const CRITERION_LABEL: Record<Criterion, string> = {
  necessary: 'Необходимость',
  appropriate: 'Уместность уровня',
  unambiguous: 'Однозначность',
  complete: 'Полнота',
  singular: 'Атомарность',
  feasible: 'Реализуемость',
  verifiable: 'Проверяемость',
  correct: 'Корректность',
  conforming: 'Соответствие шаблону',
  set_complete: 'Полнота набора',
  set_consistent: 'Непротиворечивость набора',
  set_feasible: 'Реализуемость набора',
  set_comprehensible: 'Понятность набора',
  set_validatable: 'Валидируемость набора',
  ranked: 'Ранжированность',
  modifiable: 'Модифицируемость',
  traceable: 'Трассируемость',
};

export const CRITERION_REF: Record<Criterion, string> = {
  necessary: 'ISO/IEC/IEEE 29148:2018 §5.2.5 Necessary',
  appropriate: 'ISO/IEC/IEEE 29148:2018 §5.2.5 Appropriate',
  unambiguous: 'ISO/IEC/IEEE 29148:2018 §5.2.5 Unambiguous; IEEE 830-1998 §4.3.2',
  complete: 'ISO/IEC/IEEE 29148:2018 §5.2.5 Complete; IEEE 830-1998 §4.3.3',
  singular: 'ISO/IEC/IEEE 29148:2018 §5.2.5 Singular',
  feasible: 'ISO/IEC/IEEE 29148:2018 §5.2.5 Feasible',
  verifiable: 'ISO/IEC/IEEE 29148:2018 §5.2.5 Verifiable; IEEE 830-1998 §4.3.6',
  correct: 'ISO/IEC/IEEE 29148:2018 §5.2.5 Correct; IEEE 830-1998 §4.3.1',
  conforming: 'ISO/IEC/IEEE 29148:2018 §5.2.5 Conforming',
  set_complete: 'ISO/IEC/IEEE 29148:2018 §5.2.6 Complete; IEEE 830-1998 §4.3.3',
  set_consistent: 'ISO/IEC/IEEE 29148:2018 §5.2.6 Consistent; IEEE 830-1998 §4.3.4',
  set_feasible: 'ISO/IEC/IEEE 29148:2018 §5.2.6 Feasible',
  set_comprehensible: 'ISO/IEC/IEEE 29148:2018 §5.2.6 Comprehensible',
  set_validatable: 'ISO/IEC/IEEE 29148:2018 §5.2.6 Able to be validated',
  ranked: 'IEEE 830-1998 §4.3.5 Ranked for importance and/or stability',
  modifiable: 'IEEE 830-1998 §4.3.7 Modifiable',
  traceable: 'IEEE 830-1998 §4.3.8 Traceable',
};

export const SEVERITY_LABEL: Record<Severity, string> = {
  critical: 'критичный',
  major: 'существенный',
  minor: 'незначительный',
};

export const KIND_LABEL: Record<ReqKind, string> = {
  functional: 'функциональное',
  nonfunctional: 'нефункциональное',
  data: 'данные',
  integration: 'интеграция',
  ui: 'интерфейс',
  architecture: 'архитектура',
  process: 'процесс',
  goal: 'цель',
  acceptance: 'критерий приёмки',
  testing: 'тестирование',
  api_meta: 'API: параметры метода',
  api_logic: 'API: логика',
  api_rule: 'API: правило',
  api_param: 'API: параметр запроса',
  api_response: 'API: ответ',
  api_status: 'API: статус',
  statement: 'утверждение',
  metadata: 'реквизит документа',
  template: 'незаполненный шаблон',
  context: 'контекст',
};

/** Per-requirement characteristics shown in the check matrix, in standard order. */
export const REQUIREMENT_CRITERIA: Criterion[] = [
  'necessary',
  'appropriate',
  'unambiguous',
  'complete',
  'singular',
  'feasible',
  'verifiable',
  'correct',
  'conforming',
];

export const SET_CRITERIA: Criterion[] = [
  'set_complete',
  'set_consistent',
  'set_feasible',
  'set_comprehensible',
  'set_validatable',
  'ranked',
  'modifiable',
  'traceable',
];
