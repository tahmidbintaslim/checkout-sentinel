import { z } from 'zod';

/**
 * Versioned result contract. Anything that stores or forwards results (the CLI's --json
 * output, the API's run history, webhooks) depends on this shape. Additive changes keep
 * the version; renames or removals bump RESULT_SCHEMA_VERSION.
 */
export const RESULT_SCHEMA_VERSION = 1 as const;

export const PlatformSchema = z.enum(['shopify', 'woocommerce', 'unknown']);
export type Platform = z.infer<typeof PlatformSchema>;

export const RequestedPlatformSchema = z.enum(['auto', 'shopify', 'woocommerce']);
export type RequestedPlatform = z.infer<typeof RequestedPlatformSchema>;

export const DeviceNameSchema = z.enum(['desktop', 'mobile']);
export type DeviceName = z.infer<typeof DeviceNameSchema>;

export const STEP_NAMES = [
  'open_product',
  'find_add_to_cart',
  'add_to_cart',
  'verify_cart',
  'go_to_checkout',
  'checkout_renders',
] as const;
export const StepNameSchema = z.enum(STEP_NAMES);
export type StepName = z.infer<typeof StepNameSchema>;

export const StepStatusSchema = z.enum(['passed', 'failed', 'skipped']);
export type StepStatus = z.infer<typeof StepStatusSchema>;

export const ConsoleErrorSchema = z.object({
  text: z.string(),
  location: z.string().optional(),
});
export type ConsoleError = z.infer<typeof ConsoleErrorSchema>;

export const PageErrorSchema = z.object({
  message: z.string(),
  stack: z.string().optional(),
});
export type PageError = z.infer<typeof PageErrorSchema>;

export const FailedRequestSchema = z.object({
  url: z.string(),
  method: z.string(),
  resourceType: z.string(),
  /** http_error: 4xx/5xx response. blocked: refused by the client or the safety guard. network: DNS, reset, timeout. */
  kind: z.enum(['http_error', 'blocked', 'network']),
  status: z.number().int().optional(),
  failure: z.string().optional(),
});
export type FailedRequest = z.infer<typeof FailedRequestSchema>;

const DetailValueSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);

export const StepResultSchema = z.object({
  name: StepNameSchema,
  status: StepStatusSchema,
  startedAt: z.iso.datetime(),
  durationMs: z.number().int().nonnegative(),
  /** True when the step passed but took longer than the slow-step threshold. */
  slow: z.boolean(),
  message: z.string().optional(),
  details: z.record(z.string(), DetailValueSchema),
  consoleErrors: z.array(ConsoleErrorSchema),
  pageErrors: z.array(PageErrorSchema),
  failedRequests: z.array(FailedRequestSchema),
  screenshot: z.string().optional(),
});
export type StepResult = z.infer<typeof StepResultSchema>;

export const DetectionSchema = z.object({
  detected: PlatformSchema,
  /** The platform whose selectors and cart checks were used for this journey. */
  used: PlatformSchema,
  confidence: z.enum(['high', 'medium', 'low']),
  signals: z.array(z.string()),
});
export type Detection = z.infer<typeof DetectionSchema>;

export const JourneyResultSchema = z.object({
  device: DeviceNameSchema,
  status: z.enum(['passed', 'failed']),
  startedAt: z.iso.datetime(),
  durationMs: z.number().int().nonnegative(),
  platform: DetectionSchema.nullable(),
  failedStep: StepNameSchema.optional(),
  steps: z.array(StepResultSchema),
  trace: z.string().optional(),
});
export type JourneyResult = z.infer<typeof JourneyResultSchema>;

export const RunResultSchema = z.object({
  schemaVersion: z.literal(RESULT_SCHEMA_VERSION),
  tool: z.object({ name: z.literal('checkout-sentinel'), version: z.string() }),
  runId: z.string().min(1),
  url: z.url(),
  requestedPlatform: RequestedPlatformSchema,
  startedAt: z.iso.datetime(),
  finishedAt: z.iso.datetime(),
  durationMs: z.number().int().nonnegative(),
  /** error means the run itself could not execute (browser launch, invalid URL); no journey verdict. */
  status: z.enum(['passed', 'failed', 'error']),
  error: z.object({ message: z.string() }).optional(),
  summary: z.object({
    journeys: z.number().int().nonnegative(),
    passed: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    slowSteps: z.number().int().nonnegative(),
  }),
  journeys: z.array(JourneyResultSchema),
});
export type RunResult = z.infer<typeof RunResultSchema>;

/** Parses unknown input (for example a stored JSON blob) into a RunResult, throwing on mismatch. */
export function parseRunResult(input: unknown): RunResult {
  return RunResultSchema.parse(input);
}

/** JSON Schema export, used by the docs and by consumers that are not written in TypeScript. */
export function runResultJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(RunResultSchema) as Record<string, unknown>;
}
