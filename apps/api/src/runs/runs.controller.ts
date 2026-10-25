import { Controller, Get, Inject, NotFoundException, Param, ParseUUIDPipe } from '@nestjs/common';
import { ApiBearerAuth, ApiNotFoundResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { RunRepository } from '@checkout-sentinel/db';
import { toRunSummaryDto } from '../monitors/monitor.mapper.js';
import { RUN_REPOSITORY } from '../tokens.js';

@ApiTags('runs')
@ApiBearerAuth()
@Controller('runs')
export class RunsController {
  constructor(@Inject(RUN_REPOSITORY) private readonly runs: RunRepository) {}

  @Get(':id')
  @ApiOperation({ summary: 'One run with its full result (result schema version 1)' })
  @ApiNotFoundResponse()
  async get(@Param('id', new ParseUUIDPipe({ version: '4' })) id: string) {
    const run = await this.runs.get(id);
    if (!run) throw new NotFoundException(`Run ${id} not found`);
    return { ...toRunSummaryDto(run), result: run.result };
  }
}
