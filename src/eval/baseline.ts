import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { LlmClient } from '../llm/index.js';
import { loadDocument } from '../load/index.js';
import { redact } from '../stages/redact.js';

/**
 * The control experiment: the same model, the same document, one plain request and no pipeline.
 * Its only purpose is to show what the agent adds on top of the model.
 */
export async function runBaseline(client: LlmClient, input: string, out: string, log: (m: string) => void): Promise<number> {
  const doc = await loadDocument(input);
  const res = await client.complete({
    system: 'Ты — опытный аналитик и инженер по тестированию.',
    user: `Проверь качество этого документа с требованиями по ISO/IEC/IEEE 29148:2018 и IEEE 830-1998. Перечисли все дефекты, которые найдёшь, и скажи, можно ли по нему начинать разработку.\n\n${redact(doc.text).text}`,
    json: false,
  });
  const outPath = resolve(out);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, `<!-- Ответ модели ${client.model} (${client.provider}) на один запрос без конвейера агента. Сформирован командой dalel baseline. -->\n\n${res.text}\n`);
  log(`baseline: ответ модели записан: ${outPath} (${res.text.length} знаков)`);
  return 0;
}
