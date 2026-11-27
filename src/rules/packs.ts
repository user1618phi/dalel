import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { z } from 'zod';

const LexiconCategory = z.object({ title: z.string(), hint: z.string(), terms: z.array(z.string()) });

const Omission = z.object({
  id: z.string(),
  title: z.string(),
  when: z.array(z.string()).default([]),
  unless: z.array(z.string()).default([]),
  /** Requirement kind whose first unit anchors the finding when `when` is empty. */
  anchor: z.string().optional(),
  severity: z.enum(['critical', 'major', 'minor']),
  risk: z.object({
    level: z.enum(['high', 'medium', 'low']),
    kind: z.enum(['money', 'compliance', 'security', 'customer', 'operations', 'delivery']),
  }),
  addressee: z.string(),
  explanation: z.string(),
  question: z.string(),
  options: z.array(z.object({ label: z.string(), consequence: z.string() })).min(2),
  default: z.string(),
  norm: z.string().optional(),
});

const Pack = z.object({
  id: z.string(),
  title: z.string(),
  version: z.number(),
  /** A domain pack applies only to documents that mention its subject; empty means «always». */
  appliesWhen: z.array(z.string()).optional(),
  lexicon: z.record(z.string(), LexiconCategory).optional(),
  injection: z.array(z.string()).optional(),
  /** Domain questions handed to the model when it looks for gaps; never evaluated by code. */
  lenses: z.array(z.string()).optional(),
  omissions: z.array(Omission).optional(),
});

export type RulePack = z.infer<typeof Pack>;
export type OmissionRule = z.infer<typeof Omission>;
export type LexiconCategoryDef = z.infer<typeof LexiconCategory>;

export function packsDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // src/rules → repo root, dist/rules → package root
  return join(here, '..', '..', 'packs');
}

export function loadPacks(dir: string = packsDir(), only?: string[]): RulePack[] {
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.yaml') || f.endsWith('.yml'))
    .sort();
  const packs: RulePack[] = [];
  for (const f of files) {
    const parsed = Pack.safeParse(parse(readFileSync(join(dir, f), 'utf8')));
    if (!parsed.success) throw new Error(`Пакет правил ${f} не прошёл проверку схемы: ${parsed.error.message}`);
    if (only && !only.includes(parsed.data.id)) continue;
    packs.push(parsed.data);
  }
  return packs;
}

/** \b does not see Cyrillic word boundaries, so they are spelled out with Unicode lookarounds. */
export function termRegex(fragment: string): RegExp {
  return new RegExp(`(?<![\\p{L}\\p{N}_])(?:${fragment})(?![\\p{L}\\p{N}_])`, 'giu');
}

export function packApplies(pack: RulePack, text: string): boolean {
  const conditions = pack.appliesWhen ?? [];
  return conditions.length === 0 || conditions.some((c) => termRegex(c).test(text));
}
