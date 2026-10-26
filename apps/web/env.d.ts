/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** "1" in the read-only demo build (vite build --mode demo). */
  readonly VITE_DEMO?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
