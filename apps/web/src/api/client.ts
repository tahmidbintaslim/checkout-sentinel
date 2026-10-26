import type { MonitorPatch, MonitorSpecInput } from '@checkout-sentinel/core/schemas';
import type { AlertEntry, Monitor, Page, RunDetail, RunSummary, ValidationIssue } from './types';

export class ApiError extends Error {
  constructor(
    /** HTTP status, or 0 when the API could not be reached. */
    readonly status: number,
    message: string,
    readonly issues: ValidationIssue[] = [],
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export interface ApiClientOptions {
  /** Where the API routes live. The API serves them under /api next to the dashboard. */
  baseUrl?: string;
  /** Read on every request, so a token entered later is used at once. */
  token: () => string | null;
  fetch?: typeof fetch;
  /** Called on every 401, before the error is thrown. */
  onUnauthorized?: () => void;
}

type Query = Record<string, string | number | undefined>;

function withQuery(path: string, query: Query = {}): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) params.set(key, String(value));
  }
  const search = params.toString();
  return search ? `${path}?${search}` : path;
}

const segment = encodeURIComponent;

interface ErrorBody {
  message?: unknown;
  issues?: unknown;
}

async function errorFrom(response: Response): Promise<ApiError> {
  const body = (await response.json().catch(() => null)) as ErrorBody | null;
  const message =
    typeof body?.message === 'string'
      ? body.message
      : Array.isArray(body?.message)
        ? body.message.join('; ')
        : `The API answered HTTP ${response.status}`;
  const issues = Array.isArray(body?.issues) ? (body.issues as ValidationIssue[]) : [];
  return new ApiError(response.status, message, issues);
}

export function createApiClient(options: ApiClientOptions) {
  const base = options.baseUrl ?? '/api';
  const fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);

  async function request(
    method: string,
    path: string,
    init: { body?: unknown; accept?: string } = {},
  ): Promise<Response> {
    const headers: Record<string, string> = { accept: init.accept ?? 'application/json' };
    const token = options.token();
    if (token) headers.authorization = `Bearer ${token}`;
    if (init.body !== undefined) headers['content-type'] = 'application/json';
    let response: Response;
    try {
      response = await fetchImpl(`${base}${path}`, {
        method,
        headers,
        ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new ApiError(0, `Cannot reach the API: ${reason}`);
    }
    if (response.ok) return response;
    if (response.status === 401) options.onUnauthorized?.();
    throw await errorFrom(response);
  }

  const json = async <T>(method: string, path: string, body?: unknown): Promise<T> =>
    (await (await request(method, path, { body })).json()) as T;

  return {
    listMonitors: () => json<Monitor[]>('GET', '/monitors'),
    getMonitor: (id: string) => json<Monitor>('GET', `/monitors/${segment(id)}`),
    createMonitor: (spec: MonitorSpecInput) => json<Monitor>('POST', '/monitors', spec),
    updateMonitor: (id: string, patch: MonitorPatch) =>
      json<Monitor>('PATCH', `/monitors/${segment(id)}`, patch),
    deleteMonitor: async (id: string): Promise<void> => {
      await request('DELETE', `/monitors/${segment(id)}`);
    },
    runNow: (id: string) => json<{ jobId: string }>('POST', `/monitors/${segment(id)}/runs`),
    listRuns: (id: string, query: { limit?: number; before?: string } = {}) =>
      json<Page<RunSummary>>('GET', withQuery(`/monitors/${segment(id)}/runs`, query)),
    getRun: (id: string) => json<RunDetail>('GET', `/runs/${segment(id)}`),
    listAlerts: (query: { limit?: number; monitorId?: string; before?: string } = {}) =>
      json<Page<AlertEntry>>('GET', withQuery('/alerts', query)),
    getArtifact: async (runId: string, name: string): Promise<Blob> =>
      (
        await request('GET', `/runs/${segment(runId)}/artifacts/${segment(name)}`, {
          accept: '*/*',
        })
      ).blob(),
  };
}

export type ApiClient = ReturnType<typeof createApiClient>;
