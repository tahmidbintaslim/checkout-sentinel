import type { DeviceProfile } from './devices.js';
import { PROJECT_URL, TOOL_NAME, VERSION } from './version.js';

/**
 * The user agent keeps a real browser prefix so themes that branch on "Mobile" still serve
 * the mobile layout, and appends a token that names the tool and a URL, so merchants can
 * recognise and filter synthetic traffic in their analytics and server logs.
 */
export function buildUserAgent(device: DeviceProfile, contactUrl: string = PROJECT_URL): string {
  return `${device.baseUserAgent} ${TOOL_NAME}/${VERSION} (+${contactUrl})`;
}
