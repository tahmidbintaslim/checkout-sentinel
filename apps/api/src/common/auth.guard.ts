import { timingSafeEqual } from 'node:crypto';
import {
  Inject,
  Injectable,
  SetMetadata,
  UnauthorizedException,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import type { ApiConfig } from '../config.js';
import { API_CONFIG } from '../tokens.js';

export const IS_PUBLIC = 'checkout-sentinel:public';
/** Marks a route as reachable without the API token (health checks, metrics scraping). */
export const Public = () => SetMetadata(IS_PUBLIC, true);

function tokensMatch(given: string, expected: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Static bearer token auth. Disabled when API_TOKEN is unset (local development). */
@Injectable()
export class ApiTokenGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(API_CONFIG) private readonly config: ApiConfig,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const expected = this.config.API_TOKEN;
    if (!expected) return true;
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;
    const header = context.switchToHttp().getRequest<Request>().headers.authorization ?? '';
    const [scheme, token] = header.split(' ');
    if (scheme?.toLowerCase() === 'bearer' && token && tokensMatch(token, expected)) return true;
    throw new UnauthorizedException('Missing or invalid API token');
  }
}
