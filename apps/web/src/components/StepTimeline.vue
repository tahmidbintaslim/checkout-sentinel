<script setup lang="ts">
import { computed, useId } from 'vue';
import type { JourneyResult, StepResult } from '@checkout-sentinel/core/schemas';
import type { RunArtifact } from '../api/types';
import { capitalize, formatDuration, platformName, stepLabel } from '../lib/format';
import ArtifactImage from './ArtifactImage.vue';
import StatusBadge from './StatusBadge.vue';
import TraceDownload from './TraceDownload.vue';

const props = defineProps<{
  journey: JourneyResult;
  runId: string;
  artifacts: RunArtifact[];
}>();

const headingId = useId();
const start = computed(() => Date.parse(props.journey.startedAt));
const total = computed(() =>
  Math.max(
    props.journey.durationMs,
    ...props.journey.steps.map((s) => Date.parse(s.startedAt) - start.value + s.durationMs),
    1,
  ),
);

const percent = (value: number) => `${Math.min(100, Math.max(0, (value / total.value) * 100))}%`;

/** Where the step sits in the journey: its offset from the start and its share of the time. */
function barStyle(step: StepResult) {
  const offset = Math.max(0, Date.parse(step.startedAt) - start.value);
  return {
    marginLeft: percent(offset),
    width: percent(Math.max(step.durationMs, total.value / 200)),
  };
}

/** The file name of the screenshot taken at this step, if the run has one. */
function screenshotName(step: StepResult): string | undefined {
  return props.artifacts.find(
    (a) => a.kind === 'screenshot' && a.device === props.journey.device && a.step === step.name,
  )?.name;
}

const trace = computed(() =>
  props.artifacts.find((a) => a.kind === 'trace' && a.device === props.journey.device),
);

const detailEntries = (step: StepResult) => Object.entries(step.details);
const stepStatus = (step: StepResult) =>
  step.status === 'passed' && step.slow ? 'slow' : step.status;
</script>

<template>
  <section class="card journey" :aria-labelledby="headingId">
    <div class="journey-head">
      <h2 :id="headingId">{{ capitalize(journey.device) }}</h2>
      <StatusBadge :status="journey.status" />
      <span class="muted">{{ formatDuration(journey.durationMs) }}</span>
      <span v-if="journey.platform" class="muted small">
        Platform {{ platformName(journey.platform.used) }} ({{ journey.platform.confidence }}
        confidence)
      </span>
      <TraceDownload v-if="trace" :run-id="runId" :name="trace.name" :device="journey.device" />
    </div>

    <ol class="timeline">
      <li
        v-for="step in journey.steps"
        :key="step.name"
        class="step"
        :class="`step-${stepStatus(step)}`"
        :data-step="step.name"
      >
        <div class="step-head">
          <StatusBadge :status="stepStatus(step)" />
          <h3 class="step-name">{{ stepLabel(step.name) }}</h3>
          <span v-if="step.status !== 'skipped'" class="step-duration">
            {{ formatDuration(step.durationMs) }}
          </span>
        </div>
        <div v-if="step.status !== 'skipped'" class="track" aria-hidden="true">
          <span class="bar" :style="barStyle(step)"></span>
        </div>
        <p
          v-if="step.message"
          class="step-message"
          :class="step.status === 'failed' ? 'error-text' : 'muted small'"
        >
          {{ step.message }}
        </p>

        <details v-if="step.consoleErrors.length > 0" :open="step.status === 'failed'">
          <summary>Console errors ({{ step.consoleErrors.length }})</summary>
          <ul class="plain-list">
            <li v-for="(entry, i) in step.consoleErrors" :key="i">
              <code class="break">{{ entry.text }}</code>
              <span v-if="entry.location" class="muted small break"> at {{ entry.location }}</span>
            </li>
          </ul>
        </details>

        <details v-if="step.pageErrors.length > 0" :open="step.status === 'failed'">
          <summary>Uncaught page errors ({{ step.pageErrors.length }})</summary>
          <ul class="plain-list">
            <li v-for="(entry, i) in step.pageErrors" :key="i">
              <code class="break">{{ entry.message }}</code>
            </li>
          </ul>
        </details>

        <details v-if="step.failedRequests.length > 0" :open="step.status === 'failed'">
          <summary>Failed requests ({{ step.failedRequests.length }})</summary>
          <div
            class="table-wrap"
            role="region"
            :aria-label="`Failed requests of ${stepLabel(step.name).toLowerCase()}`"
            tabindex="0"
          >
            <table>
              <thead>
                <tr>
                  <th scope="col">Method</th>
                  <th scope="col">Result</th>
                  <th scope="col">Type</th>
                  <th scope="col">URL</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="(request, i) in step.failedRequests" :key="i">
                  <td>{{ request.method }}</td>
                  <td>
                    {{ request.status ?? request.kind
                    }}<span v-if="request.failure" class="muted"> ({{ request.failure }})</span>
                  </td>
                  <td>{{ request.resourceType }}</td>
                  <td class="break mono">{{ request.url }}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </details>

        <details v-if="detailEntries(step).length > 0">
          <summary>Step details</summary>
          <dl class="definition-list">
            <template v-for="[key, value] in detailEntries(step)" :key="key">
              <dt>{{ key }}</dt>
              <dd class="mono">{{ value === null ? 'null' : String(value) }}</dd>
            </template>
          </dl>
        </details>

        <figure v-if="screenshotName(step)" class="shot-figure">
          <ArtifactImage
            :run-id="runId"
            :name="screenshotName(step) ?? ''"
            :alt="`Screenshot of the ${journey.device} page when ${stepLabel(step.name).toLowerCase()} ${step.status}`"
          />
          <figcaption class="hint">Screenshot taken when this step {{ step.status }}.</figcaption>
        </figure>
      </li>
    </ol>
  </section>
</template>

<style scoped>
.journey-head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2) var(--space-3);
  margin-bottom: var(--space-4);
}
.journey-head h2 {
  margin: 0;
}
.timeline {
  list-style: none;
  margin: 0;
  padding: 0;
}
.step {
  padding: var(--space-3) 0 var(--space-3) var(--space-4);
  border-left: 3px solid var(--color-divider);
}
.step + .step {
  border-top: 1px solid var(--color-divider);
}
.step-failed {
  border-left-color: var(--color-bar-fail);
}
.step-passed {
  border-left-color: var(--color-bar-pass);
}
.step-slow {
  border-left-color: var(--color-bar-slow);
}
.step-head {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: var(--space-2) var(--space-3);
}
.step-name {
  margin: 0;
  font-size: var(--text-md);
}
.step-duration {
  margin-left: auto;
  font-variant-numeric: tabular-nums;
  font-size: var(--text-sm);
}
.track {
  height: 0.5rem;
  margin: var(--space-2) 0;
  background: var(--color-surface-raised);
  border: 1px solid var(--color-divider);
  border-radius: var(--radius-pill);
  overflow: hidden;
}
.bar {
  display: block;
  height: 100%;
  border-radius: var(--radius-pill);
  background: var(--color-bar-pass);
}
.step-failed .bar {
  background: var(--color-bar-fail);
}
.step-slow .bar {
  background: var(--color-bar-slow);
}
.step-message {
  margin: var(--space-2) 0 0;
}
details {
  margin-top: var(--space-2);
}
summary {
  cursor: pointer;
  font-size: var(--text-sm);
  font-weight: 600;
}
.plain-list {
  margin: var(--space-2) 0 0;
  padding-left: var(--space-5);
  font-size: var(--text-sm);
}
.shot-figure {
  margin: var(--space-3) 0 0;
}
</style>
