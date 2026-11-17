import { createHmac, timingSafeEqual } from 'node:crypto';
import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  UnauthorizedException,
  type RawBodyRequest,
} from '@nestjs/common';
import { ApiBearerAuth, ApiExcludeEndpoint, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { z } from 'zod';
import type { ChangeEventRepository, ChangeEventRow } from '@checkout-sentinel/db';
import { Public, WorkspaceId } from '../common/auth.guard.js';
import { validationError } from '../common/validation.js';
import type { ApiConfig } from '../config.js';
import { MonitorsService } from '../monitors/monitors.service.js';
import { API_CONFIG, CHANGE_REPOSITORY } from '../tokens.js';

export const ChangeCreateSchema = z.object({
  /** The store's URL or host; the event shows on every monitor of that host. */
  store: z.string().trim().min(1).max(2_048),
  kind: z
    .string()
    .trim()
    .regex(/^[a-z0-9_.-]{1,64}$/, 'Lower-case letters, digits, _ . - only'),
  summary: z.string().trim().min(1).max(500),
  occurredAt: z.iso.datetime().optional(),
  /** Your id for the event; sending the same one again records it once. */
  externalId: z.string().trim().min(1).max(200).optional(),
});
type ChangeCreate = z.infer<typeof ChangeCreateSchema>;

const ChangeListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

/** A URL's host, or the value itself when it is a bare host; lower case. */
export function storeHost(value: string): string | null {
  try {
    return new URL(/^https?:\/\//i.test(value) ? value : `https://${value}`).hostname.toLowerCase();
  } catch {
    return null;
  }
}

const toChangeDto = (row: ChangeEventRow) => ({
  id: row.id,
  host: row.host,
  source: row.source,
  kind: row.kind,
  summary: row.summary,
  occurredAt: row.occurredAt.toISOString(),
});

/** Shopify webhook topics this app subscribes to, and how each reads as a change. */
const SHOPIFY_CHANGES: Record<string, (body: { name?: string; role?: string }) => string | null> = {
  'themes/publish': (theme) => `Theme published: ${theme.name ?? 'unnamed'}`,
  // Edits to themes that are not live cannot break the store.
  'themes/update': (theme) =>
    theme.role === 'main' ? `Live theme edited: ${theme.name ?? 'unnamed'}` : null,
  'app/uninstalled': () => 'This monitoring app was uninstalled',
};

@ApiTags('changes')
@Controller()
export class ChangesController {
  constructor(
    @Inject(CHANGE_REPOSITORY) private readonly changes: ChangeEventRepository,
    @Inject(MonitorsService) private readonly monitors: MonitorsService,
    @Inject(API_CONFIG) private readonly config: ApiConfig,
  ) {}

  @ApiBearerAuth()
  @Post('changes')
  @ApiOperation({
    summary: 'Record a change on a store (deploy, theme, app or plugin update)',
    description: 'Failure and tracking alerts list the changes of the 24 hours before the run.',
  })
  async create(
    @Body({ schema: ChangeCreateSchema }) body: ChangeCreate,
    @WorkspaceId() ws: string,
  ) {
    const host = storeHost(body.store);
    if (!host) throw validationError([{ path: 'store', message: 'Must be a URL or host name' }]);
    const recorded = await this.changes.add({
      workspaceId: ws,
      host,
      source: 'api',
      kind: body.kind,
      summary: body.summary,
      occurredAt: body.occurredAt ? new Date(body.occurredAt) : new Date(),
      externalId: body.externalId,
    });
    return { recorded, host };
  }

  @ApiBearerAuth()
  @Get('monitors/:id/changes')
  @ApiOperation({ summary: "Changes recorded on this monitor's store, newest first" })
  async list(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Query({ schema: ChangeListQuerySchema }) query: z.infer<typeof ChangeListQuerySchema>,
    @WorkspaceId() ws: string,
  ) {
    const monitor = await this.monitors.get(id, ws);
    const host = new URL(monitor.url).hostname;
    return (await this.changes.listForStore(ws, host, { limit: query.limit })).map(toChangeDto);
  }

  /**
   * Shopify webhooks, verified with the app's secret (X-Shopify-Hmac-Sha256 over the raw body).
   * Answers 200 to every verified delivery, as Shopify retries anything else for 48 hours.
   */
  @Public()
  @Post('webhooks/shopify')
  @HttpCode(HttpStatus.OK)
  @ApiExcludeEndpoint()
  async shopify(
    @Req() req: RawBodyRequest<Request>,
    @Headers('x-shopify-hmac-sha256') hmac: string | undefined,
    @Headers('x-shopify-topic') topic: string | undefined,
    @Headers('x-shopify-shop-domain') shopDomain: string | undefined,
    @Headers('x-shopify-webhook-id') webhookId: string | undefined,
  ) {
    const secret = this.config.SHOPIFY_API_SECRET;
    if (!secret || !req.rawBody || !hmac || !verifyShopifyHmac(req.rawBody, hmac, secret)) {
      throw new UnauthorizedException('Invalid webhook signature');
    }
    if (!topic || !shopDomain) return { ok: true };

    // Mandatory privacy topics. No customer data is ever stored, so only shop/redact has work.
    if (topic === 'shop/redact') {
      await this.changes.forgetShopifyShop(shopDomain);
      return { ok: true };
    }
    const describe = SHOPIFY_CHANGES[topic];
    const shop = describe ? await this.changes.shopifyShop(shopDomain) : null;
    const summary =
      shop && describe ? describe(req.body as { name?: string; role?: string }) : null;
    if (shop && summary) {
      await this.changes.add({
        workspaceId: shop.workspaceId,
        host: shop.host,
        source: 'shopify',
        kind: topic.replace('/', '_'),
        summary,
        occurredAt: new Date(),
        externalId: webhookId,
      });
    }
    return { ok: true };
  }
}

export function verifyShopifyHmac(rawBody: Buffer, header: string, secret: string): boolean {
  const expected = Buffer.from(createHmac('sha256', secret).update(rawBody).digest('base64'));
  const given = Buffer.from(header);
  return expected.length === given.length && timingSafeEqual(expected, given);
}
