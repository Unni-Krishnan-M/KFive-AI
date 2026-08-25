module.exports = {
  root: true,
  env: { node: true, es2021: true, jest: true },
  extends: ['eslint:recommended'],
  ignorePatterns: ['dist'],
  parser: '@typescript-eslint/parser',
  plugins: ['@typescript-eslint'],
  parserOptions: { ecmaVersion: 'latest', sourceType: 'module' },
  rules: {
    'no-unused-vars': 'off',
    '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    'no-undef': 'off',
    'no-empty': ['error', { allowEmptyCatch: true }],
  },
};
