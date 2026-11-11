import { timingSafeEqual } from 'node:crypto';
import {
  Inject,
  Injectable,
  SetMetadata,
  UnauthorizedException,
  createParamDecorator,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { verifyToken } from '@clerk/backend';
import type { Request } from 'express';
import { API_KEY_PREFIX, DEFAULT_WORKSPACE, type ApiKeyRepository } from '@checkout-sentinel/db';
import type { ApiConfig } from '../config.js';
import { API_CONFIG, API_KEY_REPOSITORY } from '../tokens.js';

export const IS_PUBLIC = 'checkout-sentinel:public';
/** Marks a route as reachable without credentials (health checks, metrics scraping, the scanner). */
export const Public = () => SetMetadata(IS_PUBLIC, true);

type AuthedRequest = Request & { workspaceId?: string };

/** The workspace the guard resolved for this request. Every scoped query takes it. */
export const WorkspaceId = createParamDecorator((_data: unknown, context: ExecutionContext) => {
  const workspaceId = context.switchToHttp().getRequest<AuthedRequest>().workspaceId;
  if (!workspaceId) throw new UnauthorizedException('No workspace for this request');
  return workspaceId;
});

function tokensMatch(given: string, expected: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Session token claims this guard reads: v2 puts the active organization in `o`, v1 in org_id. */
interface ClerkClaims {
  sub?: string;
  o?: { id?: string };
  org_id?: string;
}

/**
 * Resolves the caller's workspace from "Authorization: Bearer <token>":
 * - API_TOKEN: the self-hosted workspace (DEFAULT_WORKSPACE);
 * - an API key (cs_...): the workspace it was created in;
 * - a Clerk session token, when Clerk is configured: the active organization, else the user.
 * With no API_TOKEN and no Clerk configured (local development), requests without a token get
 * the default workspace, as before workspaces existed.
 */
@Injectable()
export class ApiTokenGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(API_CONFIG) private readonly config: ApiConfig,
    @Inject(API_KEY_REPOSITORY) private readonly apiKeys: ApiKeyRepository,
  ) {}

  private get clerkEnabled(): boolean {
    return Boolean(this.config.CLERK_SECRET_KEY || this.config.CLERK_JWT_KEY);
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;
    const req = context.switchToHttp().getRequest<AuthedRequest>();
    const [scheme, token] = (req.headers.authorization ?? '').split(' ');
    const bearer = scheme?.toLowerCase() === 'bearer' && token ? token : null;

    if (!bearer) {
      if (this.config.API_TOKEN || this.clerkEnabled) {
        throw new UnauthorizedException('Missing or invalid API token');
      }
      req.workspaceId = DEFAULT_WORKSPACE;
      return true;
    }
    const workspaceId = await this.resolve(bearer);
    if (!workspaceId) throw new UnauthorizedException('Missing or invalid API token');
    req.workspaceId = workspaceId;
    return true;
  }

  private async resolve(token: string): Promise<string | null> {
    if (this.config.API_TOKEN && tokensMatch(token, this.config.API_TOKEN)) {
      return DEFAULT_WORKSPACE;
    }
    if (token.startsWith(API_KEY_PREFIX)) return this.apiKeys.workspaceFor(token);
    if (!this.clerkEnabled) return null;
    try {
      const claims = (await verifyToken(token, {
        ...(this.config.CLERK_JWT_KEY ? { jwtKey: this.config.CLERK_JWT_KEY } : {}),
        ...(this.config.CLERK_SECRET_KEY ? { secretKey: this.config.CLERK_SECRET_KEY } : {}),
        ...(this.config.CLERK_AUTHORIZED_PARTIES
          ? { authorizedParties: this.config.CLERK_AUTHORIZED_PARTIES }
          : {}),
      })) as ClerkClaims;
      return claims.o?.id ?? claims.org_id ?? claims.sub ?? null;
    } catch {
      return null;
    }
  }
}
