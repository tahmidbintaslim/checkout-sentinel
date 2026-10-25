import { Controller, Get, HttpStatus, Inject, Res } from '@nestjs/common';
import { ApiOkResponse, ApiServiceUnavailableResponse, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { VERSION } from '@checkout-sentinel/core';
import { pingDb, type DbHandle } from '@checkout-sentinel/db';
import type { JourneyScheduler } from '@checkout-sentinel/jobs';
import { Public } from '../common/auth.guard.js';
import { DB_HANDLE, SCHEDULER } from '../tokens.js';

@ApiTags('health')
@Controller('health')
export class HealthController {
  constructor(
    @Inject(DB_HANDLE) private readonly db: DbHandle,
    @Inject(SCHEDULER) private readonly scheduler: JourneyScheduler,
  ) {}

  @Public()
  @Get()
  @ApiOkResponse({ description: 'Postgres and Redis are reachable' })
  @ApiServiceUnavailableResponse({ description: 'A dependency is down' })
  async check(@Res({ passthrough: true }) res: Response) {
    const [database, redis] = await Promise.all([pingDb(this.db), this.scheduler.ping()]);
    const ok = database && redis;
    res.status(ok ? HttpStatus.OK : HttpStatus.SERVICE_UNAVAILABLE);
    return {
      status: ok ? 'ok' : 'degraded',
      version: VERSION,
      checks: { database: database ? 'up' : 'down', redis: redis ? 'up' : 'down' },
    };
  }
}
