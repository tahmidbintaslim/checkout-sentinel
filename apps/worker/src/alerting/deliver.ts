import { createHmac } from 'node:crypto';
import type { AlertChannel } from '@checkout-sentinel/core';
import { slackPayload, webhookPayload, type AlertContext } from './payload.js';

export const SIGNATURE_HEADER = 'x-checkout-sentinel-signature';

export function signBody(body: string, secret: string): string {
  return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
}

export interface DeliveryOutcome {
  ok: boolean;
  status?: number;
  error?: string;
}

export interface DeliverOptions {
  timeoutMs: number;
  attempts: number;
  fetchImpl?: typeof fetch;
  userAgent: string;
}

/** POSTs one alert to one channel. Retries network errors and 5xx; 4xx is final. */
export async function deliverAlert(
  channel: AlertChannel,
  context: AlertContext,
  options: DeliverOptions,
): Promise<DeliveryOutcome> {
  const payload = channel.type === 'slack' ? slackPayload(context) : webhookPayload(context);
  const body = JSON.stringify(payload);
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'user-agent': options.userAgent,
  };
  if (channel.type === 'webhook' && channel.secret) {
    headers[SIGNATURE_HEADER] = signBody(body, channel.secret);
  }
  const doFetch = options.fetchImpl ?? fetch;

  let last: DeliveryOutcome = { ok: false, error: 'not attempted' };
  for (let attempt = 1; attempt <= options.attempts; attempt += 1) {
    try {
      const response = await doFetch(channel.url, {
        method: 'POST',
        headers,
        body,
        redirect: 'error',
        signal: AbortSignal.timeout(options.timeoutMs),
      });
      await response.body?.cancel().catch(() => undefined);
      if (response.ok) return { ok: true, status: response.status };
      last = { ok: false, status: response.status, error: `HTTP ${response.status}` };
      if (response.status < 500) return last;
    } catch (error) {
      last = { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
    if (attempt < options.attempts) await new Promise((r) => setTimeout(r, 500 * attempt));
  }
  return last;
}
