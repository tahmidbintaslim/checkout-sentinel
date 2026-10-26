import { styleText } from 'node:util';
import type { JourneyResult, RunResult, StepResult } from '@checkout-sentinel/core';

type Style = Parameters<typeof styleText>[0];
export type Paint = (style: Style, text: string) => string;

/** Colors only when stdout is a TTY and NO_COLOR / FORCE_COLOR allow it (styleText checks both). */
export const ttyPaint: Paint = (style, text) => styleText(style, text, { stream: process.stdout });
export const plainPaint: Paint = (_style, text) => text;

export function formatMs(ms: number): string {
  return ms < 1_000 ? `${ms} ms` : `${(ms / 1_000).toFixed(2)} s`;
}

function stepLabel(step: StepResult, paint: Paint): string {
  if (step.status === 'failed') return paint(['bold', 'red'], 'FAIL');
  if (step.status === 'skipped') return paint('gray', 'skip');
  if (step.slow) return paint('yellow', 'slow');
  return paint('green', ' ok ');
}

function stepNote(step: StepResult): string {
  if (step.message) return step.message;
  const details = step.details;
  if (step.name === 'open_product' && details.detectedPlatform !== undefined) {
    return `HTTP ${String(details.httpStatus)}, platform ${String(details.platformUsed)}`;
  }
  if (step.name === 'find_add_to_cart' && details.matched !== undefined) {
    const variant =
      details.variant !== undefined
        ? `, variant ${String(details.variant)} (${String(details.variantSelectedBy)})`
        : '';
    return `${String(details.matched)}${variant}`;
  }
  if (step.name === 'verify_cart' && details.cartAfter !== undefined) {
    return `cart ${String(details.cartBefore ?? 0)} -> ${String(details.cartAfter)} (${String(details.source)})`;
  }
  if (step.name === 'checkout_renders' && details.finalUrl !== undefined) {
    return new URL(String(details.finalUrl)).pathname;
  }
  return '';
}

function formatJourney(journey: JourneyResult, paint: Paint): string[] {
  const verdict =
    journey.status === 'passed'
      ? paint(['bold', 'green'], 'PASSED')
      : paint(['bold', 'red'], 'FAILED');
  const lines = [
    `${paint('bold', journey.device.padEnd(8))} ${verdict}  ${formatMs(journey.durationMs)}`,
  ];
  for (const step of journey.steps) {
    const duration = step.status === 'skipped' ? '' : formatMs(step.durationMs);
    lines.push(
      `  ${stepLabel(step, paint)}  ${step.name.padEnd(17)} ${duration.padStart(9)}  ${stepNote(step)}`.trimEnd(),
    );
    const notes: string[] = [];
    for (const error of step.pageErrors.slice(0, 3)) notes.push(`page error: ${error.message}`);
    for (const error of step.consoleErrors.slice(0, 3)) notes.push(`console error: ${error.text}`);
    for (const request of step.failedRequests.slice(0, 3)) {
      const reason =
        request.status !== undefined ? `HTTP ${request.status}` : (request.failure ?? request.kind);
      notes.push(`request ${request.method} ${request.url} -> ${reason}`);
    }
    if (step.screenshot) notes.push(`screenshot: ${step.screenshot}`);
    for (const note of notes) lines.push(paint('gray', `          ${note}`));
  }
  if (journey.trace) {
    lines.push(
      paint(
        'gray',
        `          trace: ${journey.trace} (open with: npx playwright show-trace <file>)`,
      ),
    );
  }
  return lines;
}

export function formatRunResult(result: RunResult, paint: Paint = plainPaint): string {
  const lines = [`${paint('bold', 'checkout-sentinel')} ${result.tool.version}  ${result.url}`];
  const detection = result.journeys.find((j) => j.platform)?.platform;
  if (detection) {
    const signals = detection.signals.length > 0 ? `: ${detection.signals.join('; ')}` : '';
    const forced =
      detection.used !== detection.detected ? `, using ${detection.used} as requested` : '';
    lines.push(
      `Platform: ${detection.detected} (${detection.confidence} confidence${signals})${forced}`,
    );
  }
  lines.push('');
  for (const journey of result.journeys) {
    lines.push(...formatJourney(journey, paint), '');
  }

  const { summary } = result;
  if (result.status === 'error') {
    lines.push(
      `${paint(['bold', 'red'], 'ERROR')}  ${result.error?.message ?? 'run could not complete'}`,
    );
  } else {
    const verdict =
      result.status === 'passed'
        ? paint(['bold', 'green'], 'PASSED')
        : paint(['bold', 'red'], 'FAILED');
    const slow = summary.slowSteps > 0 ? `, ${summary.slowSteps} slow step(s)` : '';
    lines.push(
      `Result: ${verdict}  ${summary.passed}/${summary.journeys} journeys passed${slow}  (${formatMs(result.durationMs)})`,
    );
  }
  return lines.join('\n');
}
