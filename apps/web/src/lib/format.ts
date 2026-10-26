/** Same format as the CLI's step timings. */
export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return '';
  if (ms < 1_000) return `${ms} ms`;
  if (ms < 60_000) return `${(ms / 1_000).toFixed(2)} s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1_000);
  return `${minutes} min ${seconds} s`;
}

const dateTime = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'medium' });

export function formatDateTime(iso: string | null | undefined): string {
  return iso ? dateTime.format(new Date(iso)) : '';
}

const relative = new Intl.RelativeTimeFormat('en', { numeric: 'always' });
const UNITS: Array<[Intl.RelativeTimeFormatUnit, number]> = [
  ['day', 86_400_000],
  ['hour', 3_600_000],
  ['minute', 60_000],
];

export function relativeTime(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return 'never';
  const elapsed = now - Date.parse(iso);
  if (elapsed < 45_000) return 'just now';
  for (const [unit, size] of UNITS) {
    if (elapsed >= size) return relative.format(-Math.floor(elapsed / size), unit);
  }
  return relative.format(-Math.max(1, Math.round(elapsed / 60_000)), 'minute');
}

export function stepLabel(name: string): string {
  const words = name.replace(/_/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
