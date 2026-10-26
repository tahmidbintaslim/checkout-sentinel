/**
 * Browser-safe entry point: the monitor and run result schemas, without Playwright or Node
 * modules, for clients such as the dashboard that validate the same shapes as the API.
 */
export * from './monitor.js';
export * from './schema.js';
