<script setup lang="ts">
import { computed, nextTick, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import type { AlertEntry, Monitor, RunDetail, RunSummary } from '../api/types';
import ErrorNotice from '../components/ErrorNotice.vue';
import RunsTable from '../components/RunsTable.vue';
import StatusBadge from '../components/StatusBadge.vue';
import TimeAgo from '../components/TimeAgo.vue';
import { useApi } from '../composables/api';
import { usePoll } from '../composables/poll';
import { usePageTitle } from '../composables/title';
import { capitalize, formatDateTime, formatDuration, platformName, stepLabel } from '../lib/format';

const props = defineProps<{ id: string }>();

const PAGE_SIZE = 10;
/** How long a queued run is waited for before fast polling stops. */
const RUN_WAIT_MS = 5 * 60_000;

const api = useApi();
const router = useRouter();

const monitor = ref<Monitor | null>(null);
const loadError = ref<unknown>(null);
const actionError = ref<unknown>(null);
const runs = ref<RunSummary[]>([]);
const nextCursor = ref<string | null>(null);
/** Cursors of the pages above the current one; empty on the newest page. */
const cursors = ref<string[]>([]);
const latestRun = ref<RunDetail | null>(null);
const alerts = ref<AlertEntry[]>([]);
const runMessage = ref('');
const queuing = ref(false);
/** Set by "Run now" until a run that was not on the page before has finished. */
const waiting = ref<{ since: number; known: Set<string> } | null>(null);
const confirmingDelete = ref(false);
const deleting = ref(false);
const confirmButton = ref<HTMLButtonElement | null>(null);

usePageTitle(() => monitor.value?.name ?? 'Monitor');

const anyRunning = computed(() => runs.value.some((run) => run.status === 'running'));

async function loadRuns() {
  const page = await api.listRuns(props.id, { limit: PAGE_SIZE, before: cursors.value.at(-1) });
  runs.value = page.items;
  nextCursor.value = page.nextCursor;
}

async function loadLatestRun() {
  const lastRunId = monitor.value?.status.lastRunId;
  if (!lastRunId) {
    latestRun.value = null;
  } else if (latestRun.value?.id !== lastRunId) {
    latestRun.value = await api.getRun(lastRunId);
  }
}

async function load() {
  try {
    const [, page] = await Promise.all([
      loadRuns(),
      api.listAlerts({ monitorId: props.id, limit: 5 }),
    ]);
    // Read after the run list: the API commits a run's result and the monitor's state together,
    // so the state is at least as new as the list, and a finished run in the list is never shown
    // next to an older latest result.
    monitor.value = await api.getMonitor(props.id);
    await loadLatestRun();
    alerts.value = page.items;
    loadError.value = null;
    checkQueuedRun();
  } catch (e) {
    loadError.value = e;
  }
}

function checkQueuedRun() {
  const wait = waiting.value;
  if (!wait) return;
  const fresh = runs.value.find((run) => !wait.known.has(run.id));
  if (fresh && fresh.status !== 'running') {
    waiting.value = null;
    const outcome =
      fresh.status === 'passed'
        ? 'passed'
        : fresh.status === 'failed'
          ? 'failed'
          : 'ended with an error';
    runMessage.value = `The run ${outcome}.`;
  } else if (fresh) {
    runMessage.value = 'The run is in progress.';
  } else if (Date.now() - wait.since > RUN_WAIT_MS) {
    waiting.value = null;
    runMessage.value =
      'The run has not started yet. It may be waiting for another run on the same store, or no worker is running.';
  }
}

onMounted(load);
usePoll(load, () => (waiting.value || anyRunning.value ? 2_000 : 15_000));

async function runNow() {
  queuing.value = true;
  actionError.value = null;
  try {
    // Only the newest page shows a new run.
    if (cursors.value.length > 0) {
      cursors.value = [];
      await loadRuns();
    }
    const known = new Set(runs.value.map((run) => run.id));
    await api.runNow(props.id);
    waiting.value = { since: Date.now(), known };
    runMessage.value = 'Run queued. Results appear here when the worker finishes it.';
  } catch (e) {
    actionError.value = e;
  } finally {
    queuing.value = false;
  }
}

async function showPage(direction: 'older' | 'newer') {
  if (direction === 'older' && nextCursor.value)
    cursors.value = [...cursors.value, nextCursor.value];
  if (direction === 'newer') cursors.value = cursors.value.slice(0, -1);
  try {
    await loadRuns();
  } catch (e) {
    loadError.value = e;
  }
}

async function askDelete() {
  confirmingDelete.value = true;
  await nextTick();
  confirmButton.value?.focus();
}

async function confirmDelete() {
  deleting.value = true;
  actionError.value = null;
  try {
    await api.deleteMonitor(props.id);
    await router.push('/');
  } catch (e) {
    actionError.value = e;
    deleting.value = false;
  }
}

const channelLabel = (channel: Monitor['alerts'][number]) =>
  channel.type === 'slack'
    ? `Slack: ${channel.url}`
    : `Webhook: ${channel.url}${channel.hasSecret ? ' (signed)' : ''}`;
</script>

<template>
  <div class="page">
    <nav aria-label="Breadcrumb" class="small breadcrumb">
      <RouterLink to="/">Monitors</RouterLink>
      <span aria-hidden="true"> / </span>
      <span aria-current="page">{{ monitor?.name ?? 'Monitor' }}</span>
    </nav>

    <ErrorNotice v-if="loadError" :error="loadError" title="Could not load the monitor" />
    <p v-if="!monitor && !loadError" class="muted" role="status">Loading monitor...</p>

    <template v-if="monitor">
      <div class="page-header">
        <div>
          <h1>{{ monitor.name }}</h1>
          <p class="muted break url">
            <a :href="monitor.url" rel="noopener noreferrer" target="_blank"
              >{{ monitor.url }}<span class="visually-hidden"> (opens in a new tab)</span></a
            >
          </p>
          <div class="row">
            <StatusBadge :status="monitor.status.health" />
            <StatusBadge v-if="!monitor.enabled" status="paused" />
            <span class="muted small">
              Last run <TimeAgo :at="monitor.status.lastRunAt" />.
              {{ monitor.status.consecutiveFailures }} failed in a row,
              {{ monitor.status.slowSteps.length }} slow
              {{ monitor.status.slowSteps.length === 1 ? 'step' : 'steps' }}.
            </span>
          </div>
        </div>
        <div class="row">
          <button type="button" class="button button-primary" :disabled="queuing" @click="runNow">
            Run now
          </button>
          <RouterLink class="button" :to="`/monitors/${monitor.id}/edit`">Edit</RouterLink>
          <button type="button" class="button" @click="askDelete">Delete</button>
        </div>
      </div>

      <div role="status" class="run-status">
        <p v-if="runMessage" class="notice notice-info">{{ runMessage }}</p>
      </div>
      <ErrorNotice v-if="actionError" :error="actionError" title="That did not work" />

      <div
        v-if="confirmingDelete"
        class="card confirm"
        role="group"
        aria-labelledby="confirm-delete-title"
      >
        <h2 id="confirm-delete-title">Delete {{ monitor.name }}?</h2>
        <p>Its schedule, run history, screenshots and alert log are deleted too.</p>
        <div class="row">
          <button
            ref="confirmButton"
            type="button"
            class="button button-danger"
            :disabled="deleting"
            @click="confirmDelete"
          >
            Delete monitor
          </button>
          <button type="button" class="button" @click="confirmingDelete = false">Cancel</button>
        </div>
      </div>

      <section class="card" aria-labelledby="latest-title">
        <h2 id="latest-title">Latest result by device</h2>
        <p v-if="!latestRun" class="muted">No finished run yet.</p>
        <template v-else>
          <ul v-if="latestRun.result" class="devices">
            <li
              v-for="journey in latestRun.result.journeys"
              :key="journey.device"
              class="device"
              :data-device="journey.device"
            >
              <strong>{{ capitalize(journey.device) }}</strong>
              <StatusBadge :status="journey.status" />
              <span class="muted small">{{ formatDuration(journey.durationMs) }}</span>
              <span v-if="journey.failedStep" class="small">
                Failed at {{ stepLabel(journey.failedStep).toLowerCase() }}
              </span>
            </li>
          </ul>
          <p class="small">
            <RouterLink :to="`/runs/${latestRun.id}`"
              >Run of {{ formatDateTime(latestRun.startedAt) }}</RouterLink
            >
          </p>
        </template>
      </section>

      <section class="card" aria-labelledby="history-title">
        <h2 id="history-title">Run history</h2>
        <p v-if="runs.length === 0" class="muted">No runs yet. Use Run now to start one.</p>
        <RunsTable v-else :runs="runs" caption="Run history, newest first" />
        <div v-if="cursors.length > 0 || nextCursor" class="pager">
          <button
            type="button"
            class="button"
            :disabled="cursors.length === 0"
            @click="showPage('newer')"
          >
            Newer runs
          </button>
          <button type="button" class="button" :disabled="!nextCursor" @click="showPage('older')">
            Older runs
          </button>
        </div>
      </section>

      <section class="card" aria-labelledby="settings-title">
        <h2 id="settings-title">Settings</h2>
        <dl class="definition-list">
          <dt>Platform</dt>
          <dd>
            {{
              monitor.platform === 'auto'
                ? 'Detected from the page'
                : platformName(monitor.platform)
            }}
          </dd>
          <dt>Devices</dt>
          <dd>{{ monitor.devices.map(capitalize).join(', ') }}</dd>
          <dt>Schedule</dt>
          <dd>
            <code>{{ monitor.schedule }}</code> ({{ monitor.timezone }}),
            {{ monitor.enabled ? 'on' : 'paused' }}
          </dd>
          <dt>Slow step threshold</dt>
          <dd>{{ formatDuration(monitor.slowStepMs) }}</dd>
          <dt>Failure alert after</dt>
          <dd>
            {{ monitor.alertAfterFailures }} failed
            {{ monitor.alertAfterFailures === 1 ? 'run' : 'runs' }} in a row
          </dd>
          <dt>Alert channels</dt>
          <dd>
            <span v-if="monitor.alerts.length === 0" class="muted">None</span>
            <ul v-else class="channels">
              <li v-for="(channel, i) in monitor.alerts" :key="i" class="mono small">
                {{ channelLabel(channel) }}
              </li>
            </ul>
          </dd>
        </dl>
      </section>

      <section class="card" aria-labelledby="alerts-title">
        <h2 id="alerts-title">Recent alerts</h2>
        <p v-if="alerts.length === 0" class="muted">No alerts sent yet.</p>
        <ul v-else class="alerts">
          <li v-for="alert in alerts" :key="alert.id">
            <TimeAgo :at="alert.createdAt" />: {{ alert.kind }} alert to {{ alert.channelType }},
            <StatusBadge :status="alert.status" />
            <RouterLink :to="`/runs/${alert.runId}`" class="small">View run</RouterLink>
          </li>
        </ul>
        <RouterLink :to="{ path: '/alerts', query: { monitor: monitor.id } }"
          >Alert log of this monitor</RouterLink
        >
      </section>
    </template>
  </div>
</template>

<style scoped>
.breadcrumb {
  margin-bottom: var(--space-3);
}
.url {
  margin: var(--space-1) 0 var(--space-2);
}
.devices,
.channels,
.alerts {
  list-style: none;
  margin: 0 0 var(--space-3);
  padding: 0;
}
.device {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2) var(--space-3);
  padding: var(--space-2) 0;
  border-bottom: 1px solid var(--color-divider);
}
.alerts li {
  padding: var(--space-1) 0;
}
.confirm {
  border-color: var(--color-danger);
}
</style>
