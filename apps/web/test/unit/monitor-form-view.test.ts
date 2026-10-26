import { afterEach, describe, expect, it } from 'vitest';
import { ApiError } from '../../src/api/client';
import { fakeApi, flushPromises, mountAt, sampleMonitor, sampleRun } from './helpers';

const ID = '6f1c1e2a-8a0b-4c55-9d43-0d3c1b2a7e10';
const detailAnswers = {
  listRuns: { items: [], nextCursor: null },
  listAlerts: { items: [], nextCursor: null },
  getRun: sampleRun(),
};

afterEach(() => {
  document.body.innerHTML = '';
});

describe('new monitor form', () => {
  it('shows the API schema problems next to their fields and sends nothing', async () => {
    const api = fakeApi();
    const { wrapper } = await mountAt('/monitors/new', api);
    await wrapper.get('#field-schedule').setValue('* * * * *');
    await wrapper.get('form').trigger('submit');
    await flushPromises();

    expect(api.createMonitor).not.toHaveBeenCalled();
    const summary = wrapper.get('[role="alert"]');
    expect(summary.text()).toContain('Fix 3 problems before saving');
    expect(document.activeElement).toBe(summary.element);
    expect(summary.find('a[href="#field-name"]').text()).toBe('Name');
    const name = wrapper.get('#field-name');
    expect(name.attributes('aria-invalid')).toBe('true');
    expect(name.attributes('aria-describedby')).toBe('field-name-error');
    expect(wrapper.get('#field-name-error').text()).toBe('Required');
    expect(wrapper.get('#field-url-error').text()).toBe('Must be an http or https URL');
    expect(wrapper.get('#field-schedule-error').text()).toContain('minimum interval is 5 minutes');
  });

  it('creates the monitor with its alert channels and opens it', async () => {
    const created = sampleMonitor({ name: 'Hoodie' });
    const api = fakeApi({ createMonitor: created, getMonitor: created, ...detailAnswers });
    const { wrapper, router } = await mountAt('/monitors/new', api);
    await wrapper.get('#field-name').setValue('Hoodie');
    await wrapper.get('#field-url').setValue('http://127.0.0.1:4015/product/demo-hoodie/');
    await wrapper.get('input[value="desktop"]').setValue(false);
    await wrapper
      .findAll('button')
      .find((b) => b.text() === 'Add webhook')!
      .trigger('click');
    const inputs = wrapper.findAll('.channel input');
    await inputs[0]!.setValue('https://ops.example/hook');
    expect(inputs[1]!.attributes('type')).toBe('password');
    await inputs[1]!.setValue('sixteen-chars-secret');
    await wrapper.get('form').trigger('submit');
    await flushPromises();

    expect(api.createMonitor).toHaveBeenCalledWith({
      name: 'Hoodie',
      url: 'http://127.0.0.1:4015/product/demo-hoodie/',
      platform: 'auto',
      devices: ['mobile'],
      schedule: '*/15 * * * *',
      timezone: 'UTC',
      slowStepMs: 8000,
      alertAfterFailures: 2,
      enabled: true,
      alerts: [
        { type: 'webhook', url: 'https://ops.example/hook', secret: 'sixteen-chars-secret' },
      ],
    });
    expect(router.currentRoute.value.path).toBe(`/monitors/${created.id}`);
  });

  it('shows a refusal from the API at the field it names', async () => {
    const api = fakeApi({
      createMonitor: async () => {
        throw new ApiError(400, 'Validation failed', [
          { path: 'url', message: 'Host resolves to a private or internal address' },
        ]);
      },
    });
    const { wrapper } = await mountAt('/monitors/new', api);
    await wrapper.get('#field-name').setValue('Internal');
    await wrapper.get('#field-url').setValue('http://intranet.example/p');
    await wrapper.get('form').trigger('submit');
    await flushPromises();
    expect(wrapper.get('#field-url-error').text()).toBe(
      'Host resolves to a private or internal address',
    );
  });
});

describe('edit monitor form', () => {
  const stored = sampleMonitor({
    alerts: [
      { type: 'slack', url: 'https://hooks.slack.com/...XYZ1' },
      { type: 'webhook', url: 'https://ops.example/hook', hasSecret: true },
    ],
  });

  it('shows saved channels masked, never as editable values', async () => {
    const { wrapper } = await mountAt(`/monitors/${ID}/edit`, fakeApi({ getMonitor: stored }));
    const channels = wrapper.findAll('.channel');
    expect(channels.map((c) => c.find('.stored-url').text())).toEqual([
      'https://hooks.slack.com/...XYZ1',
      'https://ops.example/hook',
    ]);
    expect(channels[1]!.text()).toContain('Signed with a secret.');
    expect(wrapper.findAll('.channel input')).toHaveLength(0);
  });

  it('sends only the changes, keeping saved channels by index', async () => {
    const api = fakeApi({
      getMonitor: stored,
      updateMonitor: { ...stored, name: 'Renamed' },
      ...detailAnswers,
    });
    const { wrapper, router } = await mountAt(`/monitors/${ID}/edit`, api);
    await wrapper.get('#field-name').setValue('Renamed');
    await wrapper.get('button[aria-label="Remove alert channel 1 (Slack)"]').trigger('click');
    await wrapper.get('form').trigger('submit');
    await flushPromises();
    expect(api.updateMonitor).toHaveBeenCalledWith(ID, {
      name: 'Renamed',
      alerts: [{ type: 'stored', index: 1 }],
    });
    expect(router.currentRoute.value.path).toBe(`/monitors/${ID}`);
  });
});
