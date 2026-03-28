import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  timeout: 30000,
  use: {
    baseURL: process.env.MORPH_URL || 'http://localhost:8080',
    ignoreHTTPSErrors: true,
  },
});
