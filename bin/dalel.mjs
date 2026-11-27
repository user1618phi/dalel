#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// PDF parsing and the test runner rely on APIs that first shipped in Node 22 (Node 20 reached end of life in April 2026).
const [major = 0, minor = 0] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 12)) {
  process.stderr.write(`dalel: нужен Node.js 22.12 или новее, сейчас ${process.versions.node}. Установите актуальную LTS-версию: https://nodejs.org/\n`);
  process.exit(1);
}

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const built = join(root, 'dist', 'cli.js');
if (existsSync(built)) {
  await import(pathToFileURL(built).href);
} else {
  // A source checkout without a build: run the TypeScript entry through tsx.
  const { register } = await import('tsx/esm/api');
  register();
  await import(pathToFileURL(join(root, 'src', 'cli.ts')).href);
}
