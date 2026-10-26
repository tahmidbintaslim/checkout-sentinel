<script setup lang="ts">
import TokenForm from '../components/TokenForm.vue';
import { authState } from '../auth/state';
import { usePageTitle } from '../composables/title';

usePageTitle('API token');

// This page holds no API data, so it only hides the 401 prompt. tokenChanged() would remount
// it and drop the form's confirmation and focus.
const tokenSaved = () => {
  authState.required = false;
};
</script>

<template>
  <div class="page">
    <div class="page-header">
      <h1>API token</h1>
    </div>
    <div class="card">
      <p>
        When the API runs with <code>API_TOKEN</code>, every request from this dashboard needs it.
        Without <code>API_TOKEN</code> the API accepts requests without a token and you can leave
        this empty.
      </p>
      <TokenForm @saved="tokenSaved" />
    </div>
    <div class="card">
      <h2>API</h2>
      <p>
        The dashboard calls the API under <code>/api</code>, for example
        <code>GET /api/monitors</code>. The OpenAPI description is at <a href="/docs">/docs</a>.
      </p>
    </div>
  </div>
</template>
