<script setup lang="ts">
import { ref } from 'vue';
import { capitalize } from '../lib/format';
import { useApi } from '../composables/api';

const props = defineProps<{ runId: string; name: string; device: string }>();

const api = useApi();
const busy = ref(false);
const problem = ref<string | null>(null);

async function download() {
  busy.value = true;
  problem.value = null;
  try {
    const url = URL.createObjectURL(await api.getArtifact(props.runId, props.name));
    const link = document.createElement('a');
    link.href = url;
    link.download = props.name;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  } catch (error) {
    problem.value = `Could not download the trace: ${error instanceof Error ? error.message : String(error)}`;
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <span class="trace">
    <button type="button" class="button" :disabled="busy" @click="download">
      Download {{ capitalize(device) }} trace
    </button>
    <span v-if="problem" class="error-text" role="alert">{{ problem }}</span>
  </span>
</template>

<style scoped>
.trace {
  display: inline-flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2);
}
</style>
