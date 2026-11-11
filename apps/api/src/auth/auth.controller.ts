import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import type { ApiKeyRepository, ApiKeyRow } from '@checkout-sentinel/db';
import { Public, WorkspaceId } from '../common/auth.guard.js';
import type { ApiConfig } from '../config.js';
import { API_CONFIG, API_KEY_REPOSITORY } from '../tokens.js';

export const ApiKeyCreateSchema = z.object({ name: z.string().trim().min(1).max(80) });
type ApiKeyCreate = z.infer<typeof ApiKeyCreateSchema>;

const toApiKeyDto = (row: ApiKeyRow) => ({
  id: row.id,
  name: row.name,
  prefix: row.prefix,
  createdAt: row.createdAt.toISOString(),
});

@ApiTags('auth')
@Controller()
export class AuthController {
  constructor(
    @Inject(API_CONFIG) private readonly config: ApiConfig,
    @Inject(API_KEY_REPOSITORY) private readonly keys: ApiKeyRepository,
  ) {}

  @Public()
  @Get('auth/config')
  @ApiOperation({
    summary: 'How the dashboard signs in: Clerk (with its publishable key) or a token',
  })
  authConfig() {
    const clerk = Boolean(this.config.CLERK_SECRET_KEY || this.config.CLERK_JWT_KEY);
    return { clerkPublishableKey: clerk ? (this.config.CLERK_PUBLISHABLE_KEY ?? null) : null };
  }

  @ApiBearerAuth()
  @Get('api-keys')
  @ApiOperation({ summary: "The workspace's API keys (never the keys themselves)" })
  async list(@WorkspaceId() ws: string) {
    return (await this.keys.list(ws)).map(toApiKeyDto);
  }

  @ApiBearerAuth()
  @Post('api-keys')
  @ApiOperation({ summary: 'Create an API key for this workspace; `key` is returned only here' })
  async create(
    @Body({ schema: ApiKeyCreateSchema }) body: ApiKeyCreate,
    @WorkspaceId() ws: string,
  ) {
    const { row, key } = await this.keys.create(ws, body.name);
    return { ...toApiKeyDto(row), key };
  }

  @ApiBearerAuth()
  @Delete('api-keys/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Revoke an API key at once' })
  async remove(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @WorkspaceId() ws: string,
  ): Promise<void> {
    if (!(await this.keys.delete(id, ws))) throw new NotFoundException(`API key ${id} not found`);
  }
}
