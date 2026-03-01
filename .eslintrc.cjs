module.exports = {
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
    "no-console": "off"
  }
};