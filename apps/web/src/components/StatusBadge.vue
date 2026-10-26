<script setup lang="ts">
import { computed } from 'vue';

const props = defineProps<{
  /** A monitor health, run, step or delivery status. */
  status: string;
  /** Text to show instead of the default label. */
  label?: string;
}>();

type Tone = 'pass' | 'fail' | 'warn' | 'info' | 'neutral';

const STATUSES: Record<string, { tone: Tone; label: string }> = {
  passing: { tone: 'pass', label: 'Passing' },
  failing: { tone: 'fail', label: 'Failing' },
  unknown: { tone: 'neutral', label: 'No result yet' },
  paused: { tone: 'neutral', label: 'Paused' },
  passed: { tone: 'pass', label: 'Passed' },
  failed: { tone: 'fail', label: 'Failed' },
  // The run could not execute; it says nothing about the store.
  error: { tone: 'warn', label: 'Error' },
  running: { tone: 'info', label: 'Running' },
  skipped: { tone: 'neutral', label: 'Skipped' },
  slow: { tone: 'warn', label: 'Slow' },
  sent: { tone: 'pass', label: 'Sent' },
  pending: { tone: 'info', label: 'Pending' },
};

const entry = computed(() => STATUSES[props.status] ?? { tone: 'neutral', label: props.status });
</script>

<template>
  <span class="badge" :class="`badge-${entry.tone}`" :data-status="status">
    {{ label ?? entry.label }}
  </span>
</template>

<style scoped>
.badge {
  display: inline-block;
  padding: 0.0625rem var(--space-2);
  border-radius: var(--radius-pill);
  border: 1px solid currentColor;
  font-size: var(--text-xs);
  font-weight: 600;
  line-height: 1.5;
  white-space: nowrap;
}
.badge-pass {
  color: var(--color-pass-fg);
  background: var(--color-pass-bg);
}
.badge-fail {
  color: var(--color-fail-fg);
  background: var(--color-fail-bg);
}
.badge-warn {
  color: var(--color-warn-fg);
  background: var(--color-warn-bg);
}
.badge-info {
  color: var(--color-info-fg);
  background: var(--color-info-bg);
}
.badge-neutral {
  color: var(--color-neutral-fg);
  background: var(--color-neutral-bg);
}
</style>
