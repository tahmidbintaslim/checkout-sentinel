import { DelayedError, type Job } from 'bullmq';
import { runJourneys, type RunResult } from '@checkout-sentinel/core';
import { ScanJobSchema, type ScanJob } from '@checkout-sentinel/jobs';
import { lockRetryDelayMs, type ProcessorDeps } from './processor.js';

export type ScanDeps = Pick<
  ProcessorDeps,
  'lock' | 'browsers' | 'targetGuard' | 'logger' | 'run'
> & {
  config: Pick<
    ProcessorDeps['config'],
    'navigationTimeoutMs' | 'stepTimeoutMs' | 'userAgentContactUrl'
  >;
};

/**
 * One public scan: both devices, every step's tags recorded, no artifacts (the page is public
 * and screenshots of someone else's store are not ours to keep). The store lock still applies,
 * so a scan never runs alongside a monitor's journey on the same store.
 */
export async function processScanJob(
  deps: ScanDeps,
  job: Job<ScanJob>,
  token?: string,
): Promise<RunResult> {
  const { url } = ScanJobSchema.parse(job.data);
  const lock = await deps.lock.acquire(url);
  if (!lock) {
    await job.moveToDelayed(Date.now() + lockRetryDelayMs(), token);
    throw new DelayedError();
  }
  try {
    const result = await (deps.run ?? runJourneys)({
      url,
      devices: 'both',
      browser: await deps.browsers.get(),
      targetGuard: deps.targetGuard,
      runId: job.id,
      timeouts: {
        navigationMs: deps.config.navigationTimeoutMs,
        stepMs: deps.config.stepTimeoutMs,
      },
      ...(deps.config.userAgentContactUrl
        ? { userAgentContactUrl: deps.config.userAgentContactUrl }
        : {}),
    });
    deps.logger.info({ scanId: job.id, status: result.status }, 'scan finished');
    return result;
  } finally {
    await lock
      .release()
      .catch((error: unknown) => deps.logger.warn({ err: error }, 'store lock release failed'));
  }
}
