import eslint from "@eslint/js";
import { fileURLToPath } from "node:url";
import path from "node:path";
import tseslint from "typescript-eslint";

const tsconfigRootDir = path.dirname(fileURLToPath(import.meta.url));

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    ignores: [
      "**/dist/",
      "**/node_modules/",
      "**/.wrangler/",
      "**/.next/",
      "**/.turbo/",
    ],
  },
  {
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],
      "no-unused-vars": "off",
      "@typescript-eslint/naming-convention": [
        "error",
        {
          selector: "default",
          format: ["camelCase"],
          leadingUnderscore: "allow",
          trailingUnderscore: "allow",
        },
        {
          selector: "variable",
          format: ["camelCase", "PascalCase", "UPPER_CASE"],
          leadingUnderscore: "allow",
          trailingUnderscore: "allow",
        },
        {
          selector: "import",
          format: ["camelCase", "PascalCase", "UPPER_CASE"],
        },
        {
          selector: "function",
          format: ["camelCase", "PascalCase", "UPPER_CASE"],
          leadingUnderscore: "allow",
          trailingUnderscore: "allow",
        },
        {
          selector: "parameter",
          format: ["camelCase", "PascalCase"],
          leadingUnderscore: "allow",
        },
        {
          selector: "typeLike",
          format: ["PascalCase"],
        },
        {
          selector: "property",
          format: null,
        },
        {
          selector: "objectLiteralProperty",
          format: null,
        },
        {
          selector: "objectLiteralMethod",
          format: null,
        },
        {
          selector: "typeProperty",
          format: null,
        },
        {
          selector: "enumMember",
          format: ["PascalCase", "UPPER_CASE"],
        },
      ],
      "quotes": [
        "error",
        "double",
        {
          avoidEscape: true,
          allowTemplateLiterals: true,
        },
      ],
      "block-spacing": ["error", "always"],
      "curly": ["error", "all"],
      "eqeqeq": ["error", "always"],
      "max-lines": [
        "error",
        {
          max: 1000,
          skipBlankLines: false,
          skipComments: false,
        },
      ],
      "max-len": [
        "error",
        {
          code: 120,
          tabWidth: 2,
          ignoreComments: true,
          ignoreStrings: true,
          ignoreTemplateLiterals: true,
          ignoreRegExpLiterals: true,
          ignoreUrls: true,
        },
      ],
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-import-type-side-effects": "error",
      "@typescript-eslint/no-unused-expressions": [
        "error",
        { allowTaggedTemplates: true },
      ],
    },
  },
  {
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      parserOptions: {
        project: [
          "./apps/web/tsconfig.json",
          "./apps/discord-bot/tsconfig.json",
          "./packages/api-contract/tsconfig.eslint.json",
          "./packages/shared/tsconfig.eslint.json",
          "./packages/vm-agent/tsconfig.eslint.json",
          "./scripts/tsconfig.json",
          "./services/api-server/tsconfig.eslint.json",
          "./services/connector-provisioner/tsconfig.eslint.json",
        ],
        tsconfigRootDir,
      },
    },
    rules: {
      "@typescript-eslint/no-floating-promises": [
        "error",
        { ignoreVoid: true },
      ],
    },
  },
);
