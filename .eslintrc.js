module.exports = {
  root: true,
  extends: '@react-native',
  ignorePatterns: ['dist/**'],
  overrides: [
    {
      files: ['backend/**/*.js'],
      env: {
        node: true,
      },
    },
    {
      files: ['jest.setup.js', '__tests__/**/*.js', '__tests__/**/*.ts', '__tests__/**/*.tsx'],
      env: {
        jest: true,
      },
    },
  ],
};
