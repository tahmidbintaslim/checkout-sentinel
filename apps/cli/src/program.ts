import { writeFile, mkdir, access } from 'node:fs/promises';
import path from 'node:path';
import { Command, CommanderError, InvalidArgumentError, Option } from 'commander';
import {
  ExitCode,
  STRICT_TARGET_POLICY,
  TargetGuard,
  VERSION,
  exitCodeFor,
  runJourneys,
  type DeviceSelection,
  type RequestedPlatform,
  type RunResult,
} from '@checkout-sentinel/core';
import { ConfigError, EXAMPLE_CONFIG, loadMonitorsFile } from './config.js';
import { formatRunResult, ttyPaint, type Paint } from './format.js';

export interface Io {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  paint: Paint;
  cwd: string;
}

export const defaultIo: Io = {
  stdout: (text) => process.stdout.write(`${text}\n`),
  stderr: (text) => process.stderr.write(`${text}\n`),
  paint: ttyPaint,
  cwd: process.cwd(),
};

const positiveInt = (value: string): number => {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0)
    throw new InvalidArgumentError('Must be a positive integer.');
  return parsed;
};

interface RunFlags {
  platform: RequestedPlatform;
  device: DeviceSelection;
  json?: boolean;
  out: string;
  slowStepMs?: number;
  navigationTimeout?: number;
  stepTimeout?: number;
  failOnPageErrors?: boolean;
  blockPrivateTargets?: boolean;
}

interface CheckFlags {
  config: string;
  json?: boolean;
  out: string;
  blockPrivateTargets?: boolean;
}

/**
 * The CLI runs on the user's own machine against URLs the user typed, so by default it may
 * reach private and local addresses (local fixture stores, staging behind a VPN). The flag
 * applies the same SSRF guard as the API and worker, for configs written by someone else.
 */
const BLOCK_PRIVATE_HELP =
  'refuse private, loopback, link-local and metadata addresses (and redirects to them), as the API and worker do';

function guardFor(block: boolean | undefined): { targetGuard?: TargetGuard } {
  return block ? { targetGuard: new TargetGuard(STRICT_TARGET_POLICY) } : {};
}

async function writeResult(outDir: string, result: RunResult): Promise<string> {
  const dir = path.join(outDir, result.runId);
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, 'result.json');
  await writeFile(file, `${JSON.stringify(result, null, 2)}\n`);
  return file;
}

