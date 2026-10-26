<script setup lang="ts">
import { useNow } from '../composables/now';
import { formatDateTime, relativeTime } from '../lib/format';

defineProps<{ at: string | null }>();
const now = useNow();
</script>

<template>
  <time v-if="at" :datetime="at" :title="formatDateTime(at)">{{ relativeTime(at, now) }}</time>
  <span v-else class="muted">Never</span>
</template>
