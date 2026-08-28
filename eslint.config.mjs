// @ts-check
import tseslint from "@typescript-eslint/eslint-plugin";
import tsparser from "@typescript-eslint/parser";

// vitest.config.ts sets `globals: true`, so tests use describe/it/expect etc.
// without imports — declare them here instead of adding the vitest plugin.
const vitestGlobals = {
  describe: "readonly",
  it: "readonly",
  test: "readonly",
  expect: "readonly",
  vi: "readonly",
  beforeEach: "readonly",
  afterEach: "readonly",
  beforeAll: "readonly",
  afterAll: "readonly",
  suite: "readonly",
  bench: "readonly",
};

export default [
  {
    ignores: ["node_modules/", "dist/", "docs/"],
  },
  {
    // Type-aware rules need files that are part of tsconfig.json (src + entry).
    files: ["src/**/*.ts", "index.ts"],
    ignores: ["src/pi-base/**/*.test.ts"],
    languageOptions: {
      parser: tsparser,
      parserOptions: {
        project: "./tsconfig.json",
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: {
      "@typescript-eslint": tseslint,
    },
    rules: {
      // Type-aware rules that catch real bugs
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",
      "@typescript-eslint/restrict-template-expressions": "error",

      // Baseline correctness
      "no-unused-vars": "off", // handled by tsconfig noUnusedLocals
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
    },
  },
  {
    // Tests: not part of tsconfig.json yet (tsc over tests/ surfaces ~153
    // pre-existing type errors, tracked as a separate cleanup), so lint them
    // without type-aware rules but still catch unused vars.
    files: ["tests/**/*.ts"],
    languageOptions: {
      parser: tsparser,
      globals: vitestGlobals,
    },
    plugins: {
      "@typescript-eslint": tseslint,
    },
    rules: {
      "no-unused-vars": "off",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
    },
  },
  {
    // Root config files (not in tsconfig.json either).
    files: ["*.mjs", "tsup.config.ts", "vitest.config.ts"],
    languageOptions: {
      parser: tsparser,
    },
    plugins: {
      "@typescript-eslint": tseslint,
    },
    rules: {
      "no-unused-vars": "off",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
    },
  },
];
