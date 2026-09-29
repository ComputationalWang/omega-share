import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["eslint.config.js", ".claude/**", "graft/**", "**/dist/**", "**/.output/**", "**/.wxt/**", "**/node_modules/**", "company/**"] },
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
