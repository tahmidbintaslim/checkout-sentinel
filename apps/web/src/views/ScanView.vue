<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { TAG_LABELS } from '@checkout-sentinel/core/schemas';
import type { Scan, ScanConfig } from '../api/types';
import ErrorNotice from '../components/ErrorNotice.vue';
import StatusBadge from '../components/StatusBadge.vue';
import StepTimeline from '../components/StepTimeline.vue';
import { useApi } from '../composables/api';
import { usePoll } from '../composables/poll';
import { usePageTitle } from '../composables/title';

/** The few Turnstile calls this page makes; the script defines window.turnstile. */
interface Turnstile {
  render(el: HTMLElement, options: Record<string, unknown>): string;
  reset(widgetId: string): void;
  remove(widgetId: string): void;
}
declare global {
  interface Window {
    turnstile?: Turnstile;
  }
}

const TURNSTILE_SRC = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';

const api = useApi();
const route = useRoute();
const router = useRouter();
usePageTitle('Free store scan');

const config = ref<ScanConfig | null>(null);
const url = ref('');
const token = ref('');
const submitting = ref(false);
const error = ref<unknown>(null);
const scan = ref<Scan | null>(null);
const widget = ref<HTMLElement | null>(null);
let widgetId: string | null = null;

const scanId = computed(() => (typeof route.query.id === 'string' ? route.query.id : null));
const pending = computed(() => scan.value?.status === 'queued' || scan.value?.status === 'running');
const tagsSeen = computed(() => {
  const tags = new Set(
    scan.value?.result?.journeys.flatMap((j) => j.steps.flatMap((s) => s.tags ?? [])) ?? [],
  );
  return [...tags].map((tag) => TAG_LABELS[tag]);
});

function loadTurnstile(): Promise<Turnstile> {
  if (window.turnstile) return Promise.resolve(window.turnstile);
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = TURNSTILE_SRC;
    script.async = true;
    script.onload = () =>
      window.turnstile ? resolve(window.turnstile) : reject(new Error('Turnstile did not load'));
    script.onerror = () => reject(new Error('The human check could not load'));
    document.head.append(script);
  });
}

async function renderWidget(siteKey: string) {
  const turnstile = await loadTurnstile();
  await nextTick();
  if (!widget.value) return;
  widgetId = turnstile.render(widget.value, {
    sitekey: siteKey,
    callback: (value: string) => (token.value = value),
    'expired-callback': () => (token.value = ''),
    'error-callback': () => (token.value = ''),
  });
}

async function loadScan() {
  if (!scanId.value) return;
  try {
    scan.value = await api.getScan(scanId.value);
    error.value = null;
  } catch (e) {
    error.value = e;
  }
}

onMounted(async () => {
  try {
    config.value = await api.getScanConfig();
    if (config.value.enabled && config.value.turnstileSiteKey) {
      await renderWidget(config.value.turnstileSiteKey);
    }
  } catch (e) {
    error.value = e;
  }
  await loadScan();
});
onBeforeUnmount(() => {
  if (widgetId) window.turnstile?.remove(widgetId);
});
usePoll(async () => {
  if (pending.value) await loadScan();
}, 3_000);

async function submit() {
  error.value = null;
  submitting.value = true;
  try {
    const { id } = await api.startScan(url.value.trim(), token.value);
    // The id in the address makes the result page reloadable and shareable for 24 hours.
    await router.replace({ query: { id } });
    await loadScan();
  } catch (e) {
    error.value = e;
  } finally {
    submitting.value = false;
    // Each Turnstile token works once.
    token.value = '';
    if (widgetId) window.turnstile?.reset(widgetId);
  }
}
</script>

<template>
  <div class="page">
    <header class="page-header">
      <h1>Free store scan</h1>
    </header>
    <p class="muted">
      A real browser opens your product page, adds it to the cart and loads checkout, on desktop and
      mobile, and lists the tracking tags that fire on the way. It never enters payment details or
      places an order.
    </p>

    <p v-if="config && !config.enabled" class="notice notice-info" role="note">
      The scanner is not enabled on this server.
    </p>

    <form v-if="config?.enabled" class="card" @submit.prevent="submit">
      <div class="field">
        <label for="scan-url">Product page URL</label>
        <input
          id="scan-url"
          v-model="url"
          type="url"
          required
          placeholder="https://your-store.com/products/bestseller"
          aria-describedby="scan-url-hint"
        />
        <p id="scan-url-hint" class="hint">Shopify and WooCommerce product pages work best.</p>
      </div>
      <div ref="widget" class="field"></div>
      <button
        type="submit"
        class="button button-primary"
        :disabled="submitting || !token || pending"
      >
        {{ submitting ? 'Starting…' : 'Scan my store' }}
      </button>
    </form>

    <ErrorNotice v-if="error" :error="error" title="The scan could not start" />

    <section v-if="scan" class="card" aria-live="polite" aria-labelledby="scan-title">
      <h2 id="scan-title">{{ scan.url }}</h2>
      <p v-if="pending" class="muted">
        {{ scan.status === 'queued' ? 'Waiting for a browser…' : 'Running, about a minute…' }}
      </p>
      <p v-else-if="scan.status === 'error'" class="error-text">{{ scan.error }}</p>
      <template v-else-if="scan.result">
        <p class="row">
          <StatusBadge :status="scan.result.status" />
          <span>
            {{ scan.result.summary.passed }} of {{ scan.result.summary.journeys }} journeys reached
            checkout.
          </span>
        </p>
        <p>
          Tracking tags seen:
          {{ tagsSeen.length > 0 ? tagsSeen.join(', ') : 'none of the ones we know' }}.
        </p>
        <p class="muted small">
          Want this every 15 minutes, with an alert when checkout or a tag breaks?
          <RouterLink to="/monitors/new">Create a monitor</RouterLink>.
        </p>
      </template>
    </section>

    <template v-if="scan?.result">
      <StepTimeline
        v-for="journey in scan.result.journeys"
        :key="journey.device"
        :journey="journey"
        :run-id="scan.id"
        :artifacts="[]"
      />
    </template>
  </div>
</template>
