<script setup lang="ts">
import type { RunSummary } from '../api/types';
import { capitalize, formatDateTime, formatDuration, stepLabel } from '../lib/format';
import StatusBadge from './StatusBadge.vue';
import TimeAgo from './TimeAgo.vue';

defineProps<{ runs: RunSummary[]; caption: string }>();
</script>

<template>
  <div class="table-wrap" role="region" :aria-label="caption" tabindex="0">
    <table>
      <caption class="visually-hidden">
        {{
          caption
        }}
      </caption>
      <thead>
        <tr>
          <th scope="col">Started</th>
          <th scope="col">Status</th>
          <th scope="col">Trigger</th>
          <th scope="col" class="num">Duration</th>
          <th scope="col">Failed step or error</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="run in runs" :key="run.id" :data-run-id="run.id">
          <td>
            <RouterLink :to="`/runs/${run.id}`">{{ formatDateTime(run.startedAt) }}</RouterLink>
            <div class="muted small"><TimeAgo :at="run.startedAt" /></div>
          </td>
          <td><StatusBadge :status="run.status" /></td>
          <td>{{ capitalize(run.trigger) }}</td>
          <td class="num">{{ formatDuration(run.durationMs) }}</td>
          <td class="break">
            <span v-if="run.failedStep">{{ stepLabel(run.failedStep) }}</span>
            <span v-else-if="run.error" class="muted">{{ run.error }}</span>
          </td>
        </tr>
      </tbody>
    </table>
  </div>
</template>
