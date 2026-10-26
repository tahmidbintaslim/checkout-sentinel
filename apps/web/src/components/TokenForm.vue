<script setup lang="ts">
import { ref, useId } from 'vue';
import { clearToken, readToken, saveToken } from '../auth/token';

const emit = defineEmits<{ saved: []; cleared: [] }>();

const id = useId();
const value = ref('');
const hasToken = ref(readToken() !== null);
const status = ref('');

function save() {
  saveToken(value.value);
  value.value = '';
  hasToken.value = readToken() !== null;
  status.value = hasToken.value ? 'Token saved for this tab.' : 'No token entered.';
  if (hasToken.value) emit('saved');
}

function forget() {
  clearToken();
  hasToken.value = false;
  status.value = 'Token removed from this tab.';
  emit('cleared');
}
</script>

<template>
  <form class="token-form" @submit.prevent="save">
    <div class="field">
      <label :for="`${id}-token`">API token</label>
      <input
        :id="`${id}-token`"
        v-model="value"
        type="password"
        autocomplete="off"
        spellcheck="false"
        :aria-describedby="`${id}-hint`"
        required
      />
      <p :id="`${id}-hint`" class="hint">
        The <code>API_TOKEN</code> the API was started with. It is kept in this tab's session
        storage, sent as a bearer token, and removed when the tab closes.
      </p>
    </div>
    <div class="row">
      <button type="submit" class="button button-primary">Save token</button>
      <button v-if="hasToken" type="button" class="button" @click="forget">Forget token</button>
    </div>
    <p class="hint" role="status">{{ status }}</p>
  </form>
</template>
