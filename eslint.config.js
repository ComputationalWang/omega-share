import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["eslint.config.js", ".claude/**", "graft/**", "**/dist/**", "**/.output/**", "**/.wxt/**", "**/node_modules/**", "company/**", "playwright-report/**", "test-results/**", "e2e/fixtures/vimeo-real-sdk/player.js"] },
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/switch-exhaustiveness-check": "error",
    },
  },
);
