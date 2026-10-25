import { Controller, Get, Header, Inject } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { Public } from '../common/auth.guard.js';
import { API_METRICS } from '../tokens.js';
import type { ApiMetrics } from './api-metrics.js';

@ApiExcludeController()
@Controller('metrics')
export class MetricsController {
  constructor(@Inject(API_METRICS) private readonly metrics: ApiMetrics) {}

  @Public()
  @Get()
  @Header('content-type', 'text/plain; version=0.0.4; charset=utf-8')
  async scrape(): Promise<string> {
    return this.metrics.registry.metrics();
  }
}
