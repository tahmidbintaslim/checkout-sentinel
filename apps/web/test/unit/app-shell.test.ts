import { afterEach, describe, expect, it } from 'vitest';
import { createMemoryHistory } from 'vue-router';
import { createAppRouter } from '../../src/router';
import { fakeApi, flushPromises, mountApp, sampleMonitor } from './helpers';

afterEach(() => {
  document.body.innerHTML = '';
});

describe('app shell', () => {
  it('keeps the form, what was typed and its errors when a link jumps to a field', async () => {
    const { wrapper, router } = await mountApp('/monitors/new', fakeApi());
    await wrapper.get('#field-name').setValue('Typed name');
    await wrapper.get('#field-url').setValue('not a url');
    await wrapper.get('form#monitor-form').trigger('submit');
    await flushPromises();
    expect(wrapper.find('.notice-error a[href="#field-url"]').exists()).toBe(true);

    // What the browser does to the router when the summary link or the skip link is followed.
    for (const hash of ['#field-url', '#main']) {
      await router.push(`/monitors/new${hash}`);
      await flushPromises();
      expect(wrapper.get<HTMLInputElement>('#field-name').element.value, hash).toBe('Typed name');
      expect(wrapper.find('.notice-error a[href="#field-url"]').exists(), hash).toBe(true);
    }
  });

  it('scrolls to the element a hash names, and to the top of other pages', () => {
    const router = createAppRouter(createMemoryHistory());
    const scroll = router.options.scrollBehavior;
    type Location = Parameters<NonNullable<typeof scroll>>[0];
    const at = (path: string) => router.resolve(path) as Location;
    const form = at('/monitors/new');
    expect(scroll?.(at('/monitors/new#field-url'), form, null)).toEqual({ el: '#field-url' });
    expect(scroll?.(at('/alerts'), form, null)).toEqual({ top: 0 });
    expect(scroll?.(at('/alerts'), form, { left: 0, top: 120 })).toEqual({
      left: 0,
      top: 120,
    });
  });

  it('filters the alert log in place, so the select keeps focus', async () => {
    const monitor = sampleMonitor();
    const api = fakeApi({
      listAlerts: { items: [], nextCursor: null },
      listMonitors: [monitor],
    });
    const { wrapper, router } = await mountApp('/alerts', api);
    const select = wrapper.get<HTMLSelectElement>('#alert-monitor-filter');
    select.element.focus();
    await select.setValue(monitor.id);
    await flushPromises();

    expect(router.currentRoute.value.query).toEqual({ monitor: monitor.id });
    expect(wrapper.get('#alert-monitor-filter').element).toBe(select.element);
    expect(document.activeElement).toBe(select.element);
    expect(api.listAlerts).toHaveBeenLastCalledWith({
      limit: 25,
      monitorId: monitor.id,
      before: undefined,
    });
  });
});
