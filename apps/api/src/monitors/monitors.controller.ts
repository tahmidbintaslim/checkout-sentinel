import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiAcceptedResponse,
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { z } from 'zod';
import {
  MonitorPatchSchema,
  MonitorSpecSchema,
  type MonitorPatch,
  type MonitorSpec,
} from '@checkout-sentinel/core';
import type { AlertDeliveryRepository, RunRepository } from '@checkout-sentinel/db';
import { DELIVERY_REPOSITORY, RUN_REPOSITORY } from '../tokens.js';
import { toMonitorDto, toRunSummaryDto, toStatusDto } from './monitor.mapper.js';
import { MonitorsService } from './monitors.service.js';

export const RunListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  /** Cursor from a previous page's nextCursor (an ISO timestamp). */
  before: z.iso.datetime().optional(),
});

const uuid = new ParseUUIDPipe({ version: '4' });

@ApiTags('monitors')
@ApiBearerAuth()
@Controller('monitors')
export class MonitorsController {
  constructor(
    @Inject(MonitorsService) private readonly service: MonitorsService,
    @Inject(RUN_REPOSITORY) private readonly runs: RunRepository,
    @Inject(DELIVERY_REPOSITORY) private readonly deliveries: AlertDeliveryRepository,
  ) {}

  @Get()
  @ApiOperation({ summary: 'List monitors with their latest status' })
  async list() {
    return (await this.service.list()).map(toMonitorDto);
  }

  @Post()
  @ApiOperation({ summary: 'Create a monitor and schedule it' })
  @ApiCreatedResponse({ description: 'The created monitor' })
  async create(@Body({ schema: MonitorSpecSchema }) body: MonitorSpec) {
    return toMonitorDto(await this.service.create(body));
  }

  @Get(':id')
  @ApiNotFoundResponse()
  async get(@Param('id', uuid) id: string) {
    return toMonitorDto(await this.service.get(id));
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update some fields of a monitor; its schedule follows' })
  @ApiNotFoundResponse()
  async update(
    @Param('id', uuid) id: string,
    @Body({ schema: MonitorPatchSchema }) body: MonitorPatch,
  ) {
    return toMonitorDto(await this.service.update(id, body));
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiNoContentResponse({ description: 'Deleted with its runs, state and alert log' })
  @ApiNotFoundResponse()
  async remove(@Param('id', uuid) id: string): Promise<void> {
    await this.service.remove(id);
  }

  @Get(':id/status')
  @ApiOperation({ summary: 'Latest status: health, last run, consecutive failures, slow steps' })
  @ApiNotFoundResponse()
  async status(@Param('id', uuid) id: string) {
    return toStatusDto((await this.service.get(id)).state);
  }

  @Get(':id/runs')
  @ApiOperation({ summary: 'Run history, newest first, keyset paginated' })
  @ApiOkResponse({ description: '{ items, nextCursor }' })
  @ApiNotFoundResponse()
  async runHistory(
    @Param('id', uuid) id: string,
    @Query({ schema: RunListQuerySchema }) query: z.infer<typeof RunListQuerySchema>,
  ) {
    await this.service.get(id);
    const page = await this.runs.listForMonitor(
      id,
      query.limit,
      query.before ? new Date(query.before) : undefined,
    );
    return { items: page.items.map(toRunSummaryDto), nextCursor: page.nextCursor };
  }

  @Post(':id/runs')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({ summary: 'Queue a run now, outside the schedule' })
  @ApiAcceptedResponse({ description: '{ jobId }' })
  @ApiNotFoundResponse()
  async runNow(@Param('id', uuid) id: string) {
    return this.service.runNow(id);
  }

  @Get(':id/alerts')
  @ApiOperation({ summary: 'Alert delivery log' })
  @ApiNotFoundResponse()
  async alerts(@Param('id', uuid) id: string) {
    await this.service.get(id);
    return (await this.deliveries.listForMonitor(id)).map((d) => ({
      id: d.id,
      runId: d.runId,
      kind: d.kind,
      channelType: d.channelType,
      status: d.status,
      responseStatus: d.responseStatus,
      error: d.error,
      createdAt: d.createdAt.toISOString(),
      sentAt: d.sentAt?.toISOString() ?? null,
    }));
  }
}
