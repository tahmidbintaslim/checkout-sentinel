import path from 'node:path';
import { DelayedError, type Job } from 'bullmq';
import type { Logger } from 'pino';
import {
  PROJECT_URL,
  TOOL_NAME,
  VERSION,
  runJourneys,
  type AlertChannel,
  type RunResult,
  type TargetGuard,
} from '@checkout-sentinel/core';
import type {
  AlertDeliveryRepository,
  MonitorRepository,
  MonitorRow,
  RunRepository,
  StateRepository,
} from '@checkout-sentinel/db';
import { JourneyJobSchema, type JourneyJob } from '@checkout-sentinel/jobs';
import { deliverAlert } from './alerting/deliver.js';
import { evaluateTransition, type AlertDecision } from './alerting/state-machine.js';
import type { BrowserPool } from './browser-pool.js';
import type { WorkerMetrics } from './metrics.js';
import type { StoreLock } from './store-lock.js';

export interface ProcessorDeps {
  monitors: MonitorRepository;
  runs: RunRepository;
  state: StateRepository;
  deliveries: AlertDeliveryRepository;
  lock: StoreLock;
  browsers: BrowserPool;
  metrics: WorkerMetrics;
  logger: Logger;
  removeScheduler: (monitorId: string) => Promise<void>;
  /** SSRF policy for monitor URLs and alert channels, checked again at use time. */
  targetGuard: TargetGuard;
  config: {
    artifactsDir: string;
    alertTimeoutMs: number;
    navigationTimeoutMs: number;
    stepTimeoutMs: number;
    publicBaseUrl?: string | undefined;
    userAgentContactUrl?: string | undefined;
  };
  run?: typeof runJourneys;
}

export type JobOutcome =
  | { outcome: 'skipped'; reason: string }
  | { outcome: 'completed'; runId: string; status: RunResult['status']; alerts: string[] }
  /**
   * The result arrived after its run was marked lost (superseded by a later attempt of the job,
   * or swept) or deleted; it changed nothing. BullMQ records this outcome only when this worker
   * still held the job's lock; otherwise BullMQ refuses the completion.
   */
  | { outcome: 'discarded'; runId: string; status: RunResult['status']; reason: string };

/** Delay before retrying a job whose store is busy; jittered so waiting jobs spread out. */
function lockRetryDelayMs(): number {
  return 15_000 + Math.floor(Math.random() * 15_000);
}

async function sendAlerts(
  deps: ProcessorDeps,
  monitor: MonitorRow,
  runId: string,
  result: RunResult,
  decisions: AlertDecision[],
): Promise<string[]> {
  const sent: string[] = [];
  const channels: AlertChannel[] = monitor.alerts;
  for (const decision of decisions) {
    for (const [channelIndex, channel] of channels.entries()) {
      const claim = await deps.deliveries.claim({
        monitorId: monitor.id,
        runId,
        kind: decision.kind,
        channelIndex,
        channelType: channel.type,
      });
      if (!claim) {
        deps.logger.info(
          { runId, kind: decision.kind, channelIndex },
          'alert already delivered for this run',
        );
        continue;
      }
      const outcome = await deliverAlert(
        channel,
        {
          monitor: { id: monitor.id, name: monitor.name, url: monitor.url },
          runId,
          result,
          decision,
          ...(deps.config.publicBaseUrl ? { publicBaseUrl: deps.config.publicBaseUrl } : {}),
        },
        {
          timeoutMs: deps.config.alertTimeoutMs,
          attempts: 2,
          userAgent: `${TOOL_NAME}/${VERSION} (+${PROJECT_URL})`,
          targetGuard: deps.targetGuard,
        },
      );
      deps.metrics.alerts.inc({
        kind: decision.kind,
        channel: channel.type,
        outcome: outcome.ok ? 'sent' : 'failed',
      });
      if (outcome.ok) {
        await deps.deliveries.markSent(claim.id, outcome.status ?? 0);
        sent.push(`${decision.kind}:${channel.type}`);
      } else {
        await deps.deliveries.markFailed(
          claim.id,
          outcome.error ?? 'unknown error',
          outcome.status,
        );
        // Logged without the URL: webhook URLs are credentials.
        deps.logger.warn(
          { runId, kind: decision.kind, channel: channel.type, error: outcome.error },
          'alert delivery failed',
        );
      }
    }
  }
  return sent;
}

