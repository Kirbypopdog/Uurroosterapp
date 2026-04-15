/** @type {import('jest').Config} */
module.exports = {
  testEnvironment: 'node',
  testMatch: ['**/tests/**/*.test.js'],
  // Increase timeout for async tests
  testTimeout: 10000,
  // Force jest to exit after all tests complete (avoids hanging due to open server handles)
  forceExit: true,
  // Show coverage by default when running `npm test`
  collectCoverageFrom: [
    'src/**/*.js',
    '!src/server.js' // server.js is tested via api.test.js integration tests
  ]
};
