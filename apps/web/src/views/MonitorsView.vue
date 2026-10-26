<script setup lang="ts">
import { onMounted, ref } from 'vue';
import type { Monitor } from '../api/types';
import ErrorNotice from '../components/ErrorNotice.vue';
import StatusBadge from '../components/StatusBadge.vue';
import TimeAgo from '../components/TimeAgo.vue';
import { useApi } from '../composables/api';
import { usePoll } from '../composables/poll';
import { usePageTitle } from '../composables/title';
import { capitalize, platformName } from '../lib/format';

usePageTitle('Monitors');
const api = useApi();
const monitors = ref<Monitor[] | null>(null);
const error = ref<unknown>(null);

async function load() {
  try {
    monitors.value = await api.listMonitors();
    error.value = null;
  } catch (e) {
    error.value = e;
  }
}

onMounted(load);
usePoll(load, 15_000);

const platformLabel = (platform: Monitor['platform']) =>
  platform === 'auto' ? 'Detect' : platformName(platform);
</script>

<template>
  <div class="page">
    <div class="page-header">
      <h1>Monitors</h1>
      <RouterLink class="button button-primary" to="/monitors/new">New monitor</RouterLink>
    </div>

    <ErrorNotice v-if="error" :error="error" title="Could not load monitors" />
    <p v-if="monitors === null && !error" class="muted" role="status">Loading monitors...</p>

    <div v-else-if="monitors && monitors.length === 0" class="card">
      <h2>No monitors yet</h2>
      <p>
        A monitor opens a product page on a schedule, adds the product to the cart and loads the
        checkout, on desktop and mobile.
      </p>
      <RouterLink class="button button-primary" to="/monitors/new">Create a monitor</RouterLink>
    </div>

    <div v-else-if="monitors" class="card table-card">
      <div class="table-wrap" role="region" aria-label="Monitors" tabindex="0">
        <table>
          <caption class="visually-hidden">
            Monitors and their latest status
          </caption>
          <thead>
            <tr>
              <th scope="col">Monitor</th>
              <th scope="col">Status</th>
              <th scope="col">Platform</th>
              <th scope="col">Devices</th>
              <th scope="col">Schedule</th>
              <th scope="col">Last run</th>
              <th scope="col" class="num">Failed in a row</th>
              <th scope="col" class="num">Slow steps</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="monitor in monitors" :key="monitor.id" :data-monitor-id="monitor.id">
              <td class="name-cell">
                <RouterLink :to="`/monitors/${monitor.id}`" class="monitor-name">{{
                  monitor.name
                }}</RouterLink>
                <div class="muted small break">{{ monitor.url }}</div>
              </td>
              <td>
                <div class="row">
                  <StatusBadge :status="monitor.status.health" />
                  <StatusBadge v-if="!monitor.enabled" status="paused" />
                </div>
              </td>
              <td>{{ platformLabel(monitor.platform) }}</td>
              <td>{{ monitor.devices.map(capitalize).join(', ') }}</td>
              <td>
                <code class="schedule">{{ monitor.schedule }}</code>
                <div v-if="monitor.timezone !== 'UTC'" class="muted small">
                  {{ monitor.timezone }}
                </div>
              </td>
              <td>
                <TimeAgo :at="monitor.status.lastRunAt" />
                <div v-if="monitor.status.lastRunStatus" class="small">
                  <StatusBadge :status="monitor.status.lastRunStatus" />
                </div>
              </td>
              <td class="num">{{ monitor.status.consecutiveFailures }}</td>
              <td class="num">{{ monitor.status.slowSteps.length }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  </div>
</template>

<style scoped>
.table-card {
  padding: 0;
}
.table-card table {
  min-width: 52rem;
}
.name-cell {
  min-width: 14rem;
  max-width: 22rem;
}
.monitor-name {
  font-weight: 600;
}
.schedule {
  white-space: nowrap;
}
</style>
