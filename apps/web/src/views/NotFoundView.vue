<script setup lang="ts">
import { usePageTitle } from '../composables/title';

usePageTitle('Page not found');
</script>

<template>
  <div class="page">
    <h1>Page not found</h1>
    <p>There is no dashboard page at this address.</p>
    <RouterLink to="/">Go to the monitors</RouterLink>
  </div>
</template>
