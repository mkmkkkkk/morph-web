module.exports = {
  projects: [
    // Pure library tests (crypto, protocol, api) — no RN runtime needed
    {
      displayName: 'lib',
      testMatch: ['<rootDir>/lib/__tests__/**/*.test.ts'],
      transform: {
        '^.+\\.tsx?$': ['babel-jest', {
          presets: [
            ['@babel/preset-env', { targets: { node: 'current' } }],
            '@babel/preset-typescript',
          ],
        }],
        '^.+\\.js$': ['babel-jest', {
          presets: [
            ['@babel/preset-env', { targets: { node: 'current' } }],
          ],
        }],
      },
      transformIgnorePatterns: [
        'node_modules/(?!(tweetnacl|@noble/.*))',
      ],
      moduleNameMapper: {
        '^@noble/ciphers/(.*)\\.js$': '<rootDir>/node_modules/@noble/ciphers/$1.js',
        '^@noble/ciphers/(.*)$': '<rootDir>/node_modules/@noble/ciphers/$1.js',
      },
      moduleFileExtensions: ['ts', 'tsx', 'js', 'jsx', 'json'],
    },
    // Component/screen tests — full RN environment
    {
      displayName: 'app',
      preset: 'jest-expo',
      testMatch: ['<rootDir>/app/**/__tests__/**/*.test.tsx', '<rootDir>/components/**/__tests__/**/*.test.tsx'],
      transformIgnorePatterns: [
        'node_modules/(?!((jest-)?react-native|@react-native(-community)?)|expo(nent)?|@expo(nent)?/.*|react-navigation|@react-navigation/.*|tweetnacl|@noble/.*|socket.io-client|engine.io-client)',
      ],
      moduleFileExtensions: ['ts', 'tsx', 'js', 'jsx', 'json'],
    },
  ],
};
