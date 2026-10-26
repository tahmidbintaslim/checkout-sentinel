import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import * as core from '@checkout-sentinel/core';
import * as schemas from '@checkout-sentinel/core/schemas';

const srcDir = fileURLToPath(new URL('../../src/', import.meta.url));

/** Follows relative imports from a source file and returns every bare module it reaches. */
async function externalImports(file: string, seen = new Set<string>()): Promise<Set<string>> {
  const external = new Set<string>();
  if (seen.has(file)) return external;
  seen.add(file);
  const source = await readFile(file, 'utf8');
  for (const match of source.matchAll(/(?:import|export)\s[^'"]*?from\s+'([^']+)'/g)) {
    const specifier = match[1] as string;
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
});
