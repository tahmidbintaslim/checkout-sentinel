import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../src/api/client';
import { fakeApi, mountAt, sampleMonitor, sampleRun } from './helpers';

const RUN = '/runs/a3d1b2c4-0000-4000-8000-000000000001';

beforeEach(() => {
  URL.createObjectURL = vi.fn(() => 'blob:http://dashboard.test/screenshot');
  URL.revokeObjectURL = vi.fn();
});

afterEach(() => {
  document.body.innerHTML = '';
});

describe('run detail', () => {
  it('shows each step with its duration, message, console errors and failed requests', async () => {
    const api = fakeApi({
      getRun: sampleRun(),
      getMonitor: sampleMonitor(),
      getArtifact: new Blob([new Uint8Array([0x89, 0x50])], { type: 'image/png' }),
    });
    const { wrapper } = await mountAt(RUN, api);

    expect(wrapper.find('nav[aria-label="Breadcrumb"]').text()).toContain('Demo tee');
    const steps = wrapper.findAll('li.step');
    expect(steps.map((s) => s.find('h3').text())).toEqual([
      'Open product',
      'Find add to cart',
      'Add to cart',
    ]);
    expect(steps[0]!.find('.step-duration').text()).toBe('121 ms');
    const failed = steps[1]!;
    expect(failed.find('.step-duration').text()).toBe('2.11 s');
    expect(failed.text()).toContain('hidden or disabled at this viewport');
    expect(failed.text()).toContain('Uncaught TypeError: x is undefined');
    expect(failed.find('table').text()).toContain('POST');
    expect(failed.find('table').text()).toContain('500');
    expect(failed.find('table').text()).toContain('/cart/add.js');
    // The bar starts where the step started in the journey.
    expect(failed.find('.bar').attributes('style')).toContain('margin-left: 4.76');
    expect(steps[2]!.find('.track').exists()).toBe(false);

    expect(api.getArtifact).toHaveBeenCalledWith(
      'a3d1b2c4-0000-4000-8000-000000000001',
      'mobile-find_add_to_cart.png',
    );
    const img = failed.get('img');
    expect(img.attributes('src')).toBe('blob:http://dashboard.test/screenshot');
    expect(img.attributes('alt')).toContain('mobile page when find add to cart failed');
    expect(wrapper.find('button').text()).toBe('Download Mobile trace');
    wrapper.unmount();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:http://dashboard.test/screenshot');
  });

  it('says when a screenshot file is gone', async () => {
    const api = fakeApi({
      getRun: sampleRun(),
      getMonitor: sampleMonitor(),
      getArtifact: async () => {
        throw new ApiError(404, 'Artifact not found');
      },
    });
    const { wrapper } = await mountAt(RUN, api);
    expect(wrapper.text()).toContain('The screenshot file is not available');
    expect(wrapper.find('img').exists()).toBe(false);
  });

  it('explains a run that could not execute', async () => {
    const api = fakeApi({
      getRun: sampleRun({
        status: 'error',
        failedStep: null,
        error: 'Worker lost: the run was still running 15 min after it started',
        result: null,
        artifacts: [],
      }),
      getMonitor: sampleMonitor(),
    });
    const { wrapper } = await mountAt(RUN, api);
    expect(wrapper.text()).toContain('The run could not execute: Worker lost');
    expect(wrapper.text()).toContain("does not change the monitor's health");
    expect(wrapper.findAll('li.step')).toHaveLength(0);
  });
});
