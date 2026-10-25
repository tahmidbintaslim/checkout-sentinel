/**
 * Injection tokens. Providers are injected by token rather than by class type so dependency
 * injection does not rely on emitted decorator metadata (the test runner's transformer
 * does not emit it).
 */
export const API_CONFIG = Symbol('API_CONFIG');
export const DB_HANDLE = Symbol('DB_HANDLE');
export const REDIS = Symbol('REDIS');
export const SCHEDULER = Symbol('SCHEDULER');
export const MONITOR_REPOSITORY = Symbol('MONITOR_REPOSITORY');
export const RUN_REPOSITORY = Symbol('RUN_REPOSITORY');
export const DELIVERY_REPOSITORY = Symbol('DELIVERY_REPOSITORY');
export const API_METRICS = Symbol('API_METRICS');
export const TARGET_GUARD = Symbol('TARGET_GUARD');
