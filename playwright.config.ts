import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  timeout: 60000,
  workers: 1, // sequential — all tests hit the same server
  use: {
    baseURL: process.env.MORPH_URL || 'http://localhost:8080',
    ignoreHTTPSErrors: true,
    launchOptions: {
      // Bypass proxy for localhost to avoid proxy interference
      args: ['--no-proxy-server'],
    },
  },
});
