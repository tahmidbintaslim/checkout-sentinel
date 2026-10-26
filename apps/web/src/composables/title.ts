import { toValue, watchEffect, type MaybeRefOrGetter } from 'vue';

export function usePageTitle(title: MaybeRefOrGetter<string>): void {
  watchEffect(() => {
    const page = toValue(title);
    document.title = page ? `${page} · checkout-sentinel` : 'checkout-sentinel';
  });
}
