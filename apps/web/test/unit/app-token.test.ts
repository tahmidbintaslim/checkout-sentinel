import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, describe, expect, it } from 'vitest';
import { createMemoryHistory } from 'vue-router';
import App from '../../src/App.vue';
import { createApiClient } from '../../src/api/client';
import { authState, markUnauthorized } from '../../src/auth/state';
import { TOKEN_STORAGE_KEY, readToken } from '../../src/auth/token';
import { apiKey } from '../../src/composables/api';
import { createAppRouter } from '../../src/router';
import { fakeApi, mountApp, sampleMonitor } from './helpers';

const TOKEN = 'e2e-api-token-0123456789';

afterEach(() => {
  sessionStorage.clear();
  authState.required = false;
  document.body.innerHTML = '';
});

describe('API token prompt', () => {
  it('asks for the token on a 401, keeps it in sessionStorage and reloads the page with it', async () => {
    const seen: Array<string | null> = [];
    const client = createApiClient({
      token: () => readToken(),
      onUnauthorized: markUnauthorized,
      fetch: (async (_url: string, init?: RequestInit) => {
        const auth = new Headers(init?.headers).get('authorization');
        seen.push(auth);
        return auth === `Bearer ${TOKEN}`
          ? new Response(JSON.stringify([sampleMonitor()]), { status: 200 })
          : new Response(
              JSON.stringify({ statusCode: 401, message: 'Missing or invalid API token' }),
              {
                status: 401,
              },
            );
      }) as typeof fetch,
    });
    const router = createAppRouter(createMemoryHistory());
    await router.push('/');
    const wrapper = mount(App, {
      attachTo: document.body,
      global: { plugins: [router], provide: { [apiKey as symbol]: client } },
    });
    await flushPromises();

    expect(wrapper.text()).toContain('The API needs a token');
    expect(wrapper.find('tbody').exists()).toBe(false);

    await wrapper.get('input[type="password"]').setValue(TOKEN);
    await wrapper.get('form').trigger('submit');
    await flushPromises();

    expect(sessionStorage.getItem(TOKEN_STORAGE_KEY)).toBe(TOKEN);
    expect(wrapper.text()).not.toContain('The API needs a token');
    expect(wrapper.get('tbody').text()).toContain('Demo tee');
    expect(seen).toEqual([null, `Bearer ${TOKEN}`]);
  });

  it('confirms a token saved or forgotten on the API token page', async () => {
    authState.required = true;
    const { wrapper } = await mountApp('/settings', fakeApi());
    const form = () => wrapper.get('div.page form');
    const save = form().get('button[type="submit"]');
    await form().get('input[type="password"]').setValue('token-0123456789');
    (save.element as HTMLButtonElement).focus();
    await form().trigger('submit');
    await flushPromises();

    expect(form().get('[role="status"]').text()).toBe('Token saved for this tab.');
    expect(document.activeElement).toBe(save.element);
    // The 401 prompt above the page goes away once a token is saved here too.
    expect(wrapper.text()).not.toContain('The API needs a token');

    await form()
      .findAll('button')
      .find((button) => button.text() === 'Forget token')!
      .trigger('click');
    await flushPromises();
    expect(form().get('[role="status"]').text()).toBe('Token removed from this tab.');
  });
});
