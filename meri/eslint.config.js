import js from "@eslint/js";
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