export async function processJourneyJob(
  deps: ProcessorDeps,
  job: Pick<Job<JourneyJob>, 'data' | 'id' | 'moveToDelayed'>,
  token?: string,
): Promise<JobOutcome> {
  const data = JourneyJobSchema.parse(job.data);
  const log = deps.logger.child({
    jobId: job.id,
    monitorId: data.monitorId,
    trigger: data.trigger,
  });

  const monitor = await deps.monitors.get(data.monitorId);
  if (!monitor) {
    // The monitor was deleted after the job was queued; make sure its scheduler is gone too.
    await deps.removeScheduler(data.monitorId);
    log.info('monitor no longer exists; removed its scheduler');
    return { outcome: 'skipped', reason: 'monitor deleted' };
  }
  if (!monitor.enabled && data.trigger === 'schedule') {
    return { outcome: 'skipped', reason: 'monitor disabled' };
  }

  const lock = await deps.lock.acquire(monitor.url);
  if (!lock) {
    deps.metrics.lockWaits.inc();
    log.info('store busy with another run; delaying job');
    await job.moveToDelayed(Date.now() + lockRetryDelayMs(), token);
    throw new DelayedError();
  }

  deps.metrics.activeJourneys.inc();
  const { run, superseded } = await deps.runs.start(monitor.id, data.trigger, job.id);
  for (const runId of superseded) {
    deps.metrics.runsSuperseded.inc();
    log.warn(
      { runId, retryRunId: run.id },
      'run marked lost: BullMQ ran its job again before it finished',
    );
  }
  try {
    const result = await (deps.run ?? runJourneys)({
      url: monitor.url,
      platform: monitor.platform,
      devices: monitor.devices,
      slowStepMs: monitor.slowStepMs,
      runId: run.id,
      browser: await deps.browsers.get(),
      targetGuard: deps.targetGuard,
      artifactsDir: path.join(deps.config.artifactsDir, monitor.id),
      timeouts: {
        navigationMs: deps.config.navigationTimeoutMs,
        stepMs: deps.config.stepTimeoutMs,
      },
      ...(deps.config.userAgentContactUrl
        ? { userAgentContactUrl: deps.config.userAgentContactUrl }
        : {}),
    });
    const applied = await deps.state.applyRunResult(monitor.id, run.id, result, async (state) => {
      const transition = evaluateTransition(
        {
          health: state.health,
          consecutiveFailures: state.consecutiveFailures,
          slowSteps: state.slowSteps,
        },
        result,
        monitor.alertAfterFailures,
      );
      return {
        update: {
          ...transition.next,
          lastRunId: run.id,
          lastRunStatus: result.status,
          lastRunAt: new Date(result.finishedAt),
          healthChanged: transition.healthChanged,
        },
        value: transition.alerts,
      };
    });
    if (!applied) {
      // The run already has a final status: a later attempt of this job superseded it, the
      // sweep marked it lost, or it was deleted. The first final status stands. A late result
      // can be older than one a later attempt has applied, so it must not move the alert state
      // or send alerts.
      const current = await deps.runs.get(run.id);
      const reason = current
        ? `run was already marked ${current.status}${current.error ? ` (${current.error})` : ''}`
        : 'run was deleted';
      deps.metrics.discardedResults.inc();
      log.warn({ runId: run.id, status: result.status, reason }, 'late journey result discarded');
      return { outcome: 'discarded', runId: run.id, status: result.status, reason };
    }
    deps.metrics.observeRun(result, data.trigger);

    const alerts = await sendAlerts(deps, monitor, run.id, result, applied.value);
    log.info(
      { runId: run.id, status: result.status, durationMs: result.durationMs, alerts },
      'journey run finished',
    );
    return { outcome: 'completed', runId: run.id, status: result.status, alerts };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await deps.runs.fail(run.id, message).catch(() => undefined);
    log.error({ runId: run.id, err: error }, 'journey run crashed');
    throw error;
  } finally {
    deps.metrics.activeJourneys.dec();
    await lock
      .release()
      .catch((error: unknown) => log.warn({ err: error }, 'store lock release failed'));
  }
}
