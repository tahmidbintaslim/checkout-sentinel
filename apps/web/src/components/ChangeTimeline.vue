<script setup lang="ts">
import { onMounted, ref } from 'vue';
import type { ChangeEntry } from '../api/types';
import { useApi } from '../composables/api';
import { formatDateTime } from '../lib/format';
import ErrorNotice from './ErrorNotice.vue';

const props = defineProps<{ monitorId: string }>();
const api = useApi();
const changes = ref<ChangeEntry[] | null>(null);
const error = ref<unknown>(null);

onMounted(async () => {
  try {
    changes.value = await api.listChanges(props.monitorId);
  } catch (e) {
    error.value = e;
  }
});
</script>

<template>
  <section class="card" aria-labelledby="changes-title">
    <h2 id="changes-title">What changed on this store</h2>
    <ErrorNotice v-if="error" :error="error" title="Could not load changes" />
    <p v-else-if="changes && changes.length === 0" class="muted">
      No changes recorded yet. Theme publishes arrive from the Shopify app; anything else (deploys,
      plugin updates) can be sent to <code>POST /api/changes</code> with an API key. Failure alerts
      list the changes from the day before the run.
    </p>
    <ol v-else-if="changes" class="plain-list">
      <li v-for="change in changes" :key="change.id">
        <time :datetime="change.occurredAt">{{ formatDateTime(change.occurredAt) }}</time>
        <span class="muted small"> · {{ change.source }}</span>
        <div>{{ change.summary }}</div>
      </li>
    </ol>
  </section>
</template>
