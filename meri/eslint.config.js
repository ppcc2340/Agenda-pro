import js from "@eslint/js";
import react from "eslint-plugin-react";
import reactHooks from "eslint-plugin-react-hooks";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["**/dist/**", "**/.next/**", "**/coverage/**", "demo/**", "packages/db/drizzle/**"] },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  {
    languageOptions: { parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname } },
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/no-floating-promises": "error",
      "no-console": ["error", { allow: ["warn", "error"] }],
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_", ignoreRestSiblings: true }],
      eqeqeq: "error",
    },
  },
  {
    // web: React rules and "no hardcoded UI strings" (docs/12 §11); texts go through next-intl
    files: ["apps/web/src/**/*.{ts,tsx}"],
    plugins: { react, "react-hooks": reactHooks },
    settings: { react: { version: "detect" } },
    rules: {
      ...reactHooks.configs.recommended.rules,
      "react/jsx-no-literals": ["error", { noStrings: true, ignoreProps: true, noAttributeStrings: false, allowedStrings: ["–", "%", ":", "·", "(", ")"] }],
      "react/jsx-key": "error",
      "react/self-closing-comp": "error",
    },
  },
  {
    files: ["apps/web/src/**/*.test.{ts,tsx}"],
    rules: { "react/jsx-no-literals": "off" },
  },
  {
    // core debe ser puro: sin reloj ni azar ni I/O
    files: ["packages/core/src/**/*.ts"],
    rules: {
      "no-restricted-globals": ["error", "fetch", "process"],
      "no-restricted-properties": [
        "error",
        { object: "Date", property: "now", message: "Inyecta el reloj (now) en core." },
        { object: "Math", property: "random", message: "Inyecta el generador en core." },
      ],
    },
  },
);
