import type { DeviceName } from './schema.js';

export interface DeviceProfile {
  name: DeviceName;
  viewport: { width: number; height: number };
  deviceScaleFactor: number;
  isMobile: boolean;
  hasTouch: boolean;
  /** Browser part of the user agent; the checkout-sentinel token is appended to it. */
  baseUserAgent: string;
}

/**
 * Profiles are defined here rather than taken from Playwright's device list so results stay
 * comparable across Playwright upgrades. The mobile width (390px) sits below the 750px
 * breakpoint most Shopify themes use, which is where "hidden on mobile" bugs show up.
 */
export const DEVICE_PROFILES: Readonly<Record<DeviceName, DeviceProfile>> = {
  desktop: {
    name: 'desktop',
    viewport: { width: 1366, height: 900 },
    deviceScaleFactor: 1,
    isMobile: false,
    hasTouch: false,
    baseUserAgent:
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
  },
  mobile: {
    name: 'mobile',
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
    baseUserAgent:
      'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36',
  },
};

export type DeviceSelection = DeviceName | 'both';

export function resolveDevices(selection: DeviceSelection | readonly DeviceName[]): DeviceName[] {
  if (selection === 'both') return ['desktop', 'mobile'];
  if (typeof selection === 'string') return [selection];
  return [...new Set(selection)];
}
