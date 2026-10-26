import { lstat, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * The file that marks <ARTIFACTS_DIR>/<monitorId>/ as made by a worker. Housekeeping removes
 * the directory of a deleted monitor only when this file is in it, so a directory the worker
 * did not create is never deleted, whatever its name.
 */
export const MONITOR_DIR_MARKER = '.checkout-sentinel-monitor';

const MARKER_TEXT =
  'Created by the checkout-sentinel worker.\n' +
  'Housekeeping deletes this directory once its monitor is deleted.\n';

/** Creates the monitor's artifacts directory with its marker. Leaves an existing marker alone. */
export async function markMonitorArtifactsDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  try {
    await writeFile(path.join(dir, MONITOR_DIR_MARKER), MARKER_TEXT, { flag: 'wx' });
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code !== 'EEXIST') throw error;
  }
}

/** True when dir holds the marker as a regular file. A missing marker is false; other errors throw. */
export async function hasMonitorDirMarker(dir: string): Promise<boolean> {
  try {
    return (await lstat(path.join(dir, MONITOR_DIR_MARKER))).isFile();
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') return false;
    throw error;
  }
}
