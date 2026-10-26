import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import * as core from '@checkout-sentinel/core';
import * as schemas from '@checkout-sentinel/core/schemas';

const srcDir = fileURLToPath(new URL('../../src/', import.meta.url));

/**
 * Follows relative imports from a source file and returns every bare module it reaches.
 * TypeScript's own scanner finds every form: `import x from`, `export from`, side-effect
 * imports, dynamic `import()` and `require()`, with either quote style.
 */
async function externalImports(file: string, seen = new Set<string>()): Promise<Set<string>> {
  const external = new Set<string>();
  if (seen.has(file)) return external;
  seen.add(file);
  const source = await readFile(file, 'utf8');
  for (const { fileName: specifier } of ts.preProcessFile(source, true, true).importedFiles) {
    if (specifier.startsWith('.')) {
      const target = path.resolve(path.dirname(file), specifier.replace(/\.js$/, '.ts'));
      for (const name of await externalImports(target, seen)) external.add(name);
    } else {
      external.add(specifier);
    }
  }
  return external;
}

describe('@checkout-sentinel/core/schemas', () => {
  it('exports the same monitor and result schemas as the main entry', () => {
    expect(schemas.MonitorSpecSchema).toBe(core.MonitorSpecSchema);
    expect(schemas.MonitorPatchSchema).toBe(core.MonitorPatchSchema);
    expect(schemas.RunResultSchema).toBe(core.RunResultSchema);
    expect(schemas.STEP_NAMES).toBe(core.STEP_NAMES);
  });

  it('reaches no Node or Playwright module, so the dashboard can bundle it', async () => {
    const modules = await externalImports(path.join(srcDir, 'schemas.ts'));
    expect([...modules].sort()).toEqual(['cron-parser', 'zod']);
  });

  it('finds imports in every form the scanner must see', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'schemas-entry-'));
    try {
      await writeFile(
        path.join(dir, 'entry.ts'),
        [
          "import { z } from 'zod';",
          "import 'side-effect';",
          'export * from "./local.js";',
          "const lazy = () => import('dynamic');",
        ].join('\n'),
      );
      await writeFile(path.join(dir, 'local.ts'), 'export { readFile } from "node:fs/promises";');
      const modules = await externalImports(path.join(dir, 'entry.ts'));
      expect([...modules].sort()).toEqual(['dynamic', 'node:fs/promises', 'side-effect', 'zod']);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
