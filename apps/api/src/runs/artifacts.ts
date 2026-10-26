import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import type { RunResult } from '@checkout-sentinel/core';

export type ArtifactKind = 'screenshot' | 'trace';

export interface ArtifactRef {
  name: string;
  kind: ArtifactKind;
  /** The step a screenshot was taken at; traces cover the whole journey. */
  device: string;
  step?: string;
}

const CONTENT_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.zip': 'application/zip',
};

/** A plain file name: no separators, no leading dot, nothing a path could be built from. */
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]*\.(png|zip)$/;

/**
 * The artifact files a run's result names, by file name. Only these can be downloaded: the
 * stored paths are the worker's, so the API keeps just their last segment and looks the file
 * up in its own ARTIFACTS_DIR.
 */
export function referencedArtifacts(result: RunResult | null): Map<string, ArtifactRef> {
  const refs = new Map<string, ArtifactRef>();
  for (const journey of result?.journeys ?? []) {
    for (const step of journey.steps) {
      if (!step.screenshot) continue;
      const name = path.basename(step.screenshot);
      refs.set(name, { name, kind: 'screenshot', device: journey.device, step: step.name });
    }
    if (journey.trace) {
      const name = path.basename(journey.trace);
      refs.set(name, { name, kind: 'trace', device: journey.device });
    }
  }
  return refs;
}

export function artifactContentType(name: string): string | null {
  return CONTENT_TYPES[path.extname(name).toLowerCase()] ?? null;
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

/**
 * Finds a run's artifact file under <root>/<monitorId>/<runId>/. Returns null unless the name
 * is a plain file name the result references, the file exists as a regular file, and its real
 * path (symbolic links resolved) is inside the root, so neither the name nor a link on disk
 * can reach another file.
 */
export async function locateArtifact(
  root: string,
  run: { id: string; monitorId: string; result: RunResult | null },
  name: string,
): Promise<{ file: string; size: number; ref: ArtifactRef } | null> {
  if (!SAFE_NAME.test(name)) return null;
  const ref = referencedArtifacts(run.result).get(name);
  if (!ref) return null;
  const base = path.resolve(root);
  const candidate = path.join(base, run.monitorId, run.id, name);
  if (!isInside(base, candidate)) return null;
  try {
    const [realRoot, realFile] = await Promise.all([realpath(base), realpath(candidate)]);
    if (!isInside(realRoot, realFile)) return null;
    const info = await stat(realFile);
    if (!info.isFile()) return null;
    return { file: realFile, size: info.size, ref };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code === 'ENOENT' || code === 'ENOTDIR' || code === 'ELOOP') return null;
    throw error;
  }
}
