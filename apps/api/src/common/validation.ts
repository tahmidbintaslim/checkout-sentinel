import { BadRequestException, StandardSchemaValidationPipe } from '@nestjs/common';

/** Validates @Body({ schema }) / @Query({ schema }) params against their zod schema. */
export function createValidationPipe(): StandardSchemaValidationPipe {
  return new StandardSchemaValidationPipe({
    exceptionFactory: (issues) =>
      new BadRequestException({
        statusCode: 400,
        error: 'Bad Request',
        message: 'Validation failed',
        issues: issues.map((issue) => ({
          path: (issue.path ?? [])
            .map((segment) => (typeof segment === 'object' ? String(segment.key) : String(segment)))
            .join('.'),
          message: issue.message,
        })),
      }),
  });
}
