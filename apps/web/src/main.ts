import { createApp } from 'vue';
import { createWebHistory } from 'vue-router';
import App from './App.vue';
import { createApiClient } from './api/client';
import { createDemoFetch } from './api/demo';
import { markUnauthorized } from './auth/state';
import { readToken } from './auth/token';
import { apiKey } from './composables/api';
import { createAppRouter } from './router';
import './styles/tokens.css';
import './styles/base.css';

const demo = import.meta.env.VITE_DEMO === '1';
const client = createApiClient({
  token: () => readToken(),
  onUnauthorized: markUnauthorized,
  ...(demo ? { fetch: createDemoFetch(`${import.meta.env.BASE_URL}demo-data/`) } : {}),
});

createApp(App)
  .use(createAppRouter(createWebHistory(import.meta.env.BASE_URL)))
  .provide(apiKey, client)
  .mount('#app');
