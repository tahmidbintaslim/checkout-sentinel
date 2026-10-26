<script setup lang="ts">
import TokenForm from '../components/TokenForm.vue';
import { tokenChanged } from '../auth/state';
import { usePageTitle } from '../composables/title';

usePageTitle('API token');
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
      <TokenForm @saved="tokenChanged" @cleared="tokenChanged" />
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
