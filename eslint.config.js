import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import pluginVue from 'eslint-plugin-vue';
import vueA11y from 'eslint-plugin-vuejs-accessibility';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/dist-demo/**',
      '**/node_modules/**',
      '**/coverage/**',
      'packages/db/drizzle/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      globals: { ...globals.node },
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': ['error', { fixStyle: 'inline-type-imports' }],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      'no-console': 'off',
      eqeqeq: ['error', 'always'],
    },
  },
  {
    // Nest resolves constructor parameters from emitted decorator metadata, which needs
    // value imports of the injected classes.
    files: ['apps/api/**/*.ts', 'apps/worker/**/*.ts'],
    rules: {
      '@typescript-eslint/consistent-type-imports': 'off',
    },
  },
  // The dashboard: Vue single-file components, browser globals, accessibility rules.
  ...pluginVue.configs['flat/recommended'].map((config) => ({
    ...config,
    files: ['apps/web/**/*.vue'],
  })),
  ...vueA11y.configs['flat/recommended'].map((config) => ({
    ...config,
    files: ['apps/web/**/*.vue'],
  })),
  {
    files: ['apps/web/**/*.vue'],
    languageOptions: {
      parserOptions: { parser: tseslint.parser, extraFileExtensions: ['.vue'] },
    },
    rules: {
      // A label is associated by wrapping its control or by for/id; either is enough.
      'vuejs-accessibility/label-has-for': ['error', { required: { some: ['nesting', 'id'] } }],
    },
  },
  {
    files: ['apps/web/src/**/*.{ts,vue}', 'apps/web/test/unit/**/*.ts'],
    languageOptions: { globals: { ...globals.browser } },
  },
  prettier,
);
