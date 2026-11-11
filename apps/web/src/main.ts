import { clerkPlugin } from '@clerk/vue';
import { createApp } from 'vue';
import { createWebHistory } from 'vue-router';
import App from './App.vue';
import { createApiClient } from './api/client';
import { createDemoFetch } from './api/demo';
import { authState, markUnauthorized } from './auth/state';
import { readToken } from './auth/token';
import { apiKey } from './composables/api';
import { createAppRouter } from './router';
import './styles/tokens.css';
import './styles/base.css';

/** The session clerk-js keeps on window once it has loaded. */
type ClerkGlobal = { session?: { getToken(): Promise<string | null> } | null };
const clerkToken = () =>
  (window as { Clerk?: ClerkGlobal }).Clerk?.session?.getToken() ?? Promise.resolve(null);

// Only `vite build --mode demo` sets this; a VITE_* variable would reach every mode.
const demo = import.meta.env.MODE === 'demo';
const client = createApiClient({
  token: () => (authState.clerk ? clerkToken() : readToken()),
  onUnauthorized: markUnauthorized,
  ...(demo ? { fetch: createDemoFetch(`${import.meta.env.BASE_URL}demo-data/`) } : {}),
});

const app = createApp(App)
  .use(createAppRouter(createWebHistory(import.meta.env.BASE_URL)))
  .provide(apiKey, client);

// The API says how to sign in. If it cannot be reached, the token flow shows the error.
const clerkKey = demo
  ? null
  : await client
      .getAuthConfig()
      .then((config) => config.clerkPublishableKey)
      .catch(() => null);
if (clerkKey) {
  authState.clerk = true;
  app.use(clerkPlugin, { publishableKey: clerkKey });
}
app.mount('#app');
