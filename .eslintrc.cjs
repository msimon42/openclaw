module.exports = {
  root: true,
  ignorePatterns: ["**/dist/**", "**/node_modules/**"],
  parser: "@typescript-eslint/parser",
  parserOptions: {
    ecmaVersion: "latest",
    sourceType: "module",
  },
  plugins: ["@typescript-eslint"],
  extends: ["eslint:recommended", "plugin:@typescript-eslint/recommended"],
  overrides: [
    {
      files: [
        "packages/security/src/**/*.ts",
        "packages/plugin-runtime/src/**/*.ts",
        "packages/skills-runtime/src/**/*.ts",
        "packages/observability/src/**/*.ts",
      ],
      rules: {
        "@typescript-eslint/no-explicit-any": "error",
      },
    },
  ],
};