/** Builds the CLI. Returns the program plus a getter for the exit code the last action chose. */
export function buildProgram(io: Io = defaultIo): { program: Command; exitCode: () => number } {
  let exitCode: number = ExitCode.Passed;
  const program = new Command('checkout-sentinel')
    .description('Synthetic add-to-cart and checkout checks for Shopify and WooCommerce stores.')
    .version(VERSION)
    .showHelpAfterError()
    .configureOutput({
      writeOut: (s) => io.stdout(s.trimEnd()),
      writeErr: (s) => io.stderr(s.trimEnd()),
    })
    .exitOverride();

  program
    .command('run')
    .description(
      'Run the product -> cart -> checkout journey once against a product URL. Never places an order.',
    )
    .argument('<productUrl>', 'product page URL, for example https://store.example/products/tee')
    .addOption(
      new Option('--platform <platform>', 'store platform')
        .choices(['auto', 'shopify', 'woocommerce'])
        .default('auto'),
    )
    .addOption(
      new Option('--device <device>', 'viewport profile')
        .choices(['desktop', 'mobile', 'both'])
        .default('both'),
    )
    .option('--json', 'print the result as JSON (schema version 1) instead of text')
    .option(
      '--out <dir>',
      'directory for result.json, failure screenshots and traces',
      'checkout-sentinel-results',
    )
    .option('--slow-step-ms <ms>', 'flag passing steps slower than this', positiveInt)
    .option('--navigation-timeout <ms>', 'page load timeout', positiveInt)
    .option(
      '--step-timeout <ms>',
      'timeout for in-page waits (buttons, cart, checkout fields)',
      positiveInt,
    )
    .option(
      '--fail-on-page-errors',
      'fail a step when the page throws an uncaught exception during it',
    )
    .option('--block-private-targets', BLOCK_PRIVATE_HELP)
    .action(async (productUrl: string, flags: RunFlags) => {
      const outDir = path.resolve(io.cwd, flags.out);
      const result = await runJourneys({
        url: productUrl,
        platform: flags.platform,
        devices: flags.device,
        artifactsDir: outDir,
        ...(flags.slowStepMs ? { slowStepMs: flags.slowStepMs } : {}),
        timeouts: {
          ...(flags.navigationTimeout ? { navigationMs: flags.navigationTimeout } : {}),
          ...(flags.stepTimeout ? { stepMs: flags.stepTimeout } : {}),
        },
        failOnPageErrors: flags.failOnPageErrors ?? false,
        ...guardFor(flags.blockPrivateTargets),
      });
      const file = await writeResult(outDir, result);
      if (flags.json) {
        io.stdout(JSON.stringify(result, null, 2));
      } else {
        io.stdout(formatRunResult(result, io.paint));
        io.stdout(io.paint('gray', `Result JSON: ${file}`));
      }
      exitCode = exitCodeFor(result);
    });

  program
    .command('check')
    .description('Run every monitor in a config file once, one after another.')
    .option('-c, --config <file>', 'monitors config file', 'checkout-sentinel.yml')
    .option('--json', 'print a JSON array of results')
    .option(
      '--out <dir>',
      'directory for results and failure artifacts',
      'checkout-sentinel-results',
    )
    .option('--block-private-targets', BLOCK_PRIVATE_HELP)
    .action(async (flags: CheckFlags) => {
      const config = await loadMonitorsFile(path.resolve(io.cwd, flags.config));
      const outDir = path.resolve(io.cwd, flags.out);
      const results: RunResult[] = [];
      for (const monitor of config.monitors.filter((m) => m.enabled)) {
        const result = await runJourneys({
          url: monitor.url,
          platform: monitor.platform,
          devices: monitor.devices,
          slowStepMs: monitor.slowStepMs,
          artifactsDir: outDir,
          timeouts: config.defaults?.timeouts ?? {},
          ...guardFor(flags.blockPrivateTargets),
        });
        await writeResult(outDir, result);
        results.push(result);
        if (!flags.json)
          io.stdout(
            `${io.paint('bold', `== ${monitor.name}`)}\n${formatRunResult(result, io.paint)}\n`,
          );
      }
      if (flags.json) io.stdout(JSON.stringify(results, null, 2));
      exitCode = Math.max(ExitCode.Passed, ...results.map((r) => exitCodeFor(r)));
    });

  program
    .command('init')
    .description('Write an example monitors config file.')
    .option('-p, --path <file>', 'where to write it', 'checkout-sentinel.yml')
    .option('-f, --force', 'overwrite an existing file')
    .action(async (flags: { path: string; force?: boolean }) => {
      const target = path.resolve(io.cwd, flags.path);
      const exists = await access(target).then(
        () => true,
        () => false,
      );
      if (exists && !flags.force) {
        throw new ConfigError(`${flags.path} already exists; pass --force to overwrite it`);
      }
      await writeFile(target, EXAMPLE_CONFIG);
      io.stdout(
        `Wrote ${flags.path}. Edit the URLs, then run: checkout-sentinel check --config ${flags.path}`,
      );
      exitCode = ExitCode.Passed;
    });

  return { program, exitCode: () => exitCode };
}

/** Parses argv and returns the process exit code. Never calls process.exit itself. */
export async function runCli(argv: string[], io: Io = defaultIo): Promise<number> {
  const { program, exitCode } = buildProgram(io);
  try {
    await program.parseAsync(argv, { from: 'user' });
    return exitCode();
  } catch (error) {
    if (error instanceof CommanderError) {
      return error.exitCode === 0 ? ExitCode.Passed : ExitCode.UsageError;
    }
    if (error instanceof ConfigError) {
      io.stderr(error.message);
      return ExitCode.UsageError;
    }
    io.stderr(`checkout-sentinel: ${error instanceof Error ? error.message : String(error)}`);
    return ExitCode.RuntimeError;
  }
}
