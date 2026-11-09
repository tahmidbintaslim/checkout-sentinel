import { randomUUID } from 'node:crypto';
import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpException,
  HttpStatus,
  Inject,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import type { Redis } from 'ioredis';
import { z } from 'zod';
import type { RunResult, TargetGuard } from '@checkout-sentinel/core';
import { SCAN_JOB_OPTIONS, type ScanQueue } from '@checkout-sentinel/jobs';
import { Public } from '../common/auth.guard.js';
import { validationError } from '../common/validation.js';
import type { ApiConfig } from '../config.js';
import {
  API_CONFIG,
  REDIS,
  SCAN_QUEUE_HANDLE,
  TARGET_GUARD,
  TURNSTILE_VERIFIER,
} from '../tokens.js';

export const ScanRequestSchema = z.object({
  url: z.url({ protocol: /^https?$/, error: 'Must be an http or https URL' }),
  turnstileToken: z.string().min(1).max(4_096),
});
export type ScanRequest = z.infer<typeof ScanRequestSchema>;

/** Checks a Turnstile token for a client address; false for any refusal or verification error. */
export type TurnstileVerifier = (token: string, ip: string | undefined) => Promise<boolean>;

export function cloudflareTurnstile(secret: string): TurnstileVerifier {
  return async (token, ip) => {
    const body = new URLSearchParams({ secret, response: token, ...(ip ? { remoteip: ip } : {}) });
    try {
      const response = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
        method: 'POST',
        body,
        signal: AbortSignal.timeout(5_000),
      });
      return response.ok && ((await response.json()) as { success?: boolean }).success === true;
    } catch {
      return false;
    }
  };
}

const RATE_WINDOW_SECONDS = 3600;
const uuid = new ParseUUIDPipe({ version: '4' });

type ScanStatus = 'queued' | 'running' | 'done' | 'error';

/**
 * The public scanner: anyone may start a one-off journey against a store URL. Every scan runs a
 * real browser, so the endpoint is off unless SCANNER_ENABLED, needs a Turnstile token, is
 * limited per client address and by queue length, and refuses private targets like monitors do.
 * Scan ids are random UUIDs; whoever holds one can read its result for 24 hours.
 */
@ApiTags('scans')
@Public()
@Controller('scans')
export class ScansController {
  constructor(
    @Inject(API_CONFIG) private readonly config: ApiConfig,
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(SCAN_QUEUE_HANDLE) private readonly queue: ScanQueue,
    @Inject(TARGET_GUARD) private readonly guard: TargetGuard,
    @Inject(TURNSTILE_VERIFIER) private readonly verify: TurnstileVerifier,
  ) {}

  @Get('config')
  @ApiOperation({ summary: 'Whether the scanner is on, and the Turnstile site key to use' })
  scannerConfig() {
    return {
      enabled: this.config.SCANNER_ENABLED,
      turnstileSiteKey: this.config.SCANNER_ENABLED
        ? (this.config.TURNSTILE_SITE_KEY ?? null)
        : null,
    };
  }

  @Post()
  @ApiOperation({ summary: 'Start a one-off scan of a product URL' })
  async create(@Body({ schema: ScanRequestSchema }) body: ScanRequest, @Req() req: Request) {
    this.requireEnabled();
    const ip = req.ip;
    const key = `checkout-sentinel:scan-rate:${ip ?? 'unknown'}`;
    const [[, count]] = (await this.redis
      .multi()
      .incr(key)
      .expire(key, RATE_WINDOW_SECONDS, 'NX')
      .exec()) as [[Error | null, number]];
    if (count > this.config.SCAN_RATE_LIMIT_PER_HOUR) {
      throw new HttpException(
        'Too many scans from this address; try again later',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    if (!(await this.verify(body.turnstileToken, ip))) {
      throw new ForbiddenException('The human check failed; reload the page and try again');
    }
    const verdict = await this.guard.checkUrl(body.url, 'store');
    if (!verdict.allowed) throw validationError([{ path: 'url', message: verdict.reason }]);
    const pending = await this.queue.getJobCountByTypes(
      'waiting',
      'delayed',
      'active',
      'prioritized',
    );
    if (pending >= this.config.SCAN_QUEUE_LIMIT) {
      throw new ServiceUnavailableException('The scanner is busy; try again in a few minutes');
    }
    const id = randomUUID();
    await this.queue.add('scan', { url: body.url }, { ...SCAN_JOB_OPTIONS, jobId: id });
    return { id, status: 'queued' satisfies ScanStatus };
  }

  @Get(':id')
  @ApiOperation({ summary: 'A scan and, once it finished, its result' })
  async get(@Param('id', uuid) id: string) {
    this.requireEnabled();
    const job = await this.queue.getJob(id);
    if (!job) throw new NotFoundException('No such scan, or its result expired');
    const state = await job.getState();
    const status: ScanStatus =
      state === 'completed'
        ? 'done'
        : state === 'failed'
          ? 'error'
          : state === 'active'
            ? 'running'
            : 'queued';
    return {
      id,
      url: job.data.url,
      status,
      createdAt: new Date(job.timestamp).toISOString(),
      ...(status === 'done' ? { result: job.returnvalue as RunResult } : {}),
      // The worker's message can name internals; the client only needs to know it did not run.
      ...(status === 'error' ? { error: 'The scan could not run. Try again later.' } : {}),
    };
  }

  private requireEnabled(): void {
    if (!this.config.SCANNER_ENABLED) throw new NotFoundException('The scanner is not enabled');
  }
}
