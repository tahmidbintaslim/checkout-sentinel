import type { RunResult } from './schema.js';

/** Process exit codes shared by the CLI and documented in the README. */
export const ExitCode = {
  /** Every journey passed (slow steps are reported but do not fail the run). */
  Passed: 0,
  /** At least one journey failed a step. */
  JourneyFailed: 1,
  /** Bad arguments or an invalid config file. */
  UsageError: 2,
  /** The run could not be executed, for example the browser failed to launch. */
  RuntimeError: 3,
} as const;

export type ExitCode = (typeof ExitCode)[keyof typeof ExitCode];

export function exitCodeFor(result: Pick<RunResult, 'status'>): ExitCode {
  switch (result.status) {
    case 'passed':
      return ExitCode.Passed;
    case 'failed':
      return ExitCode.JourneyFailed;
    case 'error':
      return ExitCode.RuntimeError;
  }
}
