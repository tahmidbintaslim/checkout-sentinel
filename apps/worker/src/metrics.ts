import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';
import type { RunResult } from '@checkout-sentinel/core';

export class WorkerMetrics {
  readonly registry = new Registry();

  readonly runs = new Counter({
    name: 'checkout_sentinel_runs_total',
    help: 'Journey runs by final status and trigger',
    labelNames: ['status', 'trigger'] as const,
    registers: [this.registry],
  });

  readonly journeyFailures = new Counter({
    name: 'checkout_sentinel_journey_failures_total',
    help: 'Failed journeys by device and the step that failed',
    labelNames: ['device', 'step'] as const,
    registers: [this.registry],
  });

  readonly stepDuration = new Histogram({
    name: 'checkout_sentinel_step_duration_seconds',
    help: 'Duration of executed journey steps',
    labelNames: ['step', 'device', 'status'] as const,
    buckets: [0.1, 0.25, 0.5, 1, 2, 4, 8, 15, 30],
    registers: [this.registry],
  });

  readonly alerts = new Counter({
    name: 'checkout_sentinel_alerts_total',
    help: 'Alert deliveries by kind, channel type and outcome',
    labelNames: ['kind', 'channel', 'outcome'] as const,
    registers: [this.registry],
  });

  readonly activeJourneys = new Gauge({
    name: 'checkout_sentinel_active_runs',
    help: 'Runs currently executing in this worker',
    registers: [this.registry],
  });

  readonly lockWaits = new Counter({
    name: 'checkout_sentinel_store_lock_waits_total',
    help: 'Jobs delayed because another run held the same store lock',
    registers: [this.registry],
  });

  readonly runsSwept = new Counter({
    name: 'checkout_sentinel_runs_swept_total',
    help: 'Runs marked error ("Worker lost") because they were still running after the stale threshold',
    registers: [this.registry],
  });

  readonly discardedResults = new Counter({
    name: 'checkout_sentinel_discarded_results_total',
    help: 'Results discarded because their run had already been marked lost or deleted',
    registers: [this.registry],
  });

  readonly runsDeleted = new Counter({
    name: 'checkout_sentinel_runs_deleted_total',
    help: 'Runs deleted by retention',
    registers: [this.registry],
  });

  readonly artifactDirsDeleted = new Counter({
    name: 'checkout_sentinel_artifact_dirs_deleted_total',
    help: 'Artifact directories removed by retention (deleted runs and deleted monitors)',
    registers: [this.registry],
  });

  readonly housekeepingFailures = new Counter({
    name: 'checkout_sentinel_housekeeping_failures_total',
    help: 'Housekeeping tasks that failed, by task',
    labelNames: ['task'] as const,
    registers: [this.registry],
  });

  constructor(options: { defaultMetrics?: boolean } = {}) {
    if (options.defaultMetrics ?? true) collectDefaultMetrics({ register: this.registry });
  }

  observeRun(result: RunResult, trigger: string): void {
    this.runs.inc({ status: result.status, trigger });
    for (const journey of result.journeys) {
      if (journey.failedStep)
        this.journeyFailures.inc({ device: journey.device, step: journey.failedStep });
      for (const step of journey.steps) {
        if (step.status === 'skipped') continue;
        this.stepDuration.observe(
          { step: step.name, device: journey.device, status: step.status },
          step.durationMs / 1000,
        );
      }
    }
  }
}
