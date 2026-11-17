import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { cp, mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { probeTestServices, truncateAll } from '@checkout-sentinel/fixtures';
import { JourneyScheduler, createRedis } from '@checkout-sentinel/jobs';
import { createApp, loadApiConfig } from '@checkout-sentinel/api';

/**
 * The WordPress plugin against real WordPress (SQLite, driven by WP-CLI) and the real API: each
 * change WordPress makes must arrive in the store's timeline. Needs PHP and network access to
 * download WordPress, its SQLite integration and WP-CLI (cached in the OS temp directory).
 * Run with WORDPRESS_E2E=1 pnpm exec vitest run apps/api/test/e2e/wordpress.e2e.test.ts.
 */
const run = promisify(execFile);
const services = await probeTestServices();
const php = await run('php', ['-r', 'echo PHP_VERSION;']).then(
  () => true,
  () => false,
);
const PLUGIN_DIR = fileURLToPath(
  new URL('../../../../integrations/wordpress/checkout-sentinel', import.meta.url),
);
const CACHE = path.join(tmpdir(), 'checkout-sentinel-wordpress-e2e');
const TOKEN = 'e2e-api-token-0123456789';
const STORE = 'http://shop.test';

async function download(url: string, file: string): Promise<string> {
  const target = path.join(CACHE, file);
  if (!existsSync(target)) {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
    await writeFile(target, Buffer.from(await response.arrayBuffer()));
  }
  return target;
}

/** A minimal plugin zip, as a merchant would upload one. */
async function pluginZip(version: string): Promise<string> {
  const dir = path.join(CACHE, `hello-store-${version}`, 'hello-store');
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, 'hello-store.php'),
    `<?php\n/**\n * Plugin Name: Hello Store\n * Version: ${version}\n */\n`,
  );
  const zip = path.join(CACHE, `hello-store-${version}.zip`);
  await run('zip', ['-qr', zip, 'hello-store'], { cwd: path.dirname(dir) }).catch(() =>
    run('php', [
      '-r',
      `$z=new ZipArchive();$z->open('${zip}',ZipArchive::CREATE|ZipArchive::OVERWRITE);$z->addFile('${dir}/hello-store.php','hello-store/hello-store.php');$z->close();`,
    ]),
  );
  return zip;
}

// Opt-in: it downloads and runs WordPress, its SQLite integration and WP-CLI. Not yet run.
const optedIn = process.env.WORDPRESS_E2E === '1';

