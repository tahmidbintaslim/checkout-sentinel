import { BadRequestException, StandardSchemaValidationPipe } from '@nestjs/common';

export interface ValidationIssue {
  /** Dotted path into the request body, for example "alerts.0.url". */
  path: string;
  message: string;
}

/** The 400 body every validation failure uses, from the schema pipe or later checks. */
export function validationError(issues: ValidationIssue[]): BadRequestException {
  return new BadRequestException({
    statusCode: 400,
    error: 'Bad Request',
    message: 'Validation failed',
    issues,
  });
}

/** Validates @Body({ schema }) / @Query({ schema }) params against their zod schema. */
export function createValidationPipe(): StandardSchemaValidationPipe {
  return new StandardSchemaValidationPipe({
    exceptionFactory: (issues) =>
      validationError(
        issues.map((issue) => ({
          path: (issue.path ?? [])
            .map((segment) => (typeof segment === 'object' ? String(segment.key) : String(segment)))
            .join('.'),
          message: issue.message,
        })),
      ),
  });
}
