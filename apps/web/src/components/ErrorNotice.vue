<script setup lang="ts">
import { computed } from 'vue';
import { ApiError } from '../api/client';

const props = defineProps<{ error: unknown; title?: string }>();

const message = computed(() =>
  props.error instanceof Error ? props.error.message : String(props.error),
);
const issues = computed(() => (props.error instanceof ApiError ? props.error.issues : []));
</script>

<template>
  <div class="notice notice-error" role="alert">
    <strong>{{ title ?? 'Something went wrong' }}:</strong> {{ message }}
    <ul v-if="issues.length > 0">
      <li v-for="issue in issues" :key="issue.path + issue.message">
        <code v-if="issue.path">{{ issue.path }}</code> {{ issue.message }}
      </li>
    </ul>
  </div>
</template>
