module.exports = {
  rootDir: '.',
  testRegex: 'src/.*\\.spec\\.ts$',
  testEnvironment: 'node',
  transform: { '^.+\\.ts$': ['ts-jest', { tsconfig: 'tsconfig.json' }] },
  moduleFileExtensions: ['ts', 'js', 'json'],
};
