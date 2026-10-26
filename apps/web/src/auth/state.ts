import { reactive } from 'vue';

/**
 * Set when the API answers 401. The app then asks for the token above the current page and,
 * once it is saved, renders the page again (version changes), so it reloads with the token.
 */
export const authState = reactive({ required: false, version: 0 });

export function markUnauthorized(): void {
  authState.required = true;
}

export function tokenChanged(): void {
  authState.required = false;
  authState.version += 1;
}
