import { readFile } from 'node:fs/promises';
import { MonitorsFileSchema, type MonitorsFile } from '@checkout-sentinel/core';
import { parse } from 'yaml';

export class ConfigError extends Error {
  override name = 'ConfigError';
}

/** Replaces ${VAR} with the environment value so secrets such as webhook URLs stay out of the file. */
export function interpolateEnv(text: string, env: NodeJS.ProcessEnv = process.env): string {
  const missing = new Set<string>();
  const result = text.replace(/\$\{([A-Z0-9_]+)\}/g, (_match, name: string) => {
    const value = env[name];
    if (value === undefined) {
      missing.add(name);
      return '';
    }
    return value;
  });
  if (missing.size > 0) {
    throw new ConfigError(
      `Config references unset environment variable(s): ${[...missing].join(', ')}`,
    );
  }
  return result;
}

/** Interpolates every string value in parsed YAML (comments and keys are left alone). */
function interpolateValues(value: unknown, env: NodeJS.ProcessEnv): unknown {
  if (typeof value === 'string') return interpolateEnv(value, env);
  if (Array.isArray(value)) return value.map((item) => interpolateValues(item, env));
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, interpolateValues(item, env)]),
    );
  }
  return value;
}

export function parseMonitorsFile(
  text: string,
  env: NodeJS.ProcessEnv = process.env,
): MonitorsFile {
  let raw: unknown;
  try {
    raw = parse(text);
  } catch (error) {
    throw new ConfigError(`Config is not valid YAML: ${(error as Error).message}`);
  }
  raw = interpolateValues(raw, env);
  const parsed = MonitorsFileSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    throw new ConfigError(`Config is invalid:\n${issues}`);
  }
  return parsed.data;
}

export async function loadMonitorsFile(path: string): Promise<MonitorsFile> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    throw new ConfigError(
      `Cannot read config ${path}: ${(error as NodeJS.ErrnoException).code ?? String(error)}`,
    );
  }
  return parseMonitorsFile(text);
}

export const EXAMPLE_CONFIG = `# checkout-sentinel monitors
# Run every monitor once:      checkout-sentinel check --config checkout-sentinel.yml
# Run a single URL ad hoc:     checkout-sentinel run <productUrl>
#
# schedule, alerts and alertAfterFailures are used by the self-hosted API and worker
# (see docker-compose.yml); the CLI runs each monitor once and ignores them.
# \${VAR} is replaced with the environment variable VAR when the file is loaded.
version: 1

defaults:
  timeouts:
    navigationMs: 30000 # product page and checkout loads
    stepMs: 15000 # waiting for buttons, cart updates and checkout fields

monitors:
  - name: Bestseller (Shopify)
    url: https://your-store.myshopify.com/products/your-bestseller
    platform: auto # auto | shopify | woocommerce
    devices: [mobile, desktop]
    schedule: '*/15 * * * *' # every 15 minutes; the minimum allowed interval is 5
    timezone: UTC
    slowStepMs: 8000 # a passing step slower than this raises a slow-step alert
    alertAfterFailures: 2 # consecutive failed runs before alerting
    alerts:
      - type: slack
        url: https://hooks.slack.com/services/REPLACE/WITH/YOURS

  - name: Hoodie (WooCommerce)
    url: https://shop.example.com/product/hoodie/
    platform: woocommerce
    devices: [mobile]
    schedule: '0 * * * *' # hourly
    alerts:
      - type: webhook
        url: https://ops.example.com/hooks/checkout
        # Deliveries are signed with HMAC-SHA256 when a secret (16+ characters) is set.
        # secret: \${CHECKOUT_SENTINEL_WEBHOOK_SECRET}
`;
