import { describe, expect, it } from 'vitest';
import { MAX_EVENTS_PER_STEP, StepRecorder } from '@checkout-sentinel/core';

describe('StepRecorder', () => {
  it('attributes events to the running step and ignores events between steps', () => {
    const recorder = new StepRecorder();
    recorder.recordPageError({ message: 'before any step' });
    recorder.begin('open_product');
    recorder.recordPageError({ message: 'boom' });
    recorder.recordConsoleError({ text: 'Failed to load resource: 404' });
    recorder.recordConsoleError({ text: 'Uncaught TypeError' });
    const events = recorder.take('open_product');
    expect(events.pageErrors).toEqual([{ message: 'boom' }]);
    expect(events.consoleErrors).toEqual([{ text: 'Uncaught TypeError' }]);
    recorder.recordPageError({ message: 'after the step' });
    expect(recorder.take('find_add_to_cart').pageErrors).toEqual([]);
  });

  it('caps events per step', () => {
    const recorder = new StepRecorder();
    recorder.begin('add_to_cart');
    for (let i = 0; i < MAX_EVENTS_PER_STEP + 10; i += 1)
      recorder.recordPageError({ message: `${i}` });
    expect(recorder.take('add_to_cart').pageErrors).toHaveLength(MAX_EVENTS_PER_STEP);
  });
});
