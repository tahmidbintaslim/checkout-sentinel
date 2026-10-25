import type { Page } from 'playwright';
import type { ConsoleError, FailedRequest, PageError, StepName } from './schema.js';

/** Results stay bounded even when a page logs in a loop. */
export const MAX_EVENTS_PER_STEP = 50;

export interface StepEvents {
  consoleErrors: ConsoleError[];
  pageErrors: PageError[];
  failedRequests: FailedRequest[];
}

function emptyEvents(): StepEvents {
  return { consoleErrors: [], pageErrors: [], failedRequests: [] };
}

function push<T>(list: T[], item: T): void {
  if (list.length < MAX_EVENTS_PER_STEP) list.push(item);
}

/**
 * Attributes browser events to the step that is running when they arrive. Events that land
 * after a step finished (late XHRs, deferred scripts) are counted against the next step,
 * which is also where a user would notice them.
 */
export class StepRecorder {
  private current: StepName | null = null;
  private readonly buckets = new Map<StepName, StepEvents>();

  begin(step: StepName): void {
    this.current = step;
    if (!this.buckets.has(step)) this.buckets.set(step, emptyEvents());
  }

  take(step: StepName): StepEvents {
    const events = this.buckets.get(step) ?? emptyEvents();
    this.buckets.delete(step);
    if (this.current === step) this.current = null;
    return events;
  }

  private bucket(): StepEvents | null {
    return this.current === null ? null : (this.buckets.get(this.current) ?? null);
  }

  recordConsoleError(error: ConsoleError): void {
    // Chromium also logs every 4xx/5xx subresource as a console error; those are already
    // captured, with more detail, as failed requests.
    if (error.text.startsWith('Failed to load resource:')) return;
    const bucket = this.bucket();
    if (bucket) push(bucket.consoleErrors, error);
  }

  recordPageError(error: PageError): void {
    const bucket = this.bucket();
    if (bucket) push(bucket.pageErrors, error);
  }

  recordFailedRequest(request: FailedRequest): void {
    const bucket = this.bucket();
    if (bucket) push(bucket.failedRequests, request);
  }

  attach(page: Page): void {
    page.on('console', (message) => {
      if (message.type() !== 'error') return;
      const { url, lineNumber } = message.location();
      this.recordConsoleError({
        text: message.text(),
        ...(url ? { location: `${url}:${lineNumber}` } : {}),
      });
    });
    page.on('pageerror', (error) => {
      this.recordPageError({
        message: error.message,
        ...(error.stack ? { stack: error.stack } : {}),
      });
    });
    page.on('response', (response) => {
      if (response.status() < 400) return;
      const request = response.request();
      this.recordFailedRequest({
        url: response.url(),
        method: request.method(),
        resourceType: request.resourceType(),
        kind: 'http_error',
        status: response.status(),
      });
    });
    page.on('requestfailed', (request) => {
      const failure = request.failure()?.errorText ?? 'unknown failure';
      this.recordFailedRequest({
        url: request.url(),
        method: request.method(),
        resourceType: request.resourceType(),
        kind: /BLOCKED|ERR_ABORTED.*blocked/i.test(failure) ? 'blocked' : 'network',
        failure,
      });
    });
  }
}
