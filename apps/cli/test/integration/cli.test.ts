import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startFixtureStore, type FixtureStore } from '@checkout-sentinel/fixtures';
import { RunResultSchema } from '@checkout-sentinel/core';
import { plainPaint, runCli, type Io } from '@checkout-sentinel/cli';

let cwd: string;
let ok: FixtureStore;
let broken: FixtureStore;

/** Environment variables come only from the test, never from the shell running it. */
function captureIo(env: Record<string, string> = {}): Io & { out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    stdout: (s) => out.push(s),
    stderr: (s) => err.push(s),
    paint: plainPaint,
    cwd,
    env,
  };
}

beforeAll(async () => {
  cwd = await mkdtemp(path.join(tmpdir(), 'checkout-sentinel-cli-'));
  ok = await startFixtureStore({ platform: 'shopify' });
  broken = await startFixtureStore({ platform: 'woocommerce', variant: 'checkout-404' });
});

afterAll(async () => {
  await Promise.all([ok.close(), broken.close()]);
  await rm(cwd, { recursive: true, force: true });
});

describe('checkout-sentinel run', () => {
  it('exits 0 and prints a readable report for a working store', async () => {
    const io = captureIo();
    const code = await runCli(
      ['run', ok.productUrl, '--device', 'mobile', '--step-timeout', '3000'],
      io,
    );
    expect(code).toBe(0);
    const text = io.out.join('\n');
    expect(text).toMatch(/mobile\s+PASSED/);
    expect(text).toContain('Result: PASSED  1/1 journeys passed');
  });

  it('exits 1 and emits schema-valid JSON for a broken checkout', async () => {
    const io = captureIo();
    const code = await runCli(
      [
        'run',
        broken.productUrl,
        '--device',
        'desktop',
        '--json',
        '--out',
        'out',
        '--step-timeout',
        '3000',
      ],
      io,
    );
    expect(code).toBe(1);
    const result = RunResultSchema.parse(JSON.parse(io.out.join('\n')));
    expect(result.journeys[0]?.failedStep).toBe('go_to_checkout');
    const saved = JSON.parse(
      await readFile(path.join(cwd, 'out', result.runId, 'result.json'), 'utf8'),
    );
    expect(saved.runId).toBe(result.runId);
  });

  it('exits 2 on bad arguments', async () => {
    const io = captureIo();
    expect(await runCli(['run', ok.productUrl, '--device', 'tablet'], io)).toBe(2);
    expect(io.err.join('\n')).toMatch(/Allowed choices are desktop, mobile, both/);
    expect(await runCli(['run'], captureIo())).toBe(2);
  });

  it('exits 3 when the run cannot execute', async () => {
    const io = captureIo();
    expect(await runCli(['run', 'ftp://nope.test/x'], io)).toBe(3);
    expect(io.out.join('\n')).toContain('ERROR');
  });
});

describe('checkout-sentinel init and check', () => {
  it('writes the example config, refuses to overwrite it, and check runs a config', async () => {
    expect(await runCli(['init'], captureIo())).toBe(0);
    const written = await readFile(path.join(cwd, 'checkout-sentinel.yml'), 'utf8');
    expect(written).toContain('version: 1');

    const again = captureIo();
    expect(await runCli(['init'], again)).toBe(2);
    expect(again.err.join('\n')).toContain('--force');

    const configPath = path.join(cwd, 'local.yml');
    const { writeFile } = await import('node:fs/promises');
    await writeFile(
      configPath,
      `version: 1
defaults:
  timeouts: { stepMs: 3000 }
monitors:
  - name: ok store
    url: ${ok.productUrl}
    devices: [desktop]
  - name: broken store
    url: ${broken.productUrl}
    devices: [desktop]
`,
    );
    const io = captureIo();
    expect(await runCli(['check', '--config', 'local.yml'], io)).toBe(1);
    const text = io.out.join('\n');
    expect(text).toContain('== ok store');
    expect(text).toContain('== broken store');
  });
});

describe('checkout-sentinel --block-private-targets', () => {
  // Without the flag the CLI reaches local stores (every test above runs against 127.0.0.1).
  it('refuses private targets in run and check when asked to', async () => {
    const io = captureIo();
    const code = await runCli(
      ['run', ok.productUrl, '--device', 'mobile', '--json', '--block-private-targets'],
      io,
    );
    expect(code).toBe(3);
    const result = RunResultSchema.parse(JSON.parse(io.out.join('\n')));
    expect(result.status).toBe('error');
    expect(result.error?.message).toBe(
      'Target blocked: 127.0.0.1 is a loopback address (127.0.0.0/8)',
    );
    expect(result.journeys).toEqual([]);

    const { writeFile } = await import('node:fs/promises');
    await writeFile(
      path.join(cwd, 'internal.yml'),
      `version: 1
monitors:
  - name: metadata
    url: http://169.254.169.254/latest/meta-data/
`,
    );
    const checked = captureIo();
    expect(
      await runCli(['check', '--config', 'internal.yml', '--block-private-targets'], checked),
    ).toBe(3);
    expect(checked.out.join('\n')).toContain('cloud metadata address');
  });

  const okPort = () => new URL(ok.productUrl).port;
  const blockedRun = async (env: Record<string, string>) => {
    const io = captureIo(env);
    const code = await runCli(
      [
        'run',
        ok.productUrl,
        '--device',
        'mobile',
        '--json',
        '--step-timeout',
        '3000',
        '--block-private-targets',
      ],
      io,
    );
    return { code, io };
  };

  it('reads ALLOWED_TARGET_HOSTS and ALLOWED_TARGET_PORTS, as the worker does', async () => {
    const { code, io } = await blockedRun({
      ALLOWED_TARGET_HOSTS: '127.0.0.1',
      ALLOWED_TARGET_PORTS: okPort(),
    });
    const result = RunResultSchema.parse(JSON.parse(io.out.join('\n')));
    expect({ code, status: result.status, error: result.error }).toEqual({
      code: 0,
      status: 'passed',
      error: undefined,
    });
  });

  it('allows only ports 80 and 443 unless ALLOWED_TARGET_PORTS lists more', async () => {
    const { code, io } = await blockedRun({ ALLOWED_TARGET_HOSTS: '127.0.0.1' });
    expect(code).toBe(3);
    const result = RunResultSchema.parse(JSON.parse(io.out.join('\n')));
    expect(result.error?.message).toBe(
      `Target blocked: Port ${okPort()} is not allowed; only ports 80, 443 are`,
    );
  });

  it('ignores ALLOW_PRIVATE_TARGETS, since the flag asks for the guard', async () => {
    const { code, io } = await blockedRun({ ALLOW_PRIVATE_TARGETS: 'true' });
    expect(code).toBe(3);
    const result = RunResultSchema.parse(JSON.parse(io.out.join('\n')));
    expect(result.error?.message).toBe(
      'Target blocked: 127.0.0.1 is a loopback address (127.0.0.0/8)',
    );
  });

  it('exits 2 when an ALLOWED_TARGET_* setting is invalid', async () => {
    const { code, io } = await blockedRun({ ALLOWED_TARGET_PORTS: 'http' });
    expect(code).toBe(2);
    expect(io.out).toEqual([]);
    expect(io.err.join('\n')).toContain('ALLOWED_TARGET_PORTS');
  });
});
