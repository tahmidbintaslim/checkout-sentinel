import { createApp } from 'vue';
import App from './App.vue';
import { createApiClient } from './api/client';
import { markUnauthorized } from './auth/state';
import { readToken } from './auth/token';
import { apiKey } from './composables/api';
import { createAppRouter } from './router';
import './styles/tokens.css';
import './styles/base.css';

const client = createApiClient({ token: () => readToken(), onUnauthorized: markUnauthorized });

createApp(App).use(createAppRouter()).provide(apiKey, client).mount('#app');
