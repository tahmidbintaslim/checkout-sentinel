<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import type { Monitor, RunDetail } from '../api/types';
import ErrorNotice from '../components/ErrorNotice.vue';
import StatusBadge from '../components/StatusBadge.vue';
import StepTimeline from '../components/StepTimeline.vue';
import { useApi } from '../composables/api';
import { usePoll } from '../composables/poll';
import { usePageTitle } from '../composables/title';
import { capitalize, formatDateTime, formatDuration, platformName, stepLabel } from '../lib/format';

const props = defineProps<{ id: string }>();

const api = useApi();
const run = ref<RunDetail | null>(null);
const monitor = ref<Monitor | null>(null);
const error = ref<unknown>(null);

const running = computed(() => run.value?.status === 'running');
const runLine = computed(() => {
  if (!run.value) return '';
  const trigger = `${capitalize(run.value.trigger)} run`;
  return run.value.durationMs === null
    ? trigger
    : `${trigger}, ${formatDuration(run.value.durationMs)}`;
});
usePageTitle(() => (run.value ? `Run of ${formatDateTime(run.value.startedAt)}` : 'Run'));

async function load() {
  try {
    run.value = await api.getRun(props.id);
    error.value = null;
    if (!monitor.value) {
      monitor.value = await api.getMonitor(run.value.monitorId).catch(() => null);
    }
  } catch (e) {
    error.value = e;
  }
}

onMounted(load);
// Only a run in progress changes; a finished one is final.
usePoll(async () => {
  if (running.value) await load();
}, 2_000);
</script>

<template>
  <div class="page">
    <nav aria-label="Breadcrumb" class="small breadcrumb">
      <RouterLink to="/">Monitors</RouterLink>
      <template v-if="run">
        <span aria-hidden="true"> / </span>
        <RouterLink :to="`/monitors/${run.monitorId}`">{{ monitor?.name ?? 'Monitor' }}</RouterLink>
      </template>
      <span aria-hidden="true"> / </span>
      <span aria-current="page">Run</span>
    </nav>

    <ErrorNotice v-if="error" :error="error" title="Could not load the run" />
    <p v-if="!run && !error" class="muted" role="status">Loading run...</p>

    <template v-if="run">
      <div class="page-header">
        <div>
          <h1>Run of {{ formatDateTime(run.startedAt) }}</h1>
          <div class="row">
            <StatusBadge :status="run.status" />
            <span class="muted small">
              {{ runLine }}
            </span>
          </div>
        </div>
      </div>

      <div role="status">
        <p v-if="running" class="notice notice-info">
          This run is in progress. The page updates when it finishes.
        </p>
      </div>

      <div v-if="run.status === 'error'" class="notice notice-error">
        <strong>The run could not execute:</strong> {{ run.error ?? 'no reason recorded' }}
        <p class="small error-detail">
          An error describes the monitoring system, not the store, so it does not change the
          monitor's health or send alerts.
        </p>
      </div>

      <section class="card" aria-labelledby="summary-title">
        <h2 id="summary-title">Summary</h2>
        <dl class="definition-list">
          <dt>Product URL</dt>
          <dd class="break">{{ run.result?.url ?? monitor?.url ?? '' }}</dd>
          <dt>Started</dt>
          <dd>{{ formatDateTime(run.startedAt) }}</dd>
          <dt>Finished</dt>
          <dd>{{ run.finishedAt ? formatDateTime(run.finishedAt) : 'Not yet' }}</dd>
          <template v-if="run.detectedPlatform">
            <dt>Detected platform</dt>
            <dd>{{ platformName(run.detectedPlatform) }}</dd>
          </template>
          <template v-if="run.failedStep">
            <dt>First failed step</dt>
            <dd>{{ stepLabel(run.failedStep) }}</dd>
          </template>
          <template v-if="run.result">
            <dt>Journeys</dt>
            <dd>
              {{ run.result.summary.passed }} of {{ run.result.summary.journeys }} passed,
              {{ run.result.summary.slowSteps }} slow
              {{ run.result.summary.slowSteps === 1 ? 'step' : 'steps' }}
            </dd>
            <dt>Checked with</dt>
            <dd>{{ run.result.tool.name }} {{ run.result.tool.version }}</dd>
          </template>
        </dl>
      </section>

      <template v-if="run.result">
        <StepTimeline
          v-for="journey in run.result.journeys"
          :key="journey.device"
          :journey="journey"
          :run-id="run.id"
          :artifacts="run.artifacts"
        />
      </template>
    </template>
  </div>
</template>

<style scoped>
.breadcrumb {
  margin-bottom: var(--space-3);
}
.error-detail {
  margin: var(--space-2) 0 0;
}
</style>
