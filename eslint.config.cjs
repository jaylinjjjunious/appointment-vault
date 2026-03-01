const js = require("@eslint/js");
const { FlatCompat } = require("@eslint/eslintrc");

const compat = new FlatCompat({
  baseDirectory: __dirname,
  recommendedConfig: js.configs.recommended,
  allConfig: js.configs.all
});

module.exports = [
  ...compat.config({
    env: {
      node: true,
      es2022: true
    },
    extends: ["eslint:recommended", "prettier"],
    parserOptions: {
      ecmaVersion: "latest",
      sourceType: "script"
    },
    rules: {
      "no-console": "off",
      "no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^(?:_|err|error|next)$",
          varsIgnorePattern: "^_",
          caughtErrors: "none"
        }
      ]
    }
  }),
  {
    files: ["src/public/**/*.js"],
    languageOptions: {
      globals: {
        window: "readonly",
        document: "readonly"
      }
    }
  }
];
