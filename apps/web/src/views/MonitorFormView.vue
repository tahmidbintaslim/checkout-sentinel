<script setup lang="ts">
import { computed, nextTick, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { ApiError } from '../api/client';
import type { Monitor } from '../api/types';
import AlertChannelsEditor from '../components/AlertChannelsEditor.vue';
import ErrorNotice from '../components/ErrorNotice.vue';
import { useApi } from '../composables/api';
import { usePageTitle } from '../composables/title';
import {
  describeSchedule,
  emptyForm,
  formFromMonitor,
  toCreatePayload,
  toUpdatePayload,
  type FieldErrors,
  type MonitorForm,
} from '../lib/monitor-form';

const props = defineProps<{ id?: string }>();

const api = useApi();
const router = useRouter();

const editing = computed(() => props.id !== undefined);
const original = ref<Monitor | null>(null);
const form = ref<MonitorForm | null>(editing.value ? null : emptyForm());
const errors = ref<FieldErrors>({});
const loadError = ref<unknown>(null);
const saveError = ref<unknown>(null);
const saving = ref(false);
const summary = ref<HTMLElement | null>(null);

usePageTitle(() => (editing.value ? `Edit ${original.value?.name ?? 'monitor'}` : 'New monitor'));

const timezones = (() => {
  try {
    return Intl.supportedValuesOf('timeZone');
  } catch {
    return ['UTC'];
  }
})();

onMounted(async () => {
  if (!props.id) return;
  try {
    original.value = await api.getMonitor(props.id);
    form.value = formFromMonitor(original.value);
  } catch (e) {
    loadError.value = e;
  }
});

const scheduleHint = computed(() => (form.value ? describeSchedule(form.value.schedule) : null));

/** Where each field's error links to in the summary. */
const FIELD_IDS = {
  name: 'field-name',
  url: 'field-url',
  platform: 'field-platform',
  devices: 'field-devices',
  schedule: 'field-schedule',
  timezone: 'field-timezone',
  slowStepMs: 'field-slow',
  alertAfterFailures: 'field-failures',
  enabled: 'field-enabled',
} as const;
type Field = keyof typeof FIELD_IDS;
const LABELS: Record<Field, string> = {
  name: 'Name',
  url: 'Product URL',
  platform: 'Platform',
  devices: 'Devices',
  schedule: 'Schedule',
  timezone: 'Time zone',
  slowStepMs: 'Slow step threshold',
  alertAfterFailures: 'Failure alert after',
  enabled: 'Run on schedule',
};

const isField = (name: string | undefined): name is Field =>
  name !== undefined && Object.hasOwn(FIELD_IDS, name);

const CHANNEL_FIELDS: Record<string, string> = { url: ' URL', secret: ' secret' };

function summaryEntry(path: string) {
  const [field, position, sub] = path.split('.');
  if (field === 'alerts') {
    const label =
      position === undefined
        ? 'Alert channels'
        : `Alert channel ${Number(position) + 1}${CHANNEL_FIELDS[sub ?? ''] ?? ''}`;
    return { href: '#field-alerts', label };
  }
  if (isField(field)) return { href: `#${FIELD_IDS[field]}`, label: LABELS[field] };
  return { href: '#monitor-form', label: path };
}

const errorList = computed(() =>
  Object.entries(errors.value).map(([path, message]) => ({ path, message, ...summaryEntry(path) })),
);

const describedBy = (field: Field, hint = true) =>
  [hint ? `${FIELD_IDS[field]}-hint` : '', errors.value[field] ? `${FIELD_IDS[field]}-error` : '']
    .filter(Boolean)
    .join(' ') || undefined;

async function showErrors(next: FieldErrors) {
  errors.value = next;
  await nextTick();
  summary.value?.focus();
}

type Plan = { ok: true; send: () => Promise<Monitor> } | { ok: false; errors: FieldErrors };

/** Validates the form and returns the request that saves it. */
function plan(current: MonitorForm): Plan {
  const monitor = original.value;
  if (monitor) {
    const result = toUpdatePayload(current, monitor);
    return result.ok
      ? { ok: true, send: () => api.updateMonitor(monitor.id, result.payload) }
      : result;
  }
  const result = toCreatePayload(current);
  return result.ok ? { ok: true, send: () => api.createMonitor(result.payload) } : result;
}

async function submit() {
  if (!form.value) return;
  saveError.value = null;
  const request = plan(form.value);
  if (!request.ok) return showErrors(request.errors);
  errors.value = {};
  saving.value = true;
  try {
    const saved = await request.send();
    await router.push(`/monitors/${saved.id}`);
  } catch (e) {
    if (e instanceof ApiError && e.status === 400 && e.issues.length > 0) {
      await showErrors(Object.fromEntries(e.issues.map((issue) => [issue.path, issue.message])));
    } else if (e instanceof ApiError && e.status === 409) {
      saveError.value = new Error(
        'The monitor was changed somewhere else after this form was opened, so nothing was saved. Reload the page to see its current settings, then make the change again.',
      );
    } else {
      saveError.value = e;
    }
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <div class="page">
    <nav aria-label="Breadcrumb" class="small breadcrumb">
      <RouterLink to="/">Monitors</RouterLink>
      <template v-if="original">
        <span aria-hidden="true"> / </span>
        <RouterLink :to="`/monitors/${original.id}`">{{ original.name }}</RouterLink>
      </template>
      <span aria-hidden="true"> / </span>
      <span aria-current="page">{{ editing ? 'Edit' : 'New monitor' }}</span>
    </nav>

    <div class="page-header">
      <h1>{{ editing ? `Edit ${original?.name ?? 'monitor'}` : 'New monitor' }}</h1>
    </div>

    <ErrorNotice v-if="loadError" :error="loadError" title="Could not load the monitor" />
    <p v-if="!form && !loadError" class="muted" role="status">Loading monitor...</p>

    <div
      v-if="errorList.length > 0"
      ref="summary"
      class="notice notice-error"
      role="alert"
      tabindex="-1"
    >
      <strong>
        Fix {{ errorList.length }} {{ errorList.length === 1 ? 'problem' : 'problems' }} before
        saving:
      </strong>
      <ul>
        <li v-for="item in errorList" :key="item.path">
          <a :href="item.href">{{ item.label }}</a
          >: {{ item.message }}
        </li>
      </ul>
    </div>
    <ErrorNotice v-if="saveError" :error="saveError" title="Could not save" />

    <form v-if="form" id="monitor-form" class="card" novalidate @submit.prevent="submit">
      <div class="field">
        <label :for="FIELD_IDS.name">Name</label>
        <input
          :id="FIELD_IDS.name"
          v-model="form.name"
          type="text"
          maxlength="120"
          autocomplete="off"
          :aria-invalid="errors.name ? 'true' : 'false'"
          :aria-describedby="describedBy('name', false)"
        />
        <p v-if="errors.name" :id="`${FIELD_IDS.name}-error`" class="error-text">
          {{ errors.name }}
        </p>
      </div>

      <div class="field">
        <label :for="FIELD_IDS.url">Product URL</label>
        <input
          :id="FIELD_IDS.url"
          v-model="form.url"
          type="url"
          inputmode="url"
          autocomplete="off"
          spellcheck="false"
          placeholder="https://your-store.example/products/your-bestseller"
          :aria-invalid="errors.url ? 'true' : 'false'"
          :aria-describedby="describedBy('url')"
        />
        <p :id="`${FIELD_IDS.url}-hint`" class="hint">
          A product page that can be added to the cart. The journey never pays or places an order.
        </p>
        <p v-if="errors.url" :id="`${FIELD_IDS.url}-error`" class="error-text">{{ errors.url }}</p>
      </div>

      <div class="form-grid">
        <div class="field">
          <label :for="FIELD_IDS.platform">Platform</label>
          <select
            :id="FIELD_IDS.platform"
            v-model="form.platform"
            :aria-describedby="describedBy('platform')"
          >
            <option value="auto">Detect from the page</option>
            <option value="shopify">Shopify</option>
            <option value="woocommerce">WooCommerce</option>
          </select>
          <p :id="`${FIELD_IDS.platform}-hint`" class="hint">
            Detection reads the page's markup and headers.
          </p>
        </div>

        <fieldset
          :id="FIELD_IDS.devices"
          class="field devices"
          :aria-describedby="errors.devices ? `${FIELD_IDS.devices}-error` : undefined"
        >
          <legend>Devices</legend>
          <div class="checks">
            <label class="check">
              <input v-model="form.devices" type="checkbox" value="desktop" />
              Desktop
            </label>
            <label class="check">
              <input v-model="form.devices" type="checkbox" value="mobile" />
              Mobile
            </label>
          </div>
          <p v-if="errors.devices" :id="`${FIELD_IDS.devices}-error`" class="error-text">
            {{ errors.devices }}
          </p>
        </fieldset>
      </div>

      <div class="form-grid">
        <div class="field">
          <label :for="FIELD_IDS.schedule">Schedule (cron)</label>
          <input
            :id="FIELD_IDS.schedule"
            v-model="form.schedule"
            type="text"
            class="mono"
            autocomplete="off"
            spellcheck="false"
            :aria-invalid="errors.schedule ? 'true' : 'false'"
            :aria-describedby="describedBy('schedule')"
          />
          <p :id="`${FIELD_IDS.schedule}-hint`" class="hint">
            Five fields, for example <code>*/15 * * * *</code> for every 15 minutes. Runs must be at
            least 5 minutes apart.
            <span v-if="scheduleHint">{{ scheduleHint }}.</span>
          </p>
          <p v-if="errors.schedule" :id="`${FIELD_IDS.schedule}-error`" class="error-text">
            {{ errors.schedule }}
          </p>
        </div>

        <div class="field">
          <label :for="FIELD_IDS.timezone">Time zone</label>
          <input
            :id="FIELD_IDS.timezone"
            v-model="form.timezone"
            type="text"
            list="timezone-options"
            autocomplete="off"
            spellcheck="false"
            :aria-invalid="errors.timezone ? 'true' : 'false'"
            :aria-describedby="describedBy('timezone')"
          />
          <datalist id="timezone-options">
            <option v-for="zone in timezones" :key="zone" :value="zone"></option>
          </datalist>
          <p :id="`${FIELD_IDS.timezone}-hint`" class="hint">The schedule's time zone.</p>
          <p v-if="errors.timezone" :id="`${FIELD_IDS.timezone}-error`" class="error-text">
            {{ errors.timezone }}
          </p>
        </div>
      </div>

      <div class="form-grid">
        <div class="field">
          <label :for="FIELD_IDS.slowStepMs">Slow step threshold (ms)</label>
          <input
            :id="FIELD_IDS.slowStepMs"
            v-model="form.slowStepMs"
            type="number"
            inputmode="numeric"
            min="100"
            max="120000"
            step="100"
            :aria-invalid="errors.slowStepMs ? 'true' : 'false'"
            :aria-describedby="describedBy('slowStepMs')"
          />
          <p :id="`${FIELD_IDS.slowStepMs}-hint`" class="hint">
            A passing step slower than this sends a slow alert. 100 to 120000.
          </p>
          <p v-if="errors.slowStepMs" :id="`${FIELD_IDS.slowStepMs}-error`" class="error-text">
            {{ errors.slowStepMs }}
          </p>
        </div>

        <div class="field">
          <label :for="FIELD_IDS.alertAfterFailures">Failure alert after (runs)</label>
          <input
            :id="FIELD_IDS.alertAfterFailures"
            v-model="form.alertAfterFailures"
            type="number"
            inputmode="numeric"
            min="1"
            max="10"
            :aria-invalid="errors.alertAfterFailures ? 'true' : 'false'"
            :aria-describedby="describedBy('alertAfterFailures')"
          />
          <p :id="`${FIELD_IDS.alertAfterFailures}-hint`" class="hint">
            Failed runs in a row before the failure alert. 2 skips one-off network blips.
          </p>
          <p
            v-if="errors.alertAfterFailures"
            :id="`${FIELD_IDS.alertAfterFailures}-error`"
            class="error-text"
          >
            {{ errors.alertAfterFailures }}
          </p>
        </div>
      </div>

      <div class="field">
        <label class="check">
          <input :id="FIELD_IDS.enabled" v-model="form.enabled" type="checkbox" />
          Run on schedule
        </label>
        <p class="hint">When off, the monitor only runs when you use Run now.</p>
      </div>

      <div id="field-alerts">
        <AlertChannelsEditor v-model:form="form" :errors="errors" />
      </div>

      <div class="row">
        <button type="submit" class="button button-primary" :disabled="saving">
          {{ editing ? 'Save changes' : 'Create monitor' }}
        </button>
        <RouterLink class="button" :to="original ? `/monitors/${original.id}` : '/'"
          >Cancel</RouterLink
        >
      </div>
    </form>
  </div>
</template>

<style scoped>
.breadcrumb {
  margin-bottom: var(--space-3);
}
.devices {
  align-content: start;
}
</style>
