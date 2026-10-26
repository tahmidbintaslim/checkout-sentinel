import { onBeforeUnmount, onMounted, toValue, watch, type MaybeRefOrGetter } from 'vue';

/**
 * Calls fn every intervalMs while the component is mounted and the tab is visible, and once
 * more when the tab becomes visible again. A call never overlaps the previous one. A changing
 * interval (for example faster while a run is in progress) takes effect at once.
 */
export function usePoll(fn: () => Promise<void>, intervalMs: MaybeRefOrGetter<number>): void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running = false;
  let stopped = false;

  const schedule = () => {
    clearTimeout(timer);
    if (stopped) return;
    timer = setTimeout(tick, toValue(intervalMs));
  };

  const tick = async () => {
    if (stopped) return;
    if (document.visibilityState === 'hidden' || running) return schedule();
    running = true;
    try {
      await fn();
    } catch {
      // The view shows its own error; polling keeps going.
    } finally {
      running = false;
      schedule();
    }
  };

  const onVisibility = () => {
    if (document.visibilityState === 'visible') void tick();
  };

  onMounted(() => {
    document.addEventListener('visibilitychange', onVisibility);
    schedule();
  });
  watch(() => toValue(intervalMs), schedule);
  onBeforeUnmount(() => {
    stopped = true;
    clearTimeout(timer);
    document.removeEventListener('visibilitychange', onVisibility);
  });
}
