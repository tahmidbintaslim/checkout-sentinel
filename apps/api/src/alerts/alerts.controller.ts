import { Controller, Get, Inject, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import type { AlertDeliveryRepository } from '@checkout-sentinel/db';
import { toAlertDto } from '../monitors/monitor.mapper.js';
import { DELIVERY_REPOSITORY } from '../tokens.js';
import { WorkspaceId } from '../common/auth.guard.js';

export const AlertListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  /** Only this monitor's deliveries. */
  monitorId: z.uuid().optional(),
  /** Cursor from a previous page's nextCursor. */
  before: z.uuid().optional(),
});

@ApiTags('alerts')
@ApiBearerAuth()
@Controller('alerts')
export class AlertsController {
  constructor(@Inject(DELIVERY_REPOSITORY) private readonly deliveries: AlertDeliveryRepository) {}

  @Get()
  @ApiOperation({ summary: 'Alert delivery log of every monitor, newest first, keyset paginated' })
  @ApiOkResponse({ description: '{ items, nextCursor }' })
  async list(
    @Query({ schema: AlertListQuerySchema }) query: z.infer<typeof AlertListQuerySchema>,
    @WorkspaceId() ws: string,
  ) {
    const page = await this.deliveries.listPage({ ...query, workspaceId: ws });
    return {
      items: page.items.map((entry) => ({
        ...toAlertDto(entry),
        monitorId: entry.monitorId,
        monitorName: entry.monitorName,
      })),
      nextCursor: page.nextCursor,
    };
  }
}
