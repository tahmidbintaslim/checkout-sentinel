import { inject, type InjectionKey } from 'vue';
import type { ApiClient } from '../api/client';

export const apiKey: InjectionKey<ApiClient> = Symbol('checkout-sentinel api client');

export function useApi(): ApiClient {
  const client = inject(apiKey);
  if (!client) throw new Error('The API client is not provided (app.provide(apiKey, client))');
  return client;
}
