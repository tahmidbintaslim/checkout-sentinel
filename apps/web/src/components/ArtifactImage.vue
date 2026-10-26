<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue';
import { ApiError } from '../api/client';
import { useApi } from '../composables/api';

const props = defineProps<{ runId: string; name: string; alt: string }>();

const api = useApi();
const url = ref<string | null>(null);
const problem = ref<string | null>(null);

// An <img src> cannot send the bearer token, so the file is fetched and shown from a blob URL.
onMounted(async () => {
  try {
    url.value = URL.createObjectURL(await api.getArtifact(props.runId, props.name));
  } catch (error) {
    problem.value =
      error instanceof ApiError && error.status === 404
        ? "The screenshot file is not available. Retention may have deleted it, or it is on another worker's disk."
        : `Could not load the screenshot: ${error instanceof Error ? error.message : String(error)}`;
  }
});

onBeforeUnmount(() => {
  if (url.value) URL.revokeObjectURL(url.value);
});
</script>

<template>
  <a v-if="url" class="shot" :href="url" target="_blank" rel="noopener">
    <img :src="url" :alt="alt" />
    <span class="visually-hidden">(opens the full size image in a new tab)</span>
  </a>
  <p v-else-if="problem" class="hint">{{ problem }}</p>
  <p v-else class="hint">Loading screenshot...</p>
</template>

<style scoped>
.shot {
  display: inline-block;
  max-width: 100%;
}
.shot img {
  display: block;
  max-width: min(100%, 40rem);
  max-height: 28rem;
  height: auto;
  border: 1px solid var(--color-divider);
  border-radius: var(--radius-sm);
}
</style>
