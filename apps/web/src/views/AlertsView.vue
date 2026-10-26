<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import type { AlertEntry, Monitor } from '../api/types';
import ErrorNotice from '../components/ErrorNotice.vue';
import StatusBadge from '../components/StatusBadge.vue';
import TimeAgo from '../components/TimeAgo.vue';
import { useApi } from '../composables/api';
import { usePageTitle } from '../composables/title';
import { formatDateTime } from '../lib/format';

const PAGE_SIZE = 25;

usePageTitle('Alert log');
const api = useApi();
const route = useRoute();
const router = useRouter();

const monitorId = computed(() =>
  typeof route.query.monitor === 'string' && route.query.monitor ? route.query.monitor : undefined,
);
const monitors = ref<Monitor[]>([]);
const alerts = ref<AlertEntry[] | null>(null);
const nextCursor = ref<string | null>(null);
const cursors = ref<string[]>([]);
const error = ref<unknown>(null);

async function loadPage() {
  try {
    const page = await api.listAlerts({
      limit: PAGE_SIZE,
      monitorId: monitorId.value,
      before: cursors.value.at(-1),
    });
    alerts.value = page.items;
    nextCursor.value = page.nextCursor;
    error.value = null;
  } catch (e) {
    error.value = e;
  }
}

onMounted(async () => {
  await loadPage();
  monitors.value = await api.listMonitors().catch(() => []);
});

watch(monitorId, () => {
  cursors.value = [];
  void loadPage();
});

async function showPage(direction: 'older' | 'newer') {
  if (direction === 'older' && nextCursor.value)
    cursors.value = [...cursors.value, nextCursor.value];
  if (direction === 'newer') cursors.value = cursors.value.slice(0, -1);
  await loadPage();
}

function filter(event: Event) {
  const value = (event.target as HTMLSelectElement).value;
  void router.replace({ path: '/alerts', query: value ? { monitor: value } : {} });
}

const KIND: Record<AlertEntry['kind'], { status: string; label: string }> = {
  failure: { status: 'failing', label: 'Failure' },
  recovery: { status: 'passing', label: 'Recovery' },
  slow: { status: 'slow', label: 'Slow' },
};
</script>

<template>
  <div class="page">
    <div class="page-header">
      <h1>Alert log</h1>
      <div class="filter">
        <label for="alert-monitor-filter" class="label">Monitor</label>
        <select id="alert-monitor-filter" :value="monitorId ?? ''" @change="filter">
          <option value="">All monitors</option>
          <option v-for="monitor in monitors" :key="monitor.id" :value="monitor.id">
            {{ monitor.name }}
          </option>
        </select>
      </div>
    </div>
    <p class="muted">
      Every delivery to a webhook or Slack channel, newest first. Alerts are sent when a monitor
      starts failing, recovers, or a step turns slow.
    </p>

    <ErrorNotice v-if="error" :error="error" title="Could not load the alert log" />
    <p v-if="alerts === null && !error" class="muted" role="status">Loading alerts...</p>
    <div v-else-if="alerts && alerts.length === 0" class="card">
      <p class="muted">No alerts sent yet.</p>
    </div>
    <div v-else-if="alerts" class="card table-card">
      <div class="table-wrap" role="region" aria-label="Alert deliveries" tabindex="0">
        <table>
          <caption class="visually-hidden">
            Alert deliveries, newest first
          </caption>
          <thead>
            <tr>
              <th scope="col">Time</th>
              <th scope="col">Monitor</th>
              <th scope="col">Alert</th>
              <th scope="col">Channel</th>
              <th scope="col">Delivery</th>
              <th scope="col">Run</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="alert in alerts" :key="alert.id">
              <td>
                {{ formatDateTime(alert.createdAt) }}
                <div class="muted small"><TimeAgo :at="alert.createdAt" /></div>
              </td>
              <td>
                <RouterLink :to="`/monitors/${alert.monitorId}`">{{
                  alert.monitorName
                }}</RouterLink>
              </td>
              <td>
                <StatusBadge :status="KIND[alert.kind].status" :label="KIND[alert.kind].label" />
              </td>
              <td>{{ alert.channelType === 'slack' ? 'Slack' : 'Webhook' }}</td>
              <td>
                <StatusBadge :status="alert.status" />
                <span v-if="alert.responseStatus" class="small">
                  HTTP {{ alert.responseStatus }}</span
                >
                <div v-if="alert.error" class="small error-text break">{{ alert.error }}</div>
              </td>
              <td><RouterLink :to="`/runs/${alert.runId}`">View run</RouterLink></td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
    <div v-if="alerts && (cursors.length > 0 || nextCursor)" class="pager">
      <button
        type="button"
        class="button"
        :disabled="cursors.length === 0"
        @click="showPage('newer')"
      >
        Newer alerts
      </button>
      <button type="button" class="button" :disabled="!nextCursor" @click="showPage('older')">
        Older alerts
      </button>
    </div>
  </div>
</template>

<style scoped>
.filter {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}
.filter select {
  min-width: 14rem;
}
.table-card {
  padding: 0;
}
</style>
