/** Dependency rules (docs/12 §1): no cycles; core imports nothing from other packages. */
module.exports = {
  forbidden: [
    { name: "no-circular", severity: "error", from: {}, to: { circular: true } },
    {
      name: "core-is-pure",
      severity: "error",
      comment: "packages/core must not import db, ai, integrations, config, apps or frameworks",
      from: { path: "^packages/core/src" },
      to: { path: "^(packages/(db|ai|integrations|config)|apps/)" },
    },
    {
      name: "core-no-node-io",
      severity: "error",
      comment: "packages/core must not use Node I/O modules",
      from: { path: "^packages/core/src" },
      to: { path: "^(node:)?(fs|net|http|https|child_process|dns|os|crypto)$" },
    },
    {
      name: "packages-do-not-import-apps",
      severity: "error",
      from: { path: "^packages/" },
      to: { path: "^apps/" },
    },
    {
      name: "db-only-imports-core-config",
      severity: "error",
      from: { path: "^packages/db/src" },
      to: { path: "^packages/(ai|integrations)" },
    },
  ],
  options: {
    doNotFollow: { path: "node_modules" },
    exclude: { path: "(node_modules|\\.next|dist|coverage|\\.test\\.ts$|\\.spec\\.ts$)" },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: "tsconfig.base.json" },
    enhancedResolveOptions: { exportsFields: ["exports"], conditionNames: ["import", "require", "default", "types"] },
    reporterOptions: { text: { highlightFocused: true } },
  },
};
