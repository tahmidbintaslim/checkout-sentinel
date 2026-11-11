<script setup lang="ts">
import { onMounted, ref } from 'vue';
import type { ApiKeyEntry } from '../api/types';
import { useApi } from '../composables/api';
import { formatDateTime } from '../lib/format';
import ErrorNotice from './ErrorNotice.vue';

const api = useApi();
const keys = ref<ApiKeyEntry[]>([]);
const name = ref('');
/** The key just created; the API returns it once, so it is shown until the page is left. */
const created = ref<string | null>(null);
const error = ref<unknown>(null);
const busy = ref(false);

async function load() {
  try {
    keys.value = await api.listApiKeys();
    error.value = null;
  } catch (e) {
    error.value = e;
  }
}
onMounted(load);

async function create() {
  busy.value = true;
  try {
    created.value = (await api.createApiKey(name.value)).key;
    name.value = '';
    await load();
  } catch (e) {
    error.value = e;
  } finally {
    busy.value = false;
  }
}

async function revoke(key: ApiKeyEntry) {
  if (!window.confirm(`Revoke "${key.name}"? Anything using it stops working at once.`)) return;
  try {
    await api.deleteApiKey(key.id);
    await load();
  } catch (e) {
    error.value = e;
  }
}
</script>

<template>
  <div class="card">
    <h2>API keys</h2>
    <p class="muted">
      For scripts and integrations: send one as <code>Authorization: Bearer &lt;key&gt;</code>. A
      key reaches this workspace's monitors only.
    </p>
    <ErrorNotice v-if="error" :error="error" title="API keys" />
    <div v-if="created" class="notice notice-info" role="status">
      <strong>Copy this key now; it is not shown again.</strong>
      <p>
        <code class="key">{{ created }}</code>
      </p>
    </div>
    <table v-if="keys.length > 0">
      <thead>
        <tr>
          <th scope="col">Name</th>
          <th scope="col">Key</th>
          <th scope="col">Created</th>
          <th scope="col"><span class="visually-hidden">Actions</span></th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="key in keys" :key="key.id">
          <td>{{ key.name }}</td>
          <td>
            <code>{{ key.prefix }}…</code>
          </td>
          <td>{{ formatDateTime(key.createdAt) }}</td>
          <td>
            <button type="button" class="button button-danger" @click="revoke(key)">
              Revoke<span class="visually-hidden"> {{ key.name }}</span>
            </button>
          </td>
        </tr>
      </tbody>
    </table>
    <form class="row" @submit.prevent="create">
      <div class="field">
        <label for="api-key-name">New key name</label>
        <input id="api-key-name" v-model="name" type="text" required maxlength="80" />
      </div>
      <button type="submit" class="button button-primary" :disabled="busy">Create key</button>
    </form>
  </div>
</template>

<style scoped>
.key {
  overflow-wrap: anywhere;
}
</style>
