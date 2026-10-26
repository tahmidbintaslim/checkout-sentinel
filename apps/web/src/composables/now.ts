import { onBeforeUnmount, onMounted, readonly, ref, type Ref } from 'vue';

const now = ref(Date.now());
let users = 0;
let timer: ReturnType<typeof setInterval> | undefined;

/**
 * The current time for "5 minutes ago" labels, refreshed every 30 seconds by one timer shared
 * by every mounted component that uses it.
 */
export function useNow(): Readonly<Ref<number>> {
  onMounted(() => {
    now.value = Date.now();
    users += 1;
    if (users === 1) timer = setInterval(() => (now.value = Date.now()), 30_000);
  });
  onBeforeUnmount(() => {
    users -= 1;
    if (users === 0) clearInterval(timer);
  });
  return readonly(now);
}
