<script setup lang="ts">
import { OrganizationSwitcher, SignIn, UserButton, useAuth } from '@clerk/vue';
import { watch } from 'vue';
import { tokenChanged } from '../auth/state';

/**
 * Rendered only when the API uses Clerk. `header` shows the workspace switcher and account
 * menu; otherwise the default slot (the page) shows once signed in, and the sign-in form until
 * then. `open` pages (the public scanner) show without signing in.
 */
defineProps<{ header?: boolean; open?: boolean }>();

const { isLoaded, isSignedIn, orgId } = useAuth();
// Another workspace means other monitors: load the page again.
watch([isSignedIn, orgId], tokenChanged);
</script>

<template>
  <template v-if="header">
    <div v-if="isSignedIn" class="row">
      <OrganizationSwitcher />
      <UserButton />
    </div>
  </template>
  <p v-else-if="!isLoaded" class="page muted" role="status">Loading…</p>
  <slot v-else-if="isSignedIn || open" />
  <section v-else class="page sign-in" aria-label="Sign in">
    <SignIn />
  </section>
</template>

<style scoped>
.sign-in {
  display: grid;
  justify-content: center;
}
</style>
