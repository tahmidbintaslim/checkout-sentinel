import { createHmac } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { LookupFunction } from 'node:net';
import { TargetBlockedError, type AlertChannel, type TargetGuard } from '@checkout-sentinel/core';
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
  userAgent: string;
  /**
   * SSRF protection for user-supplied channel URLs: the URL is checked, and the connection
   * goes only to an address the guard has just checked. The worker always passes one.
   */
  targetGuard?: TargetGuard;
}

/**
 * POSTs a body and resolves with the status code. Redirects are never followed (a redirect
 * could point at an internal address), and `lookup` decides which addresses may be used.
 */
export function postJson(
  url: URL,
  body: string,
  headers: Record<string, string>,
  options: { timeoutMs: number; lookup?: LookupFunction },
): Promise<number> {
  const send = url.protocol === 'https:' ? httpsRequest : httpRequest;
  return new Promise((resolve, reject) => {
    const request = send(url, {
      method: 'POST',
      headers: { ...headers, 'content-length': String(Buffer.byteLength(body)) },
      // A fresh connection per delivery: a pooled socket could predate the guard's check.
      agent: false,
      ...(options.lookup ? { lookup: options.lookup } : {}),
    });
    const timer = setTimeout(() => {
      request.destroy(new Error(`No response within ${options.timeoutMs} ms`));
    }, options.timeoutMs);
    request.once('response', (response) => {
      clearTimeout(timer);
      response.resume();
      resolve(response.statusCode ?? 0);
    });
    request.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    request.end(body);
  });
}

/** POSTs one alert to one channel. Retries network errors and 5xx; 4xx, 3xx and blocks are final. */
export async function deliverAlert(
  channel: AlertChannel,
  context: AlertContext,
  options: DeliverOptions,
): Promise<DeliveryOutcome> {
  const guard = options.targetGuard;
  if (guard) {
    const verdict = guard.checkUrlSync(channel.url, channel.type);
    if (!verdict.allowed) return { ok: false, error: `Blocked: ${verdict.reason}` };
  }
  const payload = channel.type === 'slack' ? slackPayload(context) : webhookPayload(context);
  const body = JSON.stringify(payload);
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'user-agent': options.userAgent,
  };
  if (channel.type === 'webhook' && channel.secret) {
    headers[SIGNATURE_HEADER] = signBody(body, channel.secret);
  }
  const url = new URL(channel.url);

  let last: DeliveryOutcome = { ok: false, error: 'not attempted' };
  for (let attempt = 1; attempt <= options.attempts; attempt += 1) {
    try {
      const status = await postJson(url, body, headers, {
        timeoutMs: options.timeoutMs,
        ...(guard && !guard.permissive ? { lookup: guard.lookup } : {}),
      });
      if (status >= 200 && status < 300) return { ok: true, status };
      last = {
        ok: false,
        status,
        error:
          status >= 300 && status < 400
            ? `HTTP ${status} (redirects are not followed)`
            : `HTTP ${status}`,
      };
      if (status < 500) return last;
    } catch (error) {
      if (error instanceof TargetBlockedError) {
        return { ok: false, error: `Blocked: ${error.message}` };
      }
      last = { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
    if (attempt < options.attempts) await new Promise((r) => setTimeout(r, 500 * attempt));
  }
  return last;
}
