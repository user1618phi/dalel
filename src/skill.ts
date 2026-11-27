import { cpSync, existsSync, mkdirSync, realpathSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Where each coding agent looks for skills. Paths follow the table of the `skills` installer (skills.sh):
 * project directory first, per-user directory second. `home` is the folder whose presence tells that the agent is installed.
 */
export const AGENT_DIRS: Record<string, { project: string; global: string; home: string }> = {
  'claude-code': { project: '.claude/skills', global: '.claude/skills', home: '.claude' },
  codex: { project: '.agents/skills', global: '.agents/skills', home: '.codex' },
  cursor: { project: '.agents/skills', global: '.cursor/skills', home: '.cursor' },
  'gemini-cli': { project: '.agents/skills', global: '.gemini/skills', home: '.gemini' },
  antigravity: { project: '.agents/skills', global: '.gemini/config/skills', home: '.gemini/config' },
  opencode: { project: '.agents/skills', global: '.config/opencode/skills', home: '.config/opencode' },
  'github-copilot': { project: '.agents/skills', global: '.copilot/skills', home: '.copilot' },
  windsurf: { project: '.windsurf/skills', global: '.codeium/windsurf/skills', home: '.codeium/windsurf' },
  universal: { project: '.agents/skills', global: '.config/agents/skills', home: '.config/agents' },
};

export const SKILL_NAME = 'dalel';

/** The skill folder shipped with the program. */
export function skillSource(): string {
  return join(dirname(fileURLToPath(import.meta.url)), '..', 'skills', SKILL_NAME);
}

export interface SkillInstallOptions {
  /** Agent names from AGENT_DIRS; empty means "choose for me". */
  agents?: string[];
  global?: boolean;
  /** Explicit skills directory; overrides agents. */
  dir?: string;
  cwd?: string;
  home?: string;
}

/**
 * Resolves the target folders. Without an explicit agent a project install covers Claude Code and the shared
 * `.agents/skills` directory; a per-user install covers the agents whose home folder exists on this machine.
 */
export function skillTargets(opts: SkillInstallOptions = {}): string[] {
  const cwd = opts.cwd ?? process.cwd();
  const home = opts.home ?? homedir();
  if (opts.dir) return [join(resolve(cwd, opts.dir), SKILL_NAME)];
  let names = opts.agents ?? [];
  for (const n of names) {
    if (!AGENT_DIRS[n]) throw new Error(`Неизвестный агент «${n}». Доступны: ${Object.keys(AGENT_DIRS).join(', ')}. Для другого агента укажите его каталог навыков: --dir <путь>.`);
  }
  if (names.length === 0) {
    names = opts.global ? Object.keys(AGENT_DIRS).filter((n) => existsSync(join(home, AGENT_DIRS[n]?.home ?? ''))) : ['claude-code', 'universal'];
    if (names.length === 0) names = ['claude-code'];
  }
  const dirs = names.map((n) => {
    const a = AGENT_DIRS[n];
    if (!a) throw new Error(`Неизвестный агент «${n}».`);
    return opts.global ? join(home, a.global, SKILL_NAME) : join(cwd, a.project, SKILL_NAME);
  });
  return [...new Set(dirs)];
}

/** Copies the skill into every target, replacing a previous copy of the same skill. */
export function installSkill(opts: SkillInstallOptions = {}): string[] {
  const source = skillSource();
  if (!existsSync(join(source, 'SKILL.md'))) throw new Error(`Файл навыка не найден: ${join(source, 'SKILL.md')}`);
  const targets = skillTargets(opts);
  for (const target of targets) {
    // A checkout of Dalel itself links these folders to the source: nothing to copy.
    if (existsSync(target) && realpathSync(target) === realpathSync(source)) continue;
    rmSync(target, { recursive: true, force: true });
    mkdirSync(dirname(target), { recursive: true });
    cpSync(source, target, { recursive: true, dereference: true });
  }
  return targets;
}
