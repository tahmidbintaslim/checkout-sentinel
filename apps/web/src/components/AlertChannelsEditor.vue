<script setup lang="ts">
import { computed, nextTick, useId } from 'vue';
import { MAX_ALERT_CHANNELS } from '@checkout-sentinel/core/schemas';
import {
  addChannel,
  type ChannelDraft,
  type FieldErrors,
  type MonitorForm,
} from '../lib/monitor-form';

const form = defineModel<MonitorForm>('form', { required: true });
const props = defineProps<{ errors: FieldErrors }>();

const id = useId();
const full = computed(() => form.value.alerts.length >= MAX_ALERT_CHANNELS);

const typeLabel = (draft: ChannelDraft) => (draft.type === 'slack' ? 'Slack' : 'Webhook');
const errorFor = (position: number, field: string) => props.errors[`alerts.${position}.${field}`];
const fieldId = (draft: ChannelDraft, field: string) => `${id}-${draft.key}-${field}`;

async function add(type: ChannelDraft['type']) {
  const draft = addChannel(form.value, type);
  if (!draft) return;
  await nextTick();
  document.getElementById(fieldId(draft, 'url'))?.focus();
}

function remove(position: number) {
  form.value.alerts.splice(position, 1);
}
</script>

<template>
  <fieldset class="channels">
    <legend>Alert channels</legend>
    <p class="hint">
      Alerts go out when the monitor starts failing, when it recovers, and when a step turns slow.
      Slack URLs and webhook secrets are not shown again after saving; saved channels stay as they
      are unless you remove them.
    </p>
    <p v-if="errors.alerts" class="error-text">{{ errors.alerts }}</p>
    <p v-if="form.alerts.length === 0" class="muted">No alert channels.</p>

    <ul class="channel-list">
      <li v-for="(draft, position) in form.alerts" :key="draft.key" class="channel">
        <div class="channel-head">
          <strong>{{ typeLabel(draft) }}</strong>
          <span v-if="draft.kind === 'stored'" class="muted small">saved</span>
          <span v-else class="muted small">new</span>
          <button
            type="button"
            class="button button-link"
            :aria-label="`Remove alert channel ${position + 1} (${typeLabel(draft)})`"
            @click="remove(position)"
          >
            Remove
          </button>
        </div>

        <template v-if="draft.kind === 'stored' && draft.stored">
          <p class="mono small break stored-url">{{ draft.stored.url }}</p>
          <p v-if="draft.stored.type === 'webhook'" class="hint">
            {{ draft.stored.hasSecret ? 'Signed with a secret.' : 'Not signed.' }}
          </p>
          <p v-if="errorFor(position, 'index')" class="error-text">
            {{ errorFor(position, 'index') }}
          </p>
        </template>

        <template v-else>
          <div class="field">
            <label :for="fieldId(draft, 'url')">
              {{ draft.type === 'slack' ? 'Slack incoming webhook URL' : 'Webhook URL' }}
            </label>
            <input
              :id="fieldId(draft, 'url')"
              v-model="draft.url"
              type="url"
              inputmode="url"
              autocomplete="off"
              spellcheck="false"
              :aria-invalid="errorFor(position, 'url') ? 'true' : 'false'"
              :aria-describedby="`${fieldId(draft, 'url')}-hint ${fieldId(draft, 'url')}-error`"
            />
            <p :id="`${fieldId(draft, 'url')}-hint`" class="hint">
              <template v-if="draft.type === 'slack'"
                >Starts with https://hooks.slack.com/. Shown masked after saving.</template
              >
              <template v-else>Receives a JSON body for each alert.</template>
            </p>
            <p :id="`${fieldId(draft, 'url')}-error`" class="error-text">
              {{ errorFor(position, 'url') }}
            </p>
          </div>
          <div v-if="draft.type === 'webhook'" class="field">
            <label :for="fieldId(draft, 'secret')">Signing secret (optional)</label>
            <input
              :id="fieldId(draft, 'secret')"
              v-model="draft.secret"
              type="password"
              autocomplete="new-password"
              spellcheck="false"
              :aria-invalid="errorFor(position, 'secret') ? 'true' : 'false'"
              :aria-describedby="`${fieldId(draft, 'secret')}-hint ${fieldId(draft, 'secret')}-error`"
            />
            <p :id="`${fieldId(draft, 'secret')}-hint`" class="hint">
              At least 16 characters. Deliveries then carry an
              <code>x-checkout-sentinel-signature</code> HMAC-SHA256 header. Never shown again.
            </p>
            <p :id="`${fieldId(draft, 'secret')}-error`" class="error-text">
              {{ errorFor(position, 'secret') }}
            </p>
          </div>
        </template>
      </li>
    </ul>

    <div class="row">
      <button type="button" class="button" :disabled="full" @click="add('webhook')">
        Add webhook
      </button>
      <button type="button" class="button" :disabled="full" @click="add('slack')">
        Add Slack channel
      </button>
      <span v-if="full" class="hint">At most {{ MAX_ALERT_CHANNELS }} channels.</span>
    </div>
  </fieldset>
</template>

<style scoped>
.channel-list {
  list-style: none;
  margin: 0 0 var(--space-3);
  padding: 0;
}
.channel {
  border: 1px solid var(--color-divider);
  border-radius: var(--radius-md);
  padding: var(--space-3);
  margin-bottom: var(--space-3);
}
.channel-head {
  display: flex;
  align-items: baseline;
  gap: var(--space-2);
  margin-bottom: var(--space-2);
}
.channel-head .button-link {
  margin-left: auto;
}
.channel .field:last-child {
  margin-bottom: 0;
}
.stored-url {
  margin: 0;
}
</style>