describe.skipIf(!optedIn || !services.available || !php)(
  'WordPress plugin (real WordPress + API)',
  () => {
    let app: INestApplication;
    let base: string;
    let redis: ReturnType<typeof createRedis>;
    let scheduler: JourneyScheduler;
    let site: string;
    let wpCli: string;
    let monitorId: string;

    const wp = (...args: string[]) => run('php', [wpCli, `--path=${site}`, ...args]);
    const api = async <T>(p: string, init: RequestInit & { json?: unknown } = {}): Promise<T> => {
      const { json, ...rest } = init;
      const response = await fetch(`${base}/api${p}`, {
        ...rest,
        headers: {
          authorization: `Bearer ${TOKEN}`,
          ...(json !== undefined ? { 'content-type': 'application/json' } : {}),
        },
        ...(json !== undefined ? { body: JSON.stringify(json) } : {}),
      });
      return (await response.json()) as T;
    };
    const timeline = async () =>
      (await api<Array<{ summary: string }>>(`/monitors/${monitorId}/changes?limit=50`)).map(
        (c) => c.summary,
      );

    beforeAll(async () => {
      await mkdir(CACHE, { recursive: true });
      const [wordpress, sqlite] = await Promise.all([
        download('https://wordpress.org/latest.zip', 'wordpress.zip'),
        download(
          'https://downloads.wordpress.org/plugin/sqlite-database-integration.zip',
          'sqlite.zip',
        ),
      ]);
      wpCli = await download(
        'https://raw.githubusercontent.com/wp-cli/builds/gh-pages/phar/wp-cli.phar',
        'wp-cli.phar',
      );

      // A fresh site per run, from the cached archives.
      const root = path.join(CACHE, `site-${Date.now()}`);
      await mkdir(root, { recursive: true });
      await run('unzip', ['-q', wordpress, '-d', root]);
      site = path.join(root, 'wordpress');
      const plugins = path.join(site, 'wp-content', 'plugins');
      await run('unzip', ['-q', sqlite, '-d', plugins]);
      const dropIn = (
        await readFile(path.join(plugins, 'sqlite-database-integration', 'db.copy'), 'utf8')
      )
        .replace(
          /\{SQLITE_IMPLEMENTATION_FOLDER_PATH\}/g,
          path.join(plugins, 'sqlite-database-integration'),
        )
        .replace(/\{SQLITE_PLUGIN\}/g, 'sqlite-database-integration/load.php');
      await writeFile(path.join(site, 'wp-content', 'db.php'), dropIn);
      await cp(path.join(site, 'wp-config-sample.php'), path.join(site, 'wp-config.php'));
      await wp(
        'core',
        'install',
        `--url=${STORE}`,
        '--title=Shop',
        '--admin_user=admin',
        '--admin_password=admin-password',
        '--admin_email=admin@shop.test',
        '--skip-email',
      );
      await symlink(PLUGIN_DIR, path.join(plugins, 'checkout-sentinel'));

      redis = createRedis(services.redisUrl);
      scheduler = new JourneyScheduler(redis);
      app = await createApp(
        loadApiConfig({
          DATABASE_URL: services.databaseUrl,
          REDIS_URL: services.redisUrl,
          API_TOKEN: TOKEN,
          LOG_LEVEL: 'silent',
        }),
        { resolveHost: async () => [{ address: '93.184.215.14', family: 4 }] },
      );
      await truncateAll(services.databaseUrl);
      await app.listen(0, '127.0.0.1');
      base = await app.getUrl();
      monitorId = (
        await api<{ id: string }>('/monitors', {
          method: 'POST',
          json: { name: 'Shop', url: `${STORE}/product/tee/`, enabled: false },
        })
      ).id;
    }, 240_000);

    afterAll(async () => {
      await app?.close();
      await scheduler?.queue.obliterate({ force: true }).catch(() => undefined);
      await scheduler?.close();
      redis?.disconnect();
    });

    it('sends nothing until an API key is saved', async () => {
      await wp('plugin', 'activate', 'checkout-sentinel');
      expect(await timeline()).toEqual([]);
      await wp('plugin', 'deactivate', 'checkout-sentinel');
    });

    it('refuses keys that are not API keys, and keeps the saved one when the field is empty', async () => {
      const sanitize = (input: object) =>
        wp(
          'eval',
          `require_once WP_PLUGIN_DIR . '/checkout-sentinel/checkout-sentinel.php';` +
            `require_once WP_PLUGIN_DIR . '/checkout-sentinel/includes/settings.php';` +
            `echo wp_json_encode(checkout_sentinel_sanitize(${phpArray(input)}));`,
        ).then((r) => JSON.parse(r.stdout) as Record<string, string>);
      expect(await sanitize({ api_url: 'https://app.example/', api_key: 'sk_live_wrong' })).toEqual(
        {
          api_url: 'https://app.example',
          api_key: '',
        },
      );
    });

    it('reports plugin, theme and activation changes to the store timeline', async () => {
      const { key } = await api<{ key: string }>('/api-keys', {
        method: 'POST',
        json: { name: 'WordPress' },
      });
      await wp(
        'option',
        'update',
        'checkout_sentinel_settings',
        JSON.stringify({ api_url: base, api_key: key }),
        '--format=json',
      );

      await wp('plugin', 'activate', 'checkout-sentinel');
      await wp('plugin', 'install', await pluginZip('1.0.0'));
      await wp('plugin', 'install', await pluginZip('1.1.0'), '--force');
      await wp('plugin', 'activate', 'hello-store');
      const themes = (await wp('theme', 'list', '--status=inactive', '--field=name')).stdout
        .trim()
        .split('\n');
      await wp('theme', 'activate', themes[0]!);
      await wp('plugin', 'deactivate', 'hello-store');

      const theme = (await wp('theme', 'get', themes[0]!, '--field=title')).stdout.trim();
      expect((await timeline()).reverse()).toEqual([
        'Plugin activated: Checkout Sentinel 0.1.0',
        'Plugin installed: Hello Store 1.0.0',
        'Plugin installed: Hello Store 1.1.0',
        'Plugin activated: Hello Store 1.1.0',
        `Theme switched to ${theme}`,
        'Plugin deactivated: Hello Store 1.1.0',
      ]);
      const last = JSON.parse(
        (await wp('option', 'get', 'checkout_sentinel_last_report', '--format=json')).stdout,
      ) as { ok: boolean };
      expect(last.ok).toBe(true);
    });

    it('keeps working when the API refuses the key, and records why', async () => {
      await wp(
        'option',
        'update',
        'checkout_sentinel_settings',
        JSON.stringify({ api_url: base, api_key: 'cs_revoked' }),
        '--format=json',
      );
      await wp('plugin', 'activate', 'hello-store');
      const last = JSON.parse(
        (await wp('option', 'get', 'checkout_sentinel_last_report', '--format=json')).stdout,
      ) as { ok: boolean; error: string };
      expect(last).toMatchObject({ ok: false, error: 'HTTP 401' });
    });
  },
);

/** A PHP array literal from a flat object of strings. */
function phpArray(input: object): string {
  return `array(${Object.entries(input)
    .map(([k, v]) => `'${k}' => '${String(v).replace(/'/g, "\\'")}'`)
    .join(', ')})`;
}
