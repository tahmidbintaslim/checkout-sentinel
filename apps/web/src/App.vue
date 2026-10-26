<script setup lang="ts">
import { nextTick, ref } from 'vue';
import { RouterLink, RouterView, useRouter } from 'vue-router';
import { authState, tokenChanged } from './auth/state';
import TokenForm from './components/TokenForm.vue';

const main = ref<HTMLElement | null>(null);
const router = useRouter();
const demo = import.meta.env.MODE === 'demo';

// After moving to another page, start keyboard and screen reader users at its content.
router.afterEach((to, from) => {
  if (from.matched.length > 0 && to.path !== from.path) {
    void nextTick(() => main.value?.focus({ preventScroll: true }));
  }
});
</script>

<template>
  <a class="skip-link" href="#main">Skip to content</a>
  <header class="site-header">
    <div class="site-header-inner">
      <RouterLink to="/" class="brand">checkout-sentinel</RouterLink>
      <nav aria-label="Main">
        <ul class="nav">
          <li>
            <RouterLink to="/" class="nav-link" exact-active-class="active">Monitors</RouterLink>
          </li>
          <li>
            <RouterLink to="/alerts" class="nav-link" active-class="active">Alert log</RouterLink>
          </li>
          <li v-if="!demo">
            <RouterLink to="/settings" class="nav-link" active-class="active">API token</RouterLink>
          </li>
        </ul>
      </nav>
    </div>
  </header>
  <p v-if="demo" class="demo-banner notice notice-info" role="note">
    Read-only demo. The runs are real journeys against local test stores, shown on an hourly
    timeline; no real shop is checked and nothing you change is saved.
  </p>

  <main id="main" ref="main" tabindex="-1">
    <section v-if="authState.required" class="page auth" aria-labelledby="auth-title">
      <div class="notice notice-info" role="alert">
        <h2 id="auth-title">The API needs a token</h2>
        <p>The API answered 401. Enter the token it was started with to continue.</p>
      </div>
      <div class="card">
        <TokenForm @saved="tokenChanged" />
      </div>
    </section>
    <!-- Keyed on the path only: a hash (summary links, the skip link) or query (the alert filter)
         change must not remount the page and drop what was typed or focused. -->
    <RouterView v-slot="{ Component, route }">
      <component :is="Component" :key="`${route.path}#${authState.version}`" />
    </RouterView>
  </main>
</template>

<style scoped>
.demo-banner {
  max-width: var(--content-width);
  margin: var(--space-2) auto 0;
  padding: var(--space-2) var(--space-4);
}
.site-header {
  background: var(--color-surface);
  border-bottom: 1px solid var(--color-divider);
}
.site-header-inner {
  max-width: var(--content-width);
  margin: 0 auto;
  padding: var(--space-2) var(--space-4);
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2) var(--space-4);
}
.brand {
  color: var(--color-text);
  font-weight: 700;
  text-decoration: none;
  font-family: var(--font-mono);
}
.nav {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-1);
  list-style: none;
  margin: 0;
  padding: 0;
}
.nav-link {
  display: inline-block;
  padding: var(--space-1) var(--space-3);
  border-radius: var(--radius-sm);
  color: var(--color-text);
  text-decoration: none;
  font-size: var(--text-sm);
  font-weight: 600;
}
.nav-link:hover {
  background: var(--color-surface-raised);
}
.nav-link.active {
  background: var(--color-neutral-bg);
  box-shadow: inset 0 -2px 0 var(--color-accent);
}
main:focus {
  outline: none;
}
.auth {
  padding-bottom: 0;
}
.auth h2 {
  margin-bottom: var(--space-2);
}
</style>
