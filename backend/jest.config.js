/** @type {import('jest').Config} */
module.exports = {
  testEnvironment: 'node',
  testMatch: ['**/tests/**/*.test.js'],
  // Increase timeout for async tests
  testTimeout: 10000,
  // Set NODE_ENV=test so server.js skips app.listen() (avoids open handles)
  testEnvironmentOptions: {},
  globals: {},
  // Show coverage by default when running `npm test`
  collectCoverageFrom: [
    'src/**/*.js',
    '!src/server.js' // server.js is tested via api.test.js integration tests
  ]
};
